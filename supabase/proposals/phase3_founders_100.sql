-- MYOPS Phase 3: Founders 100 lifetime entitlement + All Apps monthly bundle.
-- PROPOSAL ONLY. Deliberately outside supabase/migrations so no runner applies it.
-- Do NOT execute on any Supabase project until it has had security review and owner
-- approval, and then staging only. Depends on the Phase 2A foundation migration
-- (public.myops_products, public.myops_subscriptions) being applied first.
--
-- Design:
--  * Every founder-slot mutation takes ONE transaction-scoped advisory lock, so slot
--    reservation, allocation and settlement are serialised. Slot numbers are also a
--    primary key 1..100 and user_id/payment_id are unique: even without the lock the
--    database cannot hold more than 100 allocations or two for one customer.
--  * Only a payment settled as 'succeeded' by the server can allocate a slot. Pending
--    checkouts hold a short-lived reservation (default 30 min) that is released on
--    failure, cancellation or expiry and is NOT an allocation.
--  * Lifetime entitlements live in their own table, separate from recurring subscriptions,
--    and require a succeeded payment (payment_id NOT NULL, unique). No free lifetimes.
--  * All functions are SECURITY DEFINER with an empty search_path, schema-qualified
--    references, and EXECUTE granted to service_role only. Clients get no table writes.
begin;

-- FIX for Phase 2A: myops_product_or_bundle is inverted ((slug is null) <> bundle) so a bundle
-- row can never be inserted. A bundle must have NO product slug; a product row must have one.
alter table public.myops_subscriptions drop constraint if exists myops_product_or_bundle;
alter table public.myops_subscriptions add constraint myops_product_or_bundle
  check ((product_slug is null) = is_complete_bundle);

create table if not exists public.myops_payments (
  id uuid primary key default gen_random_uuid(),
  order_ref text not null unique check (order_ref ~ '^MYOPS-[A-Za-z0-9_-]{8,64}$'),
  user_id uuid not null references auth.users(id),
  plan text not null check (plan in ('founders_lifetime','all_apps_monthly')),
  amount_cents integer not null check (amount_cents = 2900),
  currency text not null default 'MYR' check (currency = 'MYR'),
  gateway text not null default 'toyyibpay_sandbox' check (gateway = 'toyyibpay_sandbox'),
  gateway_bill_code text unique check (gateway_bill_code ~ '^[A-Za-z0-9]{4,32}$'),
  gateway_txn_ref text unique,
  status text not null default 'pending'
    check (status in ('pending','succeeded','failed','canceled','expired')),
  outcome text check (outcome in ('founder_allocated','subscription_granted',
    'founder_slots_exhausted','duplicate_claim_review')),
  reserved_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  constraint myops_payment_reservation check (reserved_until is null or plan = 'founders_lifetime'),
  constraint myops_payment_outcome check ((status = 'succeeded') = (outcome is not null))
);
-- One open checkout per customer and plan: prevents duplicate claims by repeated clicks.
create unique index if not exists myops_one_pending_payment
  on public.myops_payments (user_id, plan) where status = 'pending';

create table if not exists public.myops_founder_allocations (
  slot_number integer primary key check (slot_number between 1 and 100),
  user_id uuid not null unique references auth.users(id),
  payment_id uuid not null unique references public.myops_payments(id),
  allocated_at timestamptz not null default now()
);

create table if not exists public.myops_lifetime_entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  scope text not null check (scope = 'all_apps'),
  source text not null check (source = 'founders_100'),
  payment_id uuid not null unique references public.myops_payments(id),
  status text not null default 'active' check (status in ('active','revoked')),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_reason text
);
create unique index if not exists myops_one_active_lifetime
  on public.myops_lifetime_entitlements (user_id, scope) where status = 'active';

