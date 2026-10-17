import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAuthHandler, signActivity, resolveProductStates } from '../server/auth.js';
import { createCallbackHandler } from '../server/toyyibpay-callback.js';
import { founderEventKey } from '../server/payments.js';

const origin = 'https://trusted-preview.vercel.app';
const SECRET = 'toyyib-sandbox-secret';
const env = {
  VERCEL_ENV: 'preview', VERCEL_BRANCH_URL: 'trusted-preview.vercel.app', MYOPS_SESSION_SECRET: 's'.repeat(40),
  VITE_SUPABASE_URL: 'https://uhuukcztdifvpjuopdea.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_fixture',
  MYOPS_SERVICE_ROLE_KEY: 'sb_secret_test_fixture', TOYYIBPAY_SANDBOX_SECRET_KEY: SECRET, TOYYIBPAY_SANDBOX_CATEGORY_CODE: 'cat12345',
  MYOPS_ADMIN_USER_IDS: 'admin-user, other-admin',
};
const NOW = Date.now();
const cookie = `__Host-myops-access=tok; __Host-myops-activity=${signActivity(env.MYOPS_SESSION_SECRET, NOW)}`;
const person = (id = 'user-a', type = 'personal') => ({ id, email: `${id}@example.test`, email_confirmed_at: '2026-01-01',
  user_metadata: { display_name: 'A Person', account_type: type } });

function userClient(user, rows = {}) {
  return {
    auth: { getUser: async () => ({ data: { user }, error: null }) },
    from: (table) => {
      const query = { select: () => query, eq: () => query, then: (resolve) => resolve({ data: rows[table] || [], error: null }) };
      return query;
    },
  };
}

// In-memory mirror of the SQL contract (the SQL itself is proven in founders-sql.test.mjs).
function ledger({ cap = 100, allocated = 0 } = {}) {
  const state = { payments: new Map(), alloc: new Set(), events: new Map(), calls: [], extra: allocated };
  const size = () => state.alloc.size + state.extra;
  const handlers = {
    myops_founders_status: () => ({ capacity: cap, allocated: size(), remaining: Math.max(0, cap - size()) }),
    myops_create_payment: ({ p_user_id: user, p_plan: plan, p_order_ref: ref }) => {
      if (state.alloc.has(user)) return { status: 'already_lifetime' };
      if (plan === 'founders_lifetime' && size() >= cap) return { status: 'sold_out' };
      if (plan === 'all_apps_monthly' && size() < cap) return { status: 'founders_available' };
      state.payments.set(ref, { order_ref: ref, user_id: user, plan, status: 'pending', gateway_bill_code: null, amount_cents: 2900 });
      return { status: 'created', order_ref: ref };
    },
    myops_attach_bill: ({ p_order_ref: ref, p_bill_code: code }) => { state.payments.get(ref).gateway_bill_code = code; return true; },
    myops_abort_checkout: ({ p_order_ref: ref }) => { state.payments.get(ref).status = 'failed'; return true; },
    myops_get_payment: ({ p_order_ref: ref }) => state.payments.get(ref) || null,
    myops_settle_payment: (a) => {
      const prior = state.events.get(a.p_event_key);
      state.events.set(a.p_event_key, (prior || 0) + 1);
      const pay = state.payments.get(a.p_order_ref);
      if (!pay) return { status: 'unknown_order' };
      if (pay.gateway_bill_code !== a.p_bill_code) return { status: 'bill_mismatch' };
      if (pay.status === 'succeeded') return { status: 'already_settled', duplicate: Boolean(prior) };
      if (a.p_outcome !== 'succeeded') { pay.status = a.p_outcome; return { status: a.p_outcome }; }
      if (a.p_amount_cents !== pay.amount_cents) return { status: 'amount_mismatch' };
      pay.status = 'succeeded';
      if (size() < cap) { state.alloc.add(pay.user_id); pay.outcome = 'founder_allocated'; } else pay.outcome = 'founder_slots_exhausted';
      return { status: 'settled', outcome: pay.outcome };
    },
    myops_admin_audit: () => ({ founders: handlers.myops_founders_status(), payments: [], allocations: [], entitlements: [], events: [] }),
  };
  state.client = { rpc: async (name, args) => { state.calls.push(name); return { data: handlers[name](args), error: null }; } };
  return state;
}

