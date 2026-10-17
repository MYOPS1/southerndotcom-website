# Phase 3 S1-B — Post-Remediation Independent Verification

Repository: `niz262025-hub/southerndotcom-website` · Branch: `feature/myops-founders-100` · PR #13
Verified baseline: `0ffe6cb` (diff reviewed from `dbb8cb4`). HEAD confirmed as `0ffe6cb` before this document.

Read-only verification. No application code or SQL proposal was changed, nothing was run against Supabase, nothing deployed. Evidence labels: **CODE** (diff/code reading), **LOCAL TEST** (automated tests; SQL tests use a throwaway local PostgreSQL), **UNVERIFIED**. No staging or end-to-end validation exists. No secrets are included.

## 1. Scope and regression check

`git diff dbb8cb4 0ffe6cb` touches only: `server/app-access.js`, `server/auth.js`, the SQL proposal, a new rollback proposal, three test files and two docs. **No change** to `src/` (homepage, pricing UI), `api/`, `vercel.json`, `server/payments.js`, `server/entitlements.js` or any app repository (CODE: empty diff for those paths). Founders 100 entitlement and prices are therefore unchanged; their existing tests (payments, SQL allocation, 150-concurrent-customer test, entitlement resolver) still pass.
Login behavior: `saveSession` additionally sets the signed identity cookie (`server/auth.js:159`); response bodies and redirect (`/`) are unchanged (existing login tests pass).

## 2. Requirement results

| # | Requirement | Result | Evidence |
|---|---|---|---|
| H-1a | Logout revokes app access with expired/invalid Supabase token | PASS | `auth.js:236-250` revokes by verified token user **or** signed identity cookie; LOCAL TEST "logout with an expired Supabase token", "no token" |
| H-1b | Inactivity expiry and expired token revoke | PASS | `auth.js:255-261`; LOCAL TEST (idle `session` probe, expired-token `account`) |
| H-1c | Password reset revokes | PASS (limited) | `auth.js:~302-307`; requires a valid token to reach the action; existing test covers revocation + failure path. Expired-token reset is not possible (401 → revoke via H-1b) |
| H-1d | Forged/tampered/stale identity never selects a user | PASS | HMAC with server secret, constant-time compare, 12 h age cap (`auth.js:48-56`); LOCAL TEST |
| H-1e | Revocation failure handling | **PARTIAL — see M-1** | fails closed with 500, but cookies are cleared first (`auth.js:236, 259`) so the revocation is never retried |
| H-2a | Polling cannot extend idle session | PASS | `p_touch` defaults false; extends only on `activity:true` (`app-access.js:281`, SQL 142-165); LOCAL TEST on PostgreSQL (14 min polled, stays 14 min; 16 min → dead) |
| H-2b | 15-minute inactivity | PASS | SQL 152; LOCAL TEST |
| H-2c | 12-hour absolute limit | PASS | SQL 151; LOCAL TEST (11 h 59 m active; 12 h 1 m revoked `absolute_expired`; stays revoked) |
| H-2d | `sensitive` requires `activity` | PASS | `app-access.js:276`; LOCAL TEST |
| Ed25519 | Key type enforced in code and DB | PASS | `app-access.js:38` (`asymmetricKeyType`); SQL line 13 regex on SPKI prefix; LOCAL TEST: 512-bit RSA 64-byte signature is accepted by bare `verify` but rejected; RSA/short keys rejected by DB check |
| Canonical | Recursive canonical JSON, signed app id/key version | PASS | `app-access.js:20-33`; LOCAL TEST (nested/extra/reordered, product swap, key version, app id) |
| SQL | Syntax, grants, RLS, search_path | PASS (local) | whole proposal applies and runs on local PostgreSQL; every `security definer` function pins `search_path = ''`; anon/authenticated denied on new cleanup/promote functions (LOCAL TEST); RLS enabled with no client policies |
| SQL | Compatibility with Phase 2A/3 | PASS locally / UNVERIFIED live | applied after the real Phase 2A migration and Phase 3 proposal in the local DB |
| SQL | Key rotation | PASS (local) | `myops_promote_app_key` (SQL 252-259) tested; second call returns false |
| SQL | Cleanup safety | PASS with note | `myops_cleanup_app_access` (SQL 231-250) removes only expired nonces, rate limits > 1 day, tickets expired > 1 day, audit > 90 days, app sessions revoked/idle > 30 days; `app_id is not null` guard protects pre-existing identity sessions; not scheduled |
| SQL | Rollback | PASS (structure) | rollback drops every function and table in the proposal (asserted by test); it was **not** executed or tested against a populated database |
| Staging gate | `MYOPS_ENVIRONMENT=staging` | PASS | `app-access.js:59`; LOCAL TEST |
| Existing MYOPS login / Founders / pricing | unchanged | PASS | §1 |
| Full suite | 120/120 | PASS | §4 |

## 3. Findings

No CRITICAL or HIGH findings.

### MEDIUM

