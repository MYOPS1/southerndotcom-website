import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthHandler, enforceWorkerRateLimit, signActivity, signIdentity, signLogin, verifiedLogin, verifiedIdentity, signPending, verifiedPending, resolveProductStates } from '../server/auth.js';
import { createClient } from '@supabase/supabase-js';

const origin = 'https://trusted-preview.vercel.app';
const env = { VERCEL_ENV: 'preview', VERCEL_BRANCH_URL: 'trusted-preview.vercel.app', MYOPS_SESSION_SECRET: 's'.repeat(40),
  VITE_SUPABASE_URL: 'https://uhuukcztdifvpjuopdea.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_fixture' };
const NOW = Date.now();
const LOGIN_ID = '7c1f0a52-3b6e-4d58-9a41-0e2d5b8c9f13';
const loginCookie = (id = user.id, loginId = LOGIN_ID, ageMs = 0) => `__Host-myops-login=${signLogin(env.MYOPS_SESSION_SECRET, id, loginId, NOW - ageMs)}`;
const signedIn = (ageMs = 0) => `__Host-myops-access=test-access-token; __Host-myops-activity=${signActivity(env.MYOPS_SESSION_SECRET, NOW - ageMs)}; ${loginCookie()}`;
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
  await createAuthHandler({ env: { ...env, ...options.env }, clientFactory: options.factory || (() => options.client || mock()),
    appAccessFactory: options.appAccessFactory && ((args) => ({ startLogin: async () => LOGIN_ID, touchLogin: async () => true, ...options.appAccessFactory(args) })),
    transport: options.transport, now: () => NOW, diagnostic: options.diagnostic || (() => {}) })(req, res);
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
  assert.deepEqual(result.data, { next: '/' });
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
  const tables = [];
  const subscriptionData = withData();
  client.from = (table) => { tables.push(table); return subscriptionData.from(table); };
  const result = await run({ action: 'account', userId: 'other-user' }, { client, headers: { cookie: signedIn() } });
  assert.ok(!tables.includes('myops_profiles'), 'account details must not depend on an unapproved profile table');
  assert.deepEqual(result.data, { email: user.email, profile: { display_name: 'A Person', account_type: 'business' },
    products: { opsp: 'none', opsfinance: 'none', opsflow: 'none', opswms: 'coming_soon', opshr: 'coming_soon' }, lifetime: false });
});
test('onboarding saves only descriptive metadata through the verified user and grants no role', async () => {
  let request;
  const client = mock();
  client.rpc = () => assert.fail('onboarding must not call an unapproved provisioning RPC');
  client.from = () => assert.fail('onboarding must not depend on an unapproved profile table');
  const result = await run({ action: 'profile', displayName: 'A Person', accountType: 'business', role: 'admin' }, {
    client,
    headers: { cookie: signedIn() },
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
  const headers = { cookie: signedIn() };
  assert.equal((await run({ action: 'profile', displayName: 'A Person', accountType: 'admin' }, { headers })).code, 400);
  const result = await run({ action: 'profile', displayName: 'A Person', accountType: 'personal' }, {
    headers, transport: async () => ({ ok: false }),
  });
  assert.equal(result.code, 503);
});
test('password update uses authenticated upstream, revokes refresh sessions and clears cookie', async () => {
  let request;
  const result = await run({ action: 'reset', password: 'new-staging-password' }, {
    headers: { cookie: signedIn() },
    transport: async (url, init) => { request = { url, ...init }; return { ok: true }; },
  });
  assert.equal(result.code, 200);
  assert.equal(request.method, 'PUT');
  assert.equal(request.headers.Authorization, 'Bearer test-access-token');
  assert.match(result.headers['Set-Cookie'][0], /Max-Age=0/);
});
test('logout clears browser cookies without echoing credentials', async () => {
  const result = await run({ action: 'logout' }, { headers: { cookie: signedIn() } });
  assert.equal(result.code, 200);
  assert.ok(result.headers['Set-Cookie'].every((c) => c.includes('Max-Age=0')));
  assert.deepEqual(result.data, { next: '/' });
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

// ---- Homepage-first flow: redirects, inactivity, entitlements -------------------------------
const day = 24 * 3600 * 1000;
const catalog = [
  { slug: 'opsp', launch_status: 'live' }, { slug: 'opsfinance', launch_status: 'live' },
  { slug: 'opsflow', launch_status: 'live' }, { slug: 'opswms', launch_status: 'coming_soon' },
  { slug: 'opshr', launch_status: 'coming_soon' },
];
const personal = (extra) => ({ personal_user_id: user.id, organization_id: null, product_slug: 'opsp',
  is_complete_bundle: false, status: 'active', current_period_end: new Date(NOW + day).toISOString(), ...extra });
function withData({ subscriptions = [], grants = [], failing } = {}) {
  const client = mock();
  client.from = (table) => {
    const rows = { myops_products: catalog, myops_subscriptions: subscriptions, myops_app_grants: grants }[table];
    const query = { select: () => query, eq: () => query,
      then: (resolve) => resolve(failing === table ? { data: null, error: { code: 'x' } } : { data: rows, error: null }) };
    return query;
  };
  return client;
}
const launchEnv = { MYOPS_APP_URL_OPSP: 'https://app.example.test/opsp' };

test('login and confirmed email callback land on the homepage; recovery goes to password update', async () => {
  const loginResult = await run(login);
  assert.deepEqual(loginResult.data, { next: '/' });
  const callback = await run({ action: 'callback', code: 'c' }, { headers: { cookie: '__Host-myops-pkce=v' },
    client: mock({ exchangeCodeForSession: async () => ({ data: { session, redirectType: 'signup' }, error: null }) }) });
  assert.equal(callback.code, 200);
  assert.deepEqual(callback.data, { next: '/' });
  assert.ok(callback.headers['Set-Cookie'].some((c) => c.startsWith('__Host-myops-activity=')));
});
test('registration never lands on the homepage as signed in without a confirmed email session', async () => {
  const unconfirmed = mock({
    exchangeCodeForSession: async () => ({ data: { session, redirectType: 'signup' }, error: null }),
    getUser: async () => ({ data: { user: { ...user, email_confirmed_at: null } }, error: null }),
  });
  const result = await run({ action: 'callback', code: 'c' }, { headers: { cookie: '__Host-myops-pkce=v' }, client: unconfirmed });
  assert.equal(result.code, 400);
  assert.equal(result.data.next, undefined);
  assert.ok(result.headers['Set-Cookie'].every((c) => !c.startsWith('__Host-myops-access=') && !c.startsWith('__Host-myops-activity=')));
});
test('login requires the server session secret', async () => {
  const result = await run(login, { env: { MYOPS_SESSION_SECRET: 'short' }, factory: () => assert.fail('no upstream call') });
  assert.equal(result.code, 503);
});
test('session probe: signed-out visitors get a signed-out state without error', async () => {
  const result = await run({ action: 'session' });
  assert.equal(result.code, 200);
  assert.deepEqual(result.data, { signedIn: false });
});
test('session probe: signed-in users get email and product states, never tokens', async () => {
  const result = await run({ action: 'session' }, { headers: { cookie: signedIn() },
    client: withData({ subscriptions: [personal()] }) });
  assert.equal(result.code, 200);
  assert.deepEqual(result.data, { signedIn: true, email: user.email,
    products: { opsp: 'active', opsfinance: 'none', opsflow: 'none', opswms: 'coming_soon', opshr: 'coming_soon' }, lifetime: false });
  assert.ok(!JSON.stringify(result.data).includes('test-access-token'));
});
test('15-minute inactivity is enforced server-side for every protected action', async () => {
  const stale = { cookie: signedIn(15 * 60 * 1000 + 1) };
  for (const action of ['account', 'profile', 'reset', 'launch']) {
    const result = await run({ action, product: 'opsp' }, { headers: stale, client: withData({ subscriptions: [personal()] }) });
    assert.equal(result.code, 401, action);
    assert.equal(result.data.reason, 'inactive');
    assert.ok(result.headers['Set-Cookie'].some((c) => c.startsWith('__Host-myops-access=;')));
    assert.ok(setCookies(result).some((c) => c.startsWith('__Host-myops-revoke=') && !c.includes('Max-Age=0')));
  }
  const probe = await run({ action: 'session' }, { headers: stale });
  assert.deepEqual(probe.data, { signedIn: false });
  assert.ok(probe.headers['Set-Cookie'].some((c) => c.startsWith('__Host-myops-access=;')));
  assert.ok(pendingSet(probe));
});
test('activity just inside the window is accepted and refreshed; passive probes do not refresh', async () => {
  const recent = { cookie: signedIn(14 * 60 * 1000) };
  const active = await run({ action: 'account' }, { headers: recent, client: withData() });
  assert.equal(active.code, 200);
  assert.ok(active.headers['Set-Cookie'].some((c) => c.startsWith('__Host-myops-activity=') && !c.includes('Max-Age=0')));
  const passive = await run({ action: 'session', activity: false }, { headers: recent, client: withData() });
  assert.equal(passive.data.signedIn, true);
  assert.equal(passive.headers['Set-Cookie'], undefined);
});
test('forged, unsigned, missing or future activity cookies are rejected', async () => {
  const access = '__Host-myops-access=test-access-token';
  const forged = `${NOW}.${'A'.repeat(43)}`;
  const future = signActivity(env.MYOPS_SESSION_SECRET, NOW + 60_000);
  const otherSecret = signActivity('x'.repeat(40), NOW);
  for (const cookie of [access, `${access}; __Host-myops-activity=${NOW}`, `${access}; __Host-myops-activity=${forged}`,
    `${access}; __Host-myops-activity=${future}`, `${access}; __Host-myops-activity=${otherSecret}`]) {
    assert.equal((await run({ action: 'account' }, { headers: { cookie } })).code, 401);
  }
});
test('launch rejects anonymous callers, cross-origin requests and unknown products', async () => {
  assert.equal((await run({ action: 'launch', product: 'opsp' })).code, 401);
  assert.equal((await run({ action: 'launch', product: 'opsp' }, { headers: { cookie: signedIn(), origin: 'https://evil.example' } })).code, 403);
  assert.equal((await run({ action: 'launch', product: '../admin' }, { headers: { cookie: signedIn() } })).code, 400);
});
test('launch: no subscription, coming soon, expired and non-active statuses are denied', async () => {
  const headers = { cookie: signedIn() };
  const denied = async (subscriptions, product = 'opsp') => (await run({ action: 'launch', product }, {
    headers, env: launchEnv, client: withData({ subscriptions }) })).code;
  assert.equal(await denied([]), 403);
  assert.equal(await denied([personal({ product_slug: 'opswms' })], 'opswms'), 403);
  assert.equal(await denied([personal({ is_complete_bundle: true, product_slug: null })], 'opshr'), 403);
  assert.equal(await denied([personal({ current_period_end: new Date(NOW - 1000).toISOString() })]), 403);
  for (const status of ['pending', 'past_due', 'canceled', 'expired']) assert.equal(await denied([personal({ status })]), 403, status);
  assert.equal(await denied([personal({ personal_user_id: 'someone-else' })]), 403);
  assert.equal(await denied([personal({ product_slug: 'opsfinance' })]), 403);
});
test('launch: client-supplied entitlement claims are ignored', async () => {
  const result = await run({ action: 'launch', product: 'opsp', entitled: true, status: 'active', userId: 'other', subscription: { status: 'active' } },
    { headers: { cookie: signedIn() }, env: launchEnv, client: withData() });
  assert.equal(result.code, 403);
});
test('launch: active subscription returns only the configured HTTPS destination', async () => {
  const headers = { cookie: signedIn() };
  const ok = await run({ action: 'launch', product: 'opsp' }, { headers, env: launchEnv,
    client: withData({ subscriptions: [personal()] }),
    appAccessFactory: () => ({ issueTicket: async ({ userId, product }) => {
      assert.equal(userId, user.id);
      assert.equal(product, 'opsp');
      return { status: 200, next: 'https://app.example.test/opsp/launch?t=opaque-ticket' };
    } }) });
  assert.equal(ok.code, 200);
  assert.deepEqual(ok.data, { next: 'https://app.example.test/opsp/launch?t=opaque-ticket' });
  for (const MYOPS_APP_URL_OPSP of [undefined, 'http://app.example.test', 'javascript:alert(1)', '//evil.example']) {
    const result = await run({ action: 'launch', product: 'opsp' }, { headers, env: { MYOPS_APP_URL_OPSP }, client: withData({ subscriptions: [personal()] }) });
    assert.equal(result.code, 503);
    assert.equal(result.data.next, undefined);
  }
});
test('launch fails closed when subscription data cannot be read', async () => {
  for (const failing of ['myops_products', 'myops_subscriptions', 'myops_app_grants']) {
    const result = await run({ action: 'launch', product: 'opsp' }, { headers: { cookie: signedIn() }, env: launchEnv,
      client: withData({ subscriptions: [personal()], failing }) });
    assert.equal(result.code, 503);
    assert.equal(result.data.next, undefined);
  }
});
test('MYOPS logout and detected inactivity revoke all app sessions for the verified user', async () => {
  const revoked = [];
  const appAccessFactory = () => ({
    revokeUserSessions: async (userId) => { revoked.push(userId); return true; },
  });
  const loggedOut = await run({ action: 'logout' }, {
    headers: { cookie: signedIn() }, appAccessFactory,
  });
  assert.equal(loggedOut.code, 200);
  assert.deepEqual(revoked, [user.id]);
  const stale = await run({ action: 'account' }, {
    headers: { cookie: signedIn(15 * 60 * 1000 + 1) }, appAccessFactory,
  });
  assert.equal(stale.code, 401);
  assert.deepEqual(revoked, [user.id, user.id]);
});
test('resolveProductStates: bundles, organisation grants and catalog state', () => {
  const states = (subscriptions, grants = []) => resolveProductStates({ userId: user.id, catalog, subscriptions, grants, now: NOW });
  const bundle = states([personal({ is_complete_bundle: true, product_slug: null })]);
  assert.deepEqual(bundle, { opsp: 'active', opsfinance: 'active', opsflow: 'active', opswms: 'coming_soon', opshr: 'coming_soon' });
  const org = { personal_user_id: null, organization_id: 'org-1', product_slug: 'opsfinance', is_complete_bundle: false, status: 'active', current_period_end: null };
  assert.equal(states([org]).opsfinance, 'none');
  assert.equal(states([org], [{ organization_id: 'org-2', product_slug: 'opsfinance' }]).opsfinance, 'none');
  assert.equal(states([org], [{ organization_id: 'org-1', product_slug: 'opsp' }]).opsp, 'none');
  assert.equal(states([org], [{ organization_id: 'org-1', product_slug: 'opsfinance' }]).opsfinance, 'active');
});

const identityCookie = (id = user.id, ageMs = 0) => `__Host-myops-identity=${signIdentity(env.MYOPS_SESSION_SECRET, id, NOW - ageMs)}`;
const expiredToken = mock({
  getUser: async () => ({ data: { user: null }, error: { message: 'jwt expired' } }),
  admin: { signOut: async () => ({ error: { message: 'jwt expired' } }) },
});

test('regression H-1: login stores a server-signed identity that the browser cannot forge', async () => {
  const result = await run(login);
  const identity = result.headers['Set-Cookie'].find((cookie) => cookie.startsWith('__Host-myops-identity='));
  assert.match(identity, /HttpOnly; Secure; SameSite=Lax; Max-Age=43200/);
  const value = decodeURIComponent(identity.split(';')[0].split('=').slice(1).join('='));
  assert.equal(verifiedIdentity(env.MYOPS_SESSION_SECRET, value, NOW), user.id);
  assert.equal(verifiedIdentity(env.MYOPS_SESSION_SECRET, value.replace(user.id, 'other-user'), NOW), null);
  assert.equal(verifiedIdentity('x'.repeat(40), value, NOW), null);
  assert.equal(verifiedIdentity(env.MYOPS_SESSION_SECRET, value, NOW + 12 * 3600 * 1000 + 1), null);
});

test('regression H-1: logout with an expired Supabase token still revokes app access', async () => {
  const revoked = [];
  const appAccessFactory = () => ({ revokeUserSessions: async (id) => { revoked.push(id); return true; } });
  const result = await run({ action: 'logout' }, {
    headers: { cookie: `${signedIn()}; ${identityCookie()}` }, client: expiredToken, appAccessFactory,
  });
  assert.equal(result.code, 200);
  assert.deepEqual(revoked, [user.id]);
  const noToken = await run({ action: 'logout' }, { headers: { cookie: identityCookie() }, appAccessFactory });
  assert.equal(noToken.code, 200);
  assert.deepEqual(revoked, [user.id, user.id]);
});

test('regression H-1: forged, tampered or stale identity cookies never select a user to revoke', async () => {
  const revoked = [];
  const appAccessFactory = () => ({ revokeUserSessions: async (id) => { revoked.push(id); return true; } });
  for (const cookie of ['__Host-myops-identity=victim-user.1.AAAA',
    `__Host-myops-identity=${signIdentity('y'.repeat(40), 'victim-user', NOW)}`,
    identityCookie('victim-user', 13 * 3600 * 1000)]) {
    assert.equal((await run({ action: 'logout' }, { headers: { cookie }, appAccessFactory })).code, 200);
  }
  assert.deepEqual(revoked, []);
});

test('regression H-1: inactivity and an expired token revoke app access even without a usable token', async () => {
  const revoked = [];
  const appAccessFactory = () => ({ revokeUserSessions: async (id) => { revoked.push(id); return true; } });
  const idle = await run({ action: 'session' }, {
    headers: { cookie: `__Host-myops-activity=${signActivity(env.MYOPS_SESSION_SECRET, NOW - 16 * 60 * 1000)}; ${identityCookie()}` },
    appAccessFactory,
  });
  assert.equal(idle.code, 200);
  assert.deepEqual(idle.data, { signedIn: false });
  assert.deepEqual(revoked, [user.id]);
  const expired = await run({ action: 'account' }, {
    headers: { cookie: `${signedIn()}; ${identityCookie()}` }, client: expiredToken, appAccessFactory,
  });
  assert.equal(expired.code, 401);
  assert.deepEqual(revoked, [user.id, user.id]);
  assert.ok(expired.headers['Set-Cookie'].some((cookie) => cookie.startsWith('__Host-myops-identity=;')));
});

test('regression H-1: a failed app-access revocation fails closed and still clears cookies', async () => {
  const appAccessFactory = () => ({ revokeUserSessions: async () => { throw new Error('app_access_unavailable'); } });
  const result = await run({ action: 'logout' }, { headers: { cookie: `${signedIn()}; ${identityCookie()}` }, appAccessFactory });
  assert.equal(result.code, 500);
  assert.ok(result.headers['Set-Cookie'].some((cookie) => cookie.startsWith('__Host-myops-access=;')));
  const idle = await run({ action: 'account' }, {
    headers: { cookie: `${signedIn(15 * 60 * 1000 + 1)}; ${identityCookie()}` }, appAccessFactory });
  assert.equal(idle.code, 401, 'stale cookies do not produce repeated 500s');
  assert.ok(idle.headers['Set-Cookie'].some((cookie) => cookie.startsWith('__Host-myops-revoke=') && !cookie.includes('Max-Age=0')));
});

const pendingCookie = (id = user.id, ageMs = 0) => `__Host-myops-revoke=${signPending(env.MYOPS_SESSION_SECRET, id, NOW - ageMs)}`;
const setCookies = (result) => result.headers['Set-Cookie'] || [];
const pendingSet = (result) => setCookies(result).find((cookie) => cookie.startsWith('__Host-myops-revoke=') && !cookie.includes('Max-Age=0'));
const pendingCleared = (result) => setCookies(result).some((cookie) => cookie.startsWith('__Host-myops-revoke=;'));
function flaky() {
  const state = { down: true, calls: [] };
  const appAccessFactory = () => ({ revokeUserSessions: async (id) => {
    state.calls.push(id);
    if (state.down) throw new Error('app_access_down');
    return true;
  } });
  return { state, appAccessFactory };
}

test('M-1: failed logout revocation is never reported as success and queues a signed retry', async () => {
  const { appAccessFactory } = flaky();
  const result = await run({ action: 'logout' }, { headers: { cookie: `${signedIn()}; ${identityCookie()}` }, appAccessFactory });
  assert.equal(result.code, 500);
  assert.ok(pendingSet(result), 'pending marker set');
  assert.ok(setCookies(result).some((cookie) => cookie.startsWith('__Host-myops-access=;')));
  const pending = decodeURIComponent(pendingSet(result).split(';')[0].split('=').slice(1).join('='));
  assert.equal(verifiedPending(env.MYOPS_SESSION_SECRET, pending, NOW), user.id);
  assert.equal(verifiedIdentity(env.MYOPS_SESSION_SECRET, pending, NOW), null, 'pending and identity cookies are not interchangeable');
});

test('M-1: retry succeeds after recovery and the pending marker is cleared; repeated logout is idempotent', async () => {
  const { state, appAccessFactory } = flaky();
  const first = await run({ action: 'logout' }, { headers: { cookie: identityCookie() }, appAccessFactory });
  assert.equal(first.code, 500);
  const stillDown = await run({ action: 'logout' }, { headers: { cookie: pendingCookie() }, appAccessFactory });
  assert.equal(stillDown.code, 500);
  assert.ok(pendingSet(stillDown));
  state.down = false;
  const recovered = await run({ action: 'session' }, { headers: { cookie: pendingCookie() }, appAccessFactory });
  assert.equal(recovered.code, 200);
  assert.deepEqual(recovered.data, { signedIn: false });
  assert.ok(pendingCleared(recovered));
  state.calls.length = 0;
  for (let i = 0; i < 2; i++) {
    const again = await run({ action: 'logout' }, { headers: { cookie: identityCookie() }, appAccessFactory });
    assert.equal(again.code, 200);
    assert.equal(pendingSet(again), undefined);
  }
  assert.ok(state.calls.every((id) => id === user.id));
});

test('M-1: stale cookies during an outage do not cause repeated 500s and stay queued', async () => {
  const { appAccessFactory } = flaky();
  for (const action of ['session', 'account']) {
    const result = await run({ action }, {
      headers: { cookie: `__Host-myops-activity=${signActivity(env.MYOPS_SESSION_SECRET, NOW - 20 * 60 * 1000)}; ${signedIn(0).split('; ')[0]}; ${identityCookie()}` }, appAccessFactory });
    assert.equal(result.code, action === 'session' ? 200 : 401);
    assert.ok(pendingSet(result));
  }
});

test('M-1: pending retry runs on any request and blocks sign-in until it succeeds (fail closed)', async () => {
  const { state, appAccessFactory } = flaky();
  const blocked = await run(login, { headers: { cookie: pendingCookie() }, appAccessFactory });
  assert.equal(blocked.code, 503);
  assert.equal(setCookies(blocked).some((cookie) => cookie.startsWith('__Host-myops-access=') && !cookie.includes('Max-Age=0')), false);
  state.down = false;
  const ok = await run(login, { headers: { cookie: pendingCookie() }, appAccessFactory });
  assert.equal(ok.code, 200);
  assert.ok(pendingCleared(ok));
  assert.ok(state.calls.includes(user.id));
});

test('M-1: forged, wrong-secret, stale or identity-cookie pending markers are ignored and discarded', async () => {
  const { state, appAccessFactory } = flaky();
  state.down = false;
  for (const cookie of ['__Host-myops-revoke=victim.1.AAAA',
    `__Host-myops-revoke=${signPending('z'.repeat(40), 'victim', NOW)}`,
    pendingCookie('victim', 25 * 3600 * 1000),
    `__Host-myops-revoke=${signIdentity(env.MYOPS_SESSION_SECRET, 'victim', NOW)}`]) {
    const result = await run({ action: 'session' }, { headers: { cookie }, appAccessFactory });
    assert.equal(result.code, 200);
    assert.ok(pendingCleared(result));
  }
  assert.deepEqual(state.calls, []);
});

// ---- Durable login-session binding ----
const loginCalls = () => {
  const state = { started: [], touched: [], revoked: [], issued: [], live: true, startId: LOGIN_ID };
  const appAccessFactory = () => ({
    startLogin: async (id) => { state.started.push(id); return state.startId; },
    touchLogin: async (id, loginId) => { state.touched.push([id, loginId]); return state.live; },
    revokeUserSessions: async (id, options) => { state.revoked.push([id, options]); return true; },
    issueTicket: async (args) => { state.issued.push(args); return { status: 200, next: 'https://app.example.test/opsp/launch#t=opaque' }; },
  });
  return { state, appAccessFactory };
};
const loginSet = (result) => setCookies(result).find((cookie) => cookie.startsWith('__Host-myops-login=') && !cookie.includes('Max-Age=0'));
const launchRows = () => withData({ subscriptions: [personal()] });

test('login binding: sign-in creates a server-side login record and a signed, user-bound cookie', async () => {
  const { state, appAccessFactory } = loginCalls();
  const result = await run(login, { appAccessFactory });
  assert.equal(result.code, 200);
  assert.deepEqual(state.started, [user.id]);
  const value = decodeURIComponent(loginSet(result).split(';')[0].split('=').slice(1).join('='));
  assert.deepEqual(verifiedLogin(env.MYOPS_SESSION_SECRET, value, NOW), { userId: user.id, loginSessionId: LOGIN_ID });
  assert.match(loginSet(result), /HttpOnly; Secure; SameSite=Lax/);
  assert.equal(verifiedLogin(env.MYOPS_SESSION_SECRET, value.replace(user.id, 'other-user'), NOW), null, 'cannot retarget the cookie');
  assert.equal(verifiedLogin('x'.repeat(40), value, NOW), null, 'wrong secret');
  assert.equal(verifiedLogin(env.MYOPS_SESSION_SECRET, value, NOW + 13 * 3600 * 1000), null, 'expired');
});

test('login binding: if the login record cannot be created, sign-in works but launch fails closed', async () => {
  const { state, appAccessFactory } = loginCalls();
  state.startId = null;
  const result = await run(login, { appAccessFactory });
  assert.equal(result.code, 200);
  assert.equal(loginSet(result), undefined);
  const launch = await run({ action: 'launch', product: 'opsp' }, { headers: { cookie: signedIn().replace(/; __Host-myops-login=.*/, '') },
    env: launchEnv, client: launchRows(), appAccessFactory });
  assert.equal(launch.code, 401);
  assert.equal(state.issued.length, 0);
});

test('login binding: launch needs a verified login cookie that belongs to the verified user', async () => {
  for (const extra of [loginCookie('someone-else'), '__Host-myops-login=forged.value', `__Host-myops-login=${signLogin('y'.repeat(40), user.id, LOGIN_ID, NOW)}`]) {
    const { state, appAccessFactory } = loginCalls();
    const base = signedIn().replace(/; __Host-myops-login=.*/, '');
    const result = await run({ action: 'launch', product: 'opsp' }, { headers: { cookie: `${base}; ${extra}` }, env: launchEnv, client: launchRows(), appAccessFactory });
    assert.equal(result.code, 401, extra);
    assert.equal(state.issued.length, 0);
  }
  const { state, appAccessFactory } = loginCalls();
  const ok = await run({ action: 'launch', product: 'opsp', loginSessionId: 'attacker-supplied' }, { headers: { cookie: signedIn() }, env: launchEnv, client: launchRows(), appAccessFactory });
  assert.equal(ok.code, 200);
  assert.deepEqual(state.issued, [{ userId: user.id, product: 'opsp', loginSessionId: LOGIN_ID }], 'browser-supplied ids are ignored');
});

test('login binding: user activity is recorded server-side, passive probes are not, and a dead login ends the session', async () => {
  const { state, appAccessFactory } = loginCalls();
  await run({ action: 'session' }, { headers: { cookie: signedIn() }, appAccessFactory });
  assert.deepEqual(state.touched, [[user.id, LOGIN_ID]]);
  await run({ action: 'session', activity: false }, { headers: { cookie: signedIn() }, appAccessFactory });
  assert.equal(state.touched.length, 1, 'passive polling is not MYOPS user activity');

  state.live = false;
  const ended = await run({ action: 'account' }, { headers: { cookie: signedIn() }, appAccessFactory });
  assert.equal(ended.code, 401);
  assert.equal(ended.data.reason, 'inactive');
  assert.ok(setCookies(ended).some((cookie) => cookie.startsWith('__Host-myops-access=') && cookie.includes('Max-Age=0')));
  assert.ok(setCookies(ended).some((cookie) => cookie.startsWith('__Host-myops-login=') && cookie.includes('Max-Age=0')));
  assert.deepEqual(state.revoked.at(-1), [user.id, { loginSessionId: LOGIN_ID, reason: 'inactivity' }]);

  const unknown = loginCalls();
  unknown.appAccessFactory = () => ({ touchLogin: async () => null, revokeUserSessions: async () => true });
  const stillIn = await run({ action: 'session' }, { headers: { cookie: signedIn() }, appAccessFactory: unknown.appAccessFactory });
  assert.equal(stillIn.data.signedIn, true, 'a transient lookup failure does not log the user out');
});

test('login binding: logout revokes only this login session; password reset revokes all; repeats are safe', async () => {
  const { state, appAccessFactory } = loginCalls();
  for (let i = 0; i < 2; i += 1) {
    const out = await run({ action: 'logout' }, { headers: { cookie: signedIn() }, appAccessFactory });
    assert.equal(out.code, 200);
  }
  assert.deepEqual(state.revoked, [[user.id, { loginSessionId: LOGIN_ID, reason: 'logout' }], [user.id, { loginSessionId: LOGIN_ID, reason: 'logout' }]]);
  state.revoked.length = 0;
  const reset = await run({ action: 'reset', password: 'a-new-long-password' }, { headers: { cookie: signedIn() }, appAccessFactory,
    transport: async () => ({ ok: true, json: async () => ({}) }) });
  assert.equal(reset.code, 200);
  assert.deepEqual(state.revoked, [[user.id, { reason: 'password_reset' }]], 'user-wide, no login id');
});

test('login binding: a failed per-login revocation queues a user-wide retry and never reports success', async () => {
  const state = { down: true, calls: [] };
  const appAccessFactory = () => ({ revokeUserSessions: async (id, options) => {
    state.calls.push([id, options]);
    if (state.down) throw new Error('app_access_unavailable');
    return true;
  } });
  const failed = await run({ action: 'logout' }, { headers: { cookie: signedIn() }, appAccessFactory });
  assert.equal(failed.code, 500);
  assert.ok(pendingSet(failed));
  state.down = false;
  const retry = await run({ action: 'session' }, { headers: { cookie: pendingCookie() }, appAccessFactory });
  assert.equal(retry.code, 200);
  assert.deepEqual(state.calls.at(-1), [user.id, { reason: 'logout' }], 'retry is user-wide without a login id');
});

const workerSecret = 'myops-worker-secret-32chars';
async function runWorker({ headers = {}, env = {}, processRevocations = async () => ({ processed: 0, retried: 0, retry_failed: 0, expired_logins: 0, revoked_app_sessions: 0, revoked_tickets: 0, deleted_logins: 0, queued: 0, status: 'ok' }), batch = 200 } = {}) {
  return run({ action: 'revocation-worker', batch }, {
    env: { ...env, MYOPS_CRON_SECRET: workerSecret },
    headers: { ...headers },
    appAccessFactory: () => ({ processRevocations }),
  });
}

test('worker: missing authorization is rejected', async () => {
  const result = await runWorker({ processRevocations: async () => assert.fail('worker should not run without auth') });
  assert.equal(result.code, 401);
});

test('worker: incorrect authorization is rejected', async () => {
  const result = await runWorker({
    headers: { 'x-myops-cron-secret': 'wrong-secret-not-valid-xyz' },
    processRevocations: async () => assert.fail('worker should not run with bad auth'),
  });
  assert.equal(result.code, 401);
});

test('worker: valid authorization executes and returns safe aggregate metrics', async () => {
  let called = 0;
  const result = await runWorker({
    headers: { 'x-myops-cron-secret': workerSecret },
    batch: 25,
    processRevocations: async ({ batch: size }) => {
      called += 1;
      assert.equal(size, 25);
      return { processed: 12, retried: 7, retry_failed: 2, expired_logins: 3, revoked_app_sessions: 4, revoked_tickets: 5, deleted_logins: 1, queued: 1, status: 'ok' };
    },
  });
  assert.equal(result.code, 200);
  assert.equal(called, 1);
  assert.deepEqual(result.data, {
    ok: true,
    processed: 12,
    retried: 7,
    retry_failed: 2,
    expired_logins: 3,
    revoked_app_sessions: 4,
    revoked_tickets: 5,
    deleted_logins: 1,
    queued: 1,
    status: 'ok',
  });
});

test('worker: execution timeout fails closed without false success', async () => {
  const result = await runWorker({
    env: { MYOPS_REVOCATION_TIMEOUT_MS: '5' },
    headers: { 'x-myops-cron-secret': workerSecret },
    processRevocations: async ({ signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({
        processed: 1, retried: 0, retry_failed: 0, expired_logins: 0, revoked_app_sessions: 0, revoked_tickets: 0, deleted_logins: 0, queued: 0, status: 'ok',
      }), 100);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('timeout'));
      }, { once: true });
    }),
  });
  assert.equal(result.code, 504);
  assert.equal(result.data.error, 'Revocation worker timed out.');
});

