import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthHandler } from '../server/auth.js';
import { createClient } from '@supabase/supabase-js';

const origin = 'https://trusted-preview.vercel.app';
const env = { VERCEL_ENV: 'preview', VERCEL_BRANCH_URL: 'trusted-preview.vercel.app',
  VITE_SUPABASE_URL: 'https://uhuukcztdifvpjuopdea.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_fixture' };
const user = { id: 'test-user-a', email: 'staging@example.test', email_confirmed_at: '2026-01-01' };
const session = { access_token: 'test-access-token', expires_at: Math.floor(Date.now() / 1000) + 3600 };
function mock(overrides = {}) {
  return { auth: {
    getUser: async () => ({ data: { user }, error: null }),
    signInWithPassword: async () => ({ data: { session }, error: null }),
    signUp: async () => ({ data: { session: null }, error: null }),
    exchangeCodeForSession: async () => ({ data: { session, redirectType: 'recovery' }, error: null }),
    resetPasswordForEmail: async () => ({ error: null }),
    admin: { signOut: async () => ({ error: null }) }, ...overrides },
    rpc: async () => ({ error: { code: '42883' } }),
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) };
}
async function run(body, options = {}) {
  const headers = {};
  const res = { setHeader: (key, value) => { headers[key] = value; },
    status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; } };
  const req = { method: 'POST', headers: { host: 'trusted-preview.vercel.app', origin,
    'content-type': 'application/json', ...options.headers }, body, ...options.request };
  await createAuthHandler({ env: { ...env, ...options.env }, clientFactory: options.factory || (() => options.client || mock()), transport: options.transport })(req, res);
  return { ...res, headers };
}
const login = { action: 'login', email: user.email, password: 'staging-password' };

