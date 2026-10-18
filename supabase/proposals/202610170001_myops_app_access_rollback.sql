-- Rollback for 202610170001_myops_app_access.sql. NOT EXECUTED. Staging only, owner approval required.
-- Destroys app tickets, nonces, rate limits, audit events and app-session scoping columns.
-- Run only after disabling app clients (update public.myops_app_clients set enabled = false) and
-- confirming no app depends on the endpoints. Phase 2A / Phase 3 objects are not touched.

begin;

select pg_advisory_xact_lock(hashtextextended('myops:rollback:0001', 0));

do $$
declare v_table_exists boolean; v_enabled_clients integer; v_live_sessions integer; v_live_tickets integer;
begin
  select exists (
    select 1 from information_schema.tables where table_schema = 'public' and table_name = 'myops_app_clients'
  ) into v_table_exists;

  if not v_table_exists then
    raise notice 'myops_app_access already rolled back; nothing to do';
    return;
  end if;

  select count(*) into v_enabled_clients from public.myops_app_clients where enabled;
  if v_enabled_clients > 0 then
    raise exception 'rollback blocked: disable all app clients before removing app access';
  end if;

  select count(*) into v_live_sessions from public.myops_app_sessions where revoked_at is null;
  if v_live_sessions > 0 then
    raise exception 'rollback blocked: active app sessions remain; revoke them before teardown';
  end if;

  select count(*) into v_live_tickets from public.myops_app_tickets where used_at is null and revoked_at is null;
  if v_live_tickets > 0 then
    raise exception 'rollback blocked: outstanding app tickets remain; revoke them before teardown';
  end if;

  -- Remove any remaining app-scoped records before dropping their columns or tables.
  update public.myops_app_sessions
  set revoked_at = now(), ended_reason = coalesce(ended_reason, 'admin_revoked')
  where revoked_at is null;

  update public.myops_app_tickets
  set revoked_at = now()
  where used_at is null and revoked_at is null;

  drop function if exists public.myops_get_app_client(text);
  drop function if exists public.myops_issue_app_ticket(uuid, text, text);
  drop function if exists public.myops_record_app_nonce(text, text);
  drop function if exists public.myops_redeem_app_ticket(text, text);
  drop function if exists public.myops_validate_app_session(uuid, text, text, boolean);
  drop function if exists public.myops_revoke_app_session(uuid, text);
  drop function if exists public.myops_revoke_user_app_access(uuid, text);
  drop function if exists public.myops_check_app_rate_limit(text, integer, integer);
  drop function if exists public.myops_cleanup_app_access();
  drop function if exists public.myops_promote_app_key(text);

  -- App-scoped sessions cannot exist without their client; remove them before dropping the columns.
  delete from public.myops_app_sessions where app_id is not null;
  drop index if exists public.myops_app_sessions_active_user_idx;
  alter table public.myops_app_sessions
    drop column if exists app_id,
    drop column if exists product_slug,
    drop column if exists ended_reason;

  drop table if exists public.myops_app_audit;
  drop table if exists public.myops_app_rate_limits;
  drop table if exists public.myops_app_nonces;
  drop table if exists public.myops_app_tickets;
  drop table if exists public.myops_app_clients;
end $$;

commit;
