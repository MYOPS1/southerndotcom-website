import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  canonicalRequest, createAppAccess, hashTicket, loadCurrentEntitlements, verifyAppSignature,
} from '../server/app-access.js';

const NOW = 1_900_000_000_000;
const appId = 'opsp';
const userId = '2bc79d9a-e917-4bab-bf29-b318a4f5542c';
const sessionId = '3bc79d9a-e917-4bab-bf29-b318a4f5542c';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const baseEnv = {
  VERCEL_ENV: 'preview',
  VERCEL_BRANCH_URL: 'myops-preview.vercel.app',
  VITE_SUPABASE_URL: 'https://uhuukcztdifvpjuopdea.supabase.co',
  MYOPS_SERVICE_ROLE_KEY: 'sb_secret_fixture',
  MYOPS_APP_USER_REF_SECRET: 'u'.repeat(40),
  MYOPS_APP_URL_OPSP: 'https://opsp.example.test/',
};

function make({ entitlement = 'active', nonceAccepted = true, redeemStatus = 'redeemed',
  sessionActive = true, service = true, rate = true } = {}) {
  const calls = [];
  const clientData = {
    app_id: appId, product_slug: 'opsp', enabled: true,
    public_key_current: publicPem, public_key_next: null,
  };
  const admin = { rpc: async (name, args) => {
    calls.push([name, args]);
    if (name === 'myops_check_app_rate_limit') return { data: rate, error: null };
    if (name === 'myops_get_app_client') return { data: clientData, error: null };
    if (name === 'myops_record_app_nonce') return { data: nonceAccepted, error: null };
    if (name === 'myops_issue_app_ticket') return { data: { status: 'issued' }, error: null };
    if (name === 'myops_redeem_app_ticket') return { data: {
      status: redeemStatus, user_id: userId, session_id: sessionId, product_slug: 'opsp',
    }, error: null };
    if (name === 'myops_validate_app_session') return { data: sessionActive
      ? { active: true, user_id: userId } : { active: false }, error: null };
    return { data: true, error: null };
  } };
  const serviceFactory = () => service ? admin : null;
  const handler = createAppAccess({
    env: baseEnv, adminFactory: serviceFactory, now: () => NOW,
    entitlementResolver: async () => entitlement === 'error' ? null : { opsp: entitlement },
  });
  return { handler, calls, admin, clientData };
}

function signedRequest({ path, body, timestamp = String(NOW), nonce = 'nonce-value-1234567890',
  signatureKey = privateKey, headers = {} } = {}) {
  const message = canonicalRequest('POST', path, timestamp, nonce, body);
  const signature = sign(null, Buffer.from(message), signatureKey).toString('base64url');
  return {
    method: 'POST',
    headers: {
      host: 'myops-preview.vercel.app',
      'content-type': 'application/json',
      'x-myops-app-id': appId,
      'x-myops-key-version': 'current',
      'x-myops-timestamp': timestamp,
      'x-myops-nonce': nonce,
      'x-myops-signature': signature,
      ...headers,
    },
    body,
  };
}