const gateway = ({ bill = 'abc123XY', paid = [], failBill = false, down = false } = {}) => {
  const requests = [];
  const transport = async (url, init) => {
    const body = Object.fromEntries(new URLSearchParams(init.body));
    requests.push({ url, body });
    if (down) return { ok: false, json: async () => ({}) };
    if (url.endsWith('/createBill')) return { ok: true, json: async () => (failBill ? { status: 'error', msg: 'bad category' } : [{ BillCode: bill }]) };
    if (url.endsWith('/getBillTransactions')) return { ok: true, json: async () => paid };
    throw new Error(`unexpected ${url}`);
  };
  return { transport, requests };
};

async function authRun(body, { user = person(), ledgerState = ledger(), rows, transport, extraEnv, headers } = {}) {
  const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
  const req = { method: 'POST', headers: { host: 'trusted-preview.vercel.app', origin, 'content-type': 'application/json', cookie, ...headers }, body };
  const factory = (url, key) => (key.startsWith('sb_secret_') ? ledgerState.client : userClient(user, rows));
  await createAuthHandler({ env: { ...env, ...extraEnv }, clientFactory: factory, transport, now: () => NOW })(req, res);
  return res;
}

const hashFor = (status, orderId, refno) => createHash('md5').update(`${SECRET}${status}${orderId}${refno}ok`).digest('hex');
async function hook(fields, { ledgerState, transport, method = 'POST', extraEnv } = {}) {
  const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
  await createCallbackHandler({ env: { ...env, ...extraEnv }, clientFactory: () => ledgerState.client, transport })({ method, body: fields }, res);
  return res;
}
async function started(user = 'user-a', state = ledger()) {
  const g = gateway();
  const res = await authRun({ action: 'checkout', plan: 'founders_lifetime' }, { user: person(user), ledgerState: state, transport: g.transport });
  const [order] = [...state.payments.keys()].slice(-1);
  return { res, order, state, g };
}
const callbackFields = (order, over = {}) => ({ refno: 'TP1', status: '1', reason: 'Approved', billcode: 'abc123XY', order_id: order, amount: '29.00', transaction_id: 'TX1', hash: hashFor('1', order, 'TP1'), ...over });
const paidRow = (order, over = {}) => ({ billExternalReferenceNo: order, billpaymentStatus: '1', billpaymentAmount: '29.00', billpaymentInvoiceNo: 'INV1', ...over });

test('founders status is anonymous, server-authoritative and never invents numbers', async () => {
  const anon = { headers: { cookie: '' } };
  const live = await authRun({ action: 'founders' }, { ledgerState: ledger({ allocated: 37 }), ...anon });
  assert.deepEqual(live.data, { capacity: 100, allocated: 37, remaining: 63, available: true });
  const full = await authRun({ action: 'founders' }, { ledgerState: ledger({ allocated: 100 }), ...anon });
  assert.deepEqual(full.data, { capacity: 100, allocated: 100, remaining: 0, available: false });
  const unconfigured = await authRun({ action: 'founders' }, { extraEnv: { MYOPS_SERVICE_ROLE_KEY: '' }, ...anon });
  assert.deepEqual(unconfigured.data, { available: false });
  const wrongKind = await authRun({ action: 'founders' }, { extraEnv: { MYOPS_SERVICE_ROLE_KEY: 'sb_publishable_oops' }, ...anon });
  assert.deepEqual(wrongKind.data, { available: false });
});

test('checkout requires a live signed-in session, an Individual account and sandbox configuration', async () => {
  const state = ledger();
  assert.equal((await authRun({ action: 'checkout', plan: 'founders_lifetime' }, { ledgerState: state, headers: { cookie: '' } })).code, 401);
  const stale = `__Host-myops-access=tok; __Host-myops-activity=${signActivity(env.MYOPS_SESSION_SECRET, NOW - 16 * 60 * 1000)}`;
  assert.equal((await authRun({ action: 'checkout', plan: 'founders_lifetime' }, { ledgerState: state, headers: { cookie: stale } })).code, 401);
  assert.equal((await authRun({ action: 'checkout', plan: 'founders_lifetime' }, { user: person('biz', 'business'), ledgerState: state })).code, 403);
  assert.equal((await authRun({ action: 'checkout', plan: 'founders_lifetime' }, { user: { ...person(), user_metadata: {} }, ledgerState: state })).code, 403);
  assert.equal((await authRun({ action: 'checkout', plan: 'founders_lifetime' }, { ledgerState: state, extraEnv: { TOYYIBPAY_SANDBOX_SECRET_KEY: '' } })).code, 503);
  assert.equal((await authRun({ action: 'checkout', plan: 'free_forever' }, { ledgerState: state, transport: gateway().transport })).code, 400);
  assert.deepEqual(state.calls.filter((c) => c === 'myops_create_payment'), []);
});

