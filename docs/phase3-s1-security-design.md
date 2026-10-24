# Phase 3 — S1 Application Access Security Design

Status: **Option A approved.** S1-B implements its MYOPS backend foundation; see [phase3-s1-b-ticket-backend.md](./phase3-s1-b-ticket-backend.md). The SQL remains unapplied and app integrations remain pending owner approval.

Addresses finding **S1 (High)** in [phase3-functional-security-uat.md](./phase3-functional-security-uat.md): `launch` returns the bare `MYOPS_APP_URL_<SLUG>`, so entitlement is enforced only at the MYOPS button and direct application URLs bypass it.

## 1. Current architecture (inspected)

| Area | Today |
|---|---|
| Identity | Supabase Auth (project `uhuukcztdifvpjuopdea`). `server/auth.js` exchanges credentials and stores the access token in an HttpOnly `__Host-myops-access` cookie. |
| Inactivity | HMAC-signed `__Host-myops-activity` cookie, 15-minute window, checked on every `/api/auth` call. Passive `session` probes do not extend it. |
| Entitlement | `resolveProductStates` in `server/auth.js` combines `myops_subscriptions` (single app or complete bundle, status, `current_period_end`), org `myops_app_grants`, `myops_lifetime_entitlements` (Founders, all live catalog apps) and `myops_products.launch_status`. Fails closed. |
| Launch | `action: "launch"` returns `{ next: MYOPS_APP_URL_<SLUG> }` after the check. No token is passed. |
| Slugs | `opsp` (OpsPS), `opsfinance`, `opsflow` are live. `opswms`, `opshr` are coming soon. |
| Unused | `myops_app_sessions` (RLS on, no policies) exists but nothing uses it. |
| Cookies | `__Host-` cookies are host-only, so they are **never sent to the app domains**. The apps cannot read MYOPS sessions. |
| Not visible here | The OpsFinance, OpsFlow and OpsPS repositories. Their stacks, auth and hosting are unknown and must be confirmed. |

Root cause: the apps have no way to ask "is this person entitled right now?" and MYOPS has no way to tell an app who the user is. The link is a plain URL.

## 2. Requirements to design decisions

| Req | Decision |
|---|---|
| 1 MYOPS is the authority | One new server-to-server **Entitlement API** on MYOPS. Apps never read Supabase tables and never hold Supabase keys. |
| 2 Users authenticate with MYOPS | The only way in is through MYOPS login. An app issues its own session only after redeeming a MYOPS launch ticket (section 3). |
| 3 No SSO | No OIDC/SAML, no shared cookies, no shared login, no refresh tokens or user JWTs given to apps. The ticket is a one-time, single-app authorization handoff, not a federated identity. The apps keep their own short sessions and do not accept MYOPS credentials. See open question Q1. |
| 4 Each app enforces on its server | Each app server calls the Entitlement API at session start and re-checks periodically (section 4). The frontend is never trusted. |
| 5 Direct URLs don't bypass | Every app route requires an app session. No session means redirect to the MYOPS homepage (login). |
| 6 No subscription means denied | The API returns `entitled: false` and the app refuses to create a session. |
| 7 Founders get all eligible apps | Server-side lifetime lookup covers every live catalog app, including future ones, using the same `resolveProductStates` logic. |
| 8 Expiry/revocation | Entitlement is re-checked against MYOPS every N minutes (default 5) and on every sensitive action. Revocation stops new tickets immediately. The worst case for an already open session is N minutes (section 7). |
| 9 15-minute inactivity | The app session has its own 15-minute idle timeout, and each re-check also asks MYOPS whether the MYOPS user session is still active (section 4). |
| 10 No secrets in browsers | The service-role key stays in MYOPS server functions only. Each app's Ed25519 private key lives only in that app's server environment; MYOPS stores public keys. Tickets contain no PII. |

## 3. Proposed flow

```
Browser            MYOPS (Vercel fn)                App server (e.g. OpsFinance)
  |  Open App         |                                  |
  |------------------>| 1. verify session + 15-min       |
  |                   |    activity + entitlement        |
  |                   | 2. create one-time ticket (60 s, |
  |                   |    bound to user, app, nonce)    |
  |<-- 302 app/launch?ticket=T ---|                      |
  |--------------------------------------------- GET /launch?ticket=T -->
  |                   |<--- POST /api/app/redeem (signed app request, T) ---|
  |                   | 3. verify app key, ticket not     |
  |                   |    used/expired, RE-CHECK         |
  |                   |    entitlement now, mark used     |
  |                   |--- {entitled, user_ref, expires} -->|
  |<------ Set-Cookie app session (HttpOnly, idle 15 min) ---|
```

