import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { generateKeyPairSync, randomBytes } from 'node:crypto';

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
const edPem = () => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
const ticketHash = () => randomBytes(32).toString('hex');
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
  const appAccessProposal = new URL('../supabase/proposals/202610170001_myops_app_access.sql', import.meta.url).pathname;
  await run(`${binDir}/psql`, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', String(PORT), '-U', 'postgres', '-d', 'myops', '-f', appAccessProposal]);
  const loginProposal = new URL('../supabase/proposals/202610170002_myops_login_sessions.sql', import.meta.url).pathname;
  await run(`${binDir}/psql`, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', String(PORT), '-U', 'postgres', '-d', 'myops', '-f', loginProposal]);
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

test('S1 app-access proposal has RLS and service_role-only functions', { skip }, async () => {
  const names = ['myops_app_clients', 'myops_app_tickets', 'myops_app_nonces', 'myops_app_rate_limits', 'myops_app_audit'];
  const rls = await sql(`select string_agg(relname, ',' order by relname) from pg_class
    where relname = any(array[${names.map(q).join(',')}]) and relrowsecurity`);
  assert.equal(rls, names.sort().join(','));
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(sql(`select public.myops_get_app_client('opsp')`, { role }), /permission denied/);
    await assert.rejects(sql('select * from public.myops_app_tickets', { role }), /permission denied/);
    await assert.rejects(sql(`select public.myops_redeem_app_ticket('opsp', repeat('a',64))`, { role }), /permission denied/);
  }
});

test('S1 tickets are app-bound, expire in 60 seconds, and concurrent redemption consumes once', { skip }, async () => {
  const user = await newUser();
  const key = q(edPem());
  for (const [id, product] of [['opsp', 'opsp'], ['opsfinance', 'opsfinance']]) {
    await sql(`insert into public.myops_app_clients(app_id, product_slug, public_key_current, enabled)
      values (${q(id)}, ${q(product)}, ${key}, true)
      on conflict (app_id) do update set public_key_current = excluded.public_key_current, enabled = true`);
  }
  const validHash = ticketHash();
  assert.equal((await issue(user, 'opsp', validHash)).status, 'issued');
  const lifetime = await sql(`select extract(epoch from (expires_at - created_at))::int from public.myops_app_tickets where ticket_hash = ${q(validHash)}`);
  assert.equal(lifetime, '60');
  const wrongApp = await call(`select public.myops_redeem_app_ticket('opsfinance', ${q(validHash)})`);
  assert.equal(wrongApp.status, 'denied');
  const attempts = await Promise.all([
    call(`select public.myops_redeem_app_ticket('opsp', ${q(validHash)})`),
    call(`select public.myops_redeem_app_ticket('opsp', ${q(validHash)})`),
  ]);
  assert.equal(attempts.filter((result) => result.status === 'redeemed').length, 1);
  assert.equal(attempts.filter((result) => result.status === 'denied').length, 1);
  assert.equal(await svc(`select count(*) from public.myops_app_sessions where user_id = ${q(user)} and app_id = 'opsp'`), '1');
});

test('S1 expired tickets, replayed nonces, rate limits and logout revocation fail closed', { skip }, async () => {
  const user = await newUser();
  const key = q(edPem());
  await sql(`insert into public.myops_app_clients(app_id, product_slug, public_key_current, enabled)
    values ('opsp', 'opsp', ${key}, true)
    on conflict (app_id) do update set public_key_current = excluded.public_key_current, enabled = true`);
  const expiredHash = ticketHash();
  await issue(user, 'opsp', expiredHash);
  await svc(`update public.myops_app_tickets set created_at = now() - interval '2 minutes',
    expires_at = now() - interval '1 minute' where ticket_hash = ${q(expiredHash)}`);
  assert.equal((await call(`select public.myops_redeem_app_ticket('opsp', ${q(expiredHash)})`)).status, 'denied');

  const nonce = ticketHash();
  assert.equal(await svc(`select count(*) from public.myops_app_clients where app_id = 'opsp' and enabled`), '1');
  assert.equal(await svc(`select ${q(nonce)} ~ '^[a-f0-9]{64}$'`), 't');
  const nonceResult = await svc(`select public.myops_record_app_nonce('opsp', ${q(nonce)})`);
  assert.equal(nonceResult, 't', `nonce insert failed; table rows: ${await svc('select count(*) from public.myops_app_nonces')}`);
  assert.equal(await svc(`select public.myops_record_app_nonce('opsp', ${q(nonce)})`), 'f');

  const rateKey = ticketHash();
  assert.equal(await svc(`select public.myops_check_app_rate_limit(${q(rateKey)}, 2, 60)`), 't');
  assert.equal(await svc(`select public.myops_check_app_rate_limit(${q(rateKey)}, 2, 60)`), 't');
  assert.equal(await svc(`select public.myops_check_app_rate_limit(${q(rateKey)}, 2, 60)`), 'f');

  const rawHash = ticketHash();
  await issue(user, 'opsp', rawHash);
  const redeemed = await call(`select public.myops_redeem_app_ticket('opsp', ${q(rawHash)})`);
  assert.equal(redeemed.status, 'redeemed');
  const unusedHash = ticketHash();
  await issue(user, 'opsp', unusedHash);
  assert.ok(await svc(`select public.myops_revoke_user_app_access(${q(user)}, 'myops_logout')`));
  assert.equal((await call(`select public.myops_validate_app_session(${q(redeemed.session_id)}, 'opsp', 'opsp')`)).active, false);
  assert.equal(await svc(`select revoked_at is not null from public.myops_app_tickets where ticket_hash = ${q(unusedHash)}`), 't');
});

test('S1 idle app sessions are revoked after 15 minutes', { skip }, async () => {
  const user = await newUser();
  const key = q(edPem());
  await sql(`insert into public.myops_app_clients(app_id, product_slug, public_key_current, enabled)
    values ('opsp', 'opsp', ${key}, true)
    on conflict (app_id) do update set public_key_current = excluded.public_key_current, enabled = true`);
  const hash = ticketHash();
  await issue(user, 'opsp', hash);
  const redeemed = await call(`select public.myops_redeem_app_ticket('opsp', ${q(hash)})`);
  await svc(`update public.myops_app_sessions set last_activity_at = now() - interval '16 minutes' where id = ${q(redeemed.session_id)}`);
  assert.equal((await call(`select public.myops_validate_app_session(${q(redeemed.session_id)}, 'opsp', 'opsp')`)).active, false);
  assert.equal(await svc(`select ended_reason from public.myops_app_sessions where id = ${q(redeemed.session_id)}`), 'idle_expired');
});

const logins = new Map();
async function loginFor(user) {
  if (!logins.has(user)) logins.set(user, await svc(`select public.myops_login_start(${q(user)})`));
  return logins.get(user);
}
async function issue(user, app, hash, login) {
  return call(`select public.myops_issue_app_ticket(${q(user)}, ${q(app)}, ${q(hash)}, ${q(login ?? await loginFor(user))})`);
}

async function liveSession(user, app = 'opsp') {
  await sql(`insert into public.myops_app_clients(app_id, product_slug, public_key_current, enabled)
    values (${q(app)}, ${q(app)}, ${q(edPem())}, true)
    on conflict (app_id) do update set enabled = true`);
  const hash = ticketHash();
  await issue(user, app, hash);
  return (await call(`select public.myops_redeem_app_ticket(${q(app)}, ${q(hash)})`)).session_id;
}
const validate = (id, touch = false) => call(`select public.myops_validate_app_session(${q(id)}, 'opsp', 'opsp', ${touch})`);

test('regression H-2: validation polling never extends inactivity; asserted activity does', { skip }, async () => {
  const id = await liveSession(await newUser());
  await svc(`update public.myops_app_sessions set last_activity_at = now() - interval '14 minutes' where id = ${q(id)}`);
  assert.equal((await validate(id, false)).active, true);
  const before = await svc(`select extract(epoch from now() - last_activity_at)::int >= 14 * 60 from public.myops_app_sessions where id = ${q(id)}`);
  assert.equal(before, 't', 'polling left last_activity_at unchanged');
  await svc(`update public.myops_app_sessions set last_activity_at = now() - interval '16 minutes' where id = ${q(id)}`);
  assert.equal((await validate(id, false)).active, false, 'idle session stays dead despite polling');
  const second = await liveSession(await newUser());
  await svc(`update public.myops_app_sessions set last_activity_at = now() - interval '14 minutes' where id = ${q(second)}`);
  assert.equal((await validate(second, true)).active, true);
  assert.equal(await svc(`select now() - last_activity_at < interval '1 minute' from public.myops_app_sessions where id = ${q(second)}`), 't');
});

test('regression H-2: sessions expire at the 12-hour absolute limit even with constant activity', { skip }, async () => {
  const id = await liveSession(await newUser());
  await svc(`update public.myops_app_sessions set created_at = now() - interval '11 hours 59 minutes' where id = ${q(id)}`);
  assert.equal((await validate(id, true)).active, true);
  await svc(`update public.myops_app_sessions set created_at = now() - interval '12 hours 1 minute' where id = ${q(id)}`);
  assert.equal((await validate(id, true)).active, false);
  assert.equal(await svc(`select ended_reason from public.myops_app_sessions where id = ${q(id)}`), 'absolute_expired');
  assert.equal((await validate(id, true)).active, false, 'revoked sessions stay revoked');
});

test('regression review: only Ed25519 SPKI keys can be enrolled; keys rotate with promote', { skip }, async () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' });
  await assert.rejects(sql(`insert into public.myops_app_clients(app_id, product_slug, public_key_current)
    values ('opsflow', 'opsflow', ${q(rsa)})`), /check constraint/);
  await assert.rejects(sql(`insert into public.myops_app_clients(app_id, product_slug, public_key_current)
    values ('opsflow', 'opsflow', ${q('-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----')})`), /check constraint/);
  const next = edPem();
  await sql(`insert into public.myops_app_clients(app_id, product_slug, public_key_current, public_key_next, enabled)
    values ('opsfinance', 'opsfinance', ${q(edPem())}, ${q(next)}, true)
    on conflict (app_id) do update set public_key_current = excluded.public_key_current, public_key_next = excluded.public_key_next`);
  assert.equal(await svc(`select public.myops_promote_app_key('opsfinance')`), 't');
  assert.equal(await svc(`select public_key_current = ${q(next)} and public_key_next is null from public.myops_app_clients where app_id = 'opsfinance'`), 't');
  assert.equal(await svc(`select public.myops_promote_app_key('opsfinance')`), 'f');
});