test('worker: aborted database operation is reported as a timeout, not a success', async () => {
  const result = await runWorker({
    env: { MYOPS_REVOCATION_TIMEOUT_MS: '25' },
    headers: { 'x-myops-cron-secret': workerSecret },
    processRevocations: async ({ signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({
        processed: 1, retried: 0, retry_failed: 0, expired_logins: 0, revoked_app_sessions: 0, revoked_tickets: 0, deleted_logins: 0, queued: 0, status: 'ok',
      }), 200);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('timeout'));
      }, { once: true });
    }),
  });
  assert.equal(result.code, 504);
  assert.equal(result.data.error, 'Revocation worker timed out.');
});

test('worker: repeated authenticated requests are rate limited before queue work', async () => {
  const ip = '198.51.100.77';
  let calls = 0;
  const processRevocations = async () => {
    calls += 1;
    return { processed: 1, retried: 0, retry_failed: 0, expired_logins: 0, revoked_app_sessions: 0, revoked_tickets: 0, deleted_logins: 0, queued: 0, status: 'ok' };
  };
  const first = await runWorker({
    headers: { 'x-myops-cron-secret': workerSecret, 'x-forwarded-for': ip },
    env: { MYOPS_WORKER_RATE_LIMIT_MAX: '2', MYOPS_WORKER_RATE_LIMIT_WINDOW_MS: '60000' },
    processRevocations,
  });
  const second = await runWorker({
    headers: { 'x-myops-cron-secret': workerSecret, 'x-forwarded-for': ip },
    env: { MYOPS_WORKER_RATE_LIMIT_MAX: '2', MYOPS_WORKER_RATE_LIMIT_WINDOW_MS: '60000' },
    processRevocations,
  });
  const third = await runWorker({
    headers: { 'x-myops-cron-secret': workerSecret, 'x-forwarded-for': ip },
    env: { MYOPS_WORKER_RATE_LIMIT_MAX: '2', MYOPS_WORKER_RATE_LIMIT_WINDOW_MS: '60000' },
    processRevocations,
  });
  assert.equal(first.code, 200);
  assert.equal(second.code, 200);
  assert.equal(third.code, 429);
  assert.equal(third.data.retry_after_seconds > 0, true);
  assert.equal(calls, 2, 'blocked requests must not reach queue processing');
});

