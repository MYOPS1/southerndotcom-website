import { createClient } from '@supabase/supabase-js';

const SESSION = '__Host-myops-access';
const VERIFIER = '__Host-myops-pkce';
const PROJECT = 'https://uhuukcztdifvpjuopdea.supabase.co';

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((part) => {
    const index = part.indexOf('=');
    if (index < 0) return ['', ''];
    try { return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))]; }
    catch { return ['', '']; }
  }));
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

export function createAuthHandler({ env = process.env, clientFactory = createClient, transport = fetch,
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
    if (env.VITE_SUPABASE_URL !== PROJECT || !env.VITE_SUPABASE_PUBLISHABLE_KEY?.startsWith('sb_publishable_')) {
      return reply(503, { error: 'Preview authentication is not configured. Ask the owner to set both Supabase variables for this Preview branch and redeploy.' });
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
    const saveSession = async (session) => {
      if (!session?.access_token) return false;
      const { data, error } = await client.auth.getUser(session.access_token);
      if (error || !data.user?.email_confirmed_at) return false;
      const ttl = Math.min(3600, Math.floor(session.expires_at - Date.now() / 1000));
      if (!(ttl > 0) || session.access_token.length > 3500) return false;
      setCookie(SESSION, session.access_token, ttl);
      return true;
    };
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (!body || JSON.stringify(body).length > 12000) return reply(400, { error: 'Invalid request.' });
      const { action } = body;
      const validEmail = typeof body.email === 'string' && body.email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email);
      const validPassword = typeof body.password === 'string' && body.password.length >= 12 && body.password.length <= 128;
      const callback = `${origin}/auth/callback`;
      if (action === 'register') {
        if (!validEmail || !validPassword || !['personal', 'business'].includes(body.accountType)
            || typeof body.displayName !== 'string' || body.displayName.trim().length < 1 || body.displayName.length > 120) {
          return reply(400, { error: 'Enter a name, valid email and 12–128 character password.' });
        }
        // Metadata is descriptive only. Never trust it for roles or authorization.
        const { data, error } = await client.auth.signUp({ email: body.email, password: body.password,
          options: { emailRedirectTo: callback, data: { display_name: body.displayName.trim(), account_type: body.accountType } } });
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
        return reply(200, { next: '/account' });
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
        return reply(200, { next: data.redirectType === 'recovery' ? '/account/update-password' : '/account' });
      }
      if (action === 'logout') {
        if (saved[SESSION]) await client.auth.admin.signOut(saved[SESSION], 'global');
        setCookie(SESSION, '', 0);
        setCookie(VERIFIER, '', 0);
        return reply(200, { next: '/login' });
      }
      if (!['account', 'reset', 'profile'].includes(action)) return reply(400, { error: 'Unknown operation.' });
      const { data: identity, error: identityError } = saved[SESSION]
        ? await client.auth.getUser(saved[SESSION]) : { data: {}, error: true };
      if (identityError || !identity.user?.email_confirmed_at) {
        setCookie(SESSION, '', 0);
        return reply(401, { error: 'Sign in to continue.' });
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
        setCookie(SESSION, '', 0);
        return reply(200, { next: '/login' });
      }
      if (action === 'profile') {
        if (!['personal', 'business'].includes(body.accountType) || typeof body.displayName !== 'string'
            || body.displayName.trim().length < 1 || body.displayName.length > 120) return reply(400, { error: 'Invalid profile.' });
        const { error } = await client.rpc('myops_complete_profile', { p_display_name: body.displayName.trim(), p_account_type: body.accountType });
        if (error) return reply(503, { error: 'Profile provisioning is unavailable pending database review.' });
        return reply(200, { next: '/account' });
      }
      const { data: profile, error } = await client.from('myops_profiles')
        .select('display_name,account_type').eq('user_id', identity.user.id).maybeSingle();
      if (error) return reply(503, { error: 'Account data is unavailable.' });
      // No app grants/subscriptions are treated as application authorization.
      return reply(200, { email: identity.user.email, profile });
    } catch {
      // Never log SDK errors, credentials, request bodies, cookies or callback codes.
      return reply(500, { error: 'Authentication request failed. Please try again.' });
    }
  };
}
