import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

// Runs the PROPOSED Phase 3 SQL against a throwaway local PostgreSQL cluster (never Supabase)
// with genuinely concurrent sessions. Skipped when PostgreSQL binaries are not installed.
const run = promisify(execFile);
const binDir = existsSync('/usr/lib/postgresql')
  ? readdirSync('/usr/lib/postgresql').map((v) => `/usr/lib/postgresql/${v}/bin`).find((d) => existsSync(`${d}/initdb`))
  : undefined;
const skip = binDir ? false : 'PostgreSQL binaries not installed';
const PORT = 54329;
let dir; let sock;

const psqlArgs = ['-X', '-A', '-t', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '', '-p', String(PORT), '-U', 'postgres', '-d', 'myops'];
async function sql(query, { role, sub } = {}) {
  const options = [role && `-c role=${role}`, sub && `-c request.jwt.claim.sub=${sub}`].filter(Boolean).join(' ');
  const { stdout } = await run(`${binDir}/psql`, psqlArgs.map((a, i) => (psqlArgs[i - 1] === '-h' ? sock : a)).concat(['-c', query]),
    { env: { ...process.env, PGOPTIONS: options } });
  return stdout.trim();
}
const svc = (query) => sql(query, { role: 'service_role' });
const call = async (query) => JSON.parse(await svc(query));
const q = (value) => `'${String(value).replaceAll("'", "''")}'`;

let counter = 0;
async function newUser({ confirmed = true, type = 'personal' } = {}) {
  const id = (await sql(`insert into auth.users (email, email_confirmed_at) values ('u${++counter}@example.test', ${confirmed ? 'now()' : 'null'}) returning id`)).split('\n')[0];
  if (type) await svc(`select public.myops_provision_profile(${q(id)}, 'Test', ${q(type)})`);
  return id;
}
const order = () => `MYOPS-test-${String(++counter).padStart(6, '0')}${Math.random().toString(36).slice(2, 8)}`;
const bill = () => `b${Math.random().toString(36).slice(2, 10)}`;
async function checkout(user, plan = 'founders_lifetime', product = plan === 'single_app_monthly' ? 'opsp' : null) {
  const ref = order();
  const result = await call(`select public.myops_create_payment(${q(user)}, ${q(plan)}, ${product ? q(product) : 'null'}, ${q(ref)})`);
  if (result.status === 'created') {
    const code = bill();
    assert.equal(await svc(`select public.myops_attach_bill(${q(ref)}, ${q(code)})`), 't');
    return { ...result, ref, code };
  }
  return result;
}
const settle = (p, outcome = 'succeeded', { amount = 2900, event = `${p.code}|${p.ref}|${outcome}` } = {}) => call(
  `select public.myops_settle_payment(${q(p.ref)}, ${q(p.code)}, ${q(`TX-${p.ref}`)}, ${amount}, ${q(outcome)}, ${q(event)})`);
const status = () => call('select public.myops_founders_status()');

