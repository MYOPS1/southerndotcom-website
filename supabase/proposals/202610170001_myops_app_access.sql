-- Versioned S1-B application access migration proposal.
-- NOT EXECUTED. Requires the approved Phase 2A identity migration and Phase 3 entitlement schema.
-- Apply in staging only after independent security review and owner approval.
-- App servers use Ed25519 signatures. MYOPS stores public keys only; app private keys
-- remain in each app's server-only environment. No browser or client RPC access is granted.

begin;

create table if not exists public.myops_app_clients (
  app_id text primary key check (app_id in ('opsfinance','opsflow','opsp')),
  product_slug text not null unique references public.myops_products(slug),
  -- Only Ed25519 SPKI public keys (fixed DER prefix + 32-byte key) can be enrolled.
  public_key_current text not null check (public_key_current ~ '^-----BEGIN PUBLIC KEY-----\s*MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=\s*-----END PUBLIC KEY-----\s*$'),
  public_key_next text check (public_key_next is null or public_key_next ~ '^-----BEGIN PUBLIC KEY-----\s*MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=\s*-----END PUBLIC KEY-----\s*$'),
  enabled boolean not null default false,
  rotated_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.myops_app_tickets (
  ticket_hash text primary key check (ticket_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  product_slug text not null references public.myops_products(slug),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '60 seconds')
);
create index if not exists myops_app_tickets_expiry_idx on public.myops_app_tickets(expires_at);
create index if not exists myops_app_tickets_user_idx on public.myops_app_tickets(user_id) where used_at is null and revoked_at is null;

create table if not exists public.myops_app_nonces (
  nonce_hash text primary key check (nonce_hash ~ '^[a-f0-9]{64}$'),
  app_id text not null references public.myops_app_clients(app_id) on delete cascade,
  expires_at timestamptz not null
);
create index if not exists myops_app_nonces_expiry_idx on public.myops_app_nonces(expires_at);

create table if not exists public.myops_app_rate_limits (
  key_hash text primary key check (key_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null default now()
);
create index if not exists myops_app_rate_limits_updated_idx on public.myops_app_rate_limits(updated_at);

create table if not exists public.myops_app_audit (
  id bigint generated always as identity primary key,
  app_id text references public.myops_app_clients(app_id) on delete set null,
  event text not null check (event in ('ticket_issued','ticket_redeemed','session_revoked','rate_limited')),
  reason_code text not null check (reason_code in ('issued','redeemed','logout','entitlement_revoked','entitlement_denied','idle_expired','absolute_expired','rate_limit')),
  created_at timestamptz not null default now()
);
create index if not exists myops_app_audit_created_idx on public.myops_app_audit(created_at desc);

alter table public.myops_app_sessions
  add column if not exists app_id text references public.myops_app_clients(app_id),
  add column if not exists product_slug text references public.myops_products(slug),
  add column if not exists ended_reason text check (ended_reason is null or ended_reason in (
    'myops_logout','entitlement_denied','entitlement_revoked','idle_expired','absolute_expired','admin_revoked'
  ));
create index if not exists myops_app_sessions_active_user_idx
  on public.myops_app_sessions(user_id, app_id) where revoked_at is null;

alter table public.myops_app_clients enable row level security;
alter table public.myops_app_tickets enable row level security;
alter table public.myops_app_nonces enable row level security;
alter table public.myops_app_rate_limits enable row level security;
alter table public.myops_app_audit enable row level security;
revoke all on public.myops_app_clients, public.myops_app_tickets, public.myops_app_nonces,
  public.myops_app_rate_limits, public.myops_app_audit from public, anon, authenticated;
revoke all on public.myops_app_sessions from public, anon, authenticated;

create or replace function public.myops_get_app_client(p_app_id text)
returns jsonb language sql security definer set search_path = '' stable as $$
  select jsonb_build_object(
    'app_id', c.app_id, 'product_slug', c.product_slug, 'enabled', c.enabled,
    'public_key_current', c.public_key_current, 'public_key_next', c.public_key_next
  )
  from public.myops_app_clients c where c.app_id = p_app_id;
$$;

create or replace function public.myops_issue_app_ticket(p_user_id uuid, p_product_slug text, p_ticket_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_ticket_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid ticket hash' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  if not exists (
    select 1 from public.myops_app_clients c
    join public.myops_products p on p.slug = c.product_slug
    where c.product_slug = p_product_slug and c.enabled and p.launch_status = 'live'
  ) then
    return jsonb_build_object('status', 'unavailable');
  end if;
  insert into public.myops_app_tickets (ticket_hash, user_id, product_slug, expires_at)
  values (p_ticket_hash, p_user_id, p_product_slug, now() + interval '60 seconds');
  insert into public.myops_app_audit (app_id, event, reason_code)
  select c.app_id, 'ticket_issued', 'issued' from public.myops_app_clients c where c.product_slug = p_product_slug;
  return jsonb_build_object('status', 'issued');
end $$;

create or replace function public.myops_record_app_nonce(p_app_id text, p_nonce_hash text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_inserted integer;
begin
  if p_nonce_hash !~ '^[a-f0-9]{64}$' then return false; end if;
  delete from public.myops_app_nonces where expires_at <= now();
  insert into public.myops_app_nonces (nonce_hash, app_id, expires_at)
  select p_nonce_hash, c.app_id, now() + interval '15 minutes'
  from public.myops_app_clients c where c.app_id = p_app_id and c.enabled
  on conflict (nonce_hash) do nothing;
  get diagnostics v_inserted = row_count;
  return v_inserted = 1;
end $$;

create or replace function public.myops_redeem_app_ticket(p_app_id text, p_ticket_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_client public.myops_app_clients; v_ticket public.myops_app_tickets; v_session uuid;
begin
  select * into v_client from public.myops_app_clients where app_id = p_app_id and enabled;
  if not found then return jsonb_build_object('status', 'denied'); end if;
  select * into v_ticket from public.myops_app_tickets
    where ticket_hash = p_ticket_hash for update;
  if not found or v_ticket.used_at is not null or v_ticket.revoked_at is not null
     or v_ticket.expires_at <= now() or v_ticket.product_slug <> v_client.product_slug then
    return jsonb_build_object('status', 'denied');
  end if;
  update public.myops_app_tickets set used_at = now() where ticket_hash = p_ticket_hash;
  insert into public.myops_app_sessions (user_id, app_id, product_slug)
    values (v_ticket.user_id, v_client.app_id, v_client.product_slug) returning id into v_session;
  insert into public.myops_app_audit (app_id, event, reason_code)
    values (v_client.app_id, 'ticket_redeemed', 'redeemed');
  return jsonb_build_object('status', 'redeemed', 'user_id', v_ticket.user_id,
    'session_id', v_session, 'product_slug', v_ticket.product_slug);
end $$;

-- Validation never extends the session unless the app asserts genuine user activity (p_touch).
-- Idle limit: 15 minutes since last user activity. Absolute limit: 12 hours since creation.
create or replace function public.myops_validate_app_session(p_session_id uuid, p_app_id text, p_product_slug text, p_touch boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session public.myops_app_sessions; v_reason text;
begin
  select * into v_session from public.myops_app_sessions
    where id = p_session_id and app_id = p_app_id and product_slug = p_product_slug for update;
  if not found or v_session.revoked_at is not null then
    return jsonb_build_object('active', false);
  end if;
  if v_session.created_at <= now() - interval '12 hours' then v_reason := 'absolute_expired';
  elsif v_session.last_activity_at <= now() - interval '15 minutes' then v_reason := 'idle_expired';
  end if;
  if v_reason is not null then
    update public.myops_app_sessions set revoked_at = now(), ended_reason = v_reason where id = p_session_id;
    insert into public.myops_app_audit (app_id, event, reason_code)
      values (p_app_id, 'session_revoked', v_reason);
    return jsonb_build_object('active', false);
  end if;
  if coalesce(p_touch, false) then
    update public.myops_app_sessions set last_activity_at = now() where id = p_session_id;
  end if;
  return jsonb_build_object('active', true, 'user_id', v_session.user_id);
end $$;

create or replace function public.myops_revoke_app_session(p_session_id uuid, p_reason text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_reason text;
begin
  v_reason := case when p_reason = 'entitlement_revoked' then 'entitlement_revoked'
    when p_reason = 'entitlement_denied' then 'entitlement_denied' else 'admin_revoked' end;
  update public.myops_app_sessions set revoked_at = now(), ended_reason = v_reason
    where id = p_session_id and revoked_at is null;
  if found then
    insert into public.myops_app_audit (app_id, event, reason_code)
      select app_id, 'session_revoked', v_reason from public.myops_app_sessions where id = p_session_id;
  end if;
  return found;
end $$;

create or replace function public.myops_revoke_user_app_access(p_user_id uuid, p_reason text)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_ticket_count integer; v_session_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  update public.myops_app_tickets set revoked_at = now()
    where user_id = p_user_id and used_at is null and revoked_at is null;
  get diagnostics v_ticket_count = row_count;
  update public.myops_app_sessions set revoked_at = now(), ended_reason = 'myops_logout'
    where user_id = p_user_id and revoked_at is null;
  get diagnostics v_session_count = row_count;
  if v_ticket_count + v_session_count > 0 then
    insert into public.myops_app_audit (app_id, event, reason_code)
      values (null, 'session_revoked', 'logout');
  end if;
  return v_ticket_count + v_session_count;
end $$;

create or replace function public.myops_check_app_rate_limit(p_key_hash text, p_limit integer, p_window_seconds integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_started timestamptz; v_count integer;
begin
  if p_key_hash !~ '^[a-f0-9]{64}$' or p_limit < 1 or p_limit > 10000
     or p_window_seconds < 1 or p_window_seconds > 3600 then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_key_hash, 0));
  select window_started_at, request_count into v_started, v_count
    from public.myops_app_rate_limits where key_hash = p_key_hash for update;
  if not found then
    insert into public.myops_app_rate_limits (key_hash, window_started_at, request_count)
      values (p_key_hash, now(), 1);
    return true;
  end if;
  if v_started + make_interval(secs => p_window_seconds) <= now() then
    update public.myops_app_rate_limits set window_started_at = now(), request_count = 1, updated_at = now()
      where key_hash = p_key_hash;
    return true;
  end if;
  update public.myops_app_rate_limits set request_count = request_count + 1, updated_at = now()
    where key_hash = p_key_hash returning request_count into v_count;
  if v_count > p_limit then
    if v_count = p_limit + 1 then
      insert into public.myops_app_audit (app_id, event, reason_code)
        values (null, 'rate_limited', 'rate_limit');
    end if;
    return false;
  end if;
  return true;
end $$;

-- Retention. Schedule only after owner approval (for example hourly with pg_cron or a trusted job).
create or replace function public.myops_cleanup_app_access()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_nonces integer; v_rates integer; v_tickets integer; v_audit integer; v_sessions integer;
begin
  delete from public.myops_app_nonces where expires_at <= now();
  get diagnostics v_nonces = row_count;
  delete from public.myops_app_rate_limits where updated_at < now() - interval '1 day';
  get diagnostics v_rates = row_count;
  delete from public.myops_app_tickets where expires_at < now() - interval '1 day';
  get diagnostics v_tickets = row_count;
  delete from public.myops_app_audit where created_at < now() - interval '90 days';
  get diagnostics v_audit = row_count;
  delete from public.myops_app_sessions
    where app_id is not null and (revoked_at < now() - interval '30 days'
      or (revoked_at is null and last_activity_at < now() - interval '30 days'));
  get diagnostics v_sessions = row_count;
  return jsonb_build_object('nonces', v_nonces, 'rate_limits', v_rates, 'tickets', v_tickets,
    'audit', v_audit, 'sessions', v_sessions);
end $$;

-- Promotes the staged next key after the app has deployed it. Old key stops working immediately.
create or replace function public.myops_promote_app_key(p_app_id text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.myops_app_clients
    set public_key_current = public_key_next, public_key_next = null, rotated_at = now()
    where app_id = p_app_id and public_key_next is not null;
  return found;
end $$;

revoke all on function public.myops_get_app_client(text),
  public.myops_issue_app_ticket(uuid,text,text), public.myops_record_app_nonce(text,text),
  public.myops_redeem_app_ticket(text,text), public.myops_validate_app_session(uuid,text,text,boolean),
  public.myops_revoke_app_session(uuid,text), public.myops_revoke_user_app_access(uuid,text),
  public.myops_check_app_rate_limit(text,integer,integer),
  public.myops_cleanup_app_access(), public.myops_promote_app_key(text) from public, anon, authenticated;
grant execute on function public.myops_get_app_client(text),
  public.myops_issue_app_ticket(uuid,text,text), public.myops_record_app_nonce(text,text),
  public.myops_redeem_app_ticket(text,text), public.myops_validate_app_session(uuid,text,text,boolean),
  public.myops_revoke_app_session(uuid,text), public.myops_revoke_user_app_access(uuid,text),
  public.myops_check_app_rate_limit(text,integer,integer),
  public.myops_cleanup_app_access(), public.myops_promote_app_key(text) to service_role;

commit;
