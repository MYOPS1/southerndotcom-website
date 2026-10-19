import { createHmac, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createAppAccess } from './app-access.js';
import { createPayments } from './payments.js';
import { PRODUCT_SLUGS, hasLifetime, resolveProductStates } from './entitlements.js';

const SESSION = '__Host-myops-access';
const VERIFIER = '__Host-myops-pkce';
const ACTIVITY = '__Host-myops-activity';
const IDENTITY = '__Host-myops-identity';
const PENDING = '__Host-myops-revoke';
const LOGIN = '__Host-myops-login';
const PENDING_MAX_MS = 24 * 60 * 60 * 1000;
const IDENTITY_MAX_MS = 12 * 60 * 60 * 1000;
export const INACTIVITY_MS = 15 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT = 'https://uhuukcztdifvpjuopdea.supabase.co';

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return ['', ''];
    try { return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))]; }
    catch { return ['', '']; }
  }));
}

export function signActivity(secret, timestamp) {
  const value = String(timestamp);
  return `${value}.${createHmac('sha256', secret).update(value).digest('base64url')}`;
}

// The activity cookie is HMAC-signed so the browser cannot extend its own session.
function activityValid(secret, cookie, now) {
  if (typeof cookie !== 'string') return false;
  const [value, mac, extra] = cookie.split('.');
  if (extra !== undefined || !/^\d{1,15}$/.test(value || '') || !mac) return false;
  const expected = Buffer.from(signActivity(secret, value));
  const actual = Buffer.from(cookie);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
  const age = now - Number(value);
  return age >= 0 && age <= INACTIVITY_MS;
}

// Server-signed identity bound to the verified login. It lets logout/expiry revoke app access
// even after the Supabase access token has expired; the browser cannot forge or retarget it.
export function signIdentity(secret, userId, issuedAt) {
  const value = `${userId}.${issuedAt}`;
  return `${value}.${createHmac('sha256', secret).update(`identity:${value}`).digest('base64url')}`;
}

export function verifiedIdentity(secret, cookie, now) {
  if (typeof cookie !== 'string' || cookie.length > 200) return null;
  const [userId, issuedAt, mac, extra] = cookie.split('.');
  if (extra !== undefined || !/^[A-Za-z0-9-]{1,64}$/.test(userId || '') || !/^\d{1,15}$/.test(issuedAt || '') || !mac) return null;
  const expected = Buffer.from(signIdentity(secret, userId, issuedAt));
  const actual = Buffer.from(cookie);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  const age = now - Number(issuedAt);
  return age >= 0 && age <= IDENTITY_MAX_MS ? userId : null;
}

// Server-signed pointer to this browser's durable login-session record. It carries no authority by
// itself: every use is re-checked in the database (live, unexpired, owned by the verified user).
export function signLogin(secret, userId, loginSessionId, issuedAt) {
  const value = `${userId}.${loginSessionId}.${issuedAt}`;
  return `${value}.${createHmac('sha256', secret).update(`login:${value}`).digest('base64url')}`;
}

export function verifiedLogin(secret, cookie, now) {
  if (typeof cookie !== 'string' || cookie.length > 300) return null;
  const [userId, loginSessionId, issuedAt, mac, extra] = cookie.split('.');
  if (extra !== undefined || !/^[A-Za-z0-9-]{1,64}$/.test(userId || '') || !UUID.test(loginSessionId || '')
      || !/^\d{1,15}$/.test(issuedAt || '') || !mac) return null;
  const expected = Buffer.from(signLogin(secret, userId, loginSessionId, issuedAt));
  const actual = Buffer.from(cookie);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  const age = now - Number(issuedAt);
  return age >= 0 && age <= IDENTITY_MAX_MS ? { userId, loginSessionId } : null;
}

// A server-signed marker that app-session revocation for this verified user has not yet succeeded.
// It is only ever created from an identity the server already proved, and is retried until it succeeds.
export function signPending(secret, userId, issuedAt) {
  const value = `${userId}.${issuedAt}`;
  return `${value}.${createHmac('sha256', secret).update(`pending:${value}`).digest('base64url')}`;
}

