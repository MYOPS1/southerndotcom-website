# Phase 3 — Functional & Security UAT (PR #13)

- Branch: `feature/myops-founders-100`
- Audited commit: `e78d79c` (HEAD of the local branch, equal to `origin/feature/myops-founders-100` at audit time)
- Scope: Preview and ToyyibPay sandbox only. No application code changed, no SQL executed, nothing merged or deployed, no live payments.

## How to read this report

| Label | Meaning |
|---|---|
| PASS | Verified with evidence |
| FAIL | Defect or gap confirmed |
| BLOCKED | Cannot be tested without an owner action |
| NOT TESTED | Not exercised in this audit |

Evidence type is always stated:

- **CODE** is a static read of the source. It does not prove runtime behaviour.
- **AUTO** is an automated test run in this workspace. These use mocked Supabase and gateway clients, plus a throwaway local PostgreSQL 16 for the proposed SQL.
- **E2E** is a real browser, Preview deployment, Supabase staging and ToyyibPay sandbox run.

**No E2E testing was possible.**

- The workspace has no Vercel, Supabase or ToyyibPay credentials, and Supabase has no applied schema (`docs/phase-3-founders-100.md`: Phase 2A and Phase 3 SQL are unapplied).
- Every E2E item below is therefore BLOCKED, not PASS.

## 1. Automated results (AUTO)

| Check | Result | Evidence |
|---|---|---|
| `npm test` | PASS | 92/92 pass, 0 fail, 0 skipped. The SQL suite ran against local PostgreSQL 16 and was not skipped. |
| `npm run lint` | PASS | `eslint --max-warnings 0` clean. The only output is a React-version settings notice. |
| `npm run build` (Production mode) | PASS | Built in about 1.9 s. |
| `VERCEL_ENV=preview npm run build` | PASS | Built in about 1.9 s. |
| `npm audit --omit=dev` | PASS | 0 vulnerabilities. |
| Secret scan, working tree and full git history | PASS | No `sb_secret_`, JWT or private-key material found. Only test fixtures such as `sb_secret_test_fixture` exist. `.env*` is git-ignored and none is tracked. |
| Vercel Preview URL and deployment checks | BLOCKED | No Vercel/GitHub API access. |

## 2. Authentication, registration, verification, recovery, inactivity

| # | Item | Status | Type | Evidence |
|---|---|---|---|---|
| 2.1 | Same-origin JSON POST only, trusted branch host, Preview-only | PASS | CODE+AUTO | `server/auth.js` rejects non-Preview (404), host/Origin mismatch (403) and non-JSON content types. `auth-server.test.mjs` covers these. |
| 2.2 | Registration requires email confirmation, no auto-login | PASS | CODE+AUTO | If `signUp` returns a session it is signed out globally and a 503 is returned. |
| 2.3 | Login refused when the email is not confirmed | PASS | CODE+AUTO | `saveSession` requires `email_confirmed_at`. |
| 2.4 | Post-login redirect is `/` | PASS | CODE+AUTO | The server returns `{next:'/'}`. Covered by `homepage-auth.test.mjs`. |
| 2.5 | Account enumeration resistance | PASS | CODE | Existing-email signup and `forgot` return generic messages. |
| 2.6 | Cookie hardening | PASS | CODE | `__Host-` prefix, HttpOnly, Secure, SameSite=Lax. Refresh tokens are never persisted. |
| 2.7 | PKCE recovery, recovery redirects to `/account/update-password` | PASS | CODE+AUTO | The callback requires the verifier cookie. |
| 2.8 | 15-minute inactivity logout | PASS | CODE+AUTO | The HMAC-signed activity cookie has a 15-minute window and is verified server-side. A passive `session` probe does not extend it. Covered by tests. |
| 2.9 | Live registration, confirmation email and recovery email delivered | BLOCKED | E2E | Needs Preview env and Supabase Auth SMTP. The earlier staging diagnosis showed the signup path was previously unreliable. Not re-verified here. |
| 2.10 | Inactivity logout in a real browser and real clock | NOT TESTED | E2E | Only simulated with an injected clock. |
| 2.11 | `reset` does not need the current password or a recovery-only session | FAIL (Low) | CODE | Any signed-in session can set a new password via `reset`. A stolen live session can therefore take over the account. |
| 2.12 | Brute-force and rate limiting on `/api/auth` | NOT TESTED | CODE | There is no app-level limit. Only Supabase's own Auth limits apply, and their staging configuration is unverified. |
| 2.13 | JWT lifetime after inactivity | FAIL (Low) | CODE | Inactivity clears the cookies on the next request but does not revoke the Supabase JWT, which stays valid for up to 1 h. Server requests are still refused without the signed activity cookie. A copied JWT could be used directly against Supabase with RLS limits. |