test('worker: invalid-secret flood is rate limited before database access', async () => {
  const ip = '198.51.100.78';
  let calls = 0;
  const processRevocations = async () => {
    calls += 1;
    return { processed: 0, retried: 0, retry_failed: 0, expired_logins: 0, revoked_app_sessions: 0, revoked_tickets: 0, deleted_logins: 0, queued: 0, status: 'ok' };
  };
  const first = await runWorker({ headers: { 'x-myops-cron-secret': 'bad-secret', 'x-forwarded-for': ip }, processRevocations, env: { MYOPS_WORKER_RATE_LIMIT_MAX: '2', MYOPS_WORKER_RATE_LIMIT_WINDOW_MS: '60000' } });
  const second = await runWorker({ headers: { 'x-myops-cron-secret': 'bad-secret', 'x-forwarded-for': ip }, processRevocations, env: { MYOPS_WORKER_RATE_LIMIT_MAX: '2', MYOPS_WORKER_RATE_LIMIT_WINDOW_MS: '60000' } });
  const third = await runWorker({ headers: { 'x-myops-cron-secret': 'bad-secret', 'x-forwarded-for': ip }, processRevocations, env: { MYOPS_WORKER_RATE_LIMIT_MAX: '2', MYOPS_WORKER_RATE_LIMIT_WINDOW_MS: '60000' } });
  assert.equal(first.code, 401);
  assert.equal(second.code, 401);
  assert.equal(third.code, 429);
  assert.equal(calls, 0, 'invalid auth floods must not reach the queue');
});

