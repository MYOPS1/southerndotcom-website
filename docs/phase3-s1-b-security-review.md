# Phase 3 S1-B — Independent Security Review

Repository: `niz262025-hub/southerndotcom-website` · Branch: `feature/myops-founders-100` · PR #13
Baseline reviewed: `4d5630b` ("Implement secure S1-B app launch tickets"; confirmed as HEAD, working tree clean before this document).

Scope: documentation-only review. No application code was modified, no SQL was run against Supabase, no staging validation was performed, nothing was deployed, merged or payment-enabled. Evidence types are labelled **CODE REVIEW**, **LOCAL TEST** (existing automated tests; SQL tests use a throwaway local PostgreSQL) or **UNVERIFIED**. No credentials were read or copied.

Files reviewed: `docs/phase3-s1-b-ticket-backend.md`, `server/app-access.js`, `server/auth.js`, `server/entitlements.js`, `api/app/redeem.js`, `api/app/entitlement.js`, `supabase/proposals/202610170001_myops_app_access.sql`, `supabase/migrations/202610160001_myops_identity_foundation.sql`, `supabase/proposals/phase3_founders_100.sql` (compatibility only), `src/session.jsx` (launch call), `vercel.json`, `tests/app-access.test.mjs`, `tests/auth-server.test.mjs`, `tests/founders-sql.test.mjs`.

## 1. Executive assessment

The core ticket design is sound: 256-bit `randomBytes` tickets, SHA-256 hash-only storage, a database-enforced 60-second cap, row-locked single-use redemption, app/product binding, Ed25519 request signatures with timestamp + one-time nonce, fail-closed 503 on any error, `SECURITY DEFINER` functions with empty `search_path` and `service_role`-only execute, RLS enabled with no client policies, and a fresh entitlement check on every verification call. I found **no CRITICAL** issues.

The gaps are in **revocation completeness, ticket transport, operations and hardening**: app sessions are not always revoked when MYOPS logs out or times out (HIGH), tickets travel in a URL query string (MEDIUM), a transient database error permanently kills app sessions (MEDIUM), there is no data retention or absolute session lifetime, and the Preview/staging isolation of the Supabase project is unverified.

**Decision: NO-GO for staging activation** until H-1 and the MEDIUM items below are remediated or explicitly risk-accepted by the owner. **Do not apply the SQL proposal yet**; after the revisions in §7 it is a reasonable staging-only candidate.

## 2. Findings

### HIGH

**H-1 — MYOPS logout / inactivity / password-reset revocation can silently skip app sessions.**
`server/auth.js:216` (logout), `:231` (inactivity) and `:271` (reset) revoke app sessions only when `client.auth.getUser(token)` yields a user id.
- Logout (`:213-216`): if the Supabase access token has expired or `getUser` fails, `current?.user?.id` is falsy, the cookie is cleared and global sign-out proceeds, but **no app session is revoked**, and the user sees a successful logout.
- Inactivity (`:225-231`): `identity.user?.id` is also derived from the same token lookup; the same gap applies. Detection is also lazy: it happens only when the browser next calls MYOPS. A user who simply closes the tab never triggers revocation, so app sessions then rely solely on the app's own idle check.
- Scenario: user logs in, opens OpsFinance, token ages out (access-token lifetime is shorter than a long working day), user clicks Logout → MYOPS reports success; the OpsFinance session stays valid while the app keeps calling the entitlement endpoint.
- Evidence: CODE REVIEW. The existing test (`tests/auth-server.test.mjs`, "logout and detected inactivity revoke…") only covers a valid-token user; the expired-token path is not tested.
- Remediation: record the Supabase user id inside the signed MYOPS session/activity cookie (or decode the JWT `sub` without trusting expiry for the revocation-only purpose) so revocation never depends on a live token; make revocation failure surface to the user; add a periodic server-side sweep (see M-5) for sessions whose MYOPS login has no activity.

**H-2 — App-session idle timeout can be defeated and has no absolute lifetime.**
`myops_validate_app_session` (SQL lines 139-160) slides `last_activity_at` on every call, including calls that carry no user activity. An app that polls the entitlement endpoint (heartbeat, background tab, or a misbehaving integration) keeps the session alive indefinitely; there is no absolute maximum lifetime and no link to the MYOPS session. The `sensitive` flag (`server/app-access.js:250`) is validated but has no effect.
- Remediation: separate "touch" from "validate" (only extend when the app asserts real user activity), add `absolute_expires_at` (for example 12 hours) to `myops_app_sessions`, and document that apps must not heartbeat. UNVERIFIED how each app will call the endpoint (apps not integrated).