## 3. Server-side entitlements and direct URL access

| # | Item | Status | Type | Evidence |
|---|---|---|---|---|
| 3.1 | Entitlement is resolved server-side and fails closed | PASS | CODE+AUTO | `resolveProductStates` checks status, expiry, catalog `live` state, grants and lifetime. Errors give `null` and a 503. |
| 3.2 | A single-app subscription never unlocks other apps | PASS | CODE+AUTO | `sub.product_slug` unlocks one app. Only `is_complete_bundle` unlocks all. Tested. |
| 3.3 | Lifetime covers all live catalog apps, including newly launched ones | PASS | CODE+AUTO | The lifetime scope iterates the live catalog. Tested. |
| 3.4 | Coming-soon apps cannot be launched | PASS | CODE+AUTO | `launch` returns 403 unless the state is `active`. |
| 3.5 | Unauthenticated, expired or unconfirmed access is refused (401) | PASS | CODE+AUTO | Tested. |
| 3.6 | The frontend cannot unlock an app | PASS | AUTO | `homepage-auth.test.mjs`: the server denial is shown and frontend state never unlocks access. |
| 3.7 | Direct URL access to the application itself | FAIL (High, design gap) | CODE | `launch` returns the bare `MYOPS_APP_URL_<SLUG>` URL with no token, signature or session handoff. Entitlement is enforced only at the MYOPS launch button. Anyone who knows an app's URL can reach it unless that app enforces its own login. `myops_app_sessions` exists in the schema but nothing uses it. Each app (OpsFinance, OpsFlow, OpsPS) needs verified-token or session validation before this is considered secure. |
| 3.8 | The apps' own enforcement | NOT TESTED | E2E | The apps are outside this repository. |
| 3.9 | Real subscription data end to end | BLOCKED | E2E | The schema is unapplied. |

## 4. Founders 100 allocation, verification, duplicates, overselling

| # | Item | Status | Type | Evidence |
|---|---|---|---|---|
| 4.1 | Server-authoritative remaining count | PASS | CODE+AUTO | `myops_founders_status` computes allocations plus live reservations from the database. |
| 4.2 | No oversell under concurrency | PASS | AUTO | The local PostgreSQL test with 150 concurrent customers gives exactly 100 reservations and 100 distinct slots. A global advisory lock plus unique constraints back it. |
| 4.3 | Only confirmed, successful payments count | PASS | CODE+AUTO | Allocation happens only in `myops_settle_payment` with outcome `succeeded`. Entitlements require a unique `payment_id`, so free lifetimes are impossible (tested). |
| 4.4 | Duplicate or concurrent webhooks settle once | PASS | AUTO | A unique `event_key` plus the terminal `already_settled` state. A later failure cannot revoke. |
| 4.5 | One Founder slot per user, duplicate claim handling | PASS | CODE+AUTO | A unique `user_id`. A duplicate payment becomes `duplicate_claim_review` and gets no second slot. |
| 4.6 | Late Founder payment is flagged for refund, never converted to monthly | PASS | CODE+AUTO | `founder_late_refund_review`, with no grant. |
| 4.7 | Failure and cancellation release the reservation | PASS | AUTO | Tested. |
| 4.8 | Wrong amount or wrong bill never grants | PASS | AUTO | `amount_mismatch` and `bill_mismatch`. |
| 4.9 | Single-app plan only after 100 allocated, one app per payment | PASS | AUTO | Tested. |
| 4.10 | Business and two-/all-app plans cannot be purchased | PASS | CODE+AUTO | Disabled in the plans table and in the `PLANS` allowlist. |
| 4.11 | Eligibility from the server-owned profile | PASS (with caveat) | CODE+AUTO | The `myops_profiles` row is used, not metadata. Caveat: the account type is still self-declared at registration. `personal` vs `business` is the user's own choice and is not verified. |
| 4.12 | Pre-existing users without a profile | BLOCKED | E2E | They are `not_eligible` until a backfill is approved. |
| 4.13 | An expired reservation that is paid late | NOT TESTED | CODE | A payment marked `expired` that is later confirmed can still allocate if capacity remains. This looks acceptable but is not covered by a test. |
| 4.14 | Admin audit authorisation | PASS | CODE+AUTO | Only `MYOPS_ADMIN_USER_IDS` can call it. Others get 403 and a missing configuration gives 503. |
| 4.15 | Real refund process | BLOCKED | n/a | Manual. Not defined. |

