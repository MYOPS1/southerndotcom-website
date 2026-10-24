# Phase 2B implementation — DRAFT, Preview only

## Changes and boundaries

Development branch based directly on `feature/myops-central-auth-foundation` at
`5dcda94`. Reviewed draft PR #8 at `5a491d4` (including its catalog audit and SQL
proposal); that PR is not assumed merged or applied. No SQL, Auth configuration,
Vercel settings, production deployment or existing product database was changed.

The corporate layout, styles, art and product branding are unchanged. Normal and
Production builds retain the existing design-preview portal. Preview builds enable
register, login, logout, callback, recovery, password update and account UI. The API
independently returns 404 unless `VERCEL_ENV=preview`, regardless of UI/credentials.
This is NOT a production launch or a declaration that live auth tests passed.

## Chosen architecture

- Vercel Node.js Function `/api/auth` is a same-origin backend-for-frontend (BFF).
  Supabase SDK 2.118.0 runs only on the server. Runtime must be Node 22+; this project
  uses Node 24. Owner must update the existing CI from Node 20 to Node 24. No Supabase browser client, browser token storage
  or secret/service-role key is used.
- Publishable key + user's JWT only. Every protected operation calls Supabase
  `getUser(accessToken)` and requires confirmed email. Name and Individual/Business
  selection are stored as descriptive Supabase Auth user metadata through the
  authenticated user endpoint; the account page derives them from the verified user
  response. This metadata is user-editable and is never trusted for authorization.
  No profile table or proposed RPC is required. Business workspace creation, seats,
  invitations and entitlement provisioning remain unavailable pending separately
  reviewed and approved server-side provisioning.
- Access JWT held in `__Host-myops-access`: Secure, HttpOnly, SameSite=Lax, Path=/,
  no Domain, lifetime capped at one hour or the upstream expiry, whichever is shorter.
  No refresh token is retained. Session expiry requires signing in again; there is
  intentionally no refresh endpoint, sliding expiry or automatic token refresh.
- This is server-validated, cookie-backed Supabase authentication, NOT a new central
  opaque-session database. Logout clears cookies and requests global Supabase refresh
  session revocation; already issued JWTs may remain valid until their expiry. It
  does NOT implement immediate cross-app token revocation. Phase 2C adds a 15-minute
  server-enforced inactivity limit for this site only (see phase-2c-homepage-first-auth.md).
- Signup/recovery use PKCE. A short-lived HttpOnly verifier cookie binds callback
  exchange to the initiating browser; one pending flow per browser (starting another
  overwrites it). Confirmation/recovery must open in that same browser. The SDK stores
  session state only in request-local memory, never in cookies/localStorage except
  the bounded access JWT and PKCE verifier. Parallel email flows need future UX work.
- Callback is a real `/auth/callback` page. It clears query/fragments immediately,
  posts code to the BFF, and uses a fixed `/` (Phase 2C; formerly `/account`) or `/account/update-password`
  redirect chosen by the SDK's exchanged flow type. No caller `next` URL is accepted.
  No implicit-flow token fragments are accepted. Referrer-Policy is no-referrer.
- All API operations require POST, exact trusted Host and Origin, and JSON content
  type, including login/logout/anonymous requests (CSRF defense). No CORS allowances.
  Responses are private/no-store. Bodies, keys, tokens, email links and SDK exceptions
  are never logged or returned. Supabase must enforce confirmation and suitable
  password, mail and abuse/rate-limit settings. Application-specific distributed rate
  limiting/CAPTCHA and security review remain release hardening work.
- Password update uses the Supabase Auth user endpoint with the verified caller JWT,
  then clears the cookie and requests global refresh-token revocation. No admin key
  is used. Any authenticated user may update their own password; untrusted callback
  parameters cannot select a different identity.
- A grant row, client-rendered dashboard or account type never grants application
  access. Paid OpsPS, OpsFinance and OpsFlow launches are visibly disabled; no
  app-launch endpoint is implemented. Subscriptions, SSO, organizational
  administration and product authorization remain separate.

## Trusted Preview origin and owner setup

