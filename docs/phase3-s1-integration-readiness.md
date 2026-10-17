# Phase 3 — S1-A Application Integration Readiness Audit

Status: **Audit and plan only. Awaiting owner approval before S1-B.** No code changed, no SQL executed, nothing merged or deployed, no live payments. Homepage, colours, 3D artwork, company details and policies are untouched.

Builds on [phase3-s1-security-design.md](./phase3-s1-security-design.md). Owner decision applied: **Option A**. The user logs in once at MYOPS. MYOPS issues a short-lived, one-time, app-specific launch ticket. Each app validates it server-to-server and creates its own session. There is no shared browser session or cookie and no second password prompt.

Evidence labels: **VERIFIED** means I read it in a repository or got a live HTTP response. **INFERRED** means a conclusion from what I read. **UNKNOWN** or **BLOCKED** means not determinable here. Nothing in this document is claimed as tested. I ran no tests in the app repositories.

## 1. MYOPS findings (VERIFIED, this repository)

| Area | Finding | Reuse |
|---|---|---|
| Identity and session | `server/auth.js` holds the Supabase access token in the HttpOnly `__Host-myops-access` cookie. It is host-only, so apps on other hosts never see it. | Keep as is. |
| Inactivity | The HMAC-signed `__Host-myops-activity` cookie gives a 15-minute window, enforced on every request. Passive probes do not extend it. | `signActivity` / `activityValid` pattern reused for app sessions. |
| Entitlement | `resolveProductStates` and `hasLifetime` combine single-app and bundle subscriptions, expiry, org grants, lifetime (Founders, all live catalog apps) and the catalog `launch_status`. They fail closed. | Reuse unchanged as the single source of truth for redeem and introspection. |
| Launch | `action: "launch"` checks session, activity and entitlement, then returns the bare `MYOPS_APP_URL_<SLUG>`. **No ticket**, which is the S1 gap. | Replace the return value only. |
| Slugs | The catalog slugs are `opsp` (OpsPS), `opsfinance`, `opsflow`, `opswms` and `opshr`. Env names use the upper-cased slug, e.g. `MYOPS_APP_URL_OPSP`. | Keep. Note `opsp`, not `opsps`. |
| `myops_app_sessions` | It has `id`, `user_id`, `last_activity_at`, `revoked_at`, `created_at`, with RLS on and no policies. Nothing reads or writes it. It has **no product column**, no ticket link and no per-app dimension. | Extend rather than replace (section 5). |
| RPC pattern | `server/payments.js` calls narrow `SECURITY DEFINER` RPCs through a service-role client. The proposals pin `search_path=''` and grant `EXECUTE` to `service_role` only. | Same pattern for tickets. |
| Rate limiting | None exists (UAT S4). | Prerequisite. |
| Headers | No CSP or `frame-ancestors`. Finding S5. | Prerequisite for ticket pages. |
| Account type | The server-owned `myops_profiles.account_type` already decides eligibility. | Reuse for `user_ref`. |
| Test harness | `tests/helpers/load-src.mjs` and the injected clock/transport and ledger-state patterns in `auth-server.test.mjs` and `founders-payments.test.mjs`. The local PostgreSQL test pattern is in `founders-sql.test.mjs`. | Reuse for the new tests. |

## 2. Application repositories (discovered through the public GitHub API, read-only)

| MYOPS slug | Repository | Hosting evidence | Confidence |
|---|---|---|---|
| `opsfinance` | `niz262025-hub/OpsFinance` | Repo homepage field is `https://opsfinance-flame.vercel.app`. Vercel Preview deployments exist. | VERIFIED |
| `opsflow` | `niz262025-hub/OpsFlow` | No homepage set. No hosting evidence. | VERIFIED (repo), hosting UNKNOWN |
| `opsp` (OpsPS) | `niz262025-hub/OpsPSMobileR1` ("OpsPS Mobile v1", package `bizps-mobile`) | Repo homepage field is `https://opsp-mobile-r1.vercel.app`. `VERCEL_DEPLOYMENT.md` and `vercel.json` exist. | INFERRED. Please confirm this is the OpsPS product. |

Other facts:

- The MYOPS homepage "Open App" target for the catalog is `https://app.myops.com.my/`. A request to it (one unauthenticated GET) returned 307 to `/login`. **Which app it serves is UNKNOWN.**
- The `MYOPS_APP_URL_*` values configured for Preview are **UNKNOWN**. They are not in the repository.
- Repositories are public, so I read them over the GitHub API without credentials. I could not see Vercel, Firebase, MongoDB or Supabase configuration, environment variables, deployment lists beyond the GitHub deployment metadata, or private branches.