export function verifiedPending(secret, cookie, now) {
  if (typeof cookie !== 'string' || cookie.length > 200) return null;
  const [userId, issuedAt, mac, extra] = cookie.split('.');
  if (extra !== undefined || !/^[A-Za-z0-9-]{1,64}$/.test(userId || '') || !/^\d{1,15}$/.test(issuedAt || '') || !mac) return null;
  const expected = Buffer.from(signPending(secret, userId, issuedAt));
  const actual = Buffer.from(cookie);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  const age = now - Number(issuedAt);
  return age >= 0 && age <= PENDING_MAX_MS ? userId : null;
}

export { PRODUCT_SLUGS, hasLifetime, resolveProductStates };
const SLUG = /^[a-z0-9_]{1,32}$/;

async function loadEntitlements(client, userId, now) {
  const [catalog, subscriptions, grants, lifetime] = await Promise.all([
    client.from('myops_products').select('slug,launch_status'),
    client.from('myops_subscriptions').select('personal_user_id,organization_id,product_slug,is_complete_bundle,status,current_period_end'),
    client.from('myops_app_grants').select('organization_id,product_slug').eq('user_id', userId),
    client.from('myops_lifetime_entitlements').select('user_id,scope,status').eq('user_id', userId),
  ]);
  if (catalog.error || subscriptions.error || grants.error) return null;
  // A failed lifetime read fails closed (no lifetime), e.g. before the Phase 3 SQL is approved.
  const rows = lifetime.error ? [] : lifetime.data || [];
  return {
    products: resolveProductStates({ userId, catalog: catalog.data || [], subscriptions: subscriptions.data || [], grants: grants.data || [], lifetime: rows, now }),
    lifetime: hasLifetime(userId, rows),
  };
}

async function loadProductStates(client, userId, now) {
  return (await loadEntitlements(client, userId, now))?.products ?? null;
}

function profileFrom(user) {
  const metadata = user.user_metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const displayName = metadata.display_name;
  const accountType = metadata.account_type;
  if (typeof displayName !== 'string' || !displayName.trim()
      || !['personal', 'business'].includes(accountType)) return null;
  return { display_name: displayName.trim(), account_type: accountType };
}

// Explicit allowlist: never log arbitrary upstream strings, messages or error objects.
const SIGNUP_ERROR_CODES = new Set([
  'unexpected_failure', 'validation_failed', 'bad_json', 'signup_disabled',
  'email_provider_disabled', 'provider_disabled', 'weak_password', 'user_already_exists',
  'email_exists', 'email_address_not_authorized', 'email_address_invalid',
  'over_request_rate_limit', 'over_email_send_rate_limit', 'captcha_failed',
  'hook_timeout', 'hook_timeout_after_retry', 'hook_payload_over_size_limit',
  'hook_payload_invalid_content_type', 'request_timeout',
]);

