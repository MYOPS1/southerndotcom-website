import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';

const verifyPublicKeyOnly = (key, signature, message) => verify(null, Buffer.from(message), key, Buffer.from(signature, 'base64url'));
import {
  canonicalJson, canonicalRequest, createAppAccess, hashTicket, loadCurrentEntitlements, verifyAppSignature,
} from '../server/app-access.js';

const NOW = 1_900_000_000_000;
const appId = 'opsp';
const userId = '2bc79d9a-e917-4bab-bf29-b318a4f5542c';
const sessionId = '3bc79d9a-e917-4bab-bf29-b318a4f5542c';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const baseEnv = {
  VERCEL_ENV: 'preview',
  MYOPS_ENVIRONMENT: 'staging',
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
  const message = canonicalRequest('POST', path, appId, 'current', timestamp, nonce, body);
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
  const message = canonicalRequest('POST', '/api/app/redeem', appId, 'current', String(NOW), 'nonce-value-1234567890', body);
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
  assert.equal(url.search, '');
  const rawTicket = new URLSearchParams(url.hash.slice(1)).get('t');
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
  const secondRawTicket = new URLSearchParams(new URL(launch.next).hash.slice(1)).get('t');
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
  assert.deepEqual(Object.keys(result.body).sort(), ['idle_seconds', 'max_session_seconds', 'product', 'session_id', 'user_ref']);
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
  assert.equal((await call(unavailable.handler.redeem, signedRequest({ path: '/api/app/redeem', body }))).statusCode, 503);
  assert.ok(unavailable.calls.some(([name]) => name === 'myops_revoke_app_session'), 'unverified new session is closed');
});

test('entitlement verification is fresh and revoked or idle sessions are denied', async () => {
  const body = { session_id: sessionId, product: 'opsp', sensitive: true, activity: true };
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

test('regression S1-B review: only Ed25519 public keys are accepted', () => {
  const message = 'signed message';
  // A 512-bit RSA key produces a 64-byte signature that matches the Ed25519 signature format.
  const rsa = generateKeyPairSync('rsa', { modulusLength: 512 });
  const rsaPem = rsa.publicKey.export({ type: 'spki', format: 'pem' });
  const rsaSignature = sign(null, Buffer.from(message), rsa.privateKey).toString('base64url');
  assert.equal(rsaSignature.length, 86);
  assert.equal(verifyPublicKeyOnly(rsa.publicKey, rsaSignature, message), true, 'precondition: RSA passes a bare verify');
  assert.equal(verifyAppSignature(rsaPem, rsaSignature, message), false);
  const good = sign(null, Buffer.from(message), privateKey).toString('base64url');
  assert.equal(verifyAppSignature(publicPem, good, message), true);
});

test('regression S1-B review: nested, extra or reordered body fields cannot bypass the signature', async () => {
  assert.notEqual(canonicalJson({ a: { x: 1 } }), canonicalJson({ a: { x: 2 } }));
  assert.equal(canonicalJson({ b: [1, { z: 1, y: 2 }], a: null }), canonicalJson({ a: null, b: [1, { y: 2, z: 1 }] }));
  assert.notEqual(canonicalRequest('POST', '/p', 'opsp', 'current', '1', 'n', {}),
    canonicalRequest('POST', '/p', 'opsp', 'next', '1', 'n', {}));
  assert.notEqual(canonicalRequest('POST', '/p', 'opsp', 'current', '1', 'n', {}),
    canonicalRequest('POST', '/p', 'opsfinance', 'current', '1', 'n', {}));
  const signedBody = { session_id: sessionId, product: 'opsp' };
  const request = signedRequest({ path: '/api/app/entitlement', body: signedBody });
  const tampered = [
    { ...signedBody, sensitive: true, activity: true },
    { ...signedBody, extra: { admin: true } },
    { ...signedBody, product: 'opsfinance' },
  ];
  for (const body of tampered) {
    const { handler } = make();
    const response = await call(handler.entitlement, { ...request, body });
    assert.equal(response.statusCode === 401 || response.statusCode === 400, true);
    assert.notEqual(response.statusCode, 200);
  }
  const wrongVersion = make();
  assert.equal((await call(wrongVersion.handler.entitlement, {
    ...request, headers: { ...request.headers, 'x-myops-key-version': 'next' } })).statusCode, 401);
});

test('regression S1-B review: polling does not extend the session; only asserted activity does', async () => {
  const poll = make();
  await call(poll.handler.entitlement, signedRequest({ path: '/api/app/entitlement',
    body: { session_id: sessionId, product: 'opsp' }, nonce: 'nonce-poll-1234567890' }));
  assert.equal(poll.calls.find(([name]) => name === 'myops_validate_app_session')[1].p_touch, false);
  const active = make();
  await call(active.handler.entitlement, signedRequest({ path: '/api/app/entitlement',
    body: { session_id: sessionId, product: 'opsp', activity: true }, nonce: 'nonce-active-1234567890' }));
  assert.equal(active.calls.find(([name]) => name === 'myops_validate_app_session')[1].p_touch, true);
  const sensitive = make();
  const rejected = await call(sensitive.handler.entitlement, signedRequest({ path: '/api/app/entitlement',
    body: { session_id: sessionId, product: 'opsp', sensitive: true }, nonce: 'nonce-sens-1234567890' }));
  assert.equal(rejected.statusCode, 400);
});

test('regression S1-B review: a transient lookup failure keeps the session and returns 503', async () => {
  const flaky = make({ entitlement: 'error' });
  const response = await call(flaky.handler.entitlement, signedRequest({ path: '/api/app/entitlement',
    body: { session_id: sessionId, product: 'opsp' }, nonce: 'nonce-flaky-1234567890' }));
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.entitled, false);
  assert.equal(flaky.calls.some(([name]) => name === 'myops_revoke_app_session'), false);
});

test('regression S1-B review: staging isolation and revocation fail closed', async () => {
  const body = { ticket: Buffer.alloc(32, 9).toString('base64url') };
  const notStaging = createAppAccess({ env: { ...baseEnv, MYOPS_ENVIRONMENT: undefined }, adminFactory: () => ({}), now: () => NOW });
  assert.equal((await call(notStaging.redeem, signedRequest({ path: '/api/app/redeem', body }))).statusCode, 503);
  assert.equal(await notStaging.revokeUserSessions(userId), false);
  const noService = createAppAccess({ env: baseEnv, adminFactory: () => null, now: () => NOW });
  await assert.rejects(noService.revokeUserSessions(userId));
  const dbDown = createAppAccess({ env: baseEnv, now: () => NOW,
    adminFactory: () => ({ rpc: async () => ({ data: null, error: { code: 'x' } }) }) });
  await assert.rejects(dbDown.revokeUserSessions(userId));
  await assert.rejects(dbDown.revokeUserSessions('not-a-uuid'));
});