test('worker: rate limit resets when the window expires', () => {
  const start = Date.now();
  const first = enforceWorkerRateLimit({ env: { MYOPS_WORKER_RATE_LIMIT_MAX: '1', MYOPS_WORKER_RATE_LIMIT_WINDOW_MS: '1000' }, headers: { 'x-forwarded-for': '198.51.100.88' }, now: () => start });
  const second = enforceWorkerRateLimit({ env: { MYOPS_WORKER_RATE_LIMIT_MAX: '1', MYOPS_WORKER_RATE_LIMIT_WINDOW_MS: '1000' }, headers: { 'x-forwarded-for': '198.51.100.88' }, now: () => start + 500 });
  const third = enforceWorkerRateLimit({ env: { MYOPS_WORKER_RATE_LIMIT_MAX: '1', MYOPS_WORKER_RATE_LIMIT_WINDOW_MS: '1000' }, headers: { 'x-forwarded-for': '198.51.100.88' }, now: () => start + 1500 });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(third.ok, true);
  assert.equal(third.retryAfter, 0);
});

test('worker: database unavailable fails closed', async () => {
  const result = await runWorker({
    headers: { 'x-myops-cron-secret': workerSecret },
    processRevocations: async () => { throw new Error('database unavailable'); },
  });
  assert.equal(result.code, 503);
  assert.equal(result.data.error, 'Revocation worker is unavailable.');
});

