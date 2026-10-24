# Phase 3 S1-B — Durable Login-Session Binding

Status: implemented and tested **locally only** (isolated throw-away PostgreSQL + mocked handlers).
Nothing was applied to Supabase, deployed to Staging or Production, or scheduled.
Implements the recommended design in [phase3-s1-b-durable-revocation-design.md](./phase3-s1-b-durable-revocation-design.md).

## What changed
| Area | Change |
|---|---|
| SQL (unapplied) | `supabase/proposals/202610170002_myops_login_sessions.sql` and `..._rollback.sql` |
| `server/app-access.js` | `startLogin`, `touchLogin`; `issueTicket` requires `loginSessionId`; `revokeUserSessions(userId, {loginSessionId, reason})` |
| `server/auth.js` | Signed `__Host-myops-login` cookie (`userId.loginSessionId.issuedAt.mac`, HttpOnly, 12 h); login creates the record; activity touches it; launch requires it; logout/inactivity revoke per login; password reset and retries revoke user-wide |

The signed-cookie retry (`__Host-myops-revoke`) is kept as a supplementary mechanism.

## Model
* `myops_login_sessions`: one row per MYOPS sign-in. **Live** = not revoked, `last_activity_at` within 15 min, `created_at` within 12 h, owned by the user. Computed from stored timestamps on every check, so a closed browser or deleted cookie cannot keep it alive and needs no revocation event to expire.
* `myops_app_tickets.login_session_id` / `myops_app_sessions.login_session_id` (FK, cascade).
* `myops_issue_app_ticket` (now 4 args) refuses a missing, foreign, idle or expired login.
* `myops_redeem_app_ticket` refuses (and revokes) a ticket whose login is not live; the app session inherits the login id.
* `myops_validate_app_session` additionally requires the parent login to be live. It **never writes to the login record**, so app polling and app-asserted `activity=true` cannot extend the MYOPS login. `activity=true` only extends the app session's own idle timer, and never beyond the login's life or the 12 h limit.
* `myops_login_start`: advisory lock per user; keeps at most **10** live logins, sweeping the oldest.
* `myops_login_touch`: writes at most every **30 s**; returns false for dead sessions.
* `myops_login_end` (one login, idempotent, also revokes its unused tickets and app sessions) and `myops_login_end_all` (user-wide, includes legacy unbound rows).
* `myops_enqueue_revocation` + `myops_revocation_requests`: deduplicated outbox, retry cap 20, exponential backoff.
* `myops_sweep_logins(batch)`: expires idle/absolute logins, revokes their app sessions and tickets, drains the outbox with per-row error isolation, purges rows older than 30 days. `FOR UPDATE SKIP LOCKED`, safe to run concurrently. **No scheduler is created or activated** (no pg_cron, no Vercel Cron).
* All functions: `SECURITY DEFINER`, `search_path = ''`, `EXECUTE` only for `service_role`; RLS enabled on both tables, no client policies.

## Failure behaviour
* Database cannot confirm login liveness → validation returns inactive; redemption denied; issuance unavailable (fail closed).
* Login record cannot be created at sign-in → MYOPS sign-in still works, no login cookie, launch returns 401 (fail closed).
* `touchLogin` unknown (network/DB error) → user is **not** logged out; a confirmed `false` ends the MYOPS session.
* Revocation failure → never reported as success; signed pending cookie retries user-wide on later requests; sign-in blocked until cleared.
* The cookie is only a pointer: the browser cannot choose the user or login id (HMAC-bound, re-checked against the verified Supabase user and the database).

## Deployment order and dependencies
1. Owner approval and independent SQL review.
2. Apply `0001` then `0002` to a **staging** project (never Production). Code in this branch requires **both**; without `0002`, ticket issuance and revocation fail closed (launch 503, logout 500 with pending retry).
3. Deploy the branch to the trusted Preview.
4. Rollback: deploy code without these calls, then run the rollback SQL (idempotent; restores 0001 function bodies; existing unbound app sessions are then valid again under 0001 rules).
Re-applying `0002` after a rollback leaves any pre-existing unbound app sessions invalid (tested).

## Local test evidence
* `tests/founders-sql.test.mjs` (isolated PostgreSQL, port 54329): issuance ownership/liveness, 15-min idle, 12-h absolute, 30-s touch throttle, per-login end, repeated end, foreign-user end, redeem/validate after login death, polling and `activity=true` do not extend login, concurrent redeem vs logout, 10-session cap, sweep/outbox dedupe/cap/purge, grants and RLS denial for `anon`/`authenticated`, rollback and re-apply.
* `tests/auth-server.test.mjs`, `tests/app-access.test.mjs`: login cookie binding, forged/foreign cookies, launch gating, activity vs passive polling, dead-login logout, per-login logout, user-wide password reset, retry after failed revocation.
* No Staging validation exists.

## Remaining risks
1. **M-2 (bounded):** an app can assert `activity=true` to keep its *app* session alive, but only while the MYOPS login is live (≤15 min idle / ≤12 h). It cannot extend the login.
2. **No scheduler:** nothing sweeps idle logins until an owner approves a scheduler. Correctness does not depend on it (expiry is evaluated on read); it only provides cleanup and outbox retry.
3. **App-side caches:** apps that cache a positive entitlement keep access for the cache lifetime (contract: ≤60 s normal browsing, no cache for sensitive actions). Apps are not integrated (S1-C).
4. **Direct app URLs** remain unprotected until each app enforces server-side validation (S1-C).
5. **Retry is user-wide** (kills the user's other logins on retry), a deliberate safe superset.
6. Users already signed in before deploy have no login cookie and must sign in again before launching apps.
7. A sign-in that re-uses a browser does not end its previous login record; it expires by idle/absolute rules or the 10-session cap.
8. Supabase project isolation from Production is unverified; project URL is hard-coded.
9. No WAF/edge rate limiting beyond the database limiter.

## Recommendation
Conditional **GO for a staging review** (SQL review, then staging apply), **NO-GO for Production**. Requires owner approval before any migration, scheduler or app integration.
