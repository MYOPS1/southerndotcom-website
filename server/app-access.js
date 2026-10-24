import { createHash, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { resolveProductStates } from './entitlements.js';

const PROJECT = 'https://uhuukcztdifvpjuopdea.supabase.co';
const APP_ID = /^[a-z][a-z0-9_-]{1,31}$/;
const PRODUCT = /^[a-z0-9_]{1,32}$/;
const TICKET = /^[A-Za-z0-9_-]{43}$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE = /^[A-Za-z0-9_-]{16,128}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const REQUEST_SKEW_MS = 5 * 60 * 1000;
const APP_IDLE_MS = 15 * 60 * 1000;
const APP_MAX_SESSION_MS = 12 * 60 * 60 * 1000;
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const hashTicket = (ticket) => createHash('sha256').update(ticket).digest('hex');

// Deterministic JSON: sorted keys at every depth, so no nested field can change unsigned.
export function canonicalJson(value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol'
      || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('not_canonical');
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

// The signature binds method, path, app, key version, time, nonce and the full body.
export function canonicalRequest(method, path, appId, keyVersion, timestamp, nonce, body) {
  const bodyHash = createHash('sha256').update(canonicalJson(body)).digest('hex');
  return `${method.toUpperCase()}\n${path}\n${appId}\n${keyVersion}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

export function verifyAppSignature(publicKey, signature, message) {
  if (typeof publicKey !== 'string' || typeof signature !== 'string' || !SIGNATURE.test(signature)) return false;
  try {
    const key = createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'ed25519') return false;
    return verify(null, Buffer.from(message), key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

function serviceClient(env, adminFactory, project) {
  const key = env.MYOPS_SERVICE_ROLE_KEY;
  if (typeof key !== 'string' || !key.startsWith('sb_secret_')) return null;
  return adminFactory(project, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function rpc(client, name, args, signal) {
  if (signal && signal.aborted) throw new Error('app_access_timeout');
  const { data, error } = await client.rpc(name, args);
  if (signal && signal.aborted) throw new Error('app_access_timeout');
  if (error) throw new Error(`app_access_${name}`);
  return data;
}

function configured(env) {
  return env.VERCEL_ENV === 'preview'
    && env.MYOPS_ENVIRONMENT === 'staging'
    && env.VITE_SUPABASE_URL === PROJECT
    && typeof env.MYOPS_APP_USER_REF_SECRET === 'string'
    && env.MYOPS_APP_USER_REF_SECRET.length >= 32;
}

function ipHash(req) {
  // Vercel sets x-vercel-forwarded-for itself; client-supplied forwarding headers are not trusted first.
  const forwarded = req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'];
  const ip = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : 'unknown';
  return createHash('sha256').update(ip || 'unknown').digest('hex');
}

function userRef(secret, appId, userId) {
  return createHmac('sha256', secret).update(`${appId}:${userId}`).digest('base64url');
}

function entitlementRows(client, table, columns, userId) {
  let query = client.from(table).select(columns);
  if (table === 'myops_subscriptions') return query.eq('personal_user_id', userId);
  if (table === 'myops_memberships' || table === 'myops_app_grants' || table === 'myops_lifetime_entitlements') {
    query = query.eq('user_id', userId);
  }
  if (table === 'myops_memberships') query = query.eq('status', 'active');
  if (table === 'myops_organizations') return query;
  return query;
}

export async function loadCurrentEntitlements(client, userId, now) {
  const [catalog, personalSubs, memberships, grants, lifetime] = await Promise.all([
    entitlementRows(client, 'myops_products', 'slug,launch_status', userId),
    entitlementRows(client, 'myops_subscriptions', 'personal_user_id,organization_id,product_slug,is_complete_bundle,status,current_period_end', userId),
    entitlementRows(client, 'myops_memberships', 'organization_id', userId),
    entitlementRows(client, 'myops_app_grants', 'organization_id,product_slug', userId),
    entitlementRows(client, 'myops_lifetime_entitlements', 'user_id,scope,status', userId),
  ]);
  if (catalog.error || personalSubs.error || memberships.error || grants.error || lifetime.error) return null;
  const orgIds = (memberships.data || []).map((row) => row.organization_id).filter(Boolean);
  let orgSubs = { data: [], error: null };
  if (orgIds.length) {
    orgSubs = await client.from('myops_subscriptions')
      .select('personal_user_id,organization_id,product_slug,is_complete_bundle,status,current_period_end')
      .in('organization_id', orgIds);
    if (orgSubs.error) return null;
  }
  const subscriptions = [...(personalSubs.data || []), ...(orgSubs.data || [])];
  return resolveProductStates({
    userId,
    catalog: catalog.data || [],
    subscriptions,
    grants: grants.data || [],
    lifetime: lifetime.data || [],
    now,
  });
}

function requestContext(req, res, env, now) {
  const reply = (status, body) => res.status(status).json(body);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Vary', 'Origin');
  if (env.VERCEL_ENV !== 'preview') return { done: reply(404, { error: 'Preview-only.' }) };
  const expectedHost = env.VERCEL_BRANCH_URL;
  if (!expectedHost || req.headers.host !== expectedHost) return { done: reply(403, { error: 'Request rejected.' }) };
  if (req.method !== 'POST') return { done: reply(405, { error: 'Method not allowed.' }) };
  if (req.headers.origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    return { done: reply(403, { error: 'Request rejected.' }) };
  }
  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body) || JSON.stringify(body).length > 4000) {
    return { done: reply(400, { error: 'Invalid request.' }) };
  }
  if (!configured(env)) return { done: reply(503, { error: 'Application access is not configured.' }) };
  const appId = req.headers['x-myops-app-id'];
  const timestamp = req.headers['x-myops-timestamp'];
  const nonce = req.headers['x-myops-nonce'];
  const signature = req.headers['x-myops-signature'];
  const numericTime = typeof timestamp === 'string' && /^\d{13}$/.test(timestamp) ? Number(timestamp) : NaN;
  if (typeof appId !== 'string' || !APP_ID.test(appId)
      || !Number.isSafeInteger(numericTime) || Math.abs(now() - numericTime) > REQUEST_SKEW_MS
      || typeof nonce !== 'string' || !NONCE.test(nonce)
      || typeof signature !== 'string' || !SIGNATURE.test(signature)) {
    return { done: reply(401, { error: 'Application request is not authorized.' }) };
  }
  return { body, appId, timestamp, nonce, signature, reply, ip: ipHash(req) };
}

export function createAppAccess({ env = process.env, adminFactory = createClient, now = Date.now, project = PROJECT,
  entitlementResolver = loadCurrentEntitlements } = {}) {
  const client = () => serviceClient(env, adminFactory, project);
  async function permitRate(clientAdmin, key, limit, windowSeconds) {
    const keyHash = createHash('sha256').update(key).digest('hex');
    return rpc(clientAdmin, 'myops_check_app_rate_limit', {
      p_key_hash: keyHash, p_limit: limit, p_window_seconds: windowSeconds,
    });
  }

  async function issueTicket({ userId, product, loginSessionId }) {
    if (!configured(env) || !PRODUCT.test(product) || !USER_ID.test(String(loginSessionId))) return null;
    const target = env[`MYOPS_APP_URL_${product.toUpperCase()}`];
    if (typeof target !== 'string') return null;
    let destination;
    try {
      destination = new URL(target);
      if (destination.protocol !== 'https:' || destination.username || destination.password || destination.search || destination.hash) return null;
    } catch {
      return null;
    }
    const admin = client();
    if (!admin) return null;
    const allowed = await permitRate(admin, `launch:${userId}:${product}`, 10, 60);
    if (!allowed) return { status: 429 };
    const ticket = randomBytes(32).toString('base64url');
    const inserted = await rpc(admin, 'myops_issue_app_ticket', {
      p_user_id: userId, p_product_slug: product, p_ticket_hash: hashTicket(ticket), p_login_session_id: loginSessionId,
    });
    if (!inserted || inserted.status !== 'issued') return null;
    destination.pathname = `${destination.pathname.replace(/\/+$/, '')}/launch`;
    // Fragment: never sent to servers, access logs or in Referer headers. The app's /launch page
    // must POST it to its own server and immediately remove it with history.replaceState.
    destination.hash = `t=${ticket}`;
    return { status: 200, next: destination.toString() };
  }

  // Server-side login-session record: validity is derived from stored timestamps, not from the browser.
  // Returns null when app access is not configured or the record cannot be created; launch then fails closed.
  async function startLogin(userId) {
    if (!configured(env) || !USER_ID.test(String(userId))) return null;
    const admin = client();
    if (!admin) return null;
    try {
      const id = await rpc(admin, 'myops_login_start', { p_user_id: userId });
      return typeof id === 'string' && USER_ID.test(id) ? id : null;
    } catch {
      return null;
    }
  }

  // Records MYOPS user activity (throttled to 30 s in SQL). false = login no longer live; null = unknown.
  async function touchLogin(userId, loginSessionId) {
    if (!configured(env) || !USER_ID.test(String(userId)) || !USER_ID.test(String(loginSessionId))) return null;
    const admin = client();
    if (!admin) return null;
    try {
      return (await rpc(admin, 'myops_login_touch', { p_id: loginSessionId, p_user_id: userId })) === true;
    } catch {
      return null;
    }
  }

  const REASONS = new Set(['logout', 'password_reset', 'inactivity', 'absolute', 'admin']);
  function revocationSucceeded(value) {
    return value === true || value === 't' || value === 1 || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
  }
  async function processRevocations({ batch = 200, signal } = {}) {
    if (signal && signal.aborted) throw new Error('app_access_timeout');
    if (!configured(env)) return { processed: 0, retried: 0, retry_failed: 0, expired_logins: 0, revoked_app_sessions: 0, revoked_tickets: 0, deleted_logins: 0, queued: 0, status: 'unconfigured' };
    const admin = client();
    if (!admin) return { processed: 0, retried: 0, retry_failed: 0, expired_logins: 0, revoked_app_sessions: 0, revoked_tickets: 0, deleted_logins: 0, queued: 0, status: 'unavailable' };
    try {
      const result = await rpc(admin, 'myops_sweep_logins', { p_batch: Number.isInteger(batch) ? Math.min(Math.max(batch, 1), 1000) : 200 }, signal);
      if (signal && signal.aborted) throw new Error('app_access_timeout');
      if (!result || typeof result !== 'object') {
        return { processed: 0, retried: 0, retry_failed: 0, expired_logins: 0, revoked_app_sessions: 0, revoked_tickets: 0, deleted_logins: 0, queued: 0, status: 'invalid' };
      }
      const safe = {
        processed: Number.isFinite(Number(result.processed ?? result.retried)) ? Number(result.processed ?? result.retried) : 0,
        retried: Number.isFinite(Number(result.retried)) ? Number(result.retried) : 0,
        retry_failed: Number.isFinite(Number(result.retry_failed)) ? Number(result.retry_failed) : 0,
        expired_logins: Number.isFinite(Number(result.expired_logins)) ? Number(result.expired_logins) : 0,
        revoked_app_sessions: Number.isFinite(Number(result.revoked_app_sessions)) ? Number(result.revoked_app_sessions) : 0,
        revoked_tickets: Number.isFinite(Number(result.revoked_tickets)) ? Number(result.revoked_tickets) : 0,
        deleted_logins: Number.isFinite(Number(result.deleted_logins)) ? Number(result.deleted_logins) : 0,
        queued: Number.isFinite(Number(result.queued)) ? Number(result.queued) : 0,
        status: typeof result.status === 'string' && result.status.length ? result.status : 'ok',
      };
      return safe;
    } catch (error) {
      if (signal && signal.aborted) throw new Error('app_access_timeout');
      return { processed: 0, retried: 0, retry_failed: 0, expired_logins: 0, revoked_app_sessions: 0, revoked_tickets: 0, deleted_logins: 0, queued: 0, status: 'unavailable' };
    }
  }
  async function queueRevocation(userId, { loginSessionId, reason = 'logout' } = {}) {
    if (!configured(env) || !USER_ID.test(String(userId))) return false;
    const admin = client();
    if (!admin) return false;
    const why = REASONS.has(reason) ? reason : 'admin';
    try {
      const result = await rpc(admin, 'myops_enqueue_revocation', {
        p_user_id: userId,
        p_login_session_id: loginSessionId && USER_ID.test(String(loginSessionId)) ? loginSessionId : null,
        p_reason: why,
      });
      return revocationSucceeded(result);
    } catch {
      return false;
    }
  }
  async function pendingRevocations(userId, loginSessionId = null) {
    if (!configured(env) || !USER_ID.test(String(userId))) return [];
    const admin = client();
    if (!admin) return null;
    try {
      let query = admin.from('myops_revocation_requests').select('id, user_id, login_session_id, reason').eq('user_id', userId).is('completed_at', null);
      if (loginSessionId && USER_ID.test(String(loginSessionId))) query = query.eq('login_session_id', loginSessionId);
      const { data, error } = await query;
      if (error) return null;
      return Array.isArray(data) ? data : [];
    } catch {
      return null;
    }
  }
  async function revokeUserSessions(userId, { loginSessionId, reason = 'logout' } = {}) {
    // Endpoints are disabled when unconfigured, so no app session can be granted. When configured,
    // a failure to revoke must surface to the caller (fail closed).
    if (!configured(env)) return false;
    if (!USER_ID.test(String(userId))) throw new Error('app_access_invalid_user');
    const admin = client();
    if (!admin) throw new Error('app_access_unavailable');
    const why = REASONS.has(reason) ? reason : 'admin';
    let result;
    if (loginSessionId && USER_ID.test(String(loginSessionId))) {
      result = await rpc(admin, 'myops_login_end', { p_id: loginSessionId, p_user_id: userId, p_reason: why });
    } else {
      result = await rpc(admin, 'myops_login_end_all', { p_user_id: userId, p_reason: why });
    }
    if (!revocationSucceeded(result)) throw new Error('app_access_revocation_failed');
    return true;
  }

  async function authenticate(req, res, endpoint) {
    let context;
    try {
      context = requestContext(req, res, env, now);
    } catch {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(400).json({ error: 'Invalid request.' });
    }
    if (context.done) return context.done;
    const { appId, timestamp, nonce, signature, body, reply, ip } = context;
    const admin = client();
    if (!admin) return reply(503, { error: 'Application access is not configured.' });
    const ipAllowed = await permitRate(admin, `${endpoint}:ip:${ip}`, endpoint === 'redeem' ? 30 : 120, 60);
    if (!ipAllowed) return reply(429, { error: 'Please wait before trying again.' });
    const clientData = await rpc(admin, 'myops_get_app_client', { p_app_id: appId });
    if (!clientData?.enabled) return reply(401, { error: 'Application request is not authorized.' });
    const keyVersion = req.headers['x-myops-key-version'];
    const publicKey = keyVersion === 'next' ? clientData.public_key_next : keyVersion === 'current' ? clientData.public_key_current : null;
    const path = `/api/app/${endpoint}`;
    const message = canonicalRequest('POST', path, appId, String(keyVersion), timestamp, nonce, body);
    if (!verifyAppSignature(publicKey, signature, message)) {
      return reply(401, { error: 'Application request is not authorized.' });
    }
    const appAllowed = await permitRate(admin, `${endpoint}:app:${appId}`, endpoint === 'redeem' ? 100 : 600, 60);
    if (!appAllowed) return reply(429, { error: 'Please wait before trying again.' });
    const nonceHash = createHash('sha256').update(`${appId}:${nonce}`).digest('hex');
    const nonceAccepted = await rpc(admin, 'myops_record_app_nonce', {
      p_app_id: appId, p_nonce_hash: nonceHash,
    });
    if (!nonceAccepted) return reply(401, { error: 'Application request is not authorized.' });
    return { admin, appId, clientData, body, reply };
  }

  async function redeem(req, res) {
    let auth;
    try {
      auth = await authenticate(req, res, 'redeem');
      if (!auth || typeof auth.statusCode === 'number') return auth;
      const { admin, appId, clientData, body, reply } = auth;
      if (Object.keys(body).length !== 1 || typeof body.ticket !== 'string' || !TICKET.test(body.ticket)) {
        return reply(400, { error: 'Invalid request.' });
      }
      const redeemed = await rpc(admin, 'myops_redeem_app_ticket', {
        p_app_id: appId, p_ticket_hash: hashTicket(body.ticket),
      });
      if (!redeemed || redeemed.status !== 'redeemed'
          || redeemed.product_slug !== clientData.product_slug
          || typeof redeemed.user_id !== 'string' || typeof redeemed.session_id !== 'string') {
        return reply(401, { error: 'Launch ticket is invalid or expired.' });
      }
      const products = await entitlementResolver(admin, redeemed.user_id, now());
      if (!products || products[clientData.product_slug] !== 'active') {
        await rpc(admin, 'myops_revoke_app_session', {
          p_session_id: redeemed.session_id, p_reason: 'entitlement_denied',
        });
        // Lookup failure is not a denial: tell the app to retry with a new launch.
        return products ? reply(403, { error: 'Application access is not authorized.' })
          : reply(503, { error: 'Application access could not be verified.' });
      }
      return reply(200, {
        session_id: redeemed.session_id,
        user_ref: userRef(env.MYOPS_APP_USER_REF_SECRET, appId, redeemed.user_id),
        product: clientData.product_slug,
        idle_seconds: APP_IDLE_MS / 1000,
        max_session_seconds: APP_MAX_SESSION_MS / 1000,
      });
    } catch {
      return res.status(503).json({ error: 'Application access could not be verified.' });
    }
  }

  async function entitlement(req, res) {
    let auth;
    try {
      auth = await authenticate(req, res, 'entitlement');
      if (!auth || typeof auth.statusCode === 'number') return auth;
      const { admin, appId, clientData, body, reply } = auth;
      if (Object.keys(body).some((key) => !['session_id', 'product', 'sensitive', 'activity'].includes(key))
          || !SESSION_ID.test(body.session_id || '') || body.product !== clientData.product_slug
          || (body.sensitive !== undefined && typeof body.sensitive !== 'boolean')
          || (body.activity !== undefined && typeof body.activity !== 'boolean')
          || (body.sensitive === true && body.activity !== true)) {
        return reply(400, { error: 'Invalid request.' });
      }
      const appSession = await rpc(admin, 'myops_validate_app_session', {
        p_session_id: body.session_id, p_app_id: appId, p_product_slug: body.product,
        p_touch: body.activity === true,
      });
      if (!appSession?.active || typeof appSession.user_id !== 'string') {
        return reply(403, { entitled: false, session_active: false });
      }
      const products = await entitlementResolver(admin, appSession.user_id, now());
      // Unknown state (lookup failed): deny this request but keep the session for a later retry.
      if (!products) return reply(503, { entitled: false, error: 'Application access could not be verified.' });
      const entitled = products[body.product] === 'active';
      if (!entitled) {
        await rpc(admin, 'myops_revoke_app_session', {
          p_session_id: body.session_id, p_reason: 'entitlement_revoked',
        });
        return reply(403, { entitled: false, session_active: false });
      }
      return reply(200, { entitled: true, session_active: true, checked_at: new Date(now()).toISOString() });
    } catch {
      return res.status(503).json({ error: 'Application access could not be verified.' });
    }
  }

  return { issueTicket, startLogin, touchLogin, processRevocations, queueRevocation, pendingRevocations, revokeUserSessions, redeem, entitlement };
}