test('worker: empty queue returns zero counts and success status', async () => {
  const result = await runWorker({
    headers: { 'x-myops-cron-secret': workerSecret },
    processRevocations: async () => ({ processed: 0, retried: 0, retry_failed: 0, expired_logins: 0, revoked_app_sessions: 0, revoked_tickets: 0, deleted_logins: 0, queued: 0, status: 'empty' }),
  });
  assert.equal(result.code, 200);
  assert.equal(result.data.status, 'empty');
  assert.equal(result.data.processed, 0);
});

test('worker: pending retry metrics are safe and query-safe', async () => {
  const result = await runWorker({
    headers: { authorization: `Bearer ${workerSecret}` },
    processRevocations: async () => ({ processed: 1, retried: 1, retry_failed: 0, expired_logins: 1, revoked_app_sessions: 1, revoked_tickets: 1, deleted_logins: 0, queued: 1, status: 'retry_pending' }),
  });
  assert.equal(result.code, 200);
  assert.equal(result.data.status, 'retry_pending');
  assert.equal(result.data.retried, 1);
  assert.equal(result.data.queued, 1);
});

test('worker: duplicate execution does not mutate the result payload', async () => {
  const processRevocations = async () => ({ processed: 4, retried: 2, retry_failed: 0, expired_logins: 2, revoked_app_sessions: 2, revoked_tickets: 2, deleted_logins: 0, queued: 0, status: 'ok' });
  const first = await runWorker({ headers: { 'x-myops-cron-secret': workerSecret }, processRevocations });
  const second = await runWorker({ headers: { 'x-myops-cron-secret': workerSecret }, processRevocations });
  assert.equal(first.code, 200);
  assert.equal(second.code, 200);
  assert.deepEqual(first.data, second.data);
});

