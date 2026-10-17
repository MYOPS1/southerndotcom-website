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
  await createAuthHandler({ env: { ...env, ...options.env }, clientFactory: options.factory || (() => options.client || mock()), transport: options.transport, diagnostic: options.diagnostic || (() => {}) })(req, res);
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
test('account response uses verified identity and descriptive profile metadata', async () => {
  const client = mock({ getUser: async (accessToken) => {
    assert.equal(accessToken, 'test-access-token');
    return { data: { user: { ...user, user_metadata: { display_name: 'A Person', account_type: 'business' } } }, error: null };
  } });
  client.from = () => assert.fail('account details must not depend on an unapproved profile table');
  const result = await run({ action: 'account', userId: 'other-user' }, { client, headers: { cookie: '__Host-myops-access=test-access-token' } });
  assert.deepEqual(result.data, { email: user.email, profile: { display_name: 'A Person', account_type: 'business' } });
});
test('onboarding saves only descriptive metadata through the verified user and grants no role', async () => {
  let request;
  const client = mock();
  client.rpc = () => assert.fail('onboarding must not call an unapproved provisioning RPC');
  client.from = () => assert.fail('onboarding must not depend on an unapproved profile table');
  const result = await run({ action: 'profile', displayName: 'A Person', accountType: 'business', role: 'admin' }, {
    client,
    headers: { cookie: '__Host-myops-access=test-access-token' },
    transport: async (url, init) => {
      request = { url, ...init };
      return { ok: true, json: async () => ({ id: user.id }) };
    },
  });
  assert.equal(result.code, 200);
  assert.deepEqual(result.data, { next: '/account' });
  assert.equal(request.url, 'https://uhuukcztdifvpjuopdea.supabase.co/auth/v1/user');
  assert.equal(request.method, 'PUT');
  assert.ok(request.headers.Authorization.startsWith('Bearer '));
  assert.deepEqual(JSON.parse(request.body), { data: { display_name: 'A Person', account_type: 'business' } });
});
test('onboarding rejects unsupported account types and reports upstream save failure', async () => {
  const headers = { cookie: '__Host-myops-access=test-access-token' };
  assert.equal((await run({ action: 'profile', displayName: 'A Person', accountType: 'admin' }, { headers })).code, 400);
  const result = await run({ action: 'profile', displayName: 'A Person', accountType: 'personal' }, {
    headers, transport: async () => ({ ok: false }),
  });
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

test('registration errors never masquerade as confirmation success or expose upstream details', async () => {
  const body = { ...login, action: 'register', accountType: 'personal', displayName: 'Test' };
  for (const [code, status] of [['weak_password', 400], ['signup_disabled', 503], ['email_provider_disabled', 503], ['unexpected_failure', 502]]) {
    const result = await run(body, { client: mock({ signUp: async () => ({ data: {}, error: { code, message: 'private upstream detail' } }) }) });
    assert.equal(result.code, status);
    assert.ok(result.data.error);
    assert.equal(result.data.message, undefined);
    assert.ok(!JSON.stringify(result.data).includes('private upstream detail'));
  }
  assert.equal((await run(body, { client: mock({ signUp: async () => ({ data: {}, error: { status: 429 } }) }) })).code, 429);
});
test('missing Preview key stops signup before client initialization', async () => {
  const result = await run({ action: 'register' }, { env: { VITE_SUPABASE_PUBLISHABLE_KEY: '' }, factory: () => assert.fail('must not reach Supabase') });
  assert.equal(result.code, 503);
  assert.match(result.data.error, /Preview branch and redeploy/);
});


test('signup diagnostics log only allowlisted codes and numeric HTTP statuses', async () => {
  const body = { ...login, action: 'register', accountType: 'personal', displayName: 'Test' };
  for (const [code, status, expectedCode, expectedStatus] of [
    ['unexpected_failure', 500, 'unexpected_failure', 500],
    ['email_address_not_authorized', 403, 'email_address_not_authorized', 403],
    ['over_email_send_rate_limit', 429, 'over_email_send_rate_limit', 429],
    ['hook_timeout', 500, 'hook_timeout', 500],
    ['private@example.test', 'secret-status', 'unclassified', null],
    [undefined, 999, 'unclassified', null],
  ]) {
    const entries = [];
    const result = await run(body, { diagnostic: (entry) => entries.push(entry),
      client: mock({ signUp: async () => ({ data: {}, error: { code, status,
        message: 'private upstream detail', email: body.email, password: body.password, token: 'secret' } }) }) });
    assert.deepEqual(entries, [{ event: 'myops_signup_error', code: expectedCode, status: expectedStatus }]);
    assert.equal(result.code, status === 429 ? 429 : 502);
    assert.ok(!JSON.stringify(result.data).includes(expectedCode));
  }
});
test('successful signup and Production rejection produce no signup diagnostics', async () => {
  const entries = [];
  const diagnostic = (entry) => entries.push(entry);
  const body = { ...login, action: 'register', accountType: 'personal', displayName: 'Test' };
  assert.equal((await run(body, { diagnostic })).code, 200);
  assert.equal((await run(body, { diagnostic, env: { VERCEL_ENV: 'production' } })).code, 404);
  assert.deepEqual(entries, []);
});
test('failed diagnostic sink cannot change signup error response', async () => {
  const result = await run({ ...login, action: 'register', accountType: 'personal', displayName: 'Test' }, {
    diagnostic: () => { throw new Error('sink unavailable'); },
    client: mock({ signUp: async () => ({ data: {}, error: { code: 'unexpected_failure', status: 500 } }) }),
  });
  assert.equal(result.code, 502);
});
test('signup SDK destination is exactly the dedicated staging project', async () => {
  let destination;
  const result = await run({ ...login, action: 'register', accountType: 'personal', displayName: 'Test' }, {
    factory: (url) => { destination = url; return mock(); },
  });
  assert.equal(result.code, 200);
  assert.equal(destination, 'https://uhuukcztdifvpjuopdea.supabase.co');
});


test('invalid upstream email returns actionable 400 without leaking upstream details', async () => {
  const entries = [];
  const result = await run({ ...login, action: 'register', accountType: 'personal', displayName: 'Test' }, {
    diagnostic: (entry) => entries.push(entry),
    client: mock({ signUp: async () => ({ data: {}, error: {
      code: 'email_address_invalid', status: 400, message: 'private upstream detail',
    } }) }),
  });
  assert.equal(result.code, 400);
  assert.deepEqual(result.data, { error: 'Use a valid email address with a real inbox. Example and test domains are not supported.' });
  assert.deepEqual(entries, [{ event: 'myops_signup_error', code: 'email_address_invalid', status: 400 }]);
});

test('recovery does not report email success for upstream outages or disabled email provider', async () => {
  for (const [error, expected] of [
    [{ status: 500, message: 'private SMTP detail' }, 502],
    [{ status: 503 }, 502],
    [{ code: 'email_provider_disabled', status: 400 }, 503],
    [{ status: 429 }, 429],
  ]) {
    const result = await run({ action: 'forgot', email: user.email }, {
      client: mock({ resetPasswordForEmail: async () => ({ error }) }),
    });
    assert.equal(result.code, expected);
    assert.ok(result.data.error);
    assert.equal(result.data.message, undefined);
    assert.ok(!JSON.stringify(result.data).includes('private SMTP detail'));
  }
});
