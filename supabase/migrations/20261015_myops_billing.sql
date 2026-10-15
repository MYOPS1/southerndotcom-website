-- MYOPS billing schema v1. Apply to a reviewed Supabase staging project first.
-- Isolated schema avoids collisions with OpsFinance's accounting tables.
create schema if not exists myops_billing;
create table if not exists myops_billing.plans (
 id text primary key, amount_sen integer not null check(amount_sen > 0),
 currency text not null default 'MYR' check(currency = 'MYR'),
 active boolean not null default true
);
insert into myops_billing.plans(id,amount_sen) values
 ('starter',990),('single',1990),('duo',2990),('complete',3990)
on conflict(id) do update set amount_sen=excluded.amount_sen;
create table if not exists myops_billing.orders (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id),
 plan_id text not null references myops_billing.plans(id),
 amount_sen integer not null check(amount_sen > 0),
 currency text not null default 'MYR' check(currency = 'MYR'),
 status text not null default 'pending' check(status in ('pending','paid','failed','expired','refunded')),
 provider_bill_code text unique,
 created_at timestamptz not null default now(),
 paid_at timestamptz
);
create index if not exists myops_billing_orders_user on myops_billing.orders(user_id,created_at desc);
create table if not exists myops_billing.payment_events (
 id bigint generated always as identity primary key,
 order_id uuid not null references myops_billing.orders(id),
 event_fingerprint text not null unique,
 provider_ref text,
 status text not null,
 received_at timestamptz not null default now()
);
create table if not exists myops_billing.subscriptions (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id),
 order_id uuid not null unique references myops_billing.orders(id),
 plan_id text not null references myops_billing.plans(id),
 valid_from timestamptz not null,
 valid_until timestamptz not null,
 status text not null default 'active' check(status in ('active','expired','cancelled')),
 check(valid_until > valid_from)
);
create index if not exists myops_billing_subscriptions_user on myops_billing.subscriptions(user_id,valid_until desc);
-- Do not expose payment tables to browser roles.
revoke all on schema myops_billing from public, anon, authenticated;
revoke all on all tables in schema myops_billing from public, anon, authenticated;
alter table myops_billing.orders enable row level security;
alter table myops_billing.payment_events enable row level security;
alter table myops_billing.subscriptions enable row level security;
alter table myops_billing.plans enable row level security;
-- Only backend secret/service role can read/write; no public policies.
