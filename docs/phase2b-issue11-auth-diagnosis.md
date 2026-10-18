# MYOPS Issue #11 — Registration & Authentication Diagnosis

## Summary
The failure pattern is consistent with a configuration + verification problem, not a homepage or pricing bug. The Preview-only auth backend intentionally blocks requests unless the request is sent to the exact trusted branch Preview host, the JSON payload is same-origin, and the required Supabase Preview variables are present and valid. Registration also does not complete by itself: the server requires a confirmed email and a valid PKCE callback before it will create a user session. Because of that, registration or login can appear to do nothing when the branch is not configured or the user is not confirmed.

## Root cause with evidence

1. The backend rejects non-Preview, host-mismatched, or non-same-origin requests before any auth logic runs.
   Evidence: `server/auth.js` checks `VERCEL_ENV`, exact `VERCEL_BRANCH_URL` host matching, and same-origin JSON POST requirements at `server/auth.js:145-170`.
   - `if (env.VERCEL_ENV !== 'preview') return reply(404, { error: 'Authentication is Preview-only.' });`
   - `if (!origin || req.headers.host !== new URL(origin).host) return reply(403, { error: 'Use the trusted branch Preview URL.' });`
   - `if (req.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return reply(403, { error: 'Request rejected.' });`

2. Auth is disabled until the Preview branch has the exact required Supabase settings. If the publishable key is missing or malformed, or the project URL is wrong, the server returns 503 before calling Supabase.
   Evidence: `server/auth.js:166-170` and the explicit guard in the same function.
   - `if (env.VITE_SUPABASE_URL !== PROJECT || !env.VITE_SUPABASE_PUBLISHABLE_KEY?.startsWith('sb_publishable_') || typeof secret !== 'string' || secret.length < 32) return reply(503, ...);`
   This is also validated in `tests/auth-server.test.mjs` with the config rejection cases.

3. Registration does not auto-log the user in. The server explicitly refuses a session if email confirmation is not enabled or the Supabase account is not confirmed.
   Evidence: `server/auth.js:224-301`.
   - `signUp` is called with `emailRedirectTo: callback` and user metadata only.
   - `if (data?.session) { await client.auth.admin.signOut(data.session.access_token, 'global'); return reply(503, { error: 'Email confirmation must be enabled before registration.' }); }`
   - The login path fails closed with `if (error || !await saveSession(data?.session, appAccess)) return reply(401, { error: 'Invalid credentials or email not confirmed.' });`
   - `saveSession()` checks `user.email_confirmed_at` before creating the server session cookie (`server/auth.js:175-190`).

4. The callback flow is intentionally strict: it requires the PKCE verifier cookie and a valid code. If the callback is opened outside the same browser or the cookie is expired/missing, it returns 400 and no session is created.
   Evidence: `server/auth.js:296-301` and `server/auth.js:175-190`.
   - `if (typeof body.code !== 'string' || body.code.length > 2048 || !saved[VERIFIER]) return reply(400, { error: 'Invalid or expired link. Start again in this browser.' });`
   - `exchangeCodeForSession` must succeed and `saveSession()` must validate the account before a login session is stored.

5. Even after login, app launch is explicitly fail-closed when the durable login record is not present or the app session is expired.
   Evidence: `server/auth.js:332-376` and `server/app-access.js`.
   - `loginSessionId` is created via `appAccess.startLogin()` and required for launch tickets.
   - `if (!loginSessionId) return reply(401, { error: 'Sign in again to launch applications.', reason: 'login_required' });`
   - `server/app-access.js` performs preview-only and host validation before allowing app access and also requires configured app secrets and valid signed request metadata.

6. The client-side request helper is simple and relies on `/api/auth` returning JSON on the same origin. If the backend returns a non-JSON or non-OK response, the client surfaces a generic error, which makes the flow look as though nothing happened.
   Evidence: `src/authRequest.js:1-18`.