### MEDIUM

**M-1 — Ticket is delivered in a URL query string.** `server/app-access.js:163` (`searchParams.set('t', …)`) and `src/session.jsx:99-100` (`window.location.assign(result.next)`). The ticket will appear in browser history, in the app host's request/access logs, in any `Referer` sent from the app landing page, and in analytics if present. Mitigations exist (60 s, single use, one app) but the S1 requirements list URL/log/referrer exposure as a risk. The MYOPS API response sets `Referrer-Policy: no-referrer`, but that does not protect the navigated app page.
- Remediation: deliver the ticket in the URL fragment (`/launch#t=…`, never sent to servers or referrers) and have the app page POST it to its own server, or use a MYOPS-side auto-submitted POST form to the app launch endpoint; use `location.replace` so history does not retain it; require apps to send `Referrer-Policy: no-referrer`, `Cache-Control: no-store` and strip logging of the `t` parameter. The app side is UNVERIFIED (no app integration yet).

**M-2 — Transient lookup failure permanently revokes app sessions.** `server/app-access.js:224-227` and `:259-264`: `entitlementResolver` returns `null` on any database error (`loadCurrentEntitlements`), which is treated as "not entitled" and triggers `myops_revoke_app_session`. Failing closed is correct, but revoking turns a short outage into forced re-launch for every user and, in `redeem`, burns the ticket. Distinguish "denied" (revoke) from "unavailable" (return 503, keep the session).

**M-3 — Staging/production isolation is not verified.** The Supabase project URL is hard-coded in `server/app-access.js:5` and checked by `configured()` (`:47`); `docs/supabase-staging-setup.md` states that connectivity and the project's staging suitability were not verified. The Preview gate relies on `VERCEL_ENV === 'preview'` plus `req.headers.host === VERCEL_BRANCH_URL` (`:105-108`). If this project is shared with Production, applying the proposal would change a live database. UNVERIFIED — owner must confirm the project is non-production before any migration.

**M-4 — Nonce retention equals the maximum replay window.** Timestamps are accepted ±5 min (`:12`, `:124`) but nonces are kept 10 min (SQL line 111). A request first used at the earliest valid instant (`t−5 min`) has its nonce removed at exactly `t+5 min`, the last instant it is still timestamp-valid; clock differences between Node and the database leave a sub-second replay window. Impact is low (redeem replays fail because the ticket is consumed; entitlement replays only re-read status) but retention should be ≥ 2×skew + margin (for example 15 min).

**M-5 — No retention/cleanup and unauthenticated DB writes.** `myops_app_rate_limits`, `myops_app_tickets`, `myops_app_sessions` and `myops_app_audit` are never purged (only nonces are, as a side effect). Every request—including unauthenticated or bad-signature ones—performs rate-limit upserts (`:186`) and a client lookup before signature verification, with an IP bucket derived from the first `X-Forwarded-For` entry (`:52`). On Vercel the header is platform-set (UNVERIFIED for this deployment), but a distributed flood can still grow the table and consume DB capacity; a missing header collapses all clients into one `unknown` bucket. Remediation: scheduled cleanup (owner-approved), cap on unauthenticated work, and an edge/WAF rate limit.

### LOW

- **L-1 — Key type not pinned to Ed25519.** `createPublicKey` + `verify(null, …)` (`:26`) accepts other key types; verified locally that an RSA key and signature pass `verify(null, …)`. The DB check is only a length range (SQL lines 12-13). Require `asymmetricKeyType === 'ed25519'` in code and validate at enrolment.
- **L-2 — Canonical string omits app id and key version.** `canonicalRequest` (`:17-21`) signs method, path, timestamp, nonce and body hash only. Distinct per-app keys make cross-app reuse infeasible, but a key accidentally shared by two apps would allow cross-app replay (nonce hash includes app id, so it would not be caught). Include `app_id` and `key_version` in the signed string.
- **L-3 — Canonicalisation drops nested keys.** `JSON.stringify(body, Object.keys(body).sort())` removes keys of nested objects (verified locally: `{n:{x:1,y:2}}` → `{"n":{}}`). Not exploitable today because both endpoints accept flat bodies only; switch to a real canonical JSON routine before any nested field is added.
- **L-4 — Audit trail is not investigable.** `myops_app_audit` stores no session id, user reference or reason detail (privacy-minimal by design) and logout events have `app_id` null. Add an opaque session id for correlation.
- **L-5 — Logout revokes all of a user's app sessions** on every device (SQL lines 177-193). Acceptable security-wise; document it.
- **L-6 — No key promotion/rollback procedure.** There is a `public_key_next` column but no function or runbook to promote `next` → `current` or revoke a key; no migration rollback script exists.
- **L-7 — Entitlement is decided in Node only.** `myops_issue_app_ticket` checks the app client and live status but not the user's entitlement. Acceptable because only `service_role` can call it; keep it that way.
- **L-8 — Entitlement endpoint does not re-check the MYOPS account state** (disabled/deleted users are covered only through cascade deletes and entitlement rows).

