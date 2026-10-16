-- REVIEW ONLY. Not a runnable migration until owner approval and staging tests.
-- Assumes the Phase 2A schema matches the live catalog. Do not apply to other projects.
-- No subscription, app-grant or session writes are authorized here.
begin;

-- Explicit onboarding after email confirmation avoids a failing auth.users trigger.
-- Account type is a label, never an entitlement or organization role.
create function public.myops_complete_profile(p_display_name text, p_account_type text)
returns public.myops_profiles
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.myops_profiles;
begin
  if v_uid is null or not exists (
    select 1 from auth.users where id = v_uid and email_confirmed_at is not null
  ) then raise exception 'Confirmed email required' using errcode = '42501'; end if;
  if p_account_type is null or p_account_type not in ('personal', 'business')
     or p_display_name is null or length(trim(p_display_name)) not between 1 and 120 then
    raise exception 'Invalid profile' using errcode = '22023';
  end if;
  insert into public.myops_profiles(user_id, display_name, account_type)
  values (v_uid, trim(p_display_name), p_account_type)
  on conflict (user_id) do nothing;
  select * into v_profile from public.myops_profiles where user_id = v_uid;
  if v_profile.account_type <> p_account_type then
    raise exception 'Account type already set' using errcode = '22023';
  end if;
  return v_profile;
end;
$$;

-- Proposed product decision: one owned organization per business identity.
-- Owner occupies one Basic seat. No user-selected paid tier or seat limit.
create function public.myops_create_organization(p_name text)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_id uuid;
begin
  if v_uid is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  -- Serializes concurrent organization creation by the same identity.
  perform 1 from auth.users where id = v_uid and email_confirmed_at is not null for update;
  if not found or not exists (
    select 1 from public.myops_profiles where user_id = v_uid and account_type = 'business'
  ) then raise exception 'Confirmed business profile required' using errcode = '42501'; end if;
  if p_name is null or length(trim(p_name)) not between 1 and 160 then
    raise exception 'Invalid organization name' using errcode = '22023';
  end if;
  if exists (select 1 from public.myops_organizations where owner_user_id = v_uid) then
    raise exception 'Organization already exists' using errcode = '23505';
  end if;
  insert into public.myops_organizations(name, owner_user_id, tier, seat_limit)
    values (trim(p_name), v_uid, 'basic', 5) returning id into v_id;
  insert into public.myops_memberships(organization_id, user_id, role, status)
    values (v_id, v_uid, 'admin', 'active');
  return v_id;
end;
$$;

-- Preparation for invitations to existing confirmed staging identities only.
-- Email lookup/delivery, new-user invitations, removal and admin promotion are NOT implemented.
create function public.myops_invite_member(p_organization_id uuid, p_user_id uuid, p_role text)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_limit integer; v_used bigint;
begin
  -- All membership writers must take this same organization lock.
  select seat_limit into v_limit from public.myops_organizations
    where id = p_organization_id for update;
  if not found or auth.uid() is null or not exists (
    select 1 from public.myops_memberships where organization_id = p_organization_id
      and user_id = auth.uid() and role = 'admin' and status = 'active'
  ) then raise exception 'Not authorized' using errcode = '42501'; end if;
  if p_role is null or p_role not in ('manager', 'staff') then
    raise exception 'Invalid invitation role' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users where id = p_user_id and email_confirmed_at is not null) then
    raise exception 'Invitation unavailable' using errcode = '22023';
  end if;
  if exists (select 1 from public.myops_memberships
    where organization_id = p_organization_id and user_id = p_user_id) then
    raise exception 'Membership already exists' using errcode = '23505';
  end if;
  -- Pending invitations reserve seats. Suspended seats do not count;
  -- reactivation must use the same lock and recheck capacity in a future function.
  select count(*) into v_used from public.myops_memberships
    where organization_id = p_organization_id and status in ('invited', 'active');
  if v_used >= v_limit then raise exception 'Seat limit reached' using errcode = '23514'; end if;
  insert into public.myops_memberships(organization_id, user_id, role, status)
    values (p_organization_id, p_user_id, p_role, 'invited');
end;
$$;

create function public.myops_accept_invitation(p_organization_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_limit integer; v_used bigint;
begin
  select seat_limit into v_limit from public.myops_organizations
    where id = p_organization_id for update;
  if not found or auth.uid() is null or not exists (
    select 1 from auth.users where id = auth.uid() and email_confirmed_at is not null
  ) then raise exception 'Not authorized' using errcode = '42501'; end if;
  select count(*) into v_used from public.myops_memberships
    where organization_id = p_organization_id and status in ('invited', 'active');
  if v_used > v_limit then raise exception 'Seat limit exceeded' using errcode = '23514'; end if;
  update public.myops_memberships set status = 'active'
    where organization_id = p_organization_id and user_id = auth.uid() and status = 'invited';
  if not found then raise exception 'Invitation unavailable' using errcode = '42501'; end if;
end;
$$;

revoke all on function public.myops_complete_profile(text,text) from public, anon, authenticated;
revoke all on function public.myops_create_organization(text) from public, anon, authenticated;
revoke all on function public.myops_invite_member(uuid,uuid,text) from public, anon, authenticated;
revoke all on function public.myops_accept_invitation(uuid) from public, anon, authenticated;
grant execute on function public.myops_complete_profile(text,text) to authenticated;
grant execute on function public.myops_create_organization(text) to authenticated;
grant execute on function public.myops_invite_member(uuid,uuid,text) to authenticated;
grant execute on function public.myops_accept_invitation(uuid) to authenticated;

-- No new table policies; preserve existing RLS. Verify existing grants and all
-- alternate writers before enabling these narrow SECURITY DEFINER entry points.
commit;