export function createAuthHandler({ env = process.env, clientFactory = createClient, appAccessFactory = createAppAccess, transport = fetch, now = Date.now,
  diagnostic = (entry) => console.warn(JSON.stringify(entry)) } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status, body) => res.status(status).json(body);
    // Do not enable auth on production even if someone adds production variables.
    if (env.VERCEL_ENV !== 'preview') return reply(404, { error: 'Authentication is Preview-only.' });
    const origin = env.VERCEL_BRANCH_URL ? `https://${env.VERCEL_BRANCH_URL}` : '';
    if (!origin || req.headers.host !== new URL(origin).host) {
      return reply(403, { error: 'Use the trusted branch Preview URL.' });
    }
    if (req.method !== 'POST') return reply(405, { error: 'Method not allowed.' });
    // All operations, including anonymous login/signup, require same-origin JSON POST.
    if (req.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
      return reply(403, { error: 'Request rejected.' });
    }
    const secret = env.MYOPS_SESSION_SECRET;
    if (env.VITE_SUPABASE_URL !== PROJECT || !env.VITE_SUPABASE_PUBLISHABLE_KEY?.startsWith('sb_publishable_')
        || typeof secret !== 'string' || secret.length < 32) {
      return reply(503, { error: 'Preview authentication is not configured. Ask the owner to set both Supabase variables and MYOPS_SESSION_SECRET for this Preview branch and redeploy.' });
    }
    const saved = cookies(req);
    const writes = new Map();
    const setCookie = (name, value, age) => {
      writes.set(name, `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`);
      res.setHeader('Set-Cookie', [...writes.values()]);
    };
    const memory = {};
    // SDK requires persistSession for custom verifier storage. Sessions stay request-local;
    // only the verifier crosses requests. Refresh tokens are never persisted or returned.
    const storage = {
      getItem: (key) => key.endsWith('-code-verifier') ? saved[VERIFIER] || null : memory[key] || null,
      setItem: (key, value) => {
        if (key.endsWith('-code-verifier')) setCookie(VERIFIER, value, 3600);
        else memory[key] = value;
      },
      removeItem: (key) => {
        if (key.endsWith('-code-verifier')) setCookie(VERIFIER, '', 0);
        else delete memory[key];
      },
    };
    const client = clientFactory(PROJECT, env.VITE_SUPABASE_PUBLISHABLE_KEY, {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, storage },
      ...(saved[SESSION] ? { global: { headers: { Authorization: `Bearer ${saved[SESSION]}` } } } : {}),
    });
    const touch = () => setCookie(ACTIVITY, signActivity(secret, now()), INACTIVITY_MS / 1000);
    const cookieIdentity = () => verifiedIdentity(secret, saved[IDENTITY], now());
    const clearAll = () => [SESSION, ACTIVITY, IDENTITY, LOGIN, VERIFIER].forEach((name) => setCookie(name, '', 0));
    const saveSession = async (session, access) => {
      if (!session?.access_token) return false;
      const { data, error } = await client.auth.getUser(session.access_token);
      if (error || !data.user?.email_confirmed_at) return false;
      const ttl = Math.min(3600, Math.floor(session.expires_at - Date.now() / 1000));
      if (!(ttl > 0) || session.access_token.length > 3500) return false;
      setCookie(SESSION, session.access_token, ttl);
      setCookie(IDENTITY, signIdentity(secret, data.user.id, now()), IDENTITY_MAX_MS / 1000);
      // Durable server-side login record. If it cannot be created, sign-in still works but app launch
      // fails closed (no login cookie means no tickets).
      const loginSessionId = await access.startLogin(data.user.id);
      if (loginSessionId) setCookie(LOGIN, signLogin(secret, data.user.id, loginSessionId, now()), IDENTITY_MAX_MS / 1000);
      else setCookie(LOGIN, '', 0);
      touch();
      return true;
    };
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (!body || JSON.stringify(body).length > 12000) return reply(400, { error: 'Invalid request.' });
      const { action } = body;
      const validEmail = typeof body.email === 'string' && body.email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email);
      const validPassword = typeof body.password === 'string' && body.password.length >= 12 && body.password.length <= 128;
      const callback = `${origin}/auth/callback`;
      const payments = createPayments({ env, transport, adminFactory: clientFactory, project: PROJECT });
      const appAccess = appAccessFactory({ env, adminFactory: clientFactory, now, project: PROJECT });
      // Revocation targets only identities proven by the server (signed cookie or verified token).
      // Revokes app access for every verified id plus any unresolved pending id. A failure is never
      // reported as success: it leaves a signed pending marker and a durable server-side queue so later
      // requests can retry even after cookie loss or a restart.
      // A verified login cookie narrows revocation to this browser's login session; password reset and
      // retries of an earlier failure are user-wide (a superset, never weaker).
      const settleRevocation = async (reason, ...ids) => {
        const currentLogin = verifiedLogin(secret, saved[LOGIN], now());
        const pending = verifiedPending(secret, saved[PENDING], now());
        const jobs = new Map();
        for (const id of [...ids, currentLogin?.userId].filter(Boolean)) {
          jobs.set(id, currentLogin && currentLogin.userId === id && reason !== 'password_reset'
            ? { loginSessionId: currentLogin.loginSessionId, reason } : { reason });
        }
        if (pending) jobs.set(pending, { reason: jobs.get(pending)?.reason ?? 'logout' });
        const targets = [...jobs.keys()].filter((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id));
        const results = await Promise.allSettled(targets.map((id) => appAccess.revokeUserSessions(id, jobs.get(id))));
        const failed = [];
        for (const [index, id] of targets.entries()) {
          const result = results[index];
          const noOpSuccess = appAccessFactory === createAppAccess && ['logout', 'password_reset'].includes(reason)
            && result.status === 'fulfilled' && result.value === false;
          const okay = noOpSuccess || (result.status === 'fulfilled' && (result.value === true || result.value === 't'
            || (typeof result.value === 'number' && Number.isInteger(result.value) && result.value >= 0)));
          if (result.status === 'rejected' || (!okay || result.value === false || result.value === null || result.value === undefined) && !noOpSuccess) {
            failed.push(id);
          }
        }
        if (failed.length) {
          for (const id of failed) {
            const job = jobs.get(id) || { reason: 'logout' };
            if (typeof appAccess.queueRevocation === 'function') {
              await appAccess.queueRevocation(id, {
                loginSessionId: job.loginSessionId ?? null,
                reason: job.reason ?? 'logout',
              });
            }
          }
          setCookie(PENDING, signPending(secret, failed[0], now()), PENDING_MAX_MS / 1000);
        } else if (saved[PENDING]) {
          setCookie(PENDING, '', 0);
        }
        return failed.length === 0;
      };
      const identityUser = cookieIdentity();
      const sessionLogin = verifiedLogin(secret, saved[LOGIN], now());
      const durablePending = identityUser && typeof appAccess.pendingRevocations === 'function'
        ? await appAccess.pendingRevocations(identityUser, sessionLogin?.loginSessionId ?? null)
        : null;
      if (durablePending === null && identityUser && typeof appAccess.pendingRevocations === 'function') {
        return reply(503, { error: 'Session validation is temporarily unavailable. Try again shortly.' });
      }
      // Retry an earlier failed revocation on every request, before anything else can start a session.
      const pendingUser = verifiedPending(secret, saved[PENDING], now()) || (durablePending?.length ? identityUser : null);
      const pendingCleared = pendingUser ? await settleRevocation('logout', pendingUser) : true;
      if (saved[PENDING] && !pendingUser) setCookie(PENDING, '', 0);
      if (!pendingCleared && ['login', 'callback'].includes(action)) {
        return reply(503, { error: 'Sign-in is temporarily unavailable. Try again shortly.' });
      }
      if (action === 'register') {
        if (!validEmail || !validPassword || !['personal', 'business'].includes(body.accountType)
            || typeof body.displayName !== 'string' || body.displayName.trim().length < 1 || body.displayName.length > 120) {
          return reply(400, { error: 'Enter a name, valid email and 12–128 character password.' });
        }
        // Metadata is descriptive only. Never trust it for roles or authorization.
        const { data, error } = await client.auth.signUp({ email: body.email, password: body.password,
          options: { emailRedirectTo: callback, data: { display_name: body.displayName.trim(), account_type: body.accountType } } });
        if (!error && data?.user?.id && data.user.identities?.length > 0) {
          await payments.provisionProfile({ userId: data.user.id, displayName: body.displayName.trim(), accountType: body.accountType });
        }
        if (error) {
          const entry = {
            event: 'myops_signup_error',
            code: SIGNUP_ERROR_CODES.has(error.code) ? error.code : 'unclassified',
            status: Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? error.status : null,
          };
          // Observability must not alter auth behavior, even if the logging sink fails.
          try { diagnostic(entry); } catch { /* No fallback that could leak error details. */ }
        }
        if (data?.session) {
          // Confirmation disabled is a configuration error, not an auto-login path.
          await client.auth.admin.signOut(data.session.access_token, 'global');
          return reply(503, { error: 'Email confirmation must be enabled before registration.' });
        }
        if (error?.status === 429) return reply(429, { error: 'Please wait before trying again.' });
        if (error) {
          // Do not echo upstream messages: they can disclose account existence or internals.
          if (error.code === 'user_already_exists') {
            return reply(200, { message: 'If registration is available for this address, check your email to confirm it in this browser. Otherwise sign in or reset your password.' });
          }
          if (error.code === 'email_address_invalid') {
            return reply(400, { error: 'Use a valid email address with a real inbox. Example and test domains are not supported.' });
          }
          if (error.code === 'weak_password') return reply(400, { error: 'Choose a stronger password with a mix of letters, numbers and symbols.' });
          if (error.code === 'signup_disabled' || error.code === 'email_provider_disabled') {
            return reply(503, { error: 'Email registration is currently unavailable. Contact the Preview owner.' });
          }
          return reply(502, { error: 'Registration could not be completed. Please try again later or contact the Preview owner.' });
        }
        return reply(200, { message: 'If registration is available for this address, check your email to confirm it in this browser.' });
      }
      if (action === 'login') {
        if (!validEmail || typeof body.password !== 'string' || body.password.length > 128) return reply(400, { error: 'Invalid email or password.' });
        const { data, error } = await client.auth.signInWithPassword({ email: body.email, password: body.password });
        if (error || !await saveSession(data?.session, appAccess)) return reply(401, { error: 'Invalid credentials or email not confirmed.' });
        return reply(200, { next: '/' });
      }
      if (action === 'forgot') {
        if (!validEmail) return reply(400, { error: 'Enter a valid email address.' });
        const { error } = await client.auth.resetPasswordForEmail(body.email, { redirectTo: callback });
        if (error?.status === 429) return reply(429, { error: 'Please wait before trying again.' });
        return reply(200, { message: 'If the address is registered, a recovery email will arrive. Open it in this browser.' });
      }
      if (action === 'callback') {
        if (typeof body.code !== 'string' || body.code.length > 2048 || !saved[VERIFIER]) return reply(400, { error: 'Invalid or expired link. Start again in this browser.' });
        const { data, error } = await client.auth.exchangeCodeForSession(body.code);
        setCookie(VERIFIER, '', 0);
        if (error || !await saveSession(data?.session, appAccess)) return reply(400, { error: 'Invalid or expired link. Start again.' });
        return reply(200, { next: data.redirectType === 'recovery' ? '/account/update-password' : '/' });
      }
      if (action === 'logout') {
        clearAll();
        let current = null;
        if (saved[SESSION]) {
          try { current = (await client.auth.getUser(saved[SESSION])).data?.user ?? null; } catch { current = null; }
        }
        const signOut = saved[SESSION]
          ? await Promise.allSettled([client.auth.admin.signOut(saved[SESSION], 'global')]) : [];
        const revoked = await settleRevocation('logout', current?.id, cookieIdentity());
        // A sign-out error for a token that is already invalid is harmless; app revocation must succeed.
        const signOutFailed = signOut.length && current
          && (signOut[0].status === 'rejected' || signOut[0].value?.error);
        if (signOutFailed || !revoked) throw new Error('logout_failed');
        return reply(200, { next: '/' });
      }
      if (action === 'founders') return reply(200, await payments.founders());
      if (!['account', 'reset', 'profile', 'session', 'launch', 'checkout', 'admin_audit'].includes(action)) return reply(400, { error: 'Unknown operation.' });
      const active = saved[SESSION] && activityValid(secret, saved[ACTIVITY], now());
      const { data: identity, error: identityError } = saved[SESSION]
        ? await client.auth.getUser(saved[SESSION]) : { data: {}, error: true };
      if (!active || identityError || !identity.user?.email_confirmed_at) {
        const expired = Boolean(saved[SESSION] || saved[IDENTITY]);
        const knownUser = identity.user?.id;
        clearAll();
        // MYOPS session ended (inactivity or expired/invalid token): app access ends with it.
        // A failed revocation stays queued (signed pending marker); it must not turn into repeated errors here.
        await settleRevocation('inactivity', knownUser, cookieIdentity());
        if (action === 'session') return reply(200, { signedIn: false });
        return reply(401, expired ? { error: 'Your session ended. Sign in again.', reason: 'inactive' } : { error: 'Sign in to continue.' });
      }
      // Passive probes must not extend the inactivity window.
      // Only genuine user activity is recorded server-side (30 s throttle); app polling never is.
      const login = verifiedLogin(secret, saved[LOGIN], now());
      const loginSessionId = login?.userId === identity.user.id ? login.loginSessionId : null;
      if (!(action === 'session' && body.activity === false)) {
        touch();
        if (loginSessionId && await appAccess.touchLogin(identity.user.id, loginSessionId) === false) {
          // The durable record says this login is over (expired, swept or revoked elsewhere).
          clearAll();
          await settleRevocation('inactivity', identity.user.id);
          if (action === 'session') return reply(200, { signedIn: false });
          return reply(401, { error: 'Your session ended. Sign in again.', reason: 'inactive' });
        }
      }
      if (action === 'session') {
        const entitlements = await loadEntitlements(client, identity.user.id, now());
        return reply(200, { signedIn: true, email: identity.user.email, products: entitlements?.products ?? null, lifetime: entitlements?.lifetime ?? false });
      }
      if (action === 'checkout') {
        // Eligibility (Individual-only) is decided inside the database from the server-owned
        // profile; user-editable auth metadata is never consulted.
        const result = await payments.checkout({ userId: identity.user.id, plan: body.plan, product: body.product, origin });
        return reply(result.status, result.body);
      }
      if (action === 'admin_audit') {
        const result = await payments.audit({ userId: identity.user.id });
        return reply(result.status, result.body);
      }
      if (action === 'launch') {
        if (typeof body.product !== 'string' || !SLUG.test(body.product)) return reply(400, { error: 'Unknown product.' });
        const products = await loadProductStates(client, identity.user.id, now());
        if (!products) return reply(503, { error: 'Subscription status is unavailable. Try again later.' });
        if (!products[body.product]) return reply(400, { error: 'Unknown product.' });
        if (products[body.product] !== 'active') return reply(403, { error: 'An active subscription is required for this application.' });
        // Tickets bind to a verified, live login-session record; without one, fail closed.
        if (!loginSessionId) return reply(401, { error: 'Sign in again to launch applications.', reason: 'login_required' });
        const launch = await appAccess.issueTicket({ userId: identity.user.id, product: body.product, loginSessionId });
        if (launch?.status === 429) return reply(429, { error: 'Please wait before trying again.' });
        if (!launch || launch.status !== 200) return reply(503, { error: 'Secure application launch is unavailable. Try again later.' });
        return reply(200, { next: launch.next });
      }
      if (action === 'reset') {
        if (!validPassword) return reply(400, { error: 'Use a 12–128 character password.' });
        // This client has no persisted refresh session. Use the verified caller JWT.
        const updated = await transport(`${PROJECT}/auth/v1/user`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json',
            apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${saved[SESSION]}` },
          body: JSON.stringify({ password: body.password }),
        });
        if (!updated.ok) return reply(400, { error: 'Password update failed. Request a new recovery link.' });
        const signOut = await Promise.allSettled([client.auth.admin.signOut(saved[SESSION], 'global')]);
        const revoked = await settleRevocation('password_reset', identity.user.id);
        clearAll();
        if (!revoked || signOut[0].status === 'rejected' || signOut[0].value?.error) throw new Error('password_reset_revoke_failed');
        return reply(200, { next: '/login' });
      }
      if (action === 'profile') {
        if (!['personal', 'business'].includes(body.accountType) || typeof body.displayName !== 'string'
            || body.displayName.trim().length < 1 || body.displayName.length > 120) return reply(400, { error: 'Invalid profile.' });
        const updated = await transport(`${PROJECT}/auth/v1/user`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY,
            Authorization: `Bearer ${saved[SESSION]}` },
          body: JSON.stringify({ data: { display_name: body.displayName.trim(), account_type: body.accountType } }),
        });
        if (!updated.ok) return reply(503, { error: 'Profile could not be saved. Try again later.' });
        const updatedUser = await updated.json();
        if (updatedUser?.id !== identity.user.id) return reply(503, { error: 'Profile could not be saved. Try again later.' });
        return reply(200, { next: '/account' });
      }
      // Auth metadata is user-editable and descriptive only; it never grants access.
      const entitlements = await loadEntitlements(client, identity.user.id, now());
      return reply(200, { email: identity.user.email, profile: profileFrom(identity.user), products: entitlements?.products ?? null, lifetime: entitlements?.lifetime ?? false });
    } catch {
      // Never log SDK errors, credentials, request bodies, cookies or callback codes.
      return reply(500, { error: 'Authentication request failed. Please try again.' });
    }
  };
}