test('worker: concurrent executions all succeed with correct authorization', async () => {
  const processRevocations = async () => ({ processed: 3, retried: 1, retry_failed: 0, expired_logins: 1, revoked_app_sessions: 1, revoked_tickets: 1, deleted_logins: 0, queued: 0, status: 'ok' });
  const results = await Promise.all([
    runWorker({ headers: { 'x-myops-cron-secret': workerSecret }, processRevocations }),
    runWorker({ headers: { 'x-myops-cron-secret': workerSecret }, processRevocations }),
    runWorker({ headers: { 'x-myops-cron-secret': workerSecret }, processRevocations }),
  ]);
  assert.ok(results.every((result) => result.code === 200));
  assert.ok(results.every((result) => result.data.processed === 3));
});

test('worker: retry cap reached is surfaced without exposing raw queue state', async () => {
  const result = await runWorker({
    headers: { 'x-myops-cron-secret': workerSecret },
    processRevocations: async () => ({ processed: 0, retried: 0, retry_failed: 1, expired_logins: 0, revoked_app_sessions: 0, revoked_tickets: 0, deleted_logins: 0, queued: 0, status: 'retry_cap_reached' }),
  });
  assert.equal(result.code, 200);
  assert.equal(result.data.status, 'retry_cap_reached');
  assert.equal(result.data.retry_failed, 1);
});