## 3. Area checklist

| Area | Result | Evidence |
|---|---|---|
| A. Randomness, 60 s expiry | PASS | `randomBytes(32)` (`:159`); SQL CHECK `expires_at <= created_at + 60s` (line 28) — LOCAL TEST |
| A. Hash-only storage | PASS | only SHA-256 hex stored; raw ticket never logged in code — CODE REVIEW |
| A. Single-use / concurrency | PASS | `SELECT … FOR UPDATE` then `used_at` (SQL 118-137); concurrent redemption test — LOCAL TEST |
| A. Wrong-app / expired | PASS | binding compared in SQL and Node; tests — LOCAL TEST |
| A. URL/log/referrer exposure | FAIL (M-1) | query-string transport |
| B. Ed25519, timestamp, nonce | PASS with notes | L-1, L-2, L-3, M-4 |
| B. Key registration/rotation | PARTIAL | L-6; no enrolment tooling exists |
| B. Rate-limit bypass | PARTIAL | M-5; XFF trust UNVERIFIED |
| C. SECURITY DEFINER / search_path / grants | PASS | empty `search_path`, explicit `revoke … from public, anon, authenticated`, grant to `service_role` only — CODE REVIEW; LOCAL TEST of grants/RLS |
| C. RLS, FKs, tenant isolation | PASS | RLS on all new tables, no policies; user_id FK `on delete cascade`; sessions bound to app+product |
| C. Locks, transactions | PASS | per-user advisory lock for issue/revoke; ticket row lock; revoke-vs-redeem ordering reasoned through (READ COMMITTED re-snapshots after lock wait) |
| C. Fail-closed DB errors | PASS (see M-2) | RPC errors throw → 503 |
| C. Compatibility with Phase 2A/3 | PASS locally; UNVERIFIED live | extends existing `myops_app_sessions` (`id`, `user_id`, `last_activity_at`, `revoked_at`); needs `myops_products` and Phase 3 tables; tested only on throwaway local PostgreSQL. Pre-existing session rows have null `app_id` and are never valid for apps |
| D. Logout / inactivity revocation | FAIL (H-1) | |
| D. Idle enforcement | PARTIAL (H-2) | |
| D. Expired/revoked subscription, Founder lifetime | PASS | shared resolver (`server/entitlements.js`); lifetime grants all live apps, one-app subscriptions grant one — LOCAL TEST |
| D. Cross-app session reuse | PASS | validation requires matching `app_id` and `product_slug` |
| D. Direct app access | BLOCKED | apps not integrated; app-side enforcement is outside this repository |
| D. Service outage | PASS/M-2 | denies; over-revokes |
| E. Preview-only, host/origin | PASS | non-preview → 404; host must equal branch URL; browser `Origin` rejected |
| E. Server-only secrets | PASS | service key read from server env only; `sb_secret_` shape check; not in client bundle (build output not scanned for secrets in this review — UNVERIFIED) |
| E. Production isolation | UNVERIFIED (M-3) | |
| E. Rollback safety | PARTIAL (L-6) | additive migration, but no down script |

## 4. Validation performed (this review)

- `npm test`: **106 passed, 0 failed, 0 skipped** (includes local-PostgreSQL SQL tests, not Supabase).
- `npm run lint`: passed (only the existing React-version configuration notice).
- Local reproduction scripts (no network): RSA key accepted by `verify(null, …)` (L-1); array-replacer canonicalisation drops nested keys (L-3).
- No staging, Preview or live-Supabase validation was performed.

## 5. Existing coverage and missing tests

Covered: Ed25519 signing/canonicalisation, invalid signature, stale timestamp, browser origin, replayed nonce, rate limit, wrong app, revoked entitlement, DB failure, fresh entitlement, idle app session, 60-second ticket expiry, concurrent single redemption, grants/RLS, logout and inactivity revocation with a valid token.

