-- S1-B durable login-session binding proposal. NOT EXECUTED.
-- Requires 202610170001_myops_app_access.sql (and the Phase 2A / Phase 3 schemas) first.
-- Apply in staging only after independent security review and owner approval.
-- Validity is derived from stored timestamps, so expiry never depends on a revocation event or on
-- the browser returning. No scheduler is created by this file.

begin;

create table if not exists public.myops_login_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  revoked_at timestamptz,
  ended_reason text check (ended_reason in ('logout','password_reset','inactivity','absolute','admin','swept'))
);
create index if not exists myops_login_sessions_user_idx
  on public.myops_login_sessions(user_id) where revoked_at is null;
create index if not exists myops_login_sessions_activity_idx
  on public.myops_login_sessions(last_activity_at) where revoked_at is null;

create table if not exists public.myops_revocation_requests (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  login_session_id uuid references public.myops_login_sessions(id) on delete cascade,
  reason text not null check (reason in ('logout','password_reset','inactivity','admin')),
  created_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_attempt_at timestamptz,
  completed_at timestamptz
);
create unique index if not exists myops_revocation_requests_open_idx
  on public.myops_revocation_requests (user_id, coalesce(login_session_id, '00000000-0000-0000-0000-000000000000'::uuid), reason)
  where completed_at is null;

alter table public.myops_app_tickets
  add column if not exists login_session_id uuid references public.myops_login_sessions(id) on delete cascade;
alter table public.myops_app_sessions
  add column if not exists login_session_id uuid references public.myops_login_sessions(id) on delete cascade;
create index if not exists myops_app_tickets_login_idx on public.myops_app_tickets(login_session_id);
create index if not exists myops_app_sessions_login_idx on public.myops_app_sessions(login_session_id);

alter table public.myops_login_sessions enable row level security;
alter table public.myops_revocation_requests enable row level security;
revoke all on public.myops_login_sessions, public.myops_revocation_requests from public, anon, authenticated;

-- Live = not revoked, active within 15 minutes, created within 12 hours, and owned by the user.
create or replace function public.myops_login_live(p_id uuid, p_user_id uuid)
returns boolean language sql security definer set search_path = '' stable as $$
  select coalesce((select true from public.myops_login_sessions
    where id = p_id and user_id = p_user_id and revoked_at is null
      and last_activity_at > now() - interval '15 minutes'
      and created_at > now() - interval '12 hours'), false);
$$;