## 3. Per-application readiness

### 3.1 OpsFinance — Next.js 14 App Router on Vercel. Readiness: **MEDIUM** (server exists, but it has its own auth and billing)

| Aspect | Evidence |
|---|---|
| Framework | Next 14.2.15, React 18, `@supabase/ssr`, `@supabase/supabase-js`, Vitest, Playwright. VERIFIED |
| Auth | Its own Supabase Auth login and register pages (`/login`, `/register`, `/auth/callback`) and `middleware.ts`, which calls `supabase.auth.getUser()` and redirects unauthenticated users. VERIFIED |
| Protected routes | A prefix list in `middleware.ts` and `lib/auth/session.ts`: `/dashboard`, `/accounts`, `/transactions`, `/upload`, `/reconciliation`, `/reports`, `/settings`. VERIFIED |
| Public routes | `/`, `/opsfinance`, `/login`, `/register`. VERIFIED |
| Default-deny? | **No.** Routes outside the prefix list are public. A new route is public unless someone adds it to the list. `middleware.ts` also lacks a `config.matcher` in the excerpt I read, so I cannot say which paths it covers. The `/api` routes were not found by my scan. UNVERIFIED |
| Entitlement | `SUBSCRIPTION_BILLING.md` describes its **own** billing (Starter RM29/month, lifecycle states). It is a separate entitlement model that conflicts with MYOPS as the sole authority. VERIFIED (docs) |
| Database | Supabase with business-scoped RLS (`business_members`). Whether it shares the MYOPS staging project `uhuukcztdifvpjuopdea` is UNKNOWN. Its UAT doc says live verification was blocked. |
| Bypass risks | (a) The public Vercel URL, with its own login/register that lets anyone sign up. (b) Vercel Preview deployments. (c) The prefix allow-list model. (d) Its own subscription model. |
| Service role | `.env.example` lists `SUPABASE_SERVICE_ROLE_KEY`, which must stay server-only. |
| Live probe | `GET https://opsfinance-flame.vercel.app/dashboard` returned HTTP 404 (single request). The reason is undetermined, so it is not evidence of protection. |

Needed changes: remove or gate `/register` and the standalone login. Add a `/launch` route handler. Replace the Supabase-user check with a MYOPS-ticket-derived session, or keep Supabase auth for tenant data and add the MYOPS gate on top. That choice is **Q-A below**. Invert the middleware to default-deny. Drop its own subscription gating in favour of the MYOPS introspection call.

### 3.2 OpsFlow — Expo (React Native web) frontend plus FastAPI/MongoDB backend. Readiness: **LOW to MEDIUM**

| Aspect | Evidence |
|---|---|
| Framework | Expo (`app.json`, `expo-router`, web output `single`) frontend. Python FastAPI backend (`backend/server.py`, about 1,290 lines, 35 `@api_router` routes). VERIFIED |
| Auth | Its own register and login (`/auth/register`, `/auth/login`, `/admin/login`), PyJWT bearer tokens, `HTTPBearer`, `get_current_user` and `get_current_admin` dependencies. `.env.example` also references Firebase web config. VERIFIED |
| Session | Bearer JWT, **30-day expiry** (`timedelta(days=30)`) and no inactivity timeout. VERIFIED |
| Signing key | Derived as SHA-256 of `SECRET_KEY_SOURCE` (value not visible). Strength is UNKNOWN. |
| CORS | `allow_origins=["*"]`. VERIFIED |
| Protected routes | Per-route `Depends(get_current_user)` (explicit opt-in rather than default deny). I did not audit every route. UNVERIFIED |
| Entitlement | None. No subscription check was found in the routes I scanned. INFERRED |
| Database | MongoDB through Motor, not Supabase. VERIFIED |
| Hosting | Unknown. A `frontend/.firebase` directory and `.emergent` folders hint at other tooling. UNKNOWN |
| Bypass risks | The public backend API and its own registration. 30-day tokens would outlive revocation. Wildcard CORS. |

Needed changes: this is the largest gap. The backend must stop issuing self-registered long-lived tokens for MYOPS-managed access. It needs a `/launch` ticket redeem endpoint, a server-side session (or a short JWT of 15 minutes or less plus server-side revocation), default-deny middleware, a restricted CORS list and per-request entitlement checks. The Expo web bundle is a static client. The server enforcement has to live in FastAPI.

