# Phase 3 S1-B — Secure Application Launch Ticket Backend

Status: **Backend foundation implemented in code; staging activation BLOCKED.** This is Preview-only code. No SQL was executed, no app repository was changed, no Production deployment or merge occurred, and ToyyibPay/payment code and prices were not changed.

This implements the server-side ticket issuer, redemption and entitlement-verification contract approved in [phase3-s1-integration-readiness.md](./phase3-s1-integration-readiness.md). The app servers have not integrated it yet, so direct access to their current URLs is not yet protected.

## Endpoints

### Issue: existing `POST /api/auth` action `launch`

The existing auth handler still requires its exact trusted Preview host, same-origin JSON POST, confirmed MYOPS identity and valid signed 15-minute activity cookie. It loads current entitlements and refuses non-live or unentitled products. It now creates a 32-byte cryptographically random ticket and returns a redirect URL of the form:

```text
https://<registered-preview-app-host>/<configured-base-path>/launch#t=<opaque-ticket>
```

The ticket is delivered in the URL **fragment**, which browsers never send to servers, access logs or `Referer` headers. The browser receives it because it must hand it to the app. The app's `/launch` page must read it from `location.hash`, immediately remove it with `history.replaceState`, and `POST` it to the app's own server (with `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, and no analytics on that page). MYOPS stores only its lowercase SHA-256 hash. The database proposal sets the expiry to 60 seconds. App target URLs are server environment configuration and must be HTTPS with no userinfo, query or fragment. The app ID/product mapping is also checked against the registered database client.

### Redeem: `POST /api/app/redeem`

The requesting app server signs its request with Ed25519. MYOPS verifies the registered public key, timestamp, nonce and signature; rate-limits the request; records the nonce once; and calls the atomic redeem RPC. That RPC locks the ticket row, verifies expiry/unused/app-product binding, marks it used and creates one app-scoped session. The server then reads current entitlement again. If access has expired or been revoked, it revokes the just-created session and returns denial.

Success returns only:

```json
{
  "session_id": "<opaque UUID>",
  "user_ref": "<app-specific opaque HMAC reference>",
  "product": "<authorized product slug>",
  "idle_seconds": 900
}
```

It returns no email, Supabase ID, access token, refresh token, ticket hash or MYOPS credentials. The app must create its own server-side session and `__Host-` HttpOnly cookie; that cookie is not issued by this repository.

### Verify: `POST /api/app/entitlement`

The app server supplies its app session ID, product, `activity` (true only when the request was caused by genuine user activity; default false) and an optional `sensitive` boolean under the same Ed25519 contract. `sensitive: true` requires `activity: true`. Polling or heartbeats (`activity` false/omitted) never extend the 15-minute inactivity window. The MYOPS API validates the app ID/product/session, rejects revoked or idle sessions, and does a fresh entitlement lookup for every call (no MYOPS-side entitlement cache). It returns only `{ entitled, session_active, checked_at }` or a generic denial. If the entitlement lookup itself fails it returns 503 and keeps the session (the app must deny that request); only a successful lookup showing no entitlement revokes the session.

Apps must call this endpoint for every sensitive operation. Normal browsing integrations may use the approved maximum 5-minute cache, but the app must end its own session at its 15-minute idle deadline. An API outage denies sensitive operations immediately and denies normal access after the integration's short fail-closed grace period. That app-side behaviour remains unimplemented.

Both new APIs are Preview-only, POST-only, reject browser `Origin` requests and require JSON. They emit `no-store`/`no-referrer` headers and never log request bodies, signatures, tickets, user IDs or credentials.

## Application authentication: Ed25519 (selected)

Ed25519 is the chosen server-to-server request-authentication method. Each app creates its own key pair:

- **Private key:** stays only in that app's server environment. It must not use a `NEXT_PUBLIC_`, `VITE_`, `EXPO_PUBLIC_` or other client-exposed prefix.
- **Public key:** registered in `myops_app_clients`; MYOPS stores no app private key or shared app secret.
- **Key versions:** request header `X-Myops-Key-Version` chooses `current` or `next`, allowing controlled overlap during rotation.

This choice avoids the unresolved HMAC problem in the S1-A design: MYOPS cannot verify HMAC requests from a one-way hash of the shared secret. Asymmetric signatures let MYOPS keep only public material. Ed25519 verification is available in Node's built-in `node:crypto`, has fixed-size signatures, and is covered by tests. Request authentication still requires replay protection: the timestamp is Unix milliseconds and must be within five minutes, and a hashed nonce is accepted once for ten minutes.

Canonical signature message (UTF-8):

```text
<uppercase method>
<fixed path, /api/app/redeem or /api/app/entitlement>
<app id>
<key version header: current or next>
<13-digit Unix-millisecond timestamp>
<base64url nonce>
<lowercase hex SHA-256 of canonical JSON body>
```

Canonical JSON sorts object keys at every nesting level and encodes with compact JSON, so no nested or extra field can change without invalidating the signature. The app id and key version are signed. Only Ed25519 public keys are accepted (verified in code via `asymmetricKeyType`, and enforced by a database check on the SPKI prefix). Signature is base64url Ed25519. The client must sign the same bytes and use HTTPS. Signature/key errors return generic 401; timestamps outside the window, nonce reuse, disabled clients, wrong app and invalid tickets fail closed.

Rotation: add the new public key as `public_key_next`; deploy the app with its matching private key and `X-Myops-Key-Version: next`; verify Preview traffic; promote the new key to current and clear next; remove the old private key. Do not put private key material in SQL, Git, browser config or logs.

The independent `MYOPS_APP_USER_REF_SECRET` is a MYOPS server secret used to derive a different stable opaque user reference per app. Rotating it changes app user references and needs coordinated mapping/migration in each app; do not rotate without that plan.

## Logout, inactivity and expiry

- MYOPS stores a server-HMAC-signed identity cookie (`__Host-myops-identity`, HttpOnly, 12 h) at login. Revocation uses only identities proven by the server: this signed cookie or a verified token. Forged, tampered or stale cookies are ignored, and revocation does not depend on a live Supabase access token.
- Explicit MYOPS logout signs out the MYOPS Auth token (a sign-out error for an already invalid token is tolerated) and calls the service-only `myops_revoke_user_app_access` RPC. It revokes all unused tickets and active app sessions for that user across all registered apps.
- When MYOPS detects an expired 15-minute activity cookie or an invalid/expired token, it clears the cookies and revokes the user's app sessions. If revocation fails, the request fails (HTTP 500) rather than reporting success. Closing a tab sends no request, so app sessions in that case end by their own 15-minute inactivity limit.
- App sessions are idle-checked at 15 minutes since last asserted user activity and have a 12-hour absolute lifetime (`max_session_seconds` in the redeem response) in `myops_validate_app_session`; stale rows are revoked at the next verification. The app itself must enforce its own 15-minute idle limit on every protected route.
- Subscription/lifetime access is freshly read when a ticket is redeemed and on each entitlement API call. A revoked/expired entitlement cannot get a new ticket and revokes a session on its next check. Sensitive operations require a fresh call, no cache.
- Target normal-browsing revocation latency remains at most five minutes, dependent on the app integration checking at least every five minutes. Sensitive operations are checked on every action. No push-revocation webhook exists yet.
- MYOPS logout cannot instantly erase an app's local session without an app request. App integrations must check on every protected route and reject a revoked session. The current app repositories are not changed, so their existing URLs may still bypass MYOPS until S1-C integration.

Founders 100 rules are unchanged. The existing entitlement resolver is moved without logic changes to `server/entitlements.js` and reused by the app endpoints. Lifetime entitlement remains all live catalog apps, including future apps when marked live. Single-app subscriptions remain limited to their product.

## Database proposal (NOT EXECUTED)

Versioned proposal: [`202610170001_myops_app_access.sql`](../supabase/proposals/202610170001_myops_app_access.sql).

It depends on the Phase 2A identity schema and Phase 3 entitlement tables. It adds:

- `myops_app_clients`: product binding, enablement and current/next Ed25519 public keys.
- `myops_app_tickets`: user/product binding, hash only, created/60-second expiry, use and revoke timestamps.
- `myops_app_nonces`: hashed replay nonce and ten-minute expiry.
- `myops_app_rate_limits`: atomic per-key fixed-window counters.
- `myops_app_audit`: app ID, event, safe reason code and time only; no ticket, IP, email or user ID.
- Per-app/product/revocation columns on the existing `myops_app_sessions`.
- Service-role-only RPCs for client lookup, ticket issue/redeem, nonce insert, session validation/revocation and rate limiting.

All new tables use RLS with no client policies. The RPCs use `SECURITY DEFINER`, pinned empty `search_path`, and execute grants only to `service_role`. Ticket redemption row-locks its ticket; logout and issue serialize on a per-user advisory lock; request nonces use a unique hash; rate-limit counters serialize per hashed key. The SQL tests run this proposal only in a throwaway local PostgreSQL cluster. They do not apply it to Supabase.

The migration has no app-client seed rows. After security review/approval, each app's public key and product mapping must be provisioned through the approved staging-only admin process. No client is enabled by default.

## Staging/Preview configuration (placeholder names only)

**MYOPS Preview server-only variables**

| Variable | Purpose |
|---|---|
| `MYOPS_ENVIRONMENT` | Must be exactly `staging`; otherwise all app-access endpoints and ticket issuance stay disabled (503). Set only on the verified staging Preview scope, never Production. |
| `MYOPS_SERVICE_ROLE_KEY` | Existing server-only Supabase secret key; never expose to client code. |
| `MYOPS_APP_USER_REF_SECRET` | At least 32 random bytes, server-only, dedicated to per-app opaque references. |
| `MYOPS_APP_URL_OPSFINANCE` | HTTPS OpsFinance Preview base URL/path (no query or fragment). |
| `MYOPS_APP_URL_OPSFLOW` | HTTPS OpsFlow Preview base URL/path (no query or fragment). |
| `MYOPS_APP_URL_OPSP` | HTTPS OpsPS Preview base URL/path (no query or fragment). |
| `VITE_SUPABASE_URL` | Existing fixed staging project URL check; publishable key remains public by design. |

**Each application server (not configured by this task)**

| Variable | Purpose |
|---|---|
| `MYOPS_BASE_URL` | MYOPS Preview origin. |
| `MYOPS_APP_ID` | `opsfinance`, `opsflow` or `opsp`. |
| `MYOPS_APP_PRIVATE_KEY_CURRENT` / `MYOPS_APP_PRIVATE_KEY_NEXT` | Private signing key(s), server-only. |
| `MYOPS_KEY_VERSION` | `current` or `next`, matching registered public key. |
| `APP_SESSION_SECRET` | Application's own server-side session secret, if its framework requires one. |

No actual values are included here. All variables and key rows need owner approval and a verified staging project. The migration is unapplied; absent schema/config all new functionality fails closed. Do not use the production app URLs or production secrets in Preview.

## Rate limits and audit

The SQL-backed limiter is atomic across serverless instances. Current provisional windows:

- Ticket issuance: 10 requests/user/product per 60 seconds.
- Redeem: 30 requests/IP and 100 requests/app per 60 seconds.
- Entitlement verification: 120 requests/IP and 600 requests/app per 60 seconds.

IP is reduced to a SHA-256 key before it reaches the database; no IP is persisted. App-level limits continue to apply after signature verification. These defaults require staging load validation and owner/security approval before use. Rate-limit and nonce rows need a scheduled cleanup/retention process; none is configured in this change. Audit retention also requires an owner policy.

## Automated coverage added

- Ed25519 signature creation/verification and request tampering.
- Ticket entropy shape, app URL binding and hash-only storage.
- Redemption entitlement recheck, minimum response shape and opaque user ref.
- Invalid signature, browser Origin, stale timestamp, replayed nonce, rate limiting and missing service key.
- Wrong-app/invalid ticket, revoked or unreadable entitlement, expired app session.
- Current entitlement verification and logout/inactivity revocation in MYOPS.
- Local PostgreSQL checks: RLS and grants, 60-second expiry, app binding, concurrent one-time redemption, nonce replay, atomic rate limits, logout revocation and 15-minute app-session expiry.
- Existing payment and Founders tests remain in the suite and no payment logic/prices were changed.

These are unit/local database tests, **not** a live Preview/Supabase/app E2E integration.

## Limitations and blockers

1. **Do not integrate apps yet.** OpsFinance, OpsFlow and OpsPS still need per-repository S1-C changes. Their current login/direct URL behavior is unchanged.
2. **Migration security review and owner approval are required.** This proposal is not executed; Phase 2A and Phase 3 schema are also required.
3. **No Preview secrets, key pairs, DB app-client registrations or app URLs are provisioned here.** No actual app can redeem until they are.
4. **No live end-to-end run** is claimed. Supabase Auth, Vercel environment and app deployments are not accessed by these tests.
5. The current OpsPS repository is a static web export, so it still needs an app-side server layer or a different mobile deep-link design.
6. OpsFlow/OpsFinance must implement secure server-side sessions and protect all API routes; the MYOPS backend cannot fix those repositories from here.
7. Ed25519 key provisioning/rotation must be practiced in staging. The database stores public key PEM only.
8. No push revocation is implemented. Normal browsing can retain access up to the five-minute revalidation interval; sensitive actions must be checked on every operation.
9. Stale app access records and audit retention need an approved cleanup schedule.

## Approval gate

No Supabase migration execution and no OpsFinance integration are authorized by this implementation task. Wait for owner approval of the SQL security review, staging config and S1-C app plan.

## S1-B security remediation (post-review)

See [phase3-s1-b-security-review.md](./phase3-s1-b-security-review.md) for the findings and their remediation status. Additional proposal objects: `myops_cleanup_app_access()` (retention; schedule only after approval), `myops_promote_app_key(text)` (key rotation) and `supabase/proposals/202610170001_myops_app_access_rollback.sql` (not executed). Rate-limit client identity prefers `x-vercel-forwarded-for` (set by the platform) over client-controlled headers.