## 5. ToyyibPay Sandbox integration

| # | Item | Status | Type | Evidence |
|---|---|---|---|---|
| 5.1 | Sandbox host is hard-coded | PASS | CODE | `https://dev.toyyibpay.com` is a constant, so configuration cannot select live. |
| 5.2 | Success is re-verified server-to-server | PASS | CODE+AUTO | `getBillTransactions` must match the order reference and a paid status. The amount is taken from the gateway, not from the callback. |
| 5.3 | Callback hash checked with timing-safe comparison | PASS | CODE+AUTO | A supplied hash must match, and `status=3` (failure/cancel) requires a valid hash. |
| 5.4 | The callback accepts a success callback without a hash | Informational | CODE | Safe because the gateway re-verification is mandatory. A forged callback can only trigger a lookup. |
| 5.5 | Callback hash formula matches ToyyibPay's real implementation | BLOCKED | E2E | Assumed from documentation. Not verified against the sandbox. |
| 5.6 | `getBillTransactions` response field names | BLOCKED | E2E | The code expects `billExternalReferenceNo`, `billpaymentStatus`, `billpaymentAmount` and `billpaymentInvoiceNo`. Unverified. |
| 5.7 | Callback reaches `/api/toyyibpay-callback` through Vercel Deployment Protection | BLOCKED | E2E | A Protection bypass is probably needed for the server-to-server call. |
| 5.8 | A real sandbox payment end to end | BLOCKED | E2E | Needs `TOYYIBPAY_SANDBOX_*`, `MYOPS_SERVICE_ROLE_KEY` and the applied SQL. |
| 5.9 | Placeholder customer data sent to the gateway | Informational | CODE | `sandbox@example.invalid` and `0000000000`. Fine for sandbox. Real customer details are needed before any live use. |

## 6. Supabase RLS, tenant isolation, credential exposure