Trusted origin is `https://${VERCEL_BRANCH_URL}`, taken only from Vercel's trusted
system environment, never the request headers or user input. Use that exact branch
alias to test; immutable deployment/PR aliases with a different Host fail closed.
System environment variables must be enabled for the project. No wildcard domains.

Draft PR #10 Preview branch alias:
https://southerndotcom-website-git-vercel-ag-be2b7d-mohd-syaiful-nizam1.vercel.app

CLI inspection verified this Preview is Ready and includes the `api/auth` Function.
Exact intended allowlist entry (only after the owner verifies callback HTTP behavior):
`https://southerndotcom-website-git-vercel-ag-be2b7d-mohd-syaiful-nizam1.vercel.app/auth/callback`.
After merging to the foundation branch, switch to that branch's exact origin instead;
PKCE cookies do not transfer across origins.

The callback code exists and passes build/static checks, but deployed HTTP behavior
and Supabase allowlist could not be verified from this sandbox. Before sending any
email, owner must verify `/auth/callback` loads on the branch alias and `/api/auth`
returns JSON (503 is expected until configured), then configure Supabase.

1. Vercel metadata check on 2026-10-16: the foundation branch has only
   `VITE_SUPABASE_URL`; the publishable key is NOT present in that Preview scope.
   The supplied dashboard shows a publishable-key variable in **Production**. That
   contradicts the owner report; values were NOT read, and Production was not altered.
   In this task environment on 2026-10-17, `VERCEL_ENV`, `VERCEL_BRANCH_URL`,
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` were all unset. No
   Vercel project credentials or key values were available, so current remote
   Preview scopes could not be independently queried here.
2. On the implementation branch (or after merge, the foundation branch), add BOTH
   Preview-only branch-scoped variables via Project > Settings > Environment Variables:
   https://vercel.com/mohd-syaiful-nizam1/southerndotcom-website/settings/environment-variables
   `VITE_SUPABASE_URL=https://uhuukcztdifvpjuopdea.supabase.co` and
   `VITE_SUPABASE_PUBLISHABLE_KEY` copied directly from Supabase Connect or Settings >
   API Keys. No values in chat/GitHub. These names are read only by server code here;
   publishable keys aren't authorization. Redeploy Preview after saving variables.
3. Confirm Supabase project ownership/staging status; email signup and confirmation
   enabled; test SMTP/password policy and abuse limits with staging inboxes.
4. Supabase Authentication > URL Configuration:
   https://supabase.com/dashboard/project/uhuukcztdifvpjuopdea/auth/url-configuration
   Add ONLY `https://<exact-VERCEL_BRANCH_URL>/auth/callback`. Both signup and recovery
   deliberately use this single callback; SDK recovery type routes locally to the
   password-update page. No wildcard, production URL or arbitrary return path.
   For this dedicated staging project use this same trusted origin as Site URL.
   Do not change shared/live project settings without verifying staging ownership.
5. Use standard confirmation/recovery templates with `{{ .ConfirmationURL }}` so
   Supabase verifies email and redirects with a PKCE code. Don't replace this with
   a token-hash template unless a corresponding verifier endpoint is implemented.
6. Owner should separately review the unexpected Production variable. This task does
   not authorize its removal, rotation or a production redeployment.

Branch-specific Preview variables do not automatically apply to the new implementation
branch. Existing scope on the foundation branch cannot enable this new branch's build.

## Review of PR #8 SECURITY DEFINER proposal

**Not executed, not approved, and not yet execution-tested.** It stays in PR #8 under
`supabase/proposals`, outside automatic migration execution. No SQL was copied into
an automatic migration runner in this implementation.

Positive findings from static review:
- Four narrow RPCs use empty search_path, schema-qualified relations, explicit identity
  checks and revoke PUBLIC/anon/authenticated EXECUTE before authenticated-only grants.
- Profile completion checks confirmed identity, validates account labels and cannot
  assign another user's ID. Profile account type is not an authorization role.
- Organization creation locks the confirmed auth user, restricts Business profiles,
  creates Basic/5 organization + owner admin atomically, and prevents duplicate owned
  organizations among calls using the same lock protocol.
