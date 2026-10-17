import { createHmac, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { createPayments } from './payments.js';

const SESSION = '__Host-myops-access';
const VERIFIER = '__Host-myops-pkce';
const ACTIVITY = '__Host-myops-activity';
export const INACTIVITY_MS = 15 * 60 * 1000;
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

export const PRODUCT_SLUGS = ['opsp', 'opsfinance', 'opsflow', 'opswms', 'opshr'];

// Pure entitlement rules. Row visibility is enforced by Supabase RLS for the caller's JWT;
// these rules additionally fail closed on status, expiry, catalog state and grants.
const SLUG = /^[a-z0-9_]{1,32}$/;

export const hasLifetime = (userId, lifetime = []) =>
  lifetime.some((row) => row.user_id === userId && row.status === 'active' && row.scope === 'all_apps');

export function resolveProductStates({ userId, catalog, subscriptions, grants, lifetime = [], now }) {
  const entitled = new Set();
  const live = new Set(catalog.filter((item) => item.launch_status === 'live' && SLUG.test(item.slug)).map((item) => item.slug));
  // Lifetime access covers every live catalog app, including apps launched after purchase.
  if (hasLifetime(userId, lifetime)) live.forEach((slug) => entitled.add(slug));
  for (const sub of subscriptions) {
    if (sub.status !== 'active') continue;
    if (sub.current_period_end && !(Date.parse(sub.current_period_end) > now)) continue;
    if (sub.personal_user_id) {
      if (sub.personal_user_id !== userId) continue;
      if (sub.is_complete_bundle) live.forEach((slug) => entitled.add(slug));
      else if (sub.product_slug) entitled.add(sub.product_slug);
    } else if (sub.organization_id) {
      for (const grant of grants) {
        if (grant.organization_id === sub.organization_id && (sub.is_complete_bundle || grant.product_slug === sub.product_slug)) {
          entitled.add(grant.product_slug);
        }
      }
    }
  }
  const slugs = [...new Set([...PRODUCT_SLUGS, ...catalog.map((item) => item.slug).filter((slug) => SLUG.test(slug))])];
  return Object.fromEntries(slugs.map((slug) => [slug,
    !live.has(slug) ? 'coming_soon' : entitled.has(slug) ? 'active' : 'none']));
}

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

export function createAuthHandler({ env = process.env, clientFactory = createClient, transport = fetch, now = Date.now,
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
    const clearAll = () => [SESSION, ACTIVITY, VERIFIER].forEach((name) => setCookie(name, '', 0));
    const saveSession = async (session) => {
      if (!session?.access_token) return false;
      const { data, error } = await client.auth.getUser(session.access_token);
      if (error || !data.user?.email_confirmed_at) return false;
      const ttl = Math.min(3600, Math.floor(session.expires_at - Date.now() / 1000));
      if (!(ttl > 0) || session.access_token.length > 3500) return false;
      setCookie(SESSION, session.access_token, ttl);
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
        if (error || !await saveSession(data?.session)) return reply(401, { error: 'Invalid credentials or email not confirmed.' });
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
        if (error || !await saveSession(data?.session)) return reply(400, { error: 'Invalid or expired link. Start again.' });
        return reply(200, { next: data.redirectType === 'recovery' ? '/account/update-password' : '/' });
      }
      if (action === 'logout') {
        if (saved[SESSION]) await client.auth.admin.signOut(saved[SESSION], 'global');
        clearAll();
        return reply(200, { next: '/' });
      }
      if (action === 'founders') return reply(200, await payments.founders());
      if (!['account', 'reset', 'profile', 'session', 'launch', 'checkout', 'admin_audit'].includes(action)) return reply(400, { error: 'Unknown operation.' });
      const active = saved[SESSION] && activityValid(secret, saved[ACTIVITY], now());
      const { data: identity, error: identityError } = active
        ? await client.auth.getUser(saved[SESSION]) : { data: {}, error: true };
      if (identityError || !identity.user?.email_confirmed_at) {
        const expired = Boolean(saved[SESSION]);
        clearAll();
        if (action === 'session') return reply(200, { signedIn: false });
        return reply(401, expired ? { error: 'Your session ended. Sign in again.', reason: 'inactive' } : { error: 'Sign in to continue.' });
      }
      // Passive probes must not extend the inactivity window.
      if (!(action === 'session' && body.activity === false)) touch();
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
        const target = env[`MYOPS_APP_URL_${body.product.toUpperCase()}`];
        if (typeof target !== 'string' || !/^https:\/\/[^\s]+$/.test(target)) {
          return reply(503, { error: 'Application launch is not configured for this Preview.' });
        }
        return reply(200, { next: target });
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
        await client.auth.admin.signOut(saved[SESSION], 'global');
        clearAll();
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
