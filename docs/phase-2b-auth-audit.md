# Phase 2B — audit and review package

## Status (2026-10-16)

**Not an authentication launch. No live Supabase configuration or SQL was changed.**
No production deployment or existing product database was modified. This package is
based on development branch `feature/myops-central-auth-foundation` at `5dcda94`.
The owner reports that the foundation migration, seven tables, RLS, six SELECT
policies and five products were verified. This session cannot independently verify
that report: no authenticated Supabase tool/connection is available, and external
database connections are outside the sandbox's supported network paths.

### Verified repository and Vercel findings

- React/Vite static site; no Supabase SDK, server auth endpoints or session verifier.
- `/register`, `/login`, `/account` are explicitly disabled design previews.
- No auth callback, forgot-password or password-update handler exists.
- Foundation SQL defines seven RLS-enabled tables and six SELECT policies. There
  are no client-write policies or profile provisioning functions/triggers in that file.
- Profiles and memberships are self-readable; organizations require active membership;
  organization subscriptions require active admin membership. Products are readable
  to authenticated users. Sessions have no client policies.
- A grant row is readable by its user even after membership suspension. Reading that
  row MUST NOT itself authorize an application: check active membership, current
  subscription, product launch status, explicit grant and session server-side.
- Tier constraints constrain the stored seat limit, NOT membership row counts.
  No concurrency-safe seat admission exists in the foundation migration.
- Schema does not implement subscription expiry or 15-minute session expiry.
- Table grants, actual installed policies/functions/triggers, Auth provider settings,
  SMTP, email templates, rate limits, passwords and redirect allowlist remain unverified.
- Scoped CLI verified the Vercel project and reported **no Preview environment
  variables** for this branch. No values were requested or displayed.
- Existing preview (not newly deployed or browser-tested by this session):
  https://southerndotcom-website-git-feature-m-63b434-mohd-syaiful-nizam1.vercel.app

## Included SQL — owner review required before execution

- `supabase/audits/phase2b_catalog.sql`: read-only catalog/policy/grant/function
  evidence query. Owner should run against the dedicated MYOPS staging project and
  share sanitized results, not credentials or user records.
- `supabase/proposals/phase2b_provisioning.sql`: **unapplied proposal**, deliberately
  outside migrations. Four narrow SECURITY DEFINER RPCs with empty search paths,
  explicit identity checks and restricted EXECUTE grants:
  - Confirmed-user, self-only, idempotent profile completion. UI Individual maps to
    database `personal`; Business maps to `business`. No subscription/role metadata trust.
  - Atomic business organization and owner-admin membership creation, Basic/5 only.
  - Active admin invitation of an existing confirmed identity, staff/manager only.
  - Self-only invitation acceptance. Active + invited memberships reserve capacity;
    organization-row locking serializes admission. Owner occupies one seat.
- Proposal decisions needing approval: one owned organization per identity; invitations
  reserve seats; suspended memberships free seats; no admin promotion/demotion, deletion,
  reactivation, invitation delivery or new-user invitation yet. Paid tiers are never
  chosen by the caller. Basic organization creation grants NO paid application access.