| # | Item | Status | Type | Evidence |
|---|---|---|---|---|
| 6.1 | RLS on all Phase 3 tables, no client writes | PASS | AUTO | The local suite proves clients cannot read payment tables or execute the functions. Entitlements are self-read only. |
| 6.2 | `SECURITY DEFINER` functions pin `search_path=''`, `EXECUTE` is `service_role` only | PASS | CODE+AUTO | Verified in the SQL and the proposal test. |
| 6.3 | Phase 2A RLS (profiles, memberships, subscriptions, grants, org) policies written as read-only | PASS | CODE | Policies use `auth.uid()`. Subscriptions are readable by the personal owner or an org admin. `myops_app_sessions` has RLS and no policies, so clients are denied. |
| 6.4 | Phase 2A RLS and tenant isolation behaviourally tested | NOT TESTED | AUTO | The SQL tests cover only the Phase 3 proposal. No cross-tenant read test exists for `202610160001`. |
| 6.5 | Phase 2A migration does not revoke default table privileges | FAIL (Low) | CODE | It relies on RLS having no write policies. It does not revoke `INSERT/UPDATE/DELETE` from `anon/authenticated`, which would add defence in depth. |
| 6.6 | RLS on the real staging database | BLOCKED | E2E | The SQL is unapplied and its security review is pending. |
| 6.7 | Credential exposure | PASS | CODE | No secrets are in the repository or its history. The server uses only the publishable key plus `MYOPS_SERVICE_ROLE_KEY` (server-only, `sb_secret_` format checked). The `VITE_`-prefixed variables are public by design. |
| 6.8 | Service-role key scope | Informational | CODE | `MYOPS_SERVICE_ROLE_KEY` bypasses RLS. Every use is through narrow RPC functions. The key is a new privilege that needs owner approval. |
| 6.9 | The unauthenticated `founders` action calls the DB with the service role | FAIL (Low) | CODE | The Origin check stops browsers only. A non-browser client can set any Origin and call it repeatedly, which is a cheap DB read. Add rate limiting or caching. |
| 6.10 | Security headers | FAIL (Low) | CODE | `vercel.json` sets none of CSP, `X-Frame-Options` / `frame-ancestors`, or HSTS. Only API responses set `nosniff`, no-store and a referrer policy. |

## 7. Security findings summary

| # | Severity | Finding | Reference |
|---|---|---|---|
| S1 | High (design) | Launch returns a bare app URL. Direct access to the apps is not gated by MYOPS. Each app needs verified session or token validation. | 3.7 |
| S2 | Low | Password can be changed from any signed-in session without the current password or a recovery context. | 2.11 |
| S3 | Low | The JWT is not revoked on inactivity timeout (up to 1 h). | 2.13 |
| S4 | Low | No app-level rate limiting. The public `founders` and auth endpoints can be hit by non-browser clients. | 2.12, 6.9 |
| S5 | Low | No CSP, frame-ancestors or HSTS headers. | 6.10 |
| S6 | Low | Account type is self-declared. Individual-only Founder eligibility can be chosen at registration. | 4.11 |
| S7 | Low | Phase 2A has no defence-in-depth `REVOKE` of table writes. There is no cross-tenant RLS test. | 6.4, 6.5 |

No critical findings and no exposed credentials. S1 should be resolved before any app is considered production-ready.

## 8. Blockers for real end-to-end UAT

1. Push access. The earlier session could not push, and `e78d79c` is now on origin.
2. Owner and security approval of both SQL files, then application to the staging project (Phase 2A, then Phase 3).
3. Approval and configuration of `MYOPS_SERVICE_ROLE_KEY`, `MYOPS_SESSION_SECRET`, `MYOPS_ADMIN_USER_IDS`, `MYOPS_APP_URL_*` and the `TOYYIBPAY_SANDBOX_*` variables on the Preview branch.
4. Vercel Deployment Protection bypass for `/api/toyyibpay-callback`.
5. Supabase Auth SMTP and redirect URLs for confirmation and recovery email.
6. A `myops_profiles` backfill for existing users.
7. A manual refund process for `founder_late_refund_review` payments.
8. Owner approval of the proposed plans (RM49, RM79, Business).
9. The apps' own server-side access checks (S1).

## 9. Recommended E2E script once unblocked

1. Register, confirm email, log in: expect `/` and a nav showing My Account and Logout.
2. Idle for 15 min: expect signed out.
3. Request a password reset, use the link, and confirm the old session is revoked.
4. Run a sandbox Founder payment: the slot count drops by 1 and the app card shows Open App.
5. Replay the callback: nothing changes.
6. Fail and cancel payments: no grant.
7. Run Founders 1–100 and the 101st payment: it is flagged for refund review, with no grant.
8. As a second account, confirm there is no access to other users' data.
9. Open each app URL directly while signed out and check the app's own access check (S1).