test('checkout creates a sandbox bill for RM29 and returns only the sandbox payment URL', async () => {
  const { res, order, g, state } = await started();
  assert.equal(res.code, 200);
  assert.deepEqual(res.data, { next: 'https://dev.toyyibpay.com/abc123XY' });
  const [create] = g.requests;
  assert.ok(create.url.startsWith('https://dev.toyyibpay.com/'));
  assert.equal(create.body.billAmount, '2900');
  assert.equal(create.body.billExternalReferenceNo, order);
  assert.equal(create.body.billCallbackUrl, `${origin}/api/toyyibpay-callback`);
  assert.equal(state.payments.get(order).gateway_bill_code, 'abc123XY');
});

test('checkout failures: gateway error releases the reservation; sold out and duplicates are refused', async () => {
  const state = ledger();
  const bad = await authRun({ action: 'checkout', plan: 'founders_lifetime' }, { ledgerState: state, transport: gateway({ failBill: true }).transport });
  assert.equal(bad.code, 502);
  assert.ok(state.calls.includes('myops_abort_checkout'));
  const down = await authRun({ action: 'checkout', plan: 'founders_lifetime' }, { user: person('user-b'), ledgerState: state, transport: gateway({ down: true }).transport });
  assert.equal(down.code, 502);
  const full = ledger({ allocated: 100 });
  const soldOut = await authRun({ action: 'checkout', plan: 'founders_lifetime' }, { ledgerState: full, transport: gateway().transport });
  assert.equal(soldOut.code, 409);
  const early = await authRun({ action: 'checkout', plan: 'all_apps_monthly' }, { ledgerState: ledger(), transport: gateway().transport });
  assert.equal(early.code, 409);
  const monthly = await authRun({ action: 'checkout', plan: 'all_apps_monthly' }, { ledgerState: full, transport: gateway().transport });
  assert.equal(monthly.code, 200);
});

test('admin audit is closed to non-admins and when no admins are configured', async () => {
  assert.equal((await authRun({ action: 'admin_audit' }, { user: person('user-a') })).code, 403);
  assert.equal((await authRun({ action: 'admin_audit' }, { user: person('admin-user'), extraEnv: { MYOPS_ADMIN_USER_IDS: '' } })).code, 403);
  assert.equal((await authRun({ action: 'admin_audit' }, { headers: { cookie: '' } })).code, 401);
  const ok = await authRun({ action: 'admin_audit' }, { user: person('admin-user') });
  assert.equal(ok.code, 200);
  assert.deepEqual(Object.keys(ok.data).sort(), ['allocations', 'entitlements', 'events', 'founders', 'payments']);
});

test('verified webhook allocates the founder slot; replays are harmless; later failure cannot revoke', async () => {
  const { order, state } = await started();
  const g = gateway({ paid: [paidRow(order)] });
  const first = await hook(callbackFields(order), { ledgerState: state, transport: g.transport });
  assert.equal(first.code, 200);
  assert.equal(first.data.status, 'settled');
  assert.ok(g.requests.some((r) => r.url.endsWith('/getBillTransactions') && r.body.billCode === 'abc123XY'));
  const replay = await hook(callbackFields(order), { ledgerState: state, transport: g.transport });
  assert.equal(replay.code, 200);
  assert.equal(replay.data.status, 'already_settled');
  assert.equal(state.alloc.size, 1);
  const fail = await hook(callbackFields(order, { status: '3', refno: 'TP2', hash: hashFor('3', order, 'TP2') }), { ledgerState: state, transport: g.transport });
  assert.equal(fail.data.status, 'already_settled');
  assert.equal(state.payments.get(order).status, 'succeeded');
});

