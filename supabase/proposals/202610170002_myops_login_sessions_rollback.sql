-- Rollback for 202610170002_myops_login_sessions.sql. NOT EXECUTED.
-- Restores the 0001 behaviour (tickets and app sessions unbound to a login session).
-- Deploy the application code that does not call the 0002 functions BEFORE running this.
-- Idempotent: safe to run twice.

begin;

select pg_advisory_xact_lock(hashtextextended('myops:rollback:0002', 0));

do $$
declare v_table_exists boolean; v_has_session_login_session_id boolean; v_has_ticket_login_session_id boolean;
begin
  select exists (
    select 1 from information_schema.tables where table_schema = 'public' and table_name = 'myops_login_sessions'
  ) into v_table_exists;

  if not v_table_exists then
    raise notice 'myops_login_sessions already rolled back; nothing to do';
    return;
  end if;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'myops_app_sessions' and column_name = 'login_session_id'
  ) into v_has_session_login_session_id;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'myops_app_tickets' and column_name = 'login_session_id'
  ) into v_has_ticket_login_session_id;

  if v_has_session_login_session_id then
    update public.myops_app_sessions s
    set revoked_at = now(), ended_reason = coalesce(s.ended_reason, 'myops_logout')
    where s.login_session_id is not null and s.revoked_at is null;
  end if;

  if v_has_ticket_login_session_id then
    update public.myops_app_tickets t
    set revoked_at = now()
    where t.login_session_id is not null and t.used_at is null and t.revoked_at is null;
  end if;

  update public.myops_login_sessions
  set revoked_at = coalesce(revoked_at, now()), ended_reason = coalesce(ended_reason, 'admin')
  where revoked_at is null;
end $$;

drop function if exists public.myops_sweep_logins(integer);
drop function if exists public.myops_enqueue_revocation(uuid, uuid, text);
drop function if exists public.myops_login_end_all(uuid, text);
drop function if exists public.myops_login_end(uuid, uuid, text);
drop function if exists public.myops_login_touch(uuid, uuid);
drop function if exists public.myops_login_start(uuid);
drop function if exists public.myops_issue_app_ticket(uuid, text, text, uuid);

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

drop index if exists public.myops_app_tickets_login_idx;
drop index if exists public.myops_app_sessions_login_idx;
alter table public.myops_app_tickets drop column if exists login_session_id;
alter table public.myops_app_sessions drop column if exists login_session_id;
drop table if exists public.myops_revocation_requests;
drop table if exists public.myops_login_sessions;

revoke all on function public.myops_issue_app_ticket(uuid,text,text), public.myops_redeem_app_ticket(text,text),
  public.myops_validate_app_session(uuid,text,text,boolean) from public, anon, authenticated;
grant execute on function public.myops_issue_app_ticket(uuid,text,text), public.myops_redeem_app_ticket(text,text),
  public.myops_validate_app_session(uuid,text,text,boolean) to service_role;

commit;
