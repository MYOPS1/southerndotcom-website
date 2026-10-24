-- MYOPS Phase 2A foundation (DRAFT, not applied to production).
-- Review with existing Supabase projects and run in staging only after approval.
-- The service backend owns all writes. No public/anon client write policies.
begin;

create extension if not exists pgcrypto;

create table if not exists public.myops_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  account_type text not null check (account_type in ('personal','business')),
  created_at timestamptz not null default now()
);

create table if not exists public.myops_organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  owner_user_id uuid not null references auth.users(id),
  tier text not null default 'basic' check (tier in ('basic','pro','enterprise')),
  seat_limit integer not null default 5 check (seat_limit > 0),
  created_at timestamptz not null default now(),
  constraint myops_tier_seats check (
    (tier = 'basic' and seat_limit = 5) or
    (tier = 'pro' and seat_limit = 20) or
    (tier = 'enterprise' and seat_limit >= 1)
  )
);

create table if not exists public.myops_memberships (
  organization_id uuid not null references public.myops_organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('admin','manager','staff')),
  status text not null default 'invited' check (status in ('invited','active','suspended')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table if not exists public.myops_products (
  slug text primary key,
  display_name text not null,
  launch_status text not null check (launch_status in ('live','coming_soon'))
);

insert into public.myops_products (slug, display_name, launch_status)
values
  ('opsp','OpsPS','live'),
  ('opsfinance','OpsFinance','live'),
  ('opsflow','OpsFlow','live'),
  ('opswms','OpsWMS','coming_soon'),
  ('opshr','OpsHR','coming_soon')
on conflict (slug) do nothing;
-- NOTE: 'live' here is a catalog flag only, not a declaration of production readiness.

create table if not exists public.myops_subscriptions (
  id uuid primary key default gen_random_uuid(),
  personal_user_id uuid references auth.users(id),
  organization_id uuid references public.myops_organizations(id),
  product_slug text references public.myops_products(slug),
  is_complete_bundle boolean not null default false,
  status text not null default 'pending' check (status in ('pending','active','past_due','canceled','expired')),
  renewal_mode text not null default 'manual' check (renewal_mode in ('manual','auto')),
  current_period_end timestamptz,
  gateway_reference text,
  created_at timestamptz not null default now(),
  constraint myops_one_subscriber check ((personal_user_id is null) <> (organization_id is null)),
  constraint myops_product_or_bundle check ((product_slug is null) <> is_complete_bundle)
);

create table if not exists public.myops_app_grants (
  organization_id uuid not null,
  user_id uuid not null,
  product_slug text not null references public.myops_products(slug),
  primary key (organization_id, user_id, product_slug),
  foreign key (organization_id,user_id) references public.myops_memberships(organization_id,user_id) on delete cascade
);

create table if not exists public.myops_app_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  last_activity_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists myops_sessions_user_idx on public.myops_app_sessions(user_id);
create index if not exists myops_subs_personal_idx on public.myops_subscriptions(personal_user_id);
create index if not exists myops_subs_org_idx on public.myops_subscriptions(organization_id);

alter table public.myops_profiles enable row level security;
alter table public.myops_organizations enable row level security;
alter table public.myops_memberships enable row level security;
alter table public.myops_products enable row level security;
alter table public.myops_subscriptions enable row level security;
alter table public.myops_app_grants enable row level security;
alter table public.myops_app_sessions enable row level security;

-- Explicit grants are read-only. All provisioning/changes must use a trusted backend.
create policy "myops_profile_self_read" on public.myops_profiles
  for select to authenticated using (user_id = (select auth.uid()));
create policy "myops_membership_self_read" on public.myops_memberships
  for select to authenticated using (user_id = (select auth.uid()));
create policy "myops_organization_member_read" on public.myops_organizations
  for select to authenticated using (
    exists (select 1 from public.myops_memberships m
            where m.organization_id = id and m.user_id = (select auth.uid()) and m.status = 'active')
  );
create policy "myops_product_catalog_read" on public.myops_products
  for select to authenticated using (true);
create policy "myops_personal_subscription_read" on public.myops_subscriptions
  for select to authenticated using (
    personal_user_id = (select auth.uid())
    or exists (
      select 1 from public.myops_memberships m
      where m.organization_id = myops_subscriptions.organization_id
        and m.user_id = (select auth.uid()) and m.status = 'active' and m.role = 'admin'
    )
  );
create policy "myops_grant_self_read" on public.myops_app_grants
  for select to authenticated using (user_id = (select auth.uid()));
-- No direct session read/write policies: server controls inactivity and revocation.

commit;