Missing: logout/inactivity/reset with an expired or invalid Supabase token (H-1); heartbeat keeps session alive and absolute lifetime (H-2); transient DB error must not revoke (M-2); ticket never present in logs/Referer/fragment handling (M-1); nonce retention boundary (M-4); non-Ed25519 key rejection (L-1); `X-Forwarded-For` absent/spoofed behaviour (M-5); key rotation `current`/`next` and disabled client; entitlement revoked mid-session across both endpoints with real timing; migration idempotence and rollback; bundle scan proving no secret in the browser build.

## 6. SQL migration approval recommendation

**Do not approve for execution yet.** The structure is acceptable, but revise first: absolute session lifetime and touch semantics (H-2), nonce retention (M-4), cleanup plan (M-5), Ed25519 enrolment validation (L-1), a rollback script, and owner confirmation that the target is a non-production Supabase project (M-3). After revisions and a second review, approve for staging only.

## 7. GO / NO-GO and remediation plan

**NO-GO for staging activation.**

Priority order:
1. H-1 revocation independent of live JWT; add tests.
2. H-2 absolute lifetime + activity-aware touch.
3. M-1 fragment/POST ticket transport with app-side header requirements.
4. M-2 distinguish unavailable from denied.
5. M-3 owner verification of a non-production Supabase project and Vercel Preview-only secrets.
6. M-4, M-5 nonce retention, cleanup schedule, edge rate limiting.
7. L-1 to L-8 hardening and rollback/rotation runbook.
8. Re-review, then owner approval before migration, app-client enrolment and OpsFinance integration.

Remediation, migrations and staging activation await owner approval.

---

## 8. Remediation status (follow-up commit)

Implemented in code, the unapplied SQL proposal and tests. Evidence: **LOCAL TEST** only (automated tests and a throwaway local PostgreSQL); nothing has been validated on staging or Supabase, and the apps are not integrated.

| Finding | Status | Change |
|---|---|---|
| H-1 | FIXED (local) | Server-signed identity cookie (`server/auth.js`); logout, inactivity, invalid/expired token and password reset revoke by verified identity only; revocation failure returns 500 (fail closed); tolerant of an already-invalid token's sign-out error. Tests: forged/tampered/stale cookie, expired token, no token, revocation outage. |
| H-2 | FIXED (local) | `myops_validate_app_session(…, p_touch)` extends only on asserted activity; 12 h absolute limit (`absolute_expired`); `sensitive` requires `activity`. SQL tests for polling, idle and absolute expiry. |
| M-1 | MITIGATED | Ticket in URL fragment, not query; app must strip it (app side UNVERIFIED, not yet integrated). Residual: fragment remains in the browser's history entry until the app calls `replaceState`. |
| M-2 | FIXED (local) | Lookup failure → 503 without revoking an existing session; redeem closes the unverified new session and returns 503. |
| M-3 | MITIGATED | `MYOPS_ENVIRONMENT=staging` required. Owner must still verify the Supabase project is non-production (UNVERIFIED). |
| M-4 | FIXED (local) | Nonce retention 15 min (> 2 × 5 min skew). |
| M-5 | PARTIAL | `myops_cleanup_app_access()` added and tested; no scheduler configured (needs approval). Unauthenticated requests still do one rate-limit write; edge/WAF limiting is still required. IP bucket now prefers `x-vercel-forwarded-for` (platform behaviour UNVERIFIED). |
| L-1 | FIXED (local) | Ed25519 enforced in code (512-bit RSA 64-byte-signature regression) and by SQL check. |
| L-2 | FIXED (local) | App id and key version are signed. |
| L-3 | FIXED (local) | Recursive canonical JSON; nested/extra field tampering tests. |
| L-4 | OPEN | Audit still has no correlation id. |
| L-5 | ACCEPTED | Logout revokes all devices. |
| L-6 | FIXED (local) | `myops_promote_app_key` and rollback proposal (not executed). |
| L-7, L-8 | OPEN / ACCEPTED | Unchanged; service-role-only RPC; MYOPS account state is covered through cascades. |

Remaining risks: a closed tab leaves the app session until its 15-minute idle expiry; app-side route enforcement is unimplemented; the direct app URLs may still bypass MYOPS until S1-C; no scheduler or WAF; Supabase project isolation unverified; no staging or end-to-end validation.

**Updated recommendation: staging activation is CONDITIONAL GO** — acceptable for an owner-approved, non-production staging trial of the unapplied migration once the owner (1) confirms the Supabase project is non-production, (2) approves the revised SQL after a second review, and (3) accepts the residual risks above. It is **NO-GO** for any Production or live-user exposure. Direct app URL bypass is not closed until the app integrations are done.
