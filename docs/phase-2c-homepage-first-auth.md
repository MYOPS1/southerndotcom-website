# Phase 2C — homepage-first authentication and subscription UX (DRAFT, Preview only)

Builds on PR #10 (`vercel-agent/myops-server-auth`). Production builds are unchanged: the
new controls render only in the `preview-auth` build, and `/api/auth` still returns 404
unless `VERCEL_ENV=preview`. No payments, SQL, Supabase settings or Production are touched.

## Behaviour

- Signed out: the main navigation shows **Register** and **Login**. Signed in: **My Account**
  and **Logout**. State comes from the server (`action: "session"`); it is display-only.
- Login and the confirmed-email callback redirect to `/`. A session is only issued after the
  server verifies a confirmed email, so registration reaches `/` only after confirmation.
  Password recovery still goes to `/account/update-password`; logout returns to `/`.
- Homepage product cards (existing design unchanged) show **Open App** (active
  subscription), **Subscribe** (none) or **Coming Soon**. Subscribe goes to `/login` when
  signed out, otherwise to the subscription list on `/account`, where checkout is shown as
  not enabled. `/account` keeps profile, billing and subscription status.
- Open App calls `action: "launch"`. The server re-verifies identity, inactivity and the
  entitlement on every call and only then returns the HTTPS URL configured for that product
  (`MYOPS_APP_URL_OPSP`, `_OPSFINANCE`, `_OPSFLOW`). Missing/non-HTTPS URL fails closed (503).
  No cross-app SSO is implemented; the destination app must enforce its own access.

## Entitlements (server-side)

Read with the caller's JWT, so Supabase RLS applies, from the Phase 2A tables
`myops_products`, `myops_subscriptions` and `myops_app_grants`. A product is **active** only if
the catalog marks it `live`, the subscription status is `active` and `current_period_end` has
not passed, and it belongs to the caller (personal) or to an organisation where the caller
holds an app grant. Any read error fails closed. Client-supplied claims are ignored.

These tables exist only if the Phase 2A migration was reviewed and applied to staging; this
PR does not apply it. Without it, entitlement reads fail closed and cards show Subscribe.
Organisation members cannot read organisation subscriptions under the current RLS policy
(admins only), so they are not entitled until a reviewed policy/function allows it.

## 15-minute inactivity

A signed `__Host-myops-activity` cookie (HMAC-SHA256 with `MYOPS_SESSION_SECRET`) records the
last activity. Every protected request rejects a missing, forged, future-dated or older than
15 minutes cookie (401, all cookies cleared) and otherwise refreshes it. Passive probes
(`activity: false`, once a minute from the browser) detect expiry without extending it; user
input extends it at most once a minute. This is enforced by this site's BFF. Already issued
Supabase JWTs remain valid until expiry for other consumers; cross-app revocation is not done.

## Preview configuration

Preview-scoped only (values never in Git or chat): `VITE_SUPABASE_URL`,
`VITE_SUPABASE_PUBLISHABLE_KEY`, **new** `MYOPS_SESSION_SECRET` (random, at least 32
characters), and optionally `MYOPS_APP_URL_<PRODUCT>` (HTTPS). Redirect allowlist is unchanged:
the exact branch-alias `/auth/callback` only. Redeploy the Preview after changing variables.

## Tests

`npm test` covers redirects, nav state, product states, inactivity (stale, forged, future,
passive), unauthorized/cross-origin launch, expired/non-active/other-user/coming-soon
subscriptions, unconfigured destinations and read failures.