### 3.3 OpsPS (candidate `OpsPSMobileR1`) — Expo, static SPA export on Vercel. Readiness: **LOW (BLOCKED on architecture)**

| Aspect | Evidence |
|---|---|
| Framework | Expo about 57, React Native 0.86, `react-native-web`. README: "mobile-only … Android … Expo Go … Out of scope: Expo web". But `VERCEL_DEPLOYMENT.md` and `vercel.json` publish a static web export. The two statements conflict. VERIFIED |
| Server | **None.** Static `dist/` with a catch-all rewrite to `/index.html`. VERIFIED |
| Auth | Client-side Supabase (`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY`) in `context/AuthContext.tsx`. `SUPABASE_PRODUCTION_READINESS.md` says the workspace was "NOT CONFIGURED" for Supabase and the app was mock-backed at its 2026-09-05 assessment. Current state UNKNOWN. VERIFIED (docs) |
| Protected routes | Client-side only. A static site cannot enforce authorization on a server. VERIFIED (inferred from architecture) |
| Entitlement | None. |
| Extra | Contains `mock-shared-db-store.json` and `.mock-shared-store.json` committed, which should be checked for real data. Also a payments config pointing at Stripe sandbox, which conflicts with ToyyibPay and MYOPS being the billing authority. |
| Bypass risks | The public Vercel URL returned HTTP 200 (single request), so the web build is publicly reachable. Static assets and client logic are open. The Android build ships offline. |

Needed changes: Requirement 4 (each app enforces on its server) **cannot be met by a static SPA**. It needs a server component: either Vercel Functions or Edge Middleware in front of the app, or a backend API that holds the data and does the check. If the real OpsPS product is the Android app, the web URL needs to be removed or locked, and the mobile flow needs a different handoff (deep link ticket). That is **Q-C below**.

### 3.4 Summary

| App | Server to enforce? | Own login/billing to disable | Public bypass URLs | Readiness |
|---|---|---|---|---|
| OpsFinance | Yes (Next middleware and route handlers) | Supabase auth, `/register`, billing | Vercel URL, previews | MEDIUM |
| OpsFlow | Yes (FastAPI) | Register/login, 30-day JWT | Backend API, unknown frontend host | LOW to MEDIUM |
| OpsPS | **No (static)** | Client Supabase auth, Stripe config | Vercel URL (200 confirmed) | LOW, BLOCKED |

## 4. Security contract (MYOPS to app)

All of this is design. None of it is implemented.

### 4.1 Ticket
- **Format:** 32 random bytes from a CSPRNG, base64url encoded. It is opaque, never a JWT, and holds no claims.
- **Storage:** MYOPS stores only `sha256(ticket)`.
- **Binding:** one `user_id` and one product slug. It expires 60 seconds after issue and has a `used_at` column.
- **Delivery:** HTTPS redirect to the app's registered launch URL as `?t=<ticket>`. The target comes only from the app client record, never from request input.
- **Issuance:** only after `launch` verifies a confirmed session, a live 15-minute activity cookie and current entitlement. A ticket is not issued if the user logged out.

### 4.2 Redemption (server to server)
`POST {MYOPS}/api/app/redeem` with JSON `{ ticket }`, signed headers `X-App-Id`, `X-Timestamp` (within 5 minutes), `X-Nonce` and `X-Signature = HMAC-SHA256(app_secret, method|path|timestamp|nonce|sha256(body))`.

MYOPS in one transaction:
1. Verifies the app client (enabled, the signature matches in constant time, the nonce was not seen).
2. Claims the ticket atomically: `update ... set used_at = now() where ticket_hash = $1 and used_at is null and expires_at > now() and product_slug = <client.product> returning user_id`. Zero rows means 400 with a generic error. There is no race window.
3. Re-checks entitlement with `resolveProductStates` at redeem time, so a cancellation between launch and redeem is denied.
4. Creates an `myops_app_sessions` row (with product) and returns `{ user_ref, session_id, entitled: true, idle_seconds: 900 }`.

The failure responses are indistinguishable (expired, used, wrong app, not entitled), and the details go only to the audit log.