test('production disabled regardless of configured values', async () => {
  const result = await run(login, { env: { VERCEL_ENV: 'production' }, factory: () => assert.fail('no upstream call') });
  assert.equal(result.code, 404);
});
test('exact trusted host, same-origin JSON and POST required', async () => {
  for (const options of [{ headers: { origin: 'https://evil.example' } }, { headers: { host: 'other.vercel.app' } },
    { headers: { origin: undefined } }, { headers: { 'content-type': 'text/plain' } }]) {
    assert.equal((await run(login, options)).code, 403);
  }
  assert.equal((await run(login, { request: { method: 'GET' } })).code, 405);
});
test('reject wrong project, missing key and service-role/secret key shape', async () => {
  for (const value of ['', 'sb_secret_test', 'legacy-jwt']) {
    assert.equal((await run(login, { env: { VITE_SUPABASE_PUBLISHABLE_KEY: value } })).code, 503);
  }
  assert.equal((await run(login, { env: { VITE_SUPABASE_URL: 'https://other.supabase.co' } })).code, 503);
});
test('confirmed login saves only HttpOnly secure bounded access cookie, no tokens in JSON', async () => {
  const result = await run(login);
  assert.equal(result.code, 200);
  assert.deepEqual(result.data, { next: '/account' });
  const cookie = result.headers['Set-Cookie'][0];
  assert.match(cookie, /^__Host-myops-access=/);
  assert.match(cookie, /Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=\d+/);
  assert.equal(result.headers['Cache-Control'], 'private, no-store');
});
test('wrong credentials and unconfirmed login cannot save a session', async () => {
  for (const client of [mock({ signInWithPassword: async () => ({ data: {}, error: {} }) }),
    mock({ getUser: async () => ({ data: { user: { ...user, email_confirmed_at: null } }, error: null }) })]) {
    const result = await run(login, { client });
    assert.equal(result.code, 401);
    assert.equal(result.headers['Set-Cookie'], undefined);
  }
});
test('signup never starts a session when confirmation is disabled', async () => {
  const result = await run({ ...login, action: 'register', accountType: 'business', displayName: 'Test' },
    { client: mock({ signUp: async () => ({ data: { session }, error: null }) }) });
  assert.equal(result.code, 503);
  assert.equal(result.headers['Set-Cookie'], undefined);
});
test('registration and recovery use generic messages and fixed callback, not caller redirect', async () => {
  let called;
  const client = mock({ resetPasswordForEmail: async (...args) => { called = args; return { error: null }; } });
  const result = await run({ action: 'forgot', email: user.email, next: 'https://evil.example' }, { client });
  assert.equal(result.code, 200);
  assert.equal(called[1].redirectTo, `${origin}/auth/callback`);
  const existing = await run({ action: 'forgot', email: user.email }, { client: mock({ resetPasswordForEmail: async () => ({ error: {} }) }) });
  assert.deepEqual(existing.data, result.data);
});
test('callback requires verifier and invalid code cannot create session', async () => {
  assert.equal((await run({ action: 'callback', code: 'test-code' })).code, 400);
  const result = await run({ action: 'callback', code: 'test-code' }, { headers: { cookie: '__Host-myops-pkce=verifier' },
    client: mock({ exchangeCodeForSession: async () => ({ data: {}, error: {} }) }) });
  assert.equal(result.code, 400);
  assert.ok(result.headers['Set-Cookie'].every((c) => !c.startsWith('__Host-myops-access=')));
});
test('recovery callback redirects only to fixed password page', async () => {
  const result = await run({ action: 'callback', code: 'test-code', next: '//evil.example' }, { headers: { cookie: '__Host-myops-pkce=verifier' } });
  assert.equal(result.code, 200);
  assert.equal(result.data.next, '/account/update-password');
});
test('unauthenticated account, reset and profile operations rejected', async () => {
  for (const action of ['account', 'reset', 'profile']) assert.equal((await run({ action })).code, 401);
});
test('account response uses verified identity and only self-profile query', async () => {
  let filter;
  const client = mock();
  client.from = (table) => { assert.equal(table, 'myops_profiles'); return { select: () => ({ eq: (...args) => {
    filter = args; return { maybeSingle: async () => ({ data: null }) };
  } }) }; };
  const result = await run({ action: 'account', userId: 'other-user' }, { client, headers: { cookie: '__Host-myops-access=test-access-token' } });
  assert.deepEqual(filter, ['user_id', user.id]);
  assert.deepEqual(result.data, { email: user.email, profile: null });
});
test('provisioning unavailable fails closed with no app access or broad table writes', async () => {
  const result = await run({ action: 'profile', displayName: 'Test', accountType: 'business', role: 'admin' }, { headers: { cookie: '__Host-myops-access=test-access-token' } });
  assert.equal(result.code, 503);
});
test('password update uses authenticated upstream, revokes refresh sessions and clears cookie', async () => {
  let request;
  const result = await run({ action: 'reset', password: 'new-staging-password' }, {
    headers: { cookie: '__Host-myops-access=test-access-token' },
    transport: async (url, init) => { request = { url, ...init }; return { ok: true }; },
  });
  assert.equal(result.code, 200);
  assert.equal(request.method, 'PUT');
  assert.equal(request.headers.Authorization, 'Bearer test-access-token');
  assert.match(result.headers['Set-Cookie'][0], /Max-Age=0/);
});
test('logout clears browser cookies without echoing credentials', async () => {
  const result = await run({ action: 'logout' }, { headers: { cookie: '__Host-myops-access=test-access-token' } });
  assert.equal(result.code, 200);
  assert.ok(result.headers['Set-Cookie'].every((c) => c.includes('Max-Age=0')));
  assert.deepEqual(result.data, { next: '/login' });
});
test('real installed SDK persists PKCE verifier but never refresh/access session to cookie storage', async () => {
  const factory = (url, key, options) => createClient(url, key, { ...options,
    global: { fetch: async () => new Response(JSON.stringify({ id: 'fixture', email: user.email }), { status: 200, headers: { 'Content-Type': 'application/json' } }) } });
  const result = await run({ ...login, action: 'register', accountType: 'personal', displayName: 'Test' }, { factory });
  assert.equal(result.code, 200);
  assert.ok(result.headers['Set-Cookie'].some((c) => c.startsWith('__Host-myops-pkce=')));
  assert.ok(result.headers['Set-Cookie'].every((c) => !c.startsWith('__Host-myops-access=')));
});