test('webhook rejects bad hashes, missing fields and forged success without gateway confirmation', async () => {
  const { order, state } = await started();
  const g = gateway({ paid: [] });
  assert.equal((await hook(callbackFields(order, { hash: 'f'.repeat(32) }), { ledgerState: state, transport: g.transport })).code, 400);
  assert.equal((await hook({ status: '1' }, { ledgerState: state, transport: g.transport })).code, 400);
  assert.equal((await hook(callbackFields(order, { order_id: 'bad id' }), { ledgerState: state, transport: g.transport })).code, 400);
  assert.equal((await hook(callbackFields(order, { billcode: 'zzzz9999' }), { ledgerState: state, transport: g.transport })).code, 400);
  assert.equal((await hook(callbackFields('MYOPS-unknownorder1'), { ledgerState: state, transport: g.transport })).code, 400);
  // Correct hash but the gateway reports no paid transaction: nothing is granted.
  const forged = await hook(callbackFields(order), { ledgerState: state, transport: g.transport });
  assert.equal(forged.code, 400);
  assert.equal(state.alloc.size, 0);
  assert.ok(!state.calls.includes('myops_settle_payment'));
  // A success callback with no hash still needs (and gets) API confirmation, so a paid bill settles.
  const noHash = await hook(callbackFields(order, { hash: undefined }), { ledgerState: state, transport: gateway({ paid: [paidRow(order)] }).transport });
  assert.equal(noHash.data.status, 'settled');
});

test('gateway verification outage returns 502 so the gateway retries; wrong paid amount never grants', async () => {
  const { order, state } = await started();
  const outage = await hook(callbackFields(order), { ledgerState: state, transport: gateway({ down: true }).transport });
  assert.equal(outage.code, 502);
  const short = await hook(callbackFields(order), { ledgerState: state, transport: gateway({ paid: [paidRow(order, { billpaymentAmount: '1.00' })] }).transport });
  assert.equal(short.code, 400);
  assert.equal(short.data.status, 'amount_mismatch');
  const other = await hook(callbackFields(order), { ledgerState: state, transport: gateway({ paid: [paidRow('MYOPS-someoneelse01')] }).transport });
  assert.equal(other.code, 400);
  assert.equal(state.alloc.size, 0);
});

test('payment failure and cancellation need a valid hash and never grant access', async () => {
  const { order, state } = await started();
  const g = gateway();
  const unsigned = await hook(callbackFields(order, { status: '3', hash: undefined }), { ledgerState: state, transport: g.transport });
  assert.equal(unsigned.code, 400);
  const failed = await hook(callbackFields(order, { status: '3', reason: 'Insufficient funds', hash: hashFor('3', order, 'TP1') }), { ledgerState: state, transport: g.transport });
  assert.equal(failed.data.status, 'failed');
  assert.equal(state.alloc.size, 0);
  const second = await started('user-b', state);
  const cancelled = await hook(callbackFields(second.order, { status: '3', reason: 'User cancelled', hash: hashFor('3', second.order, 'TP1') }), { ledgerState: state, transport: g.transport });
  assert.equal(cancelled.data.status, 'canceled');
  const pending = await hook(callbackFields(second.order, { status: '2', hash: hashFor('2', second.order, 'TP1') }), { ledgerState: state, transport: g.transport });
  assert.equal(pending.data.status, 'pending_ignored');
  assert.equal(state.alloc.size, 0);
});

test('slot exhaustion: the 101st payer is never given a lifetime', async () => {
  const state = ledger({ allocated: 99 });
  const a = await started('user-a', state);
  const b = await started('user-b', state);
  assert.equal(b.res.code, 200);
  const g = (order) => gateway({ paid: [paidRow(order)] }).transport;
  assert.equal((await hook(callbackFields(a.order), { ledgerState: state, transport: g(a.order) })).data.status, 'settled');
  assert.equal(state.payments.get(a.order).outcome, 'founder_allocated');
  const late = await hook(callbackFields(b.order), { ledgerState: state, transport: g(b.order) });
  assert.equal(late.data.status, 'settled');
  assert.equal(state.payments.get(b.order).outcome, 'founder_slots_exhausted');
  assert.equal(state.alloc.has('user-b'), false);
  const next = await started('user-c', state);
  assert.equal(next.res.code, 409);
});