test('regression review: nonces outlive the full timestamp window and cleanup enforces retention', { skip }, async () => {
  const id = await liveSession(await newUser());
  const nonce = ticketHash();
  assert.equal(await svc(`select public.myops_record_app_nonce('opsp', ${q(nonce)})`), 't');
  assert.equal(await svc(`select expires_at - now() > interval '14 minutes' from public.myops_app_nonces where nonce_hash = ${q(nonce)}`), 't');
  const oldKey = ticketHash();
  await svc(`select public.myops_check_app_rate_limit(${q(oldKey)}, 5, 60)`);
  await svc(`update public.myops_app_rate_limits set updated_at = now() - interval '2 days' where key_hash = ${q(oldKey)}`);
  await svc(`update public.myops_app_sessions set revoked_at = now() - interval '31 days' where id = ${q(id)}`);
  const result = await call('select public.myops_cleanup_app_access()');
  assert.ok(result.rate_limits >= 1 && result.sessions >= 1);
  assert.equal(await svc(`select count(*) from public.myops_app_rate_limits where key_hash = ${q(oldKey)}`), '0');
  assert.equal(await svc(`select count(*) from public.myops_app_sessions where id = ${q(id)}`), '0');
  assert.equal(await svc(`select count(*) from public.myops_app_nonces where nonce_hash = ${q(nonce)}`), '1');
  for (const role of ['anon', 'authenticated']) {
    await assert.rejects(sql('select public.myops_cleanup_app_access()', { role }), /permission denied/);
    await assert.rejects(sql(`select public.myops_promote_app_key('opsp')`, { role }), /permission denied/);
  }
});