async function call(handler, req) {
  const responseHeaders = {};
  const res = {
    setHeader(name, value) { responseHeaders[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  await handler(req, res);
  return { ...res, headers: responseHeaders };
}

test('app requests use Ed25519 signatures and the canonical request binds method, path, nonce and body', () => {
  const body = { ticket: 'x'.repeat(43) };
  const message = canonicalRequest('POST', '/api/app/redeem', String(NOW), 'nonce-value-1234567890', body);
  const signature = sign(null, Buffer.from(message), privateKey).toString('base64url');
  assert.equal(verifyAppSignature(publicPem, signature, message), true);
  assert.equal(verifyAppSignature(publicPem, signature, `${message}x`), false);
  assert.equal(verifyAppSignature('not a key', signature, message), false);
});

test('launch ticket is 256-bit, delivered only in the registered app URL, while only its SHA-256 hash is stored', async () => {
  const { handler, calls } = make();
  const result = await handler.issueTicket({ userId, product: 'opsp' });
  assert.equal(result.status, 200);
  const url = new URL(result.next);
  assert.equal(url.origin, 'https://opsp.example.test');
  assert.equal(url.pathname, '/launch');
  const rawTicket = url.searchParams.get('t');
  assert.equal(rawTicket.length, 43);
  const issueCall = calls.find(([name]) => name === 'myops_issue_app_ticket');
  assert.equal(issueCall[1].p_ticket_hash, hashTicket(rawTicket));
  assert.notEqual(issueCall[1].p_ticket_hash, rawTicket);

  let storedHash;
  const issued = createAppAccess({
    env: baseEnv,
    adminFactory: () => ({ rpc: async (name, args) => {
      if (name === 'myops_check_app_rate_limit') return { data: true, error: null };
      if (name === 'myops_issue_app_ticket') { storedHash = args.p_ticket_hash; return { data: { status: 'issued' }, error: null }; }
      return { data: null, error: null };
    } }),
    now: () => NOW,
  });
  const launch = await issued.issueTicket({ userId, product: 'opsp' });
  const secondRawTicket = new URL(launch.next).searchParams.get('t');
  assert.equal(secondRawTicket.length, 43);
  assert.equal(storedHash, hashTicket(secondRawTicket));
  assert.notEqual(storedHash, secondRawTicket);
});

test('redemption revalidates entitlement and returns only an app-scoped opaque user reference', async () => {
  const { handler } = make();
  const body = { ticket: Buffer.alloc(32, 9).toString('base64url') };
  const req = signedRequest({ path: '/api/app/redeem', body });
  const result = await call(handler.redeem, req);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ['idle_seconds', 'product', 'session_id', 'user_ref']);
  assert.notEqual(result.body.user_ref, userId);
  assert.equal(result.body.idle_seconds, 900);
  assert.equal(result.body.product, 'opsp');
});

test('invalid signatures, browser origins, stale timestamps, replayed nonces and rate limits fail closed', async () => {
  const body = { ticket: Buffer.alloc(32, 9).toString('base64url') };
  for (const { handler, request, status } of [
    { handler: make().handler, request: signedRequest({ path: '/api/app/redeem', body, signatureKey: generateKeyPairSync('ed25519').privateKey }), status: 401 },
    { handler: make().handler, request: signedRequest({ path: '/api/app/redeem', body, headers: { origin: 'https://evil.example' } }), status: 403 },
    { handler: make().handler, request: signedRequest({ path: '/api/app/redeem', body, timestamp: String(NOW - 6 * 60 * 1000) }), status: 401 },
    { handler: make({ nonceAccepted: false }).handler, request: signedRequest({ path: '/api/app/redeem', body }), status: 401 },
    { handler: make({ rate: false }).handler, request: signedRequest({ path: '/api/app/redeem', body }), status: 429 },
  ]) {
    const response = await call(handler.redeem, request);
    assert.equal(response.statusCode, status);
  }
});

test('wrong-app ticket, revoked entitlement and database failures never grant an app session', async () => {
  const body = { ticket: Buffer.alloc(32, 9).toString('base64url') };
  const wrongApp = make({ redeemStatus: 'denied' });
  assert.equal((await call(wrongApp.handler.redeem, signedRequest({ path: '/api/app/redeem', body }))).statusCode, 401);
  const revoked = make({ entitlement: 'none' });
  const denied = await call(revoked.handler.redeem, signedRequest({ path: '/api/app/redeem', body }));
  assert.equal(denied.statusCode, 403);
  assert.ok(revoked.calls.some(([name]) => name === 'myops_revoke_app_session'));
  const unavailable = make({ entitlement: 'error' });
  assert.equal((await call(unavailable.handler.redeem, signedRequest({ path: '/api/app/redeem', body }))).statusCode, 403);
});

test('entitlement verification is fresh and revoked or idle sessions are denied', async () => {
  const body = { session_id: sessionId, product: 'opsp', sensitive: true };
  const active = make();
  const accepted = await call(active.handler.entitlement,
    signedRequest({ path: '/api/app/entitlement', body, nonce: 'nonce-second-1234567890' }));
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(accepted.body, { entitled: true, session_active: true, checked_at: new Date(NOW).toISOString() });
  assert.ok(active.calls.some(([name]) => name === 'myops_validate_app_session'));

  const idle = make({ sessionActive: false });
  const expired = await call(idle.handler.entitlement,
    signedRequest({ path: '/api/app/entitlement', body, nonce: 'nonce-third-1234567890' }));
  assert.equal(expired.statusCode, 403);
  assert.equal(expired.body.session_active, false);
});

test('current subscription expiry, revocation and Founder lifetime use the central resolver', async () => {
  const now = NOW;
  const tables = {
    myops_products: [
      { slug: 'opsp', launch_status: 'live' },
      { slug: 'opsfinance', launch_status: 'live' },
      { slug: 'opsfuture', launch_status: 'live' },
    ],
    myops_subscriptions: [
      { personal_user_id: userId, organization_id: null, product_slug: 'opsp', is_complete_bundle: false, status: 'active', current_period_end: null },
      { personal_user_id: userId, organization_id: null, product_slug: 'opsfinance', is_complete_bundle: false, status: 'active', current_period_end: new Date(now - 1).toISOString() },
    ],
    myops_memberships: [],
    myops_app_grants: [],
    myops_lifetime_entitlements: [{ user_id: userId, scope: 'all_apps', status: 'revoked' }],
  };
  const client = { from(table) {
    const filters = [];
    const query = {
      select() { return query; },
      eq(key, value) { filters.push((row) => row[key] === value); return query; },
      in(key, values) { filters.push((row) => values.includes(row[key])); return query; },
      then(resolve) { return resolve({ data: (tables[table] || []).filter((row) => filters.every((filter) => filter(row))), error: null }); },
    };
    return query;
  } };
  const denied = await loadCurrentEntitlements(client, userId, now);
  assert.equal(denied.opsp, 'active');
  assert.equal(denied.opsfinance, 'none');
  assert.equal(denied.opsfuture, 'none');
  tables.myops_lifetime_entitlements = [{ user_id: userId, scope: 'all_apps', status: 'active' }];
  const lifetime = await loadCurrentEntitlements(client, userId, now);
  assert.deepEqual(lifetime, { opsp: 'active', opsfinance: 'active', opsfuture: 'active', opsflow: 'coming_soon', opswms: 'coming_soon', opshr: 'coming_soon' });
});

test('requests require Preview configuration and do not use a service role in the browser', async () => {
  const body = { ticket: Buffer.alloc(32, 9).toString('base64url') };
  const req = signedRequest({ path: '/api/app/redeem', body });
  assert.equal((await call(make({ service: false }).handler.redeem, req)).statusCode, 503);
  const production = createAppAccess({ env: { ...baseEnv, VERCEL_ENV: 'production' } });
  assert.equal((await call(production.redeem, req)).statusCode, 404);
});