1. **Ticket:** a 256-bit random value. MYOPS stores only its SHA-256 hash (table `myops_app_tickets`), with user id, product slug, expiry (60 s) and `used_at`. It is single use and bound to the product. The browser sees only the opaque value, and it is never a JWT carrying claims.
2. **Redeem:** the app server calls `POST /api/app/redeem` with an Ed25519-signed request (timestamp, nonce and body signed). MYOPS verifies the registered public key, redeems the ticket atomically, re-checks entitlement and returns only an opaque per-app user reference and app-session identifier.
3. **App session:** the app creates its own server-side session keyed by `user_ref` (an opaque id, not the Supabase UUID, if preferred). The app may map `user_ref` to its own users.
4. The ticket is carried in a URL, so it is short-lived, single use, and the app must immediately redirect to strip it from the address bar and history. The `Referrer-Policy: no-referrer` header is required on that response.

### Re-check (entitlement introspection)

`POST /api/app/entitlement` (app private-key signature) with `{ session_id, product }` returns `{ entitled, session_active, checked_at }`. The app calls it:

- at redeem time,
- every 5 minutes while the user is active (cached no longer than that),
- before sensitive or billable actions, such as exports, user invites or payments, if the app opts in.

Result handling is **fail closed**: a 4xx/5xx, timeout or bad signature ends the app session after a short grace period (suggested 2 minutes for transient network errors; none for explicit `entitled:false`).

### Inactivity (requirement 9)

- MYOPS keeps its existing signed 15-minute activity cookie unchanged.
- Each app session has its own 15-minute idle timeout, reset by app activity.
- App activity should be reported to MYOPS no more than once per 5 minutes through the re-check call. MYOPS then reports `myops_session_active`. If the MYOPS session was logged out or inactive, the app ends its session at its next re-check.
- Logout in MYOPS calls a **revocation** step marking `myops_app_sessions` rows revoked. The apps see this at the next re-check (at most 5 minutes). Optional hardening: a signed push webhook from MYOPS to each app (see Q4).

## 4. Changes required

### MYOPS (this repository)

| # | Change | Notes |
|---|---|---|
| M1 | Proposed SQL (not executed): hashed tickets, registered app public keys, hashed nonces, rate limits and app sessions. All RLS on, no client policies, service-role RPCs only, `search_path=''`. | See the versioned S1-B proposal and implementation report. |
| M2 | `launch` returns `{ next: <app>/launch?ticket=T }`, not the bare URL. The app origin is fixed from allowlisted environment values. | Replaces the S1 gap. |
| M3 | New `/api/app/redeem` and `/api/app/entitlement` handlers. They reuse `resolveProductStates` and `hasLifetime`. Ed25519 verification, timestamp/nonce replay protection, no CORS, no ticket/credential logging. | Implemented in Preview-only code; staging is blocked on the migration. |
| M4 | Rate limiting on the new endpoints and on `launch` and `founders`, which also addresses S4. | Needs a store (Vercel KV or a table). |
| M5 | Logout and inactivity paths mark the user's `myops_app_sessions` revoked. | Keeps requirement 9 end to end. |
| M6 | Each app retains its private signing key server-side; MYOPS stores current/next public keys. The service-role key remains in MYOPS server functions only. | No browser exposure (req. 10). |
| M7 | Tests (section 6). | |

### Each application (OpsFinance, OpsFlow, OpsPS repositories)

| # | Change |
|---|---|
| A1 | Add an auth middleware to **every** server route, API and static or asset route holding private data. Default deny. Only `/launch` and health checks are public. |
| A2 | `/launch` endpoint: read the ticket, call MYOPS redeem, create a server session cookie (`__Host-`, HttpOnly, Secure, SameSite=Lax, 15-minute idle), then redirect with the ticket stripped. |
| A3 | Re-check scheduler, as in section 3, with fail-closed behaviour and a short cache. |
| A4 | Unauthenticated or denied requests redirect to the MYOPS homepage. API calls get 401/403 with no data. |
| A5 | Store each app's Ed25519 private key in a server-only environment variable. Never ship it to the client bundle (no `VITE_`/`NEXT_PUBLIC_` prefixes). |
| A6 | Per-user data scoping in the app's own database remains the app's responsibility. This design only gates access. |
| A7 | If the app currently has its own login or a public deployment URL, disable or protect it so it cannot be used as a bypass. Provider preview URLs and old deployments must also be gated. |
| A8 | Contract tests against a MYOPS mock. |

## 5. Threat model