**M-1 — Cookies are cleared before app revocation succeeds; failed revocation is not retried.** `server/auth.js:236` (logout) and `:259-261` (inactivity/expired token) call `clearAll()` before awaiting revocation. If the revocation database call fails (outage, migration not applied while `MYOPS_ENVIRONMENT=staging` is set) the handler returns 500, but the signed identity cookie is already deleted, so no later request can revoke that user's app sessions. Those sessions then live until their own 15-minute idle limit (or 12 h if the app keeps asserting activity). Fail-closed for the MYOPS session, but only fail-open-until-idle for app sessions. Impact is bounded and the user is told logout failed on explicit logout. Suggested remediation: keep the identity cookie (clear only access/activity) when revocation fails, or queue a server-side retry, plus a periodic sweep.
*Side effect:* in the same failure state the passive `session` probe on page load returns 500 for any visitor with a stale cookie (`auth.js:261` runs before the `session` branch), causing UI errors during a DB outage. Only reachable when app access is configured. (CODE; behavior confirmed by the existing 500-and-cleared-cookie test, not by a staging outage.)

**M-2 — App-controlled `activity=true` can keep a session alive for up to 12 hours.** `app-access.js:275-281`, SQL 142-165. MYOPS cannot verify that activity occurred; a buggy or compromised app server (or a heartbeat mislabelled as activity) defeats the 15-minute idle rule up to the 12-hour absolute cap. Limits that still hold: the app must hold a valid Ed25519 key; every call re-checks the entitlement; MYOPS logout, password reset, subscription revocation and the absolute limit all end the session; a stolen app session cookie alone cannot send `activity` (only the signed app server can). Remediation: contractual/code-review requirement that apps send `activity:true` only for user-initiated requests; optionally rate-limit touches per session (for example one per minute) and audit the touch count; consider shortening the absolute limit (for example 8 h). Residual risk accepted only by owner decision.

**M-3 — Closed-tab and cross-device gaps remain (unchanged from review).** Sessions rely on app-side idle expiry when no MYOPS request arrives; the direct app URLs still bypass MYOPS until the S1-C integrations (UNVERIFIED, apps not inspected for change). No scheduler or edge rate limit exists for cleanup and unauthenticated writes (M-5 of the earlier review remains PARTIAL).

### LOW

- **L-1 — Identity cookie is not refreshed and is capped at 12 h from login** (`auth.js:159`, `:11`). The Supabase access cookie lasts at most 1 h without refresh, so a user must re-login (reissuing the cookie) well within the window; no gap found, but an app session started late in a long login would outlive the cookie. Documented assumption.
- **L-2 — `x-real-ip` fallback is client-controllable off Vercel** (`app-access.js:67`). On Vercel the preferred `x-vercel-forwarded-for` is platform-set (UNVERIFIED for this project); a missing header collapses clients into one `unknown` bucket. Remove the fallback.
- **L-3 — Fragment ticket stays in the browser history entry until the app calls `replaceState`** (`app-access.js` fragment delivery). App-side behavior UNVERIFIED (not implemented). Redirect still goes through `window.location.assign` (`src/session.jsx`, unchanged by request), so the MYOPS page remains in history.
- **L-4 — Audit still has no session correlation id; logout audit rows use null app** (SQL 183-190). Carried over.
- **L-5 — Rollback script untested with data and destructive** (deletes app sessions, tickets, audit). Appropriate for staging only; take a backup first.
- **L-6 — Signature-breaking contract change.** The canonical string changed (app id/key version added); documentation is updated, no app uses it yet. Not a vulnerability.
- **L-7 — Concurrency note (UNVERIFIED):** `myops_validate_app_session` takes `FOR UPDATE`; high-frequency polling of one session serializes on that row. No correctness issue found.

## 4. Test evidence (this verification)

- `npm test`: 120 tests, 120 pass, 0 fail, 0 skipped (includes local PostgreSQL SQL tests; no Supabase connection).
- `npm run lint`: passed (only the existing React-version notice).
- `npm run build`, `VERCEL_ENV=preview npm run build`: both passed. `git diff --check`: clean.
- Not performed: staging/Preview HTTP testing, app integration, outage injection against a real database, load testing, bundle secret scan.

## 5. Remaining blockers

1. Owner confirmation that the Supabase project is non-production (UNVERIFIED).
2. Second owner approval of the SQL after this verification.
3. Staging secrets and app-client public keys not provisioned.
4. App-side enforcement and direct-URL protection (S1-C) not implemented.
5. M-1 and M-2 remediation or explicit risk acceptance; cleanup scheduling and edge rate limiting decision.

## 6. Staging migration recommendation

**Conditionally recommended for a staging-only trial** of `202610170001_myops_app_access.sql`, with a database backup and the rollback script ready, after the owner verifies the project is non-production. Apply with `MYOPS_ENVIRONMENT` unset first (endpoints stay disabled) and enable it only after the migration is confirmed. Do not schedule cleanup until approved. Not for Production.

## 7. Final decision

**GO for a limited, owner-approved, non-production staging trial of the S1-B backend and migration (conditional on items 1-3 above and acceptance of M-1/M-2).**
**NO-GO for Production, live users or any claim that direct app access is secured** — that requires the S1-C app integrations and real staging validation.

Waiting for owner approval before any staging activation.