create table if not exists public.myops_payment_events (
  id bigint generated always as identity primary key,
  event_key text not null unique,
  order_ref text,
  bill_code text,
  verified_outcome text,
  result text,
  duplicate_count integer not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

alter table public.myops_payments enable row level security;
alter table public.myops_founder_allocations enable row level security;
alter table public.myops_lifetime_entitlements enable row level security;
alter table public.myops_payment_events enable row level security;

revoke all on public.myops_payments, public.myops_founder_allocations,
  public.myops_lifetime_entitlements, public.myops_payment_events from public, anon, authenticated;

-- The only client-visible data: a customer may read their own active lifetime entitlement.
grant select on public.myops_lifetime_entitlements to authenticated;
drop policy if exists myops_lifetime_self_read on public.myops_lifetime_entitlements;
create policy myops_lifetime_self_read on public.myops_lifetime_entitlements
  for select to authenticated using (user_id = (select auth.uid()) and status = 'active');

-- Internal helper: add one month of the All Apps bundle (manual renewal), extending an
-- existing active bundle rather than creating a parallel one.
create or replace function public.myops_grant_month(p_user_id uuid, p_ref text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.myops_subscriptions
     set current_period_end = greatest(coalesce(current_period_end, now()), now()) + interval '1 month',
         gateway_reference = p_ref
   where personal_user_id = p_user_id and is_complete_bundle and status = 'active';
  if not found then
    insert into public.myops_subscriptions
      (personal_user_id, is_complete_bundle, status, renewal_mode, current_period_end, gateway_reference)
    values (p_user_id, true, 'active', 'manual', now() + interval '1 month', p_ref);
  end if;
end $$;

create or replace function public.myops_founders_status()
returns jsonb language plpgsql security definer set search_path = '' stable as $$
declare v_alloc integer; v_res integer;
begin
  select count(*) into v_alloc from public.myops_founder_allocations;
  select count(*) into v_res from public.myops_payments
   where plan = 'founders_lifetime' and status = 'pending' and reserved_until > now();
  return jsonb_build_object('capacity', 100, 'allocated', v_alloc, 'reserved', v_res,
    'remaining', greatest(0, 100 - v_alloc - v_res));
end $$;

create or replace function public.myops_create_payment(
  p_user_id uuid, p_plan text, p_order_ref text, p_reservation_minutes integer default 30)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_alloc integer; v_res integer; v_existing public.myops_payments;
begin
  if p_plan not in ('founders_lifetime','all_apps_monthly') then
    raise exception 'invalid plan' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(730500100);
  if not exists (select 1 from auth.users where id = p_user_id and email_confirmed_at is not null) then
    return jsonb_build_object('status', 'unconfirmed_user');
  end if;
  if exists (select 1 from public.myops_lifetime_entitlements where user_id = p_user_id and status = 'active')
     or exists (select 1 from public.myops_founder_allocations where user_id = p_user_id) then
    return jsonb_build_object('status', 'already_lifetime');
  end if;
  -- Release stale reservations/checkouts for this customer.
  update public.myops_payments set status = 'expired', updated_at = now()
   where user_id = p_user_id and status = 'pending'
     and ((reserved_until is not null and reserved_until <= now())
          or (reserved_until is null and created_at < now() - interval '24 hours'));
  select * into v_existing from public.myops_payments
   where user_id = p_user_id and plan = p_plan and status = 'pending';
  if found then
    return jsonb_build_object('status', 'existing', 'order_ref', v_existing.order_ref,
      'bill_code', v_existing.gateway_bill_code);
  end if;
  select count(*) into v_alloc from public.myops_founder_allocations;
  select count(*) into v_res from public.myops_payments
   where plan = 'founders_lifetime' and status = 'pending' and reserved_until > now();
  if p_plan = 'founders_lifetime' then
    if v_alloc + v_res >= 100 then
      return jsonb_build_object('status', case when v_alloc >= 100 then 'sold_out' else 'reserved_out' end);
    end if;
    insert into public.myops_payments (order_ref, user_id, plan, amount_cents, reserved_until)
    values (p_order_ref, p_user_id, p_plan, 2900,
            now() + make_interval(mins => least(greatest(p_reservation_minutes, 5), 60)));
  else
    -- The monthly bundle is offered only from customer 101 onward.
    if v_alloc < 100 then return jsonb_build_object('status', 'founders_available'); end if;
    insert into public.myops_payments (order_ref, user_id, plan, amount_cents)
    values (p_order_ref, p_user_id, p_plan, 2900);
  end if;
  return jsonb_build_object('status', 'created', 'order_ref', p_order_ref);
end $$;

create or replace function public.myops_attach_bill(p_order_ref text, p_bill_code text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.myops_payments set gateway_bill_code = p_bill_code, updated_at = now()
   where order_ref = p_order_ref and status = 'pending' and gateway_bill_code is null;
  return found;
end $$;

-- Gateway bill could not be created: release the reservation immediately.
create or replace function public.myops_abort_checkout(p_order_ref text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.myops_payments set status = 'failed', updated_at = now()
   where order_ref = p_order_ref and status = 'pending' and gateway_bill_code is null;
  return found;
end $$;

create or replace function public.myops_get_payment(p_order_ref text)
returns jsonb language sql security definer set search_path = '' stable as $$
  select to_jsonb(p) from public.myops_payments p where p.order_ref = p_order_ref;
$$;

-- Settle a payment whose outcome the SERVER has verified with the gateway.
-- Idempotent: safe for duplicate/replayed webhooks and concurrent invocations.
create or replace function public.myops_settle_payment(
  p_order_ref text, p_bill_code text, p_txn_ref text, p_amount_cents integer,
  p_outcome text, p_event_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_pay public.myops_payments; v_result text; v_dup integer; v_alloc integer;
  v_others integer; v_slot integer; v_outcome text;
begin
  if p_outcome not in ('succeeded','failed','canceled') then
    raise exception 'invalid outcome' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(730500100);
  insert into public.myops_payment_events (event_key, order_ref, bill_code, verified_outcome)
  values (p_event_key, p_order_ref, p_bill_code, p_outcome)
  on conflict (event_key) do update
    set duplicate_count = public.myops_payment_events.duplicate_count + 1, last_seen_at = now()
  returning duplicate_count into v_dup;

  select * into v_pay from public.myops_payments where order_ref = p_order_ref for update;
  if not found then
    v_result := 'unknown_order';
  elsif v_pay.gateway_bill_code is distinct from p_bill_code then
    v_result := 'bill_mismatch';
  elsif v_pay.status = 'succeeded' then
    -- Terminal: a later failure/cancel/replay can never revoke or re-grant.
    v_result := 'already_settled';
  elsif p_outcome in ('failed','canceled') then
    if v_pay.status = 'pending' then
      update public.myops_payments set status = p_outcome, updated_at = now() where id = v_pay.id;
    end if;
    v_result := p_outcome;
  elsif p_amount_cents is distinct from v_pay.amount_cents then
    v_result := 'amount_mismatch';
  else
    if v_pay.plan = 'founders_lifetime' then
      select count(*) into v_alloc from public.myops_founder_allocations;
      select count(*) into v_others from public.myops_payments
       where plan = 'founders_lifetime' and status = 'pending' and reserved_until > now() and id <> v_pay.id;
      if exists (select 1 from public.myops_founder_allocations where user_id = v_pay.user_id)
         or exists (select 1 from public.myops_lifetime_entitlements where user_id = v_pay.user_id and status = 'active') then
        v_outcome := 'duplicate_claim_review';
      elsif v_alloc + v_others < 100 then
        select min(n) into v_slot from generate_series(1, 100) n
         where not exists (select 1 from public.myops_founder_allocations a where a.slot_number = n);
        insert into public.myops_founder_allocations (slot_number, user_id, payment_id)
        values (v_slot, v_pay.user_id, v_pay.id);
        insert into public.myops_lifetime_entitlements (user_id, scope, source, payment_id)
        values (v_pay.user_id, 'all_apps', 'founders_100', v_pay.id);
        v_outcome := 'founder_allocated';
      else
        -- Paid after slots ran out: the RM29 buys one month of the bundle instead.
        perform public.myops_grant_month(v_pay.user_id, p_txn_ref);
        v_outcome := 'founder_slots_exhausted';
      end if;
    else
      perform public.myops_grant_month(v_pay.user_id, p_txn_ref);
      v_outcome := 'subscription_granted';
    end if;
    update public.myops_payments
       set status = 'succeeded', outcome = v_outcome, confirmed_at = now(),
           gateway_txn_ref = p_txn_ref, reserved_until = null, updated_at = now()
     where id = v_pay.id;
    v_result := 'settled';
  end if;

  update public.myops_payment_events set result = v_result where event_key = p_event_key;
  select * into v_pay from public.myops_payments where order_ref = p_order_ref;
  return jsonb_build_object('status', v_result, 'outcome', v_pay.outcome, 'duplicate', v_dup > 0);
end $$;

create or replace function public.myops_admin_audit(p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path = '' stable as $$
declare v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
begin
  return jsonb_build_object(
    'founders', public.myops_founders_status(),
    'payments', coalesce((select jsonb_agg(to_jsonb(x)) from (
      select order_ref, user_id, plan, amount_cents, currency, status, outcome, gateway_bill_code,
             gateway_txn_ref, reserved_until, created_at, confirmed_at
        from public.myops_payments order by created_at desc limit v_limit) x), '[]'::jsonb),
    'allocations', coalesce((select jsonb_agg(to_jsonb(x)) from (
      select slot_number, user_id, payment_id, allocated_at
        from public.myops_founder_allocations order by slot_number limit v_limit) x), '[]'::jsonb),
    'entitlements', coalesce((select jsonb_agg(to_jsonb(x)) from (
      select id, user_id, scope, source, payment_id, status, granted_at, revoked_at, revoked_reason
        from public.myops_lifetime_entitlements order by granted_at desc limit v_limit) x), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(to_jsonb(x)) from (
      select order_ref, bill_code, verified_outcome, result, duplicate_count, first_seen_at, last_seen_at
        from public.myops_payment_events order by last_seen_at desc limit v_limit) x), '[]'::jsonb));
end $$;

revoke all on function public.myops_grant_month(uuid, text),
  public.myops_founders_status(), public.myops_create_payment(uuid, text, text, integer),
  public.myops_attach_bill(text, text), public.myops_abort_checkout(text),
  public.myops_get_payment(text),
  public.myops_settle_payment(text, text, text, integer, text, text),
  public.myops_admin_audit(integer) from public, anon, authenticated;
grant execute on function public.myops_founders_status(), public.myops_create_payment(uuid, text, text, integer),
  public.myops_attach_bill(text, text), public.myops_abort_checkout(text),
  public.myops_get_payment(text),
  public.myops_settle_payment(text, text, text, integer, text, text),
  public.myops_admin_audit(integer) to service_role;

commit;

-- Rollback (staging only, after approval): drop the four tables and the functions above
-- in reverse order. Allocations/entitlements are financial records: export first.