- Invitations/acceptance lock the organization row; active + invited seats count,
  owner consumes one; invitations can't promote admins. Final-seat races among these
  functions are serialized. Acceptance is self-only, not arbitrary user provisioning.

Pending review before any execution approval request:
- Run PR #8's read-only catalog query in dedicated staging and obtain sanitized
  output: actual columns, constraints, policies, table grants, trigger definitions,
  function owners/search_paths/ACLs and all alternative membership/tier writers.
  This session has no Supabase authenticated tool or external database connection.
- Verify function owner is trusted; no untrusted role can replace functions or alter
  protected objects. Validate schema USAGE/SELECT grants needed for the RLS reads.
  RLS policy presence alone does not prove effective table privileges or isolation.
- Explicitly authorize product decisions: one owned organization; invited seats
  reserve capacity; suspended seats release capacity. Reactivation/tier downgrades,
  membership removal, owner/admin changes and invitation delivery are not implemented.
- Audit all alternate writers. Direct service-role/manual membership writes bypass
  this lock protocol and can exceed capacity. Proposed constraints do not alone
  enforce seat counts. Add appropriate database invariants if alternate writers exist.
- Consider authorization precheck before taking organization locks, followed by an
  authorization recheck after locking, to reduce unauthorized contention/DoS.
- Test concurrent last-seat invitations, duplicate creation, retry behavior and full
  transaction rollback. No new public subscription or grant write policy is proposed.
- Existing grant SELECT policy permits own grant reads after membership suspension;
  never use that alone for authorization. No actual app authorization is added here.

Only AFTER live catalog review and staging test preparation should an explicit owner
approval request specify the exact SQL, project and expected effects. No approval to
execute SQL is requested or inferred by this draft code PR.

## Test evidence

Local: 20 Node tests passed; ESLint passed (existing React-version warning);
Production-safe and Preview-auth builds passed. Tests include real installed SDK
PKCE storage against a mocked transport. SDK/session credential data in tests is
synthetic, not an actual key or account. Existing CI workflow was intentionally left
unchanged after GitHub denied publication of a tree containing a workflow edit.
The denial did not specify whether workflow permissions were the cause. Owner CI
follow-up: use Node 24, include PRs targeting the foundation branch, and run
`npm test`, `npm run lint`, `npm run build`, and `VERCEL_ENV=preview npm run build`.
Until then, do not rely on existing CI to cover this implementation.

Covered with mocks: production gate; exact origin/host and method/content-type;
missing/wrong project or non-publishable key shapes; wrong credentials/unconfirmed
identity; confirmation disabled; generic registration/recovery behavior; absent or
invalid verifier/code; fixed recovery redirect; unauthorized account/reset/profile;
self-only data filtering; unavailable provisioning; password update; logout cookies;
secure cookie flags and no token-bearing JSON.

**NOT RUN** (release blockers):
- Real staging signup + confirmation, login with correct/wrong credentials, real SMTP
  and confirmation-disabled rejection; expired/reused email links and multi-tab flows.
- Real recovery and password update, callback/rewrite/HttpOnly behavior in a browser,
  missing-cookie unauthorized dashboard and expiry behavior on deployed Preview.
- Actual password change/session revocation behavior in Supabase; network failures.
- Live RLS isolation using distinct users/orgs and anon JWT clients, all rejected
  direct writes, inactive memberships, foreign profiles/subscriptions/grants.
- Proposed SQL execution, privileges and concurrent membership seat races.
- Subscription/SSO integration and secure 15-minute cross-app inactivity revocation.

Use PR #8's staging matrix with distinct test identities and assert no foreign rows
and unchanged counts after rejected writes. Never test isolation with service-role
clients. Do not claim these tests pass based on unit mocks/build success.

## Documentation

- https://supabase.com/docs/guides/auth/sessions/pkce-flow
- https://supabase.com/docs/reference/javascript/auth
- https://supabase.com/docs/guides/database/functions
- https://vercel.com/docs/environment-variables/system-environment-variables