test('S1 SQL proposal retains pinned search_path and has no client write policies', () => {
  const text = readFileSync(new URL('../supabase/proposals/202610170001_myops_app_access.sql', import.meta.url), 'utf8');
  assert.equal((text.match(/security definer set search_path = ''/g) || []).length, (text.match(/create or replace function/g) || []).length);
  assert.match(text, /grant execute[^;]*to service_role;/s);
  assert.doesNotMatch(text, /create policy[^;]*for (insert|update|delete|all)/i);
  assert.match(text, /NOT EXECUTED/);
  const rollback = readFileSync(new URL('../supabase/proposals/202610170001_myops_app_access_rollback.sql', import.meta.url), 'utf8');
  assert.match(rollback, /NOT EXECUTED/);
  for (const [, name] of text.matchAll(/create or replace function public\.(\w+)/g)) assert.ok(rollback.includes(name), `rollback drops ${name}`);
  for (const [, name] of text.matchAll(/create table if not exists public\.(\w+)/g)) assert.ok(rollback.includes(name), `rollback drops ${name}`);
});

// ---- Durable login-session binding (202610170002) ----
const applyFile = (name) => run(`${binDir}/psql`, ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', sock, '-p', String(PORT), '-U', 'postgres', '-d', 'myops', '-f', new URL(`../supabase/proposals/${name}`, import.meta.url).pathname]);
const ageLogin = (id, minutes, column = 'last_activity_at') => svc(`update public.myops_login_sessions set ${column} = now() - interval '${minutes} minutes' where id = ${q(id)}`);
const live = async (id, user) => (await svc(`select public.myops_login_live(${q(id)}, ${q(user)})`)) === 't';

test('login sessions: ticket issuance requires a live, owned login session', { skip }, async () => {
  const user = await newUser(); const other = await newUser();
  const login = await loginFor(user);
  await liveSession(user);
  assert.equal((await issue(user, 'opsp', ticketHash(), login)).status, 'issued');
  assert.equal((await issue(other, 'opsp', ticketHash(), login)).status, 'unavailable', 'another user cannot use this login');
  assert.equal((await call(`select public.myops_issue_app_ticket(${q(user)}, 'opsp', ${q(ticketHash())}, null)`)).status, 'unavailable');
  assert.equal((await call(`select public.myops_issue_app_ticket(${q(user)}, 'opsp', ${q(ticketHash())}, gen_random_uuid())`)).status, 'unavailable');
  await ageLogin(login, 16);
  assert.equal((await issue(user, 'opsp', ticketHash(), login)).status, 'unavailable', 'idle login cannot issue');
});

test('login sessions: 15-minute idle and 12-hour absolute limits are derived from stored timestamps', { skip }, async () => {
  const user = await newUser();
  const login = await svc(`select public.myops_login_start(${q(user)})`);
  assert.equal(await live(login, user), true);
  await ageLogin(login, 14);
  assert.equal(await live(login, user), true);
  await ageLogin(login, 16);
  assert.equal(await live(login, user), false, 'idle at 16 minutes');
  const second = await svc(`select public.myops_login_start(${q(user)})`);
  await ageLogin(second, 720 + 1, 'created_at');
  assert.equal(await live(second, user), false, 'absolute at 12 hours even though recently active');
  assert.equal(await svc(`select public.myops_login_touch(${q(second)}, ${q(user)})`), 'f');
  assert.equal(await live(login, await newUser()), false, 'ownership mismatch');
});

test('login sessions: touch is throttled to 30 seconds and never revives dead sessions', { skip }, async () => {
  const user = await newUser();
  const login = await svc(`select public.myops_login_start(${q(user)})`);
  const stamp = () => svc(`select last_activity_at::text from public.myops_login_sessions where id = ${q(login)}`);
  const first = await stamp();
  assert.equal(await svc(`select public.myops_login_touch(${q(login)}, ${q(user)})`), 't');
  assert.equal(await stamp(), first, 'touch within 30 seconds does not write');
  await svc(`update public.myops_login_sessions set last_activity_at = now() - interval '31 seconds' where id = ${q(login)}`);
  await svc(`select public.myops_login_touch(${q(login)}, ${q(user)})`);
  assert.equal(await svc(`select now() - last_activity_at < interval '5 seconds' from public.myops_login_sessions where id = ${q(login)}`), 't');
  await ageLogin(login, 20);
  assert.equal(await svc(`select public.myops_login_touch(${q(login)}, ${q(user)})`), 'f');
  assert.equal(await live(login, user), false);
});

test('login sessions: ending one is idempotent and revokes only its own tickets and app sessions', { skip }, async () => {
  const user = await newUser();
  const a = await svc(`select public.myops_login_start(${q(user)})`);
  const b = await svc(`select public.myops_login_start(${q(user)})`);
  const ticketA = ticketHash(); const ticketB = ticketHash();
  assert.equal((await issue(user, 'opsp', ticketA, a)).status, 'issued');
  assert.equal((await issue(user, 'opsp', ticketB, b)).status, 'issued');
  const sessionA = (await call(`select public.myops_redeem_app_ticket('opsp', ${q(ticketA)})`)).session_id;
  const sessionB = (await call(`select public.myops_redeem_app_ticket('opsp', ${q(ticketB)})`)).session_id;
  const unused = ticketHash();
  await issue(user, 'opsp', unused, a);
  assert.equal(await svc(`select public.myops_login_end(${q(a)}, ${q(user)}, 'logout')`), 't');
  assert.equal(await svc(`select public.myops_login_end(${q(a)}, ${q(user)}, 'logout')`), 't', 'repeat is a safe no-op');
  assert.equal((await validate(sessionA)).active, false);
  assert.equal((await validate(sessionB)).active, true, 'other login unaffected');
  assert.equal((await call(`select public.myops_redeem_app_ticket('opsp', ${q(unused)})`)).status, 'denied');
  assert.equal(await svc(`select public.myops_login_end(${q(a)}, ${q(await newUser())}, 'logout')`), 't');
  assert.equal(await live(b, user), true, 'a foreign user id cannot end or disturb a session');
  await svc(`select public.myops_login_end_all(${q(user)}, 'password_reset')`);
  assert.equal((await validate(sessionB)).active, false);
  assert.equal(await live(b, user), false);
  assert.equal(await svc(`select ended_reason from public.myops_login_sessions where id = ${q(b)}`), 'password_reset');
});

test('login sessions: redeem and validate fail closed when the parent login is gone or expired', { skip }, async () => {
  const user = await newUser();
  const login = await loginFor(user);
  const stale = ticketHash();
  await issue(user, 'opsp', stale, login);
  const id = await liveSession(user);
  assert.equal((await validate(id)).active, true);
  await ageLogin(login, 16);
  assert.equal((await call(`select public.myops_redeem_app_ticket('opsp', ${q(stale)})`)).status, 'denied');
  assert.equal(await svc(`select revoked_at is not null from public.myops_app_tickets where ticket_hash = ${q(stale)}`), 't');
  assert.equal((await validate(id, true)).active, false, 'app session dies with its login');
  assert.equal(await svc(`select ended_reason from public.myops_app_sessions where id = ${q(id)}`), 'myops_logout');
  const orphan = await newUser();
  const orphanSession = await liveSession(orphan);
  await svc(`update public.myops_app_sessions set login_session_id = null where id = ${q(orphanSession)}`);
  assert.equal((await validate(orphanSession)).active, false, 'unbound sessions are rejected');
});

test('login sessions: app polling and asserted activity never extend the MYOPS login', { skip }, async () => {
  const user = await newUser();
  const login = await loginFor(user);
  const id = await liveSession(user);
  await svc(`update public.myops_login_sessions set last_activity_at = now() - interval '14 minutes' where id = ${q(login)}`);
  for (const touch of [false, true, true]) assert.equal((await validate(id, touch)).active, true);
  assert.equal(await svc(`select now() - last_activity_at > interval '13 minutes' from public.myops_login_sessions where id = ${q(login)}`), 't');
  await ageLogin(login, 16);
  assert.equal((await validate(id, true)).active, false, 'activity=true cannot keep a dead login alive');
});

test('login sessions: concurrent redeem and logout never leave a usable app session', { skip }, async () => {
  for (let i = 0; i < 5; i += 1) {
    const user = await newUser();
    const login = await svc(`select public.myops_login_start(${q(user)})`);
    const hash = ticketHash();
    await issue(user, 'opsp', hash, login);
    const [redeemed] = await Promise.all([
      call(`select public.myops_redeem_app_ticket('opsp', ${q(hash)})`),
      svc(`select public.myops_login_end(${q(login)}, ${q(user)}, 'logout')`),
    ]);
    if (redeemed.status === 'redeemed') assert.equal((await validate(redeemed.session_id)).active, false);
    assert.equal(await svc(`select count(*) from public.myops_app_sessions where login_session_id = ${q(login)} and revoked_at is null`), '0');
  }
});

test('login sessions: at most 10 concurrent logins per user, oldest swept', { skip }, async () => {
  const user = await newUser();
  const ids = [];
  for (let i = 0; i < 12; i += 1) ids.push(await svc(`select public.myops_login_start(${q(user)})`));
  assert.equal(await svc(`select count(*) from public.myops_login_sessions where user_id = ${q(user)} and revoked_at is null`), '10');
  assert.equal(await live(ids[0], user), false);
  assert.equal(await live(ids[11], user), true);
  assert.equal(await svc(`select ended_reason from public.myops_login_sessions where id = ${q(ids[0])}`), 'swept');
});

test('login sessions: sweep expires logins, cascades to apps, retries the outbox and is idempotent', { skip }, async () => {
  const user = await newUser();
  const login = await svc(`select public.myops_login_start(${q(user)})`);
  const hash = ticketHash();
  await issue(user, 'opsp', hash, login);
  const session = (await call(`select public.myops_redeem_app_ticket('opsp', ${q(hash)})`)).session_id;
  const fresh = await svc(`select public.myops_login_start(${q(await newUser())})`);
  await ageLogin(login, 30);
  const result = await call('select public.myops_sweep_logins(100)');
  assert.ok(result.expired_logins >= 1 && result.revoked_app_sessions >= 1);
  assert.equal(await svc(`select revoked_at is not null from public.myops_app_sessions where id = ${q(session)}`), 't');
  assert.equal(await svc(`select revoked_at is null from public.myops_login_sessions where id = ${q(fresh)}`), 't', 'active logins untouched');
  const again = await call('select public.myops_sweep_logins(100)');
  assert.equal(again.revoked_app_sessions, 0);

  const target = await svc(`select public.myops_login_start(${q(user)})`);
  await svc(`select public.myops_enqueue_revocation(${q(user)}, ${q(target)}, 'logout')`);
  await svc(`select public.myops_enqueue_revocation(${q(user)}, ${q(target)}, 'logout')`);
  assert.equal(await svc(`select count(*) from public.myops_revocation_requests where login_session_id = ${q(target)} and completed_at is null`), '1', 'deduplicated');
  const swept = await call('select public.myops_sweep_logins(100)');
  assert.ok(swept.retried >= 1);
  assert.equal(await live(target, user), false);
  assert.equal(await svc(`select count(*) from public.myops_revocation_requests where login_session_id = ${q(target)} and completed_at is null`), '0');

  await svc(`insert into public.myops_revocation_requests (user_id, login_session_id, reason, attempts, last_attempt_at)
    values (${q(user)}, null, 'admin', 20, now() - interval '1 day')`);
  const capped = await call('select public.myops_sweep_logins(100)');
  assert.equal(await svc(`select count(*) from public.myops_revocation_requests where user_id = ${q(user)} and reason = 'admin' and completed_at is null`), '1', 'retry cap respected');
  assert.equal(capped.retry_failed, 0);
  await svc(`update public.myops_login_sessions set revoked_at = now() - interval '31 days' where id = ${q(login)}`);
  assert.ok((await call('select public.myops_sweep_logins(100)')).deleted_logins >= 1);
});

test('login sessions: clients cannot reach tables or functions and the proposal stays unapplied-safe', { skip }, async () => {
  for (const role of ['anon', 'authenticated']) {
    for (const stmt of ['select * from public.myops_login_sessions', 'select * from public.myops_revocation_requests',
      `select public.myops_login_start(gen_random_uuid())`, `select public.myops_login_end(gen_random_uuid(), gen_random_uuid(), 'logout')`,
      `select public.myops_login_end_all(gen_random_uuid(), 'logout')`, 'select public.myops_sweep_logins(10)',
      `select public.myops_enqueue_revocation(gen_random_uuid(), null, 'logout')`]) {
      await assert.rejects(sql(stmt, { role }), /permission denied/, `${role}: ${stmt}`);
    }
  }
  const rls = await sql(`select count(*) from pg_class where relname in ('myops_login_sessions','myops_revocation_requests') and relrowsecurity`);
  assert.equal(rls, '2');
  const text = readFileSync(new URL('../supabase/proposals/202610170002_myops_login_sessions.sql', import.meta.url), 'utf8');
  assert.equal((text.match(/security definer set search_path = ''/g) || []).length, (text.match(/create or replace function/g) || []).length);
  assert.doesNotMatch(text, /create policy|cron\.schedule|create extension/i);
  assert.match(text, /NOT EXECUTED/);
  const rollback = readFileSync(new URL('../supabase/proposals/202610170002_myops_login_sessions_rollback.sql', import.meta.url), 'utf8');
  assert.match(rollback, /NOT EXECUTED/);
  assert.doesNotMatch(rollback, /cron\./i);
});

test('login sessions: rollback restores the 0001 behaviour and the proposal re-applies cleanly', { skip }, async () => {
  await applyFile('202610170002_myops_login_sessions_rollback.sql');
  await applyFile('202610170002_myops_login_sessions_rollback.sql');
  assert.equal(await sql(`select count(*) from pg_proc where proname in ('myops_login_start','myops_sweep_logins','myops_login_end')`), '0');
  assert.equal(await sql(`select count(*) from information_schema.columns where column_name = 'login_session_id'`), '0');
  const user = await newUser();
  const hash = ticketHash();
  assert.equal((await call(`select public.myops_issue_app_ticket(${q(user)}, 'opsp', ${q(hash)})`)).status, 'issued');
  const redeemed = await call(`select public.myops_redeem_app_ticket('opsp', ${q(hash)})`);
  assert.equal((await validate(redeemed.session_id)).active, true);
  await applyFile('202610170002_myops_login_sessions.sql');
  await sql('grant execute on all functions in schema public to service_role');
  await applyFile('202610170002_myops_login_sessions.sql');
  assert.equal((await validate(redeemed.session_id)).active, false, 'pre-existing unbound sessions fail closed after re-applying');
});