| # | Threat | Mitigation | Residual risk |
|---|---|---|---|
| T1 | Direct app URL used without MYOPS | Default-deny middleware, no session means redirect. | App must be audited for unprotected routes, static data, public previews (A1, A7). |
| T2 | Forged or guessed ticket | 256-bit random, hashed at rest, 60 s, single use, bound to product. | None practical. |
| T3 | Ticket replay or leak (history, logs, Referer) | Single use, immediate strip redirect, `no-referrer`, no logging of query strings. | Brief window for a leaked, unredeemed ticket. A shorter 30 s TTL is possible. |
| T4 | Ticket used for the wrong app | Ticket bound to product, and the redeeming client is bound to that product. | None. |
| T5 | Stolen app private key | Per-app Ed25519 signing keys, public keys in MYOPS, current/next rotation, timestamp and nonce. A compromised key may request or redeem app access for its bound app. | Rotate/revoke promptly and monitor. |
| T6 | Expired or revoked subscription still used | Periodic re-check (5 min), the fresh check on redeem, fail closed. | Up to 5 minutes for already open sessions. A push webhook could reduce it (Q4). |
| T7 | Founders edge cases (late or refund-flagged payment) | The lifetime entitlement exists only after a succeeded, allocated payment. Refund flagged payments grant nothing. Same code path as today. | A manual refund of an already allocated Founder needs a revoke procedure to set the entitlement to non-active. Not defined yet. |
| T8 | Single-app subscriber reaching other apps | The ticket and the check are per product. `resolveProductStates` already limits to one slug. | None. |
| T9 | Service-role or secret exposure to browsers | Only the server holds them. Browser-visible values are the opaque ticket and the app's own cookie. | Build-config mistakes: scan bundles in CI. |
| T10 | MYOPS session hijack, XSS | HttpOnly cookies, 15-minute inactivity. Add CSP (S5) and require the current password for password changes (S2). | Depends on S2 and S5 being fixed. |
| T11 | Entitlement API abuse or enumeration | Auth required, rate limits, generic errors, no user lookup by email. | Moderate. Needs M4. |
| T12 | MYOPS outage | Apps fail closed after the 2-minute grace. | Availability trade-off. |
| T13 | Clock skew on signed request timestamps | Five-minute skew window and nonce store. | Low. |
| T14 | Confused deputy through open redirect | Launch targets come only from allowlisted server environment values. | None. |

## 6. Test plan

**MYOPS (automated):** implemented coverage is documented in [phase3-s1-b-ticket-backend.md](./phase3-s1-b-ticket-backend.md). App-side route inventory and live E2E tests remain pending.

**Each app (contract and integration):** every route returns 401/redirect without a session (route inventory test); a forged cookie, an expired session and an idle 15-minute session are rejected; the re-check denies after revoke; transient failure grace and then lock; ticket stripped from the URL; the secret is absent from the client bundle.

**End to end (Preview and sandbox only, after approvals):** subscribe via sandbox, Open App succeeds; open the direct app URL in a fresh browser and get denied; expire or cancel and confirm re-check denial within 5 minutes and no new ticket; Founders open all three apps; a second account cannot see the first account's data; idle 15 minutes forces re-login.

## 7. Implementation sequence

1. Owner decisions on the questions below, and an inventory of each app's stack, hosting, login and public URLs.
2. Fix prerequisites: S2 (password change), S4 (rate limiting), S5 (security headers).
3. Write the proposed SQL (M1) and have it security reviewed. Do not execute until approved.
4. Build the MYOPS endpoints and tests (M2–M5, M7) behind a Preview-only flag.
5. Build a reference verifier module (small, copyable) for the apps, plus a mock MYOPS for their tests.
6. Integrate OpsPS first (smallest risk), then OpsFinance, then OpsFlow, each in its own PR, with the default-deny route inventory.
7. Preview end-to-end UAT, security re-review, then owner approval before any production step.

## 8. Dependencies and limitations

- Access to the three app repositories and their hosting config. Unknown today.
- Approved and applied Phase 2A and Phase 3 SQL, plus the new SQL (M1).
- `MYOPS_SERVICE_ROLE_KEY`, `MYOPS_SESSION_SECRET`, `MYOPS_APP_USER_REF_SECRET` and the per-app Ed25519 keys provisioned on Preview.
- A rate limit store for M4.
- Revocation latency: with polling it is up to the re-check interval (5 minutes). Truly instant revocation needs a push webhook or a per-request check, which costs latency and MYOPS availability coupling.
- Apps that keep their own long-lived login will still bypass this unless that login is removed or placed behind the ticket (A7).
- Users who are already inside an app when MYOPS logs them out remain until the next re-check.
- Static assets served by a CDN without a server cannot enforce access, so apps need a server in front of private content.
- The homepage, brand, artwork, company details and policies are not touched by this work.

## 9. Outstanding questions for the owner

1. **Is the ticket handoff acceptable under "no SSO"?** It is one-time and per-app and issues no shared identity, but it does tell the app who the user is. The alternative, with no handoff at all, makes each app run its own login and ask MYOPS "is this email entitled?". This is weaker, because it relies on emails and apps then hold separate credentials.
2. What are the stacks, hosting and current login method of OpsFinance, OpsFlow and OpsPS, and do they have public or preview URLs?
3. Revocation target: is a delay of up to 5 minutes acceptable, or must it be near immediate (push webhook, per-request check)?
4. Should MYOPS push revocation webhooks to the apps (more secure, more moving parts)?
5. Should apps see the Supabase user id, or an opaque per-app `user_ref`? An opaque id is recommended.
6. Business and organisation access: this design supports org grants through the same API. Is it in scope now, given Business billing is disabled?
7. If a Founder is refunded after allocation, may staff revoke the lifetime entitlement and free the slot, or is the slot permanently used?
8. Who owns per-app Ed25519 private-key rotation and monitoring?
9. Should the 15-minute inactivity window in apps be counted from app activity only, or also end when MYOPS ends?

## 10. Approval

No implementation starts until the owner approves this design and answers the questions above.