before(async () => {
  if (skip) return;
  dir = mkdtempSync(join(tmpdir(), 'myops-pg-'));
  sock = dir;
  execFileSync(`${binDir}/initdb`, ['-D', `${dir}/data`, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], { stdio: 'ignore' });
  execFileSync(`${binDir}/pg_ctl`, ['-D', `${dir}/data`, '-w', '-o', `-p ${PORT} -k ${dir} -c listen_addresses= -c max_connections=300`, '-l', `${dir}/log`, 'start'], { stdio: 'ignore' });
  await run(`${binDir}/createdb`, ['-h', sock, '-p', String(PORT), '-U', 'postgres', 'myops']);
  await sql(`create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema auth; create table auth.users (id uuid primary key default gen_random_uuid(), email text, email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;`);
  const migrations = new URL('../supabase/migrations/', import.meta.url);
  for (const file of readdirSync(migrations).sort()) {
    await run(`${binDir}/psql`, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', String(PORT), '-U', 'postgres', '-d', 'myops', '-f', new URL(file, migrations).pathname]);
  }
  const proposal = new URL('../supabase/proposals/phase3_founders_100.sql', import.meta.url).pathname;
  await run(`${binDir}/psql`, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', String(PORT), '-U', 'postgres', '-d', 'myops', '-f', proposal]);
  // Supabase grants service_role BYPASSRLS; the stub cluster must match.
  await sql('alter role service_role bypassrls; grant execute on all functions in schema public to service_role');
  await sql('revoke execute on all functions in schema public from public, anon, authenticated');
  await sql('grant execute on function public.myops_founders_status(), public.myops_create_payment(uuid,text,text,text,integer), public.myops_provision_profile(uuid,text,text), public.myops_attach_bill(text,text), public.myops_abort_checkout(text), public.myops_get_payment(text), public.myops_settle_payment(text,text,text,integer,text,text), public.myops_admin_audit(integer) to service_role');
});

after(() => {
  if (skip || !dir) return;
  try { execFileSync(`${binDir}/pg_ctl`, ['-D', `${dir}/data`, '-m', 'immediate', 'stop'], { stdio: 'ignore' }); } catch { /* already stopped */ }
  rmSync(dir, { recursive: true, force: true });
});

test('proposal is idempotent to re-apply and enables RLS on every new table', { skip }, async () => {
  const proposal = new URL('../supabase/proposals/phase3_founders_100.sql', import.meta.url).pathname;
  await run(`${binDir}/psql`, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', String(PORT), '-U', 'postgres', '-d', 'myops', '-f', proposal]);
  const rls = await sql(`select string_agg(relname, ',' order by relname) from pg_class where relname in ('myops_payments','myops_founder_allocations','myops_lifetime_entitlements','myops_payment_events') and relrowsecurity`);
  assert.equal(rls, 'myops_founder_allocations,myops_lifetime_entitlements,myops_payment_events,myops_payments');
});

test('sanity: clients cannot execute functions or read payment tables; entitlement is self-read only', { skip }, async () => {
  const a = await newUser(); const b = await newUser();
  const p = await checkout(a);
  await settle(p);
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(sql('select public.myops_founders_status()', { role }), /permission denied/);
    await assert.rejects(sql(`select public.myops_settle_payment('x','y','z',2900,'succeeded','k')`, { role }), /permission denied/);
    await assert.rejects(sql('select * from public.myops_payments', { role }), /permission denied/);
    await assert.rejects(sql('select * from public.myops_founder_allocations', { role }), /permission denied/);
    await assert.rejects(sql('select * from public.myops_payment_events', { role }), /permission denied/);
  }
  await assert.rejects(sql(`insert into public.myops_lifetime_entitlements (user_id, scope, source, payment_id) values (${q(b)}, 'all_apps', 'founders_100', gen_random_uuid())`, { role: 'authenticated', sub: b }), /permission denied/);
  assert.equal(await sql('select count(*) from public.myops_lifetime_entitlements', { role: 'authenticated', sub: a }), '1');
  assert.equal(await sql('select count(*) from public.myops_lifetime_entitlements', { role: 'authenticated', sub: b }), '0');
});

test('free lifetimes are impossible: entitlements require a payment row', { skip }, async () => {
  const user = await newUser();
  await assert.rejects(sql(`insert into public.myops_lifetime_entitlements (user_id, scope, source, payment_id) values (${q(user)}, 'all_apps', 'founders_100', gen_random_uuid())`), /violates foreign key/);
  await assert.rejects(sql(`insert into public.myops_founder_allocations (slot_number, user_id, payment_id) values (101, ${q(user)}, gen_random_uuid())`), /violates check constraint/);
});

test('unconfirmed users, bad plans and the monthly plan while slots remain are refused', { skip }, async () => {
  const unconfirmed = await newUser({ confirmed: false });
  assert.equal((await checkout(unconfirmed)).status, 'unconfirmed_user');
  const user = await newUser();
  await assert.rejects(call(`select public.myops_create_payment(${q(user)}, 'free_forever', null, ${q(order())})`), /invalid plan/);
  assert.equal((await checkout(user, 'single_app_monthly')).status, 'founders_available');
});

test('duplicate and concurrent checkout clicks reuse one pending payment and one reservation', { skip }, async () => {
  const user = await newUser();
  const before = await status();
  const results = await Promise.all(Array.from({ length: 8 }, () => checkout(user)));
  assert.equal(results.filter((r) => r.status === 'created').length, 1);
  assert.ok(results.filter((r) => r.status !== 'created').every((r) => r.status === 'existing'));
  assert.equal((await status()).reserved, before.reserved + 1);
  const pending = results.find((r) => r.status === 'created');
  await settle(pending, 'failed');
});

test('failure and cancellation release the reservation and never grant access', { skip }, async () => {
  const before = await status();
  for (const outcome of ['failed', 'canceled']) {
    const user = await newUser();
    const p = await checkout(user);
    assert.equal((await status()).reserved, before.reserved + 1);
    assert.equal((await settle(p, outcome)).status, outcome);
    assert.deepEqual(await status(), before);
    assert.equal(await svc(`select count(*) from public.myops_lifetime_entitlements where user_id = ${q(user)}`), '0');
  }
});

test('abort of a checkout whose gateway bill failed releases the slot', { skip }, async () => {
  const user = await newUser();
  const before = await status();
  const ref = order();
  assert.equal((await call(`select public.myops_create_payment(${q(user)}, 'founders_lifetime', null, ${q(ref)})`)).status, 'created');
  assert.equal(await svc(`select public.myops_abort_checkout(${q(ref)})`), 't');
  assert.deepEqual(await status(), before);
});

test('wrong amount and wrong bill never grant; unknown orders are inert', { skip }, async () => {
  const user = await newUser();
  const p = await checkout(user);
  assert.equal((await settle(p, 'succeeded', { amount: 100, event: 'amt-1' })).status, 'amount_mismatch');
  assert.equal((await call(`select public.myops_settle_payment(${q(p.ref)}, 'otherbill', 'T', 2900, 'succeeded', 'bill-1')`)).status, 'bill_mismatch');
  assert.equal((await call(`select public.myops_settle_payment('MYOPS-doesnotexist1', 'x', 'T', 2900, 'succeeded', 'unk-1')`)).status, 'unknown_order');
  assert.equal(await svc(`select count(*) from public.myops_lifetime_entitlements where user_id = ${q(user)}`), '0');
  assert.equal((await settle(p)).status, 'settled');
});

test('duplicate and concurrent webhooks settle exactly once; later failure cannot revoke', { skip }, async () => {
  const user = await newUser();
  const p = await checkout(user);
  const results = await Promise.all(Array.from({ length: 12 }, () => settle(p, 'succeeded', { event: `dup-${p.ref}` })));
  assert.equal(results.filter((r) => r.status === 'settled').length, 1);
  assert.ok(results.filter((r) => r.status !== 'settled').every((r) => r.status === 'already_settled' && r.duplicate));
  assert.equal(await svc(`select count(*) from public.myops_founder_allocations where user_id = ${q(user)}`), '1');
  assert.equal(await svc(`select count(*) from public.myops_lifetime_entitlements where user_id = ${q(user)} and status = 'active'`), '1');
  assert.equal(await svc(`select duplicate_count from public.myops_payment_events where event_key = ${q(`dup-${p.ref}`)}`), '11');
  assert.equal((await settle(p, 'failed')).status, 'already_settled');
  assert.equal(await svc(`select count(*) from public.myops_lifetime_entitlements where user_id = ${q(user)} and status = 'active'`), '1');
  assert.equal((await checkout(user)).status, 'already_lifetime');
});

test('150 concurrent customers: exactly 100 reservations, 100 distinct slots, nobody beyond 100', { skip }, async () => {
  const existing = await status();
  const users = await Promise.all(Array.from({ length: 150 }, () => newUser()));
  const attempts = await Promise.all(users.map((user) => checkout(user)));
  const created = attempts.filter((a) => a.status === 'created');
  assert.equal(created.length, 100 - existing.allocated - existing.reserved);
  assert.ok(attempts.filter((a) => a.status !== 'created').every((a) => ['sold_out', 'reserved_out'].includes(a.status)));
  assert.equal((await status()).remaining, 0);
  const settled = await Promise.all(created.map((p) => settle(p)));
  assert.ok(settled.every((r) => r.status === 'settled' && r.outcome === 'founder_allocated'));
  const final = await status();
  assert.equal(final.allocated, 100);
  assert.equal(final.remaining, 0);
  assert.equal(await svc('select count(distinct slot_number) from public.myops_founder_allocations'), '100');
  assert.equal(await svc('select min(slot_number) || \'-\' || max(slot_number) from public.myops_founder_allocations'), '1-100');
  assert.equal(await svc('select count(*) from public.myops_lifetime_entitlements where status = \'active\''), '100');
  const next = await newUser();
  assert.equal((await checkout(next)).status, 'sold_out');
  await assert.rejects(sql(`insert into public.myops_founder_allocations (slot_number, user_id, payment_id) values (101, ${q(next)}, gen_random_uuid())`), /violates check constraint/);
});

test('after 100: RM29/month covers exactly ONE app, once per payment, and renewals extend it', { skip }, async () => {
  const user = await newUser();
  const p = await checkout(user, 'single_app_monthly', 'opsp');
  assert.equal(p.status, 'created');
  assert.equal(p.amount_cents, 2900);
  const results = await Promise.all(Array.from({ length: 5 }, () => settle(p, 'succeeded', { event: `m-${p.ref}` })));
  assert.equal(results.filter((r) => r.status === 'settled').length, 1);
  assert.equal(await svc(`select count(*) from public.myops_subscriptions where personal_user_id = ${q(user)} and product_slug = 'opsp' and not is_complete_bundle and status = 'active'`), '1');
  // Never an all-app grant: no bundle row, no lifetime entitlement, no other app.
  assert.equal(await svc(`select count(*) from public.myops_subscriptions where personal_user_id = ${q(user)} and (is_complete_bundle or product_slug <> 'opsp')`), '0');
  assert.equal(await svc(`select count(*) from public.myops_lifetime_entitlements where user_id = ${q(user)}`), '0');
  const first = await svc(`select current_period_end from public.myops_subscriptions where personal_user_id = ${q(user)}`);
  await settle(await checkout(user, 'single_app_monthly', 'opsp'));
  assert.equal(await svc(`select count(*) from public.myops_subscriptions where personal_user_id = ${q(user)}`), '1');
  assert.equal(await svc(`select current_period_end > ${q(first)}::timestamptz from public.myops_subscriptions where personal_user_id = ${q(user)}`), 't');
  // A second app is a separate payment and a separate subscription.
  await settle(await checkout(user, 'single_app_monthly', 'opsfinance'));
  assert.equal(await svc(`select string_agg(product_slug, ',' order by product_slug) from public.myops_subscriptions where personal_user_id = ${q(user)}`), 'opsfinance,opsp');
});

test('duplicate single-app checkouts for the same app reuse one pending payment', { skip }, async () => {
  const user = await newUser();
  const results = await Promise.all(Array.from({ length: 6 }, () => checkout(user, 'single_app_monthly', 'opsflow')));
  assert.equal(results.filter((r) => r.status === 'created').length, 1);
  assert.ok(results.filter((r) => r.status !== 'created').every((r) => r.status === 'existing'));
});

test('single-app needs a live catalog app; coming-soon and unknown apps are refused', { skip }, async () => {
  const user = await newUser();
  assert.equal((await checkout(user, 'single_app_monthly', 'opswms')).status, 'invalid_product');
  assert.equal((await checkout(user, 'single_app_monthly', 'nope')).status, 'invalid_product');
  await assert.rejects(checkout(user, 'single_app_monthly', null), /invalid product/);
  await assert.rejects(checkout(user, 'founders_lifetime', 'opsp'), /invalid product/);
});

test('proposed plans (RM49 two-app, RM79 all-app, Business tiers) are disabled', { skip }, async () => {
  const user = await newUser();
  for (const plan of ['two_app_monthly', 'all_apps_monthly', 'business_basic', 'business_pro', 'enterprise']) {
    assert.equal((await checkout(user, plan, null)).status, 'plan_disabled', plan);
  }
  assert.equal(await svc(`select string_agg(code || ':' || coalesce(price_cents::text, '-') || ':' || enabled, ',' order by code) from public.myops_plans`),
    'all_apps_monthly:7900:false,business_basic:-:false,business_pro:-:false,enterprise:-:false,founders_lifetime:2900:true,single_app_monthly:2900:true,two_app_monthly:4900:false');
  assert.equal(await svc(`select seat_limit from public.myops_plans where code = 'business_basic'`) + await svc(`select seat_limit from public.myops_plans where code = 'business_pro'`), '520');
  await assert.rejects(sql(`update public.myops_plans set enabled = true where code = 'business_basic'`, { role: 'authenticated' }), /permission denied/);
  await assert.rejects(sql(`update public.myops_plans set enabled = true where code = 'enterprise'`), /myops_plan_enabled_needs_price/);
});

test('eligibility is the server-owned profile: Business and unprovisioned accounts cannot buy', { skip }, async () => {
  const business = await newUser({ type: 'business' });
  const none = await newUser({ type: null });
  assert.equal((await checkout(business)).status, 'not_eligible');
  assert.equal((await checkout(none)).status, 'not_eligible');
  // Insert-only: provisioning again cannot flip a Business profile to Individual.
  assert.equal(await svc(`select public.myops_provision_profile(${q(business)}, 'X', 'personal')`), 'f');
  assert.equal((await checkout(business)).status, 'not_eligible');
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(sql(`select public.myops_provision_profile(${q(none)}, 'X', 'personal')`, { role }), /permission denied/);
    await sql(`update public.myops_profiles set account_type = 'personal' where user_id = ${q(business)}`, { role, sub: business }).catch(() => {});
    assert.equal(await svc(`select account_type from public.myops_profiles where user_id = ${q(business)}`), 'business');
  }
});

test('a founder payment confirmed after the places are gone is flagged for refund review, never converted', { skip }, async () => {
  // Cluster is full (100 allocated). Backdate a pending founder payment's reservation.
  const user = await newUser();
  const ref = order(); const code = bill();
  await sql(`insert into public.myops_payments (order_ref, user_id, plan, amount_cents, reserved_until, gateway_bill_code) values (${q(ref)}, ${q(user)}, 'founders_lifetime', 2900, now() - interval '1 hour', ${q(code)})`);
  const result = await settle({ ref, code });
  assert.equal(result.status, 'settled');
  assert.equal(result.outcome, 'founder_late_refund_review');
  assert.equal(await svc(`select count(*) from public.myops_lifetime_entitlements where user_id = ${q(user)}`), '0');
  assert.equal(await svc(`select count(*) from public.myops_subscriptions where personal_user_id = ${q(user)}`), '0');
  assert.equal((await status()).allocated, 100);
  assert.ok((await call('select public.myops_admin_audit(500)')).payments.some((x) => x.order_ref === ref && x.outcome === 'founder_late_refund_review'));
});

test('admin audit returns payments, allocations, entitlements and events, bounded by limit', { skip }, async () => {
  const audit = await call('select public.myops_admin_audit(5)');
  assert.equal(audit.founders.allocated, 100);
  assert.equal(audit.payments.length, 5);
  assert.equal(audit.allocations.length, 5);
  assert.equal(audit.entitlements.length, 5);
  assert.ok(audit.events.length > 0);
  assert.ok(!JSON.stringify(audit).includes('@'), 'no emails in audit output');
  assert.equal((await call('select public.myops_admin_audit(100000)')).payments.length, 500 > 0 ? (await call('select public.myops_admin_audit(500)')).payments.length : 0);
});

// Reads the proposal text once so a regression in grants is caught even if PG is unavailable.
test('proposal file keeps service_role-only grants and no client write policies', () => {
  const text = readFileSync(new URL('../supabase/proposals/phase3_founders_100.sql', import.meta.url), 'utf8');
  assert.match(text, /to service_role;/);
  assert.doesNotMatch(text, /grant execute[^;]*to[^;]*(anon|authenticated|public)/i);
  assert.doesNotMatch(text, /create policy[^;]*for (insert|update|delete|all)/i);
  assert.equal((text.match(/security definer set search_path = ''/g) || []).length, (text.match(/create or replace function/g) || []).length);
});