- Before execution: compare live schema, existing functions and alternate writers;
  review function owner and grants; confirm this is staging; approve this security-
  sensitive proposal. Do not rerun the original migration (policies aren't idempotent).
  Do not use CREATE OR REPLACE to overwrite unknown live functions.
- Every future trusted writer and seat downgrade must follow the same locking/capacity
  protocol. Service-role/manual SQL can bypass RLS and must not circumvent it.

## Supabase owner setup

Project: https://supabase.com/dashboard/project/uhuukcztdifvpjuopdea

Expected URL: `https://uhuukcztdifvpjuopdea.supabase.co` — derived from supplied
project reference, not connectivity-verified. Confirm using the project's Connect dialog.
Copy the **publishable** key from Connect or **Settings > API Keys**:
https://supabase.com/dashboard/project/uhuukcztdifvpjuopdea/settings/api-keys
Never copy a secret/service-role key or password into frontend variables or chat.

1. Confirm ownership and staging-only usage before changing project-wide Auth settings.
2. Authentication > Sign In / Providers > Email: enable email/password signup and
   require email confirmation. Confirm password policy, rate limits and abuse
   protection appropriate to staging. Do not assume hosted defaults prove live state.
3. Authentication > Email: configure/test SMTP and confirmation/recovery templates
   with staging recipient inboxes only. Keep delivery credentials in protected settings.
4. Authentication > URL Configuration:
   https://supabase.com/dashboard/project/uhuukcztdifvpjuopdea/auth/url-configuration
   Once callback routes are implemented, allow exactly:
   `https://southerndotcom-website-git-feature-m-63b434-mohd-syaiful-nizam1.vercel.app/auth/callback`
   and
   `https://southerndotcom-website-git-feature-m-63b434-mohd-syaiful-nizam1.vercel.app/account/update-password`.
   For this dedicated staging project, use that Preview origin as Site URL, NOT the
   production MYOPS domain. Always supply the exact redirect on signup/recovery.
   No wildcard covering every Vercel tenant or arbitrary return URL. Do not enable
   links yet: these handlers do not currently exist.
5. Review email templates against the selected PKCE/callback flow. A future server
   token-hash flow needs a matching verifier route and templates; do not mix it with
   a code-exchange callback. Ensure callback errors, expired and reused links fail safely.

## Vercel Preview configuration handoff

Not changed: publishable key is unavailable through a protected input in this session.
Vercel access does not grant Supabase access. An approved Vercel write Plan would be
required for agent-side environment changes; none was requested without both values.

Owner steps:
1. Open Project > Settings > Environment Variables:
   https://vercel.com/mohd-syaiful-nizam1/southerndotcom-website/settings/environment-variables
2. Add `VITE_SUPABASE_URL` with the verified project URL above.
3. Add `VITE_SUPABASE_PUBLISHABLE_KEY`, copying the publishable key directly from
   Supabase's Connect/API Keys page. Do not paste the value into chat.
4. Select **Preview only**, and scope both to branch
   `feature/myops-central-auth-foundation`. Do not select Production or Development.
5. After frontend implementation and approval, redeploy that branch's Preview only.
   Existing builds do not gain newly configured build-time Vite values automatically.
   Environment variables alone do not activate the current disabled mockups.

## Frontend/backend integration contract (not yet implemented)

Preserve the existing architecture requirement: server-owned sessions with secure
HttpOnly cookies, CSRF/origin protections, and server-side authorization. Do not
silently replace it with long-lived localStorage tokens in a client-only form.
A backend/BFF and its cookie/session design must be approved and built first.

- `/register`: collect display name, Individual/Business, email and password. Call
  signup with exact approved `emailRedirectTo`; use a generic confirmation response.
  Never log submitted credentials. Do not create roles/subscriptions from metadata.
- `/auth/callback`: implement selected PKCE code exchange, reject missing/invalid/
  reused code, clear callback parameters, never log tokens; redirect only to fixed
  local destinations. Validate session server-side before onboarding/account access.
- After confirmed authentication: call proposed `myops_complete_profile` as the user;
  resume onboarding on missing profile, never silently elevate account type. Business
  setup separately invokes `myops_create_organization`; no broad client INSERT policy.
- `/login`: password authentication, generic failure, rate-limit handling, verified
  email requirement. No authentication bypass from a UI state or mock account.
- `/forgot-password`: generic response using `resetPasswordForEmail` and exact approved
  redirect. `/account/update-password`: verified recovery session, `updateUser` password
  change, appropriate session revocation/re-authentication. Test expired/reused links.
- `/account`: server-authenticated data reads; only self/active-org authorized rows.
  Show real subscription state only after server enforcement exists. Keep app launch
  disabled until an application validates current identity and entitlements itself.

## Security test results and required staging matrix

**Live RLS, Auth, email, callback and seat-race tests: NOT RUN (no Supabase access).**
Local validation: all five existing source-assertion tests passed; Vite build and
ESLint passed (React-version configuration warning). These checks do not execute
PostgreSQL or prove live isolation. Proposed SQL has not been execution-tested.

Use staging users A/B (unrelated), C (A's org admin), D (staff), E (suspended),
separate organizations X/Y, and an anonymous client. Authenticate with the
publishable key and each user's JWT, never a service-role client for isolation tests.

| Test | Required result | Result this session |
| --- | --- | --- |
| Anonymous reads/writes; direct authenticated inserts/updates/deletes on all seven tables | No unauthorized access (zero rows or permission error as appropriate) | Not run |
| A queries B's profile/membership/grant and X user queries Y organization | No foreign rows | Not run |
| Active admin vs staff subscription reads; invited/suspended org reads | Only active org admin reads org subscriptions; no inactive org read | Not run |
| Catalog reads and all client session reads/writes | Authenticated catalog only; sessions denied | Not run |
| RPC without auth/unconfirmed identity; forged user/role/tier parameters | Reject; no writes | Not run |
| Profile completion retry/type change and simultaneous org creation | Stable self profile; no duplicate owned org; owner seat atomic | Not run |
| Staff/foreign admin invitation; self invitation acceptance for another user | Reject | Not run |
| Fifth vs sixth seat including pending invitations; two simultaneous final-seat invites | Capacity never exceeded; exactly one final-seat admission | Not run |
| Failed provisioning transaction | No orphan org/profile escalation/membership | Not run |
| Confirm email, login, reset, expired/reused links, hostile redirects | Confirm required; safe failure; no open redirect | Not run |

Tests must also assert unchanged row counts after rejected writes. Run expected-error
SQL statements separately or in savepoints; don't mistake an aborted transaction for
multiple passing checks. Clean up only clearly tagged staging fixtures after review.

## Remaining work — explicitly incomplete

- Apply approved provisioning migration only after live catalog review and staging tests.
- Subscription enforcement: verified/idempotent payment webhooks, expiration/renewal,
  refunds and revocation; server checks subscription + active membership + explicit
  product grant + launch status for every sensitive request. No publicly writable
  subscription or access-grant policies.
- Cross-application SSO: audit existing app identity systems; approved OIDC/PKCE handoff,
  audiences/issuers, session validation, revocation and logout across separate domains.
  Do not copy bearer tokens into URLs or change OpsFinance/OpsPS/OpsFlow databases.
- Secure 15-minute inactivity: trusted server time/activity, central session revocation,
  rejection of expired sessions in every app/API, multi-tab/device behavior and real
  meaningful activity only (not background polling). Browser timers alone do not enforce it.
- Re-run two-tenant isolation, seat concurrency, real inbox email flows and end-to-end
  Preview tests before enabling forms or claiming completion. Production remains out of scope.

## References

- https://supabase.com/docs/guides/auth/passwords
- https://supabase.com/docs/guides/auth/redirect-urls
- https://supabase.com/docs/guides/auth/auth-email-templates
- https://supabase.com/docs/guides/getting-started/api-keys
- https://supabase.com/docs/guides/database/functions