test('official domain login requires opt-in and exact www host/origin', async () => {
  const official = 'https://www.myops.com.my';
  const production = { VERCEL_ENV: 'production', MYOPS_ENABLE_PRODUCTION_AUTH: 'true' };
  const headers = { host: 'www.myops.com.my', origin: official };
  const result = await run(login, { env: production, headers });
  assert.equal(result.code, 200);
  assert.equal(result.data.next, '/');
  assert.ok(result.headers['Set-Cookie'].every((cookie) => cookie.includes('HttpOnly; Secure; SameSite=Lax')));
  for (const invalid of [
    { host: 'myops.com.my', origin: 'https://myops.com.my' },
    { host: 'trusted-preview.vercel.app', origin },
    { host: 'www.myops.com.my', origin: 'https://evil.example' },
  ]) assert.equal((await run(login, { env: production, headers: invalid })).code, 403);
  assert.equal((await run(login, { env: { ...production, MYOPS_ENABLE_PRODUCTION_AUTH: 'false' }, headers })).code, 404);
});

test('official-domain recovery callback is fixed and billing/app operations stay disabled', async () => {
  const options = { env: { VERCEL_ENV: 'production', MYOPS_ENABLE_PRODUCTION_AUTH: 'true' },
    headers: { host: 'www.myops.com.my', origin: 'https://www.myops.com.my' } };
  let redirect;
  const result = await run({ action: 'forgot', email: user.email, next: 'https://evil.example' }, {
    ...options, client: mock({ resetPasswordForEmail: async (_email, settings) => { redirect = settings.redirectTo; return { error: null }; } }),
  });
  assert.equal(result.code, 200);
  assert.equal(redirect, 'https://www.myops.com.my/auth/callback');
  for (const action of ['checkout', 'launch', 'admin_audit', 'revocation-worker']) {
    const blocked = await run({ action }, { ...options, client: mock({ getUser: async () => assert.fail('no identity request for disabled actions') }) });
    assert.equal(blocked.code, 404);
  }
  assert.deepEqual((await run({ action: 'founders' }, options)).data, { available: false });
});