-- At most 10 concurrent login sessions per user; the oldest are revoked.
create or replace function public.myops_login_start(p_user_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  update public.myops_login_sessions set revoked_at = now(), ended_reason = 'swept'
    where id in (select id from public.myops_login_sessions
      where user_id = p_user_id and revoked_at is null order by created_at desc offset 9);
  insert into public.myops_login_sessions (user_id) values (p_user_id) returning id into v_id;
  return v_id;
end $$;

-- Activity is written at most every 30 seconds. Returns false when the session is not live.
create or replace function public.myops_login_touch(p_id uuid, p_user_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not public.myops_login_live(p_id, p_user_id) then return false; end if;
  update public.myops_login_sessions set last_activity_at = now()
    where id = p_id and user_id = p_user_id and revoked_at is null
      and last_activity_at < now() - interval '30 seconds';
  return true;
end $$;

-- Idempotent. Ending a login session invalidates its tickets and app sessions.
create or replace function public.myops_login_end(p_id uuid, p_user_id uuid, p_reason text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_reason text := case when p_reason in ('logout','password_reset','inactivity','absolute','admin') then p_reason else 'admin' end;
begin
  update public.myops_login_sessions
    set revoked_at = coalesce(revoked_at, now()), ended_reason = coalesce(ended_reason, v_reason)
    where id = p_id and user_id = p_user_id;
  update public.myops_app_tickets set revoked_at = now()
    where login_session_id = p_id and user_id = p_user_id and used_at is null and revoked_at is null;
  update public.myops_app_sessions set revoked_at = now(), ended_reason = 'myops_logout'
    where login_session_id = p_id and user_id = p_user_id and revoked_at is null;
  update public.myops_revocation_requests set completed_at = now()
    where user_id = p_user_id and login_session_id = p_id and completed_at is null;
  return true;
end $$;

-- All login sessions plus legacy unbound tickets/app sessions of the user (password reset, admin, cookie retry).
create or replace function public.myops_login_end_all(p_user_id uuid, p_reason text)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  update public.myops_login_sessions set revoked_at = now(),
      ended_reason = case when p_reason in ('logout','password_reset','inactivity','absolute','admin') then p_reason else 'admin' end
    where user_id = p_user_id and revoked_at is null;
  get diagnostics v_count = row_count;
  perform public.myops_revoke_user_app_access(p_user_id, p_reason);
  update public.myops_revocation_requests set completed_at = now()
    where user_id = p_user_id and completed_at is null;
  return v_count;
end $$;

create or replace function public.myops_enqueue_revocation(p_user_id uuid, p_login_session_id uuid, p_reason text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  insert into public.myops_revocation_requests (user_id, login_session_id, reason)
    values (p_user_id, p_login_session_id,
      case when p_reason in ('logout','password_reset','inactivity','admin') then p_reason else 'admin' end)
    on conflict do nothing;
  return true;
end $$;

-- Tickets now require a live parent login session owned by the same user.
drop function if exists public.myops_issue_app_ticket(uuid, text, text);
create or replace function public.myops_issue_app_ticket(p_user_id uuid, p_product_slug text, p_ticket_hash text, p_login_session_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_ticket_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid ticket hash' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  if p_login_session_id is null or not public.myops_login_live(p_login_session_id, p_user_id) then
    return jsonb_build_object('status', 'unavailable');
  end if;
  if not exists (
    select 1 from public.myops_app_clients c
    join public.myops_products p on p.slug = c.product_slug
    where c.product_slug = p_product_slug and c.enabled and p.launch_status = 'live'
  ) then
    return jsonb_build_object('status', 'unavailable');
  end if;
  insert into public.myops_app_tickets (ticket_hash, user_id, product_slug, expires_at, login_session_id)
  values (p_ticket_hash, p_user_id, p_product_slug, now() + interval '60 seconds', p_login_session_id);
  insert into public.myops_app_audit (app_id, event, reason_code)
  select c.app_id, 'ticket_issued', 'issued' from public.myops_app_clients c where c.product_slug = p_product_slug;
  return jsonb_build_object('status', 'issued');
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
  if v_ticket.login_session_id is null
     or not public.myops_login_live(v_ticket.login_session_id, v_ticket.user_id) then
    update public.myops_app_tickets set revoked_at = now() where ticket_hash = p_ticket_hash;
    return jsonb_build_object('status', 'denied');
  end if;
  update public.myops_app_tickets set used_at = now() where ticket_hash = p_ticket_hash;
  insert into public.myops_app_sessions (user_id, app_id, product_slug, login_session_id)
    values (v_ticket.user_id, v_client.app_id, v_client.product_slug, v_ticket.login_session_id)
    returning id into v_session;
  insert into public.myops_app_audit (app_id, event, reason_code)
    values (v_client.app_id, 'ticket_redeemed', 'redeemed');
  return jsonb_build_object('status', 'redeemed', 'user_id', v_ticket.user_id,
    'session_id', v_session, 'product_slug', v_ticket.product_slug);
end $$;

-- Validation never extends the login session; polling cannot count as MYOPS user activity.
-- p_touch extends only the app session's own idle timer (app-asserted user activity).
create or replace function public.myops_validate_app_session(p_session_id uuid, p_app_id text, p_product_slug text, p_touch boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session public.myops_app_sessions; v_reason text;
begin
  select * into v_session from public.myops_app_sessions
    where id = p_session_id and app_id = p_app_id and product_slug = p_product_slug for update;
  if not found or v_session.revoked_at is not null then
    return jsonb_build_object('active', false);
  end if;
  if v_session.login_session_id is null
     or not public.myops_login_live(v_session.login_session_id, v_session.user_id) then
    v_reason := 'myops_logout';
  elsif v_session.created_at <= now() - interval '12 hours' then v_reason := 'absolute_expired';
  elsif v_session.last_activity_at <= now() - interval '15 minutes' then v_reason := 'idle_expired';
  end if;
  if v_reason is not null then
    update public.myops_app_sessions set revoked_at = now(), ended_reason = v_reason where id = p_session_id;
    insert into public.myops_app_audit (app_id, event, reason_code)
      values (p_app_id, 'session_revoked',
        case v_reason when 'myops_logout' then 'logout' else v_reason end);
    return jsonb_build_object('active', false);
  end if;
  if coalesce(p_touch, false) then
    update public.myops_app_sessions set last_activity_at = now() where id = p_session_id;
  end if;
  return jsonb_build_object('active', true, 'user_id', v_session.user_id);
end $$;

-- Scheduled cleanup/retry. NOT SCHEDULED by this proposal. Safe to run concurrently (skip locked).
create or replace function public.myops_sweep_logins(p_batch integer default 200)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_expired integer; v_apps integer; v_tickets integer; v_deleted integer;
  v_retried integer := 0; v_failed integer := 0; r record; v_limit integer := greatest(1, least(coalesce(p_batch, 200), 1000));
begin
  with doomed as (
    select id from public.myops_login_sessions
    where revoked_at is null and (last_activity_at <= now() - interval '15 minutes' or created_at <= now() - interval '12 hours')
    order by last_activity_at limit v_limit for update skip locked)
  update public.myops_login_sessions s set revoked_at = now(), ended_reason = 'inactivity'
    from doomed where s.id = doomed.id;
  get diagnostics v_expired = row_count;
  update public.myops_app_sessions a set revoked_at = now(), ended_reason = 'myops_logout'
    where a.revoked_at is null and a.login_session_id is not null
      and exists (select 1 from public.myops_login_sessions s where s.id = a.login_session_id and s.revoked_at is not null);
  get diagnostics v_apps = row_count;
  update public.myops_app_tickets t set revoked_at = now()
    where t.used_at is null and t.revoked_at is null and t.login_session_id is not null
      and exists (select 1 from public.myops_login_sessions s where s.id = t.login_session_id and s.revoked_at is not null);
  get diagnostics v_tickets = row_count;
  for r in select * from public.myops_revocation_requests
      where completed_at is null and attempts < 20
        and (last_attempt_at is null or last_attempt_at < now() - (interval '1 minute' * power(2, least(attempts, 6))))
      order by created_at limit v_limit for update skip locked loop
    begin
      if r.login_session_id is null then perform public.myops_login_end_all(r.user_id, r.reason);
      else perform public.myops_login_end(r.login_session_id, r.user_id, r.reason); end if;
      update public.myops_revocation_requests
        set attempts = attempts + 1, last_attempt_at = now(), completed_at = now() where id = r.id;
      v_retried := v_retried + 1;
    exception when others then
      update public.myops_revocation_requests set attempts = attempts + 1, last_attempt_at = now() where id = r.id;
      v_failed := v_failed + 1;
    end;
  end loop;
  delete from public.myops_login_sessions
    where (revoked_at < now() - interval '30 days')
       or (revoked_at is null and last_activity_at < now() - interval '30 days');
  get diagnostics v_deleted = row_count;
  delete from public.myops_revocation_requests where completed_at < now() - interval '30 days';
  return jsonb_build_object('expired_logins', v_expired, 'revoked_app_sessions', v_apps,
    'revoked_tickets', v_tickets, 'retried', v_retried, 'retry_failed', v_failed, 'deleted_logins', v_deleted);
end $$;

revoke all on function public.myops_login_live(uuid,uuid), public.myops_login_start(uuid),
  public.myops_login_touch(uuid,uuid), public.myops_login_end(uuid,uuid,text),
  public.myops_login_end_all(uuid,text), public.myops_enqueue_revocation(uuid,uuid,text),
  public.myops_issue_app_ticket(uuid,text,text,uuid), public.myops_redeem_app_ticket(text,text),
  public.myops_validate_app_session(uuid,text,text,boolean), public.myops_sweep_logins(integer)
  from public, anon, authenticated;
grant execute on function public.myops_login_live(uuid,uuid), public.myops_login_start(uuid),
  public.myops_login_touch(uuid,uuid), public.myops_login_end(uuid,uuid,text),
  public.myops_login_end_all(uuid,text), public.myops_enqueue_revocation(uuid,uuid,text),
  public.myops_issue_app_ticket(uuid,text,text,uuid), public.myops_redeem_app_ticket(text,text),
  public.myops_validate_app_session(uuid,text,text,boolean), public.myops_sweep_logins(integer)
  to service_role;

commit;
