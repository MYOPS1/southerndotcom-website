# Phase 3 S1-B — Login-Session Binding Independent Security Review

Baseline: `28fde47` on `feature/myops-founders-100` (PR #13). Read-only review.
No SQL was run against Supabase; no code, tests, homepage, pricing, payments or scheduler were changed.
Evidence is static code/SQL reading plus the existing local suite (143 passing, isolated PostgreSQL). Nothing here was validated on Staging or on real Supabase/PostgREST.

Reviewed: `supabase/proposals/202610170002_myops_login_sessions.sql` (+ `_rollback.sql`), `202610170001_myops_app_access.sql`, `server/auth.js`, `server/app-access.js`, and the related tests.

## 1. Executive assessment
The design is sound. Validity is derived from stored timestamps on every read (`myops_login_live`, SQL L48–54), so expiry and revocation do not depend on browsers returning, cookies surviving or schedulers running. Tickets, redemption and validation all require a live parent login; polling and `activity=true` never write the login record. All new functions are `SECURITY DEFINER`, `search_path = ''`, and executable by `service_role` only; both tables have RLS enabled with no policies. No Critical or High findings. Several Medium items concern overstated durability claims, rollback safety and PostgREST behaviour, and should be handled before or during the staging apply.

## 2. Findings

### Critical — none. High — none.

### Medium
**M-1 — Durable retry outbox is not wired to anything (documentation overstates durability).**
`myops_enqueue_revocation` (SQL ~L123) and `myops_sweep_logins` (L207) are never called from `server/` or `api/` (grep: no references). On failed logout during a DB outage the only retry is the signed cookie `__Host-myops-revoke` (`server/auth.js` L223–240). If the browser is closed or cookies are deleted, no retry occurs. Backstop: the login still dies ≤15 min after last MYOPS activity by timestamp derivation, so the exposure is bounded; but after logout + outage, app sessions remain valid until then.
Condition: logout during DB outage, then browser cookie loss. Remediation: have the handler enqueue (best-effort) when revocation fails, or state plainly in docs that the bound is "≤15 min after last MYOPS activity" and the outbox is inert until a scheduler is approved.

**M-2 — Rollback can resurrect app sessions whose parent login was dead.**
Rollback L84–87 drops `login_session_id` and the tables without first revoking app sessions/tickets whose login is expired-but-unswept (`revoked_at is null`). After rollback, 0001 `myops_validate_app_session` (restored in rollback) has no parent check, so those sessions become valid again, and an app sending `activity=true` could keep them alive up to the 12 h absolute limit. Remediation: before `drop column`, add to the rollback: revoke every `myops_app_sessions`/unused ticket whose login is not live (or all of them), inside the same transaction.

**M-3 — PostgREST schema cache / overload swap is not handled.**
0002 drops the 3-arg `myops_issue_app_ticket` and creates a 4-arg one (SQL L~128–150). Neither proposal issues `notify pgrst, 'reload schema'` (grep: none). On real Supabase a stale cache yields `PGRST202`; code fails closed (launch 503, logout 500 + pending marker), so this is availability, not bypass. Test harness uses `psql`, not PostgREST, so it cannot catch it. Remediation: add the notify to 0002 and the rollback; add a staging smoke test via the real client.

**M-4 — Positive entitlement caching depends on unintegrated apps.**
MYOPS itself does not cache: `entitlement` re-resolves entitlements and revalidates the login on every call (`server/app-access.js` L311–327). The risk lies in app repositories (S1-C): a cached "entitled" result survives revocation for its TTL. Also the `sensitive` flag (L~300) is validated but has no server-side effect, and requires `activity:true`, which touches the app session. Remediation: contract ≤60 s TTL for browsing, no cache for sensitive actions; make `sensitive` meaningful or remove it; do not couple it to `activity`.

### Low
- **L-1** `myops_login_end` (SQL L81–94) always returns `true` even when no row matches (wrong user/unknown id). Silent success could mask a bug; return whether a row was affected (retain idempotency).
- **L-2** Sweep (L216) labels every expiry `inactivity`, including absolute-limit expiry; audit mapping of dead-login → `logout` (validate) is similarly coarse.
- **L-3** Sweep's app-session/ticket cascades (L~219–226) are unbounded by `p_batch`; large backlogs could run long. Retry cap `attempts < 20` (L228) silently abandons requests without alerting.
- **L-4** New sign-in does not end the browser's previous login row (`server/auth.js` L203–205); rows accumulate until idle/10-cap. A password holder can evict a victim's older logins by logging in 10 times (needs the password; availability only).
- **L-5** Outage during active use: `touchLogin` returning `null` (L199–207) is correctly not treated as logout, but if the outage exceeds 15 min the DB login expires and the user is logged out on next touch. Availability only.
- **L-6** `touchLogin` is an RPC on every non-passive authenticated request with no dedicated rate limit (the write is throttled to 30 s, the call is not).
- **L-7** `startLogin` failures are swallowed with no diagnostic (L203); operators cannot see why launch returns 401.
- **L-8** One `MYOPS_SESSION_SECRET` signs identity, login and pending cookies (domain-separated MACs). Rotating it discards pending markers; document an overlap procedure.
- **L-9** Pending marker stores only the first failed id (`auth.js` ~L235); pre-existing, mitigated because retry is user-wide.
- **L-10** Identity-column sequence on `myops_revocation_requests` inherits Supabase default sequence grants; harmless with no table access, but revoke explicitly for hygiene.

## 3. Focus-area verdicts
| Area | Result | Evidence |
|---|---|---|
| SECURITY DEFINER / grants / RLS | PASS | `search_path=''` on all functions; revoke from public/anon/authenticated (SQL L251–256); grant to service_role only (L257–261); RLS on both tables (L43–45); SQL tests assert denial for anon/authenticated |
| Privilege escalation | PASS | No dynamic SQL; all object references schema-qualified; no client policies |
| Ownership / fixation / forged cookies | PASS | Login cookie HMAC-bound (`auth.js` L65–80, domain `login:`), created only after verified `getUser`; launch uses cookie id only if user matches verified identity (L339–340); browser-supplied ids ignored (tested); DB re-checks ownership |
| 15-min idle / 12-h absolute | PASS (SQL tested) | `myops_login_live` L48–54; app session rules retained in validate |
| Outage / fail closed | PASS | rpc errors throw → 503/500; start failure → launch 401; unknown touch ≠ revoke |
| Logout / reset / retry | PASS with M-1 | per-login logout, user-wide reset/retry; failure never reported as success |
| Concurrent redeem vs revoke | PASS | ticket row lock + liveness derived at validate; a session inserted just after logout is inactive on first validation (orphan row swept later) |
| Migration compatibility | PASS with M-3 | builds on Phase 2A `myops_app_sessions` and 0001; existing unbound sessions/tickets fail closed |
| Rollback safety | CONDITIONAL | M-2 |
| Entitlement bypass | PASS | entitlement re-resolved on redeem and every validate; no bypass found through the login binding |
| Mocks vs real Supabase | RISK | handler tests default `touchLogin→true`, mock `startLogin`; SQL tests use psql roles and manual clock edits, not PostgREST/JWT roles; M-3 untestable locally |
| 28fde47 regressions | No security regression | availability-only: sessions created before deploy lack a login cookie and must re-login before launch |

## 4. Test coverage and gaps
Covered: issuance ownership/liveness, idle/absolute, 30 s throttle, per-login end, repeat end, foreign user end, polling/`activity=true`, concurrent redeem vs end, 10-cap, sweep/outbox, grants/RLS, rollback + re-apply, cookie forgery/retarget/expiry, launch gating, dead-login logout, retry.
Missing: rollback with expired-unswept sessions (M-2); PostgREST/JWT-role invocation and schema reload (M-3); handler enqueue on failure (M-1); real clock-skew between app and DB; load/concurrency on `myops_login_start` with the cap; `sensitive` semantics.

## 5. SQL migration recommendation
Approve for **staging only** after: add `notify pgrst, 'reload schema'`; fix rollback revocation precondition (M-2); decide M-1 handling. Apply `0001` then `0002`; do not schedule the sweep without separate approval.

## 6. Remediation priority
1. M-2 rollback revocation. 2. M-3 schema reload + staging smoke test. 3. M-1 enqueue-or-document. 4. M-4 app contract (S1-C). 5. L-1, L-7, L-2/L-3, L-4.

## 7. GO / NO-GO
**Conditional GO for staging** (after M-2 and M-3 are addressed in the proposals; M-1 documented or fixed). **NO-GO for Production** (apps not integrated, project isolation unverified, no scheduler, no edge rate limiting). Unverified: Supabase project separation from Production; real PostgREST behaviour.
