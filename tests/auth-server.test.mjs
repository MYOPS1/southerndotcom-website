import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthHandler, signActivity, resolveProductStates } from '../server/auth.js';
import { createClient } from '@supabase/supabase-js';

const origin = 'https://trusted-preview.vercel.app';
const env = { VERCEL_ENV: 'preview', VERCEL_BRANCH_URL: 'trusted-preview.vercel.app', MYOPS_SESSION_SECRET: 's'.repeat(40),
  VITE_SUPABASE_URL: 'https://uhuukcztdifvpjuopdea.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_fixture' };
const NOW = Date.now();
const signedIn = (ageMs = 0) => `__Host-myops-access=test-access-token; __Host-myops-activity=${signActivity(env.MYOPS_SESSION_SECRET, NOW - ageMs)}`;
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
  await createAuthHandler({ env: { ...env, ...options.env }, clientFactory: options.factory || (() => options.client || mock()), transport: options.transport, now: () => NOW, diagnostic: options.diagnostic || (() => {}) })(req, res);
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
    assert.ok(result.headers['Set-Cookie'].every((c) => c.includes('Max-Age=0')));
  }
  const probe = await run({ action: 'session' }, { headers: stale });
  assert.deepEqual(probe.data, { signedIn: false });
  assert.ok(probe.headers['Set-Cookie'].every((c) => c.includes('Max-Age=0')));
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
  const ok = await run({ action: 'launch', product: 'opsp' }, { headers, env: launchEnv, client: withData({ subscriptions: [personal()] }) });
  assert.equal(ok.code, 200);
  assert.deepEqual(ok.data, { next: 'https://app.example.test/opsp' });
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