test('webhook endpoint is Preview-only, POST-only and fails closed without configuration', async () => {
  const state = ledger();
  assert.equal((await hook({}, { ledgerState: state, extraEnv: { VERCEL_ENV: 'production' } })).code, 404);
  assert.equal((await hook({}, { ledgerState: state, method: 'GET' })).code, 405);
  assert.equal((await hook(callbackFields('MYOPS-abcdefgh12'), { ledgerState: state, extraEnv: { MYOPS_SERVICE_ROLE_KEY: '' } })).code, 503);
  assert.equal((await hook(callbackFields('MYOPS-abcdefgh12'), { ledgerState: state, extraEnv: { TOYYIBPAY_SANDBOX_SECRET_KEY: '' } })).code, 503);
  assert.equal((await hook('x'.repeat(5000), { ledgerState: state })).code, 400);
  assert.equal((await hook(callbackFields('MYOPS-abcdefgh12', { reason: 'x'.repeat(500) }), { ledgerState: state })).code, 400);
});

test('event keys are stable per callback so duplicates collapse', () => {
  const fields = { billcode: 'b', order_id: 'o', refno: 'r', status: '1' };
  assert.equal(founderEventKey(fields), founderEventKey({ ...fields }));
  assert.notEqual(founderEventKey(fields), founderEventKey({ ...fields, status: '3' }));
});

const catalog = [{ slug: 'opsp', launch_status: 'live' }, { slug: 'opswms', launch_status: 'coming_soon' }, { slug: 'opsnew', launch_status: 'live' }];
const lifeRow = (over) => ({ user_id: 'user-a', scope: 'all_apps', status: 'active', ...over });

test('lifetime entitlement unlocks every live app, including newly launched catalog apps', () => {
  const base = { userId: 'user-a', catalog, subscriptions: [], grants: [], now: NOW };
  assert.deepEqual(resolveProductStates({ ...base, lifetime: [lifeRow()] }),
    { opsp: 'active', opsfinance: 'coming_soon', opsflow: 'coming_soon', opswms: 'coming_soon', opshr: 'coming_soon', opsnew: 'active' });
  const none = resolveProductStates({ ...base, lifetime: [] });
  assert.equal(none.opsp, 'none');
  assert.equal(none.opsnew, 'none');
  assert.equal(resolveProductStates({ ...base, lifetime: [lifeRow({ status: 'revoked' })] }).opsp, 'none');
  assert.equal(resolveProductStates({ ...base, lifetime: [lifeRow({ user_id: 'someone-else' })] }).opsp, 'none');
  assert.equal(resolveProductStates({ ...base, lifetime: [lifeRow({ scope: 'other' })] }).opsp, 'none');
  assert.equal(resolveProductStates({ ...base, catalog: [{ slug: 'Bad Slug!', launch_status: 'live' }], lifetime: [lifeRow()] }).opsp, 'coming_soon');
});

test('session reports lifetime and the launch gate follows it server-side, with no frontend trust', async () => {
  const rows = { myops_products: catalog, myops_lifetime_entitlements: [lifeRow()] };
  const session = await authRun({ action: 'session' }, { rows });
  assert.equal(session.data.lifetime, true);
  assert.equal(session.data.products.opsp, 'active');
  const launch = await authRun({ action: 'launch', product: 'opsnew' }, { rows, extraEnv: { MYOPS_APP_URL_OPSNEW: 'https://app.example.test/new' } });
  assert.deepEqual(launch.data, { next: 'https://app.example.test/new' });
  const denied = await authRun({ action: 'launch', product: 'opsp' }, { rows: { myops_products: catalog }, extraEnv: { MYOPS_APP_URL_OPSP: 'https://app.example.test/opsp' } });
  assert.equal(denied.code, 403);
  const unknown = await authRun({ action: 'launch', product: 'nothere' }, { rows });
  assert.equal(unknown.code, 400);
  const injected = await authRun({ action: 'launch', product: 'opsp/../x' }, { rows });
  assert.equal(injected.code, 400);
});