## Exact affected files and line numbers
- `server/auth.js:145-170` — Preview-only gate, trusted host, and same-origin checks.
- `server/auth.js:171-190` — cookie/session creation and `saveSession()` validation (`email_confirmed_at`, login record, activity cookie).
- `server/auth.js:224-301` — register/login/forgot/callback action flow.
- `server/auth.js:332-376` — session expiry, inactivity enforcement, app launch checks, and fail-closed response.
- `server/app-access.js:35-65` and `server/app-access.js:69-123` — preview-only enforcement, app configuration guard, and ticket start/login checks.
- `src/authRequest.js:1-18` — fetch wrapper for `/api/auth` and generic error handling.
- `tests/auth-server.test.mjs:34-101` — covers invalid config, exact host checks, registration, email confirmation, callback, login failure, and same-origin validation.

## Affected flow(s)
- Registration: affected. The code requires the right Preview config and valid/confirmed email registration semantics.
- Email confirmation: affected. The registration path intentionally waits for a confirmation link before creating a session.
- Login: affected. Login succeeds only if the credentials are valid and the Supabase user is confirmed.
- Callback: affected. It requires a valid PKCE verifier and valid code; otherwise it returns 400.
- App launch after sign-in: affected by fail-closed app-session checks, but this is secondary to the auth setup itself.

## Recommended minimal fix
This is a diagnosis-only report; no code changes are proposed here. The minimal production-safe next step is to fix the environment/configuration and live verification path:

1. Ensure the Preview branch is configured with the exact required variables: `VERCEL_ENV=preview`, `VERCEL_BRANCH_URL` matching the branch host, `VITE_SUPABASE_URL` matching the dedicated staging project, `VITE_SUPABASE_PUBLISHABLE_KEY` beginning with `sb_publishable_`, and `MYOPS_SESSION_SECRET` length >= 32 bytes.
2. In the Supabase project, enable email signup and email confirmation for the Preview project and set the exact redirect allowlist to the branch callback URL.
3. Verify a real, valid inbox + strong password and complete the confirmation in the same browser that started the flow.
4. Retest the browser flow: register -> email -> callback -> `/account` (or `/account/update-password` for reset) -> login session.
5. Only after the live Preview flow is proven should any auth or app-launch logic be considered ready for staging review.

## Security regression risks
The existing code intentionally hardens the auth path with server-owned cookies, host validation, and fail-closed app access. Any relaxation of those checks would introduce risk:
- CSRF or cross-origin form submission to `/api/auth` could trigger an auth action.
- Non-same-origin URLs could permit callback or reset abuse.
- If the verifier cookie or signed identity/login cookies were not validated, users could forge login or revocation state.
- Removing the 15-minute inactivity and 12-hour absolute session limits would break session integrity and entitlement controls.
- Granting app tickets without a verified login session would bypass the entitlement enforcement in `server/app-access.js`.

## Tests needed
The project already has the right behavioral tests in `tests/auth-server.test.mjs`; they should be retained and extended with live Preview gate checks:
- Data-only config checks for missing/invalid Supabase variables.
- Exact trusted-host and same-origin POST rejection.
- Registration failure for invalid email/test domain and weak password.
- Login failure for unconfirmed users and invalid credentials.
- Callback rejection when PKCE verifier cookie is missing or invalid.
- Successful registration + confirmation flow on the real Preview branch with a valid inbox.
- Inactivity expiry and force logout for an expired login session.
- App launch blocked when no valid durable login record exists.

## GO / NO-GO recommendation
NO-GO for production or any merge based on this diagnosis alone. The Preview auth flow is not safe to treat as working until the branch is configured and a real email-confirmed browser flow has been demonstrated against the dedicated Supabase project. A Preview-only GO is appropriate only after the environment variables, callback allowlist, and email confirmation flow all pass in a valid browser session.

This is a configuration and verification block, not a reason to bypass the existing security controls.