### 4.3 Identifier and app session
- `user_ref = base64url(HMAC-SHA256(per_app_pepper, user_id))`: opaque, stable per app, and different between apps. The Supabase UUID never leaves MYOPS.
- App session: an HttpOnly, Secure, `SameSite=Lax`, `__Host-` cookie holding a random id for a **server-side** record. It lives on the app's own host, with a 15-minute idle timeout and an absolute maximum (suggested 8 hours).
- The `/launch` handler must respond with a 303 redirect to a clean path so the ticket leaves the URL. The response has `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
- The ticket must never reach third-party scripts, analytics or logs. Apps should strip query strings from access logs on `/launch`. No analytics tag may load on that route.

### 4.4 Authorization on every request
Default deny: every server route requires a valid app session, except `/launch` and a health check. A session check costs a local lookup. Entitlement is re-checked as follows.

| Situation | Entitlement check |
|---|---|
| Normal browsing | Cached for at most **5 minutes**, then revalidated through `POST /api/app/entitlement`. |
| **Sensitive actions** (exports and downloads, financial postings, invites and user changes, billing or plan changes, data deletion, API key creation, bulk operations) | **Fresh MYOPS check for every action. No cache.** |
| MYOPS unreachable | Normal browsing: grace of up to 2 minutes and then deny. Sensitive actions: deny immediately. |
| Explicit `entitled: false` or `session_active: false` | End the app session at once. |

### 4.5 Revocation
- MYOPS logout and the 15-minute MYOPS inactivity both mark the user's `myops_app_sessions` rows revoked and stop new tickets.
- **Acceptable latency for normal browsing: 5 minutes** (the cache window). Sensitive actions: immediate. Owner to confirm (Q-3). A signed push webhook (`POST app/_myops/revoke`) is an optional later step that would cut browsing latency to seconds.
- Expired, cancelled or refunded entitlement stops new tickets right away and ends app sessions at the next check.
- The app's own 15-minute idle timeout is independent of MYOPS: it ends the app session, and it does not log the user out of MYOPS.

### 4.6 Operational controls
- **Rate limiting:** `launch`, `redeem` and `entitlement` per IP and per user, with a lower limit for failed redeems. Needs a store (Vercel KV or Upstash) or a DB counter. This also closes UAT S4.
- **Audit log** (table `myops_app_audit`): issue, redeem success and failure with a reason code, entitlement denials, and revocations. Never log tickets, secrets, cookies or full signatures.
- **Secret rotation:** each app client has two accepted secrets (current and next) with a rotation timestamp. The raw values are shown once. MYOPS keeps only hashes or an encrypted form, depending on whether HMAC verification needs the raw key (see Risks R3).
- **No leakage into bundles:** app secrets and the service-role key use server-only environment variable names. Never use the `VITE_`, `NEXT_PUBLIC_` or `EXPO_PUBLIC_` prefixes. CI scans the build output for the secret prefixes.

### 4.7 Old login paths and direct URLs
For each app: disable public registration; remove or redirect the standalone login to the MYOPS homepage; reject any request without an app session; protect Vercel Preview and old deployment URLs (Vercel Deployment Protection or an env flag that refuses requests); restrict CORS; and remove any alternative token issuance. An app that keeps a separate password login remains bypassable, so the owner must decide this.

## 5. Implementation plan

### 5.1 MYOPS — files to create or modify
| File | Change |
|---|---|
| `server/auth.js` | `launch` issues a ticket and returns `{ next: <registered launch URL>?t=… }`. Logout and inactivity paths call the revoke RPC. |
| `server/app-access.js` (new) | Ticket issue, HMAC verification, redeem and introspection logic. It calls RPCs and reuses `resolveProductStates`. |
| `api/app-redeem.js`, `api/app-entitlement.js` (new, thin handlers) | Server-to-server only. No CORS, no cookies. |
| `server/rate-limit.js` (new) | Shared limiter. |
| `supabase/proposals/phase3_s1_app_access.sql` (new, **proposal only**) | See 5.3. |
| `vercel.json` | Routes for the new endpoints, plus the S5 headers. |
| `tests/app-access.test.mjs`, `tests/app-access-sql.test.mjs` (new) | See section 7. |
| `docs/` | A contract reference for the app teams and an env var table. |

### 5.2 Each app — files to create or modify (to confirm at S1-B)
| App | Create or modify |
|---|---|
| OpsFinance | New `app/launch/route.ts` (redeem and set the session). `middleware.ts` becomes default-deny with an explicit public list and a `config.matcher`. New `lib/myops/client.ts` (signed requests and introspection). Disable `/register` and the standalone `/login`. Remove or bypass its internal subscription gating. Add Vercel Deployment Protection. |
| OpsFlow | New FastAPI `/launch` route and an app-session dependency that replaces `get_current_user` for MYOPS-managed access. New `myops_client.py`. Shorten token lifetime (15 minutes idle, server-side revocation). Restrict `allow_origins`. Disable `/auth/register`. Review all 35 routes. |
| OpsPS | **Blocked on Q-C.** If the web build stays: add a server layer (Vercel Edge Middleware or Functions) with a `/launch` handler and a session cookie in front of the static output, plus a protected data API. If the product is Android only: remove the public web deployment and design a deep-link ticket flow. Remove the Stripe config. Audit the committed mock store JSON files. |

### 5.3 Proposed database changes (not executed)
All tables have RLS on, no client policies, `SECURITY DEFINER` RPCs with `search_path=''`, and `EXECUTE` for `service_role` only. They need the same security review as the Phase 3 SQL.

- `myops_app_clients(app_id, product_slug references myops_products, launch_url, secret_hash_current, secret_hash_next, pepper, enabled, rotated_at)`.
- `myops_app_tickets(ticket_hash pk, user_id, product_slug, created_at, expires_at, used_at)`, with an index on `expires_at` and a purge job.
- `myops_app_nonces(app_id, nonce, seen_at)` with a unique key and a purge job.
- Alter `myops_app_sessions`: add `product_slug`, `app_id` and `ended_reason`. The current table has no per-app dimension.
- `myops_app_audit(id, at, app_id, user_id, event, reason_code)`.
- RPCs: `myops_issue_ticket`, `myops_redeem_ticket` (atomic), `myops_app_introspect`, `myops_revoke_user_sessions`, `myops_touch_app_session`.
- **No execution**: SQL is only written as a proposal file.

### 5.4 Environment variables (placeholder names)
- **MYOPS server:** `MYOPS_SESSION_SECRET`, `MYOPS_SERVICE_ROLE_KEY` (both existing), `MYOPS_APP_URL_OPSFINANCE`, `MYOPS_APP_URL_OPSFLOW`, `MYOPS_APP_URL_OPSP` (now registered launch URLs), `MYOPS_RATE_LIMIT_STORE_URL`, `MYOPS_RATE_LIMIT_STORE_TOKEN`.
- **Each app (server-only):** `MYOPS_BASE_URL`, `MYOPS_APP_ID`, `MYOPS_APP_SECRET`, `APP_SESSION_SECRET`.
- No variable above may carry a client-exposed prefix.

### 5.5 Deployment sequence (Preview and staging only)
1. Owner answers the questions in section 8 and confirms the repositories and hosting.
2. Fix prerequisites in MYOPS: S2 password change, S4 rate limiting, S5 headers.
3. Security review of `phase3_s1_app_access.sql`, then owner approval, then application to **staging only**.
4. MYOPS endpoints and tests behind the Preview flag.
5. Build the shared reference verifier and a MYOPS mock for the apps.
6. Integrate one app per PR on a Preview branch, in this order: OpsFinance (smallest gap, has a server), OpsFlow, then OpsPS (after the architecture decision).
7. Enable Deployment Protection on each app's public and Preview URLs.
8. Staging end-to-end UAT, security re-review and owner sign-off before any production step.

### 5.6 Rollback
- Each step is behind a Preview-only flag, so turning it off restores today's `launch` behaviour.
- If the SQL proposal is applied to staging: it is additive. Roll back by revoking the grants and dropping the new objects in reverse order, after exporting the audit rows. The `myops_app_sessions` alter is additive columns only.
- App side: each integration is a separate PR that can be reverted. Keeping the old login disabled requires an explicit feature flag to re-enable it, so rollback does not silently reopen a bypass.
- Rotating or disabling an app client (`enabled=false`) immediately stops redeems for that app.

## 6. Threat model additions (beyond the S1 design)
| Threat | Control |
|---|---|
| App secret in a client bundle (the `EXPO_PUBLIC_*` and `NEXT_PUBLIC_*` pattern already present in these repos) | Server-only names, CI bundle scan. |
| Ticket in third-party logs, analytics, referrers | 303 redirect, `no-referrer`, no analytics on `/launch`, query-string stripping in access logs. |
| Standalone app login or public registration | Disabled and covered by a route inventory test. |
| 30-day OpsFlow JWT outliving revocation | Replace with a server-side session. |
| Static OpsPS bundle readable without auth | Server layer or removal of the web deployment. |
| Wildcard CORS (OpsFlow) | Explicit allow-list. |
| Entitlement divergence (OpsFinance's own billing) | MYOPS only, with the local model disabled. |
| Replay of a signed redeem request | Timestamp window plus nonce store. |

## 7. Test cases

**Automated, MYOPS (to write in S1-B; none written or run yet):** ticket 60 s expiry boundary; single use and 50 concurrent redeems giving exactly one success; wrong app or wrong product rejected; hash-only storage; tampered, stale or replayed signatures rejected; disabled client rejected; entitlement revoked between issue and redeem denied; Founders get every live app and a newly launched one; a single-app subscriber is denied other apps; coming-soon denied; no ticket after MYOPS logout or past 15 minutes of inactivity; introspection reports `session_active:false` after logout; rate limits; generic errors; no secrets in logs; SQL tests on a local PostgreSQL (RLS, grants, atomicity).

**Automated, each app:** route inventory showing every route returns 401 or a redirect with no session; forged, expired and idle-expired sessions rejected; the ticket is stripped from the URL; the fail-closed path on a MYOPS outage; sensitive actions call MYOPS every time; CORS rejects unlisted origins; the built bundle contains no secret.

**Manual (Preview and sandbox):** log in once and open each app without a password prompt; open each app's direct URL, a Preview URL and an old login URL in a fresh browser and get denied; reuse a ticket and get denied; let a ticket sit for 61 seconds and get denied; cancel or expire a subscription and confirm that no new ticket is issued and the session ends within the agreed latency; MYOPS logout followed by a new ticket attempt is denied; idle 15 minutes in an app ends the app session; a second account cannot read the first account's data.

## 8. Questions and blockers
| # | Item | Type |
|---|---|---|
| Q-A | OpsFinance: keep Supabase Auth for tenant data underneath the MYOPS gate, or move entirely to the MYOPS-derived session? | Decision |
| Q-B | OpsFlow: is the live product this repo (FastAPI/MongoDB) and where is it hosted? Is the Firebase config still used? | Decision |
| Q-C | OpsPS: is `OpsPSMobileR1` the OpsPS product, and is it Android only or also web? A static SPA cannot enforce server-side authorization. | **Blocker** |
| Q-1 | What does `app.myops.com.my` serve, and what are the intended launch URLs? | Info |
| Q-2 | Do the apps share the MYOPS Supabase project or use their own databases? Business-scoped data stays the app's responsibility. | Info |
| Q-3 | Confirm the revocation latency (5 minutes for normal browsing, immediate for sensitive actions) and the list of sensitive actions. | Decision |
| Q-4 | May apps keep any separate password login? Recommendation: no. | Decision |
| Q-5 | OpsFinance's own RM29 Starter billing: retire it in favour of MYOPS? | Decision |
| Q-6 | Founder refund after allocation: may staff revoke lifetime and free the slot? (carried over) | Decision |
| B-1 | Access to the private configuration of each app (Vercel, Firebase, Mongo, Supabase) to complete the audit of environment variables and Preview URLs. | Blocker |
| B-2 | GitHub push credentials: pushes from this workspace have failed on credentials. | Blocker |
| B-3 | Approval of the new SQL, secrets, rate-limit store and a Vercel Deployment Protection policy. | Dependency |
| B-4 | UAT prerequisites: S2, S4, S5 from the UAT report. | Dependency |

## 9. Risks
- **R1:** OpsPS cannot meet "each app enforces on its server" without new infrastructure.
- **R2:** OpsFlow's stand-alone auth and long-lived tokens are the biggest bypass surface.
- **R3:** HMAC verification needs the raw per-app secret on MYOPS. Storing only a hash prevents HMAC verification. The options are storing the key encrypted (key held in the environment or a KMS) or switching to asymmetric request signing (Ed25519) so MYOPS stores only public keys. **Recommendation: Ed25519**, owner and security review to confirm.
- **R4:** Revocation latency for normal browsing is bounded by the cache window.
- **R5:** Coupling: a MYOPS outage blocks new sessions and sensitive actions.
- **R6:** I read only public repository contents. Hidden environment variables, other branches or deployments may change this assessment.

## 10. Recommended sequence (summary)
1. Owner answers Q-A to Q-C, Q-1 to Q-6, and unblocks B-1 and B-2.
2. Fix the MYOPS prerequisites (S2, S4, S5).
3. Security review and approval of the SQL proposal, then apply it to staging only.
4. Build the MYOPS ticket, redeem and introspection endpoints with tests.
5. Integrate OpsFinance, then OpsFlow, then OpsPS (after Q-C), one PR each.
6. Lock down public and Preview URLs and the old login paths.
7. Staging end-to-end UAT, security re-review, owner approval.

Waiting for owner approval before S1-B.
