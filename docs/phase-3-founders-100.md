# Phase 3 — Founders 100 lifetime promotion and single-app subscriptions

Status: **Preview and ToyyibPay sandbox only.** Nothing here has been applied to any Supabase
project, deployed to Production, or connected to live payments.

## Pricing

| Plan | Price | Status | Entitlement |
| --- | --- | --- | --- |
| Founders 100 | RM29 once | **Enabled (sandbox)** | Lifetime access to every live MYOPS app, current and future; limited to 100 successful customers |
| Single app | RM29 / month | **Enabled (sandbox), only after the 100 Founder places are taken** | ONE selected live app per payment; never grants other apps |
| Two-app bundle | RM49 / month | Proposed, **disabled** pending owner approval | — |
| All-app bundle | RM79 / month | Proposed, **disabled** pending owner approval | — |
| Business Basic (5 users), Business Pro (20 users), Enterprise (custom) | not priced | Proposed, **disabled** pending owner approval | — |

Disabled plans exist in the `myops_plans` catalog with `enabled = false`; the server and
`myops_create_payment` both refuse them (`plan_disabled`, HTTP 403). The homepage lists them with disabled
buttons. No free lifetimes exist: a lifetime row cannot be created without a `succeeded` payment row.

## What was built

- `supabase/proposals/phase3_founders_100.sql` — proposed migration (**not** in `supabase/migrations`).
- `server/payments.js` — ToyyibPay sandbox gateway, checkout, verified settlement, admin audit.
- `server/toyyibpay-callback.js` + `api/toyyibpay-callback.js` — server-to-server webhook.
- `server/auth.js` — new `/api/auth` actions `founders`, `checkout`, `admin_audit`; entitlement logic now
  includes lifetime entitlements and is catalog-driven (new live apps are covered automatically); `session`
  and `account` responses include `lifetime`.
- `src/FoundersPromo.jsx` (homepage promotion, before the Solutions section), `src/AdminAudit.jsx`
  (`/admin/audit`), Subscribe on product cards now points signed-in users to `/#founders`.
- Tests: `tests/founders-sql.test.mjs` (real PostgreSQL, concurrent), `tests/founders-payments.test.mjs`,
  `tests/founders-promo.test.mjs`.

## Slot allocation

All slot mutations take one transaction-scoped advisory lock (`pg_advisory_xact_lock(730500100)`) and are
backed by constraints (slot number PK 1–100, unique `user_id`, unique `payment_id`), so more than 100 or two
for one customer is impossible even if the lock were bypassed.

- A pending checkout holds a 30-minute **reservation**; it is not an allocation and is released on failure,
  cancellation or expiry. Remaining = 100 − allocated − live reservations.
- Only a payment the **server** settles as `succeeded` allocates a slot and creates the lifetime entitlement.
- Settlement is idempotent. `succeeded` is terminal: later failure/cancel/replay never revokes or re-grants.
- Amount or bill-code mismatch grants nothing.
- A Founder payment confirmed after the places ran out is recorded as `succeeded` with outcome
  `founder_late_refund_review`: **no lifetime and no subscription is granted**. It is shown in the admin audit
  for refund or manual review and is never converted to monthly. A duplicate claim is flagged
  `duplicate_claim_review`.

Local verification (throwaway PostgreSQL 16, never Supabase): 150 concurrent customers → exactly 100
reservations/slots (1–100, distinct), 12 concurrent duplicate webhooks → one settlement, 8 concurrent
checkout clicks → one pending payment, client roles denied on all tables/functions.

## Payment flow and webhook verification

1. Signed-in Individual clicks Claim → `/api/auth` `checkout` → `myops_create_payment` (reservation) →
   ToyyibPay sandbox `createBill` (RM29, `billExternalReferenceNo` = order ref) → redirect to
   `https://dev.toyyibpay.com/<BillCode>`. The sandbox host is a constant; live cannot be selected by config.
2. ToyyibPay posts to `/api/toyyibpay-callback`. The handler:
   - validates field shapes, rejects a supplied hash that does not match
     `md5(secret + status + order_id + refno + "ok")`;
   - for success **always** confirms with `getBillTransactions` (order ref, paid status, amount = RM29.00);
     a forged callback cannot grant anything;
   - accepts failure/cancel only with a valid hash;
   - de-duplicates by `sha256(billcode|order_id|refno|status)`; returns 502 if verification is unavailable
     so the gateway retries.
3. After settlement the next `session` read returns `lifetime: true`; cards flip Subscribe → Open App.
   The browser polls `session` for ~30 s after returning from payment.

**Unverified assumptions (confirm against the real sandbox before relying on them):** the callback hash
formula and the exact `getBillTransactions` field names (`billpaymentStatus`, `billpaymentAmount`,
`billExternalReferenceNo`, `billpaymentInvoiceNo`) come from public documentation/community sources.

Security review note: a success callback without a `hash` is currently accepted *only because* it is
independently confirmed through `getBillTransactions`. Once the sandbox hash formula is verified, make the
hash mandatory for every status (defence in depth).

## Eligibility: server-owned account type

Checkout eligibility (Individual only) is decided inside `myops_create_payment` from `public.myops_profiles`,
which only `service_role` can write. Registration provisions the profile through
`myops_provision_profile` (insert-only; an existing type is never changed, and no row is created for
existing-email probes). User-editable auth metadata is **not** consulted, so editing it cannot bypass
eligibility. Accounts with no profile (including those registered before this change) are refused
(`not_eligible`) until an operator provisions them.

## Server-side enforcement

The browser never decides access. `launch` re-reads entitlements with the user's JWT (RLS) and requires
`active` **for the selected app**. A single-app subscription row carries one `product_slug` and unlocks only that
app; `myops_grant_month` can never create a bundle row; lifetime applies to every `live` catalog app; coming-soon apps are never unlocked. Slugs are
validated (`^[a-z0-9_]{1,32}$`) before building the `MYOPS_APP_URL_<SLUG>` lookup.

## Admin audit

`/admin/audit` → `admin_audit` action. Allowed only for user ids in `MYOPS_ADMIN_USER_IDS` (fail closed when
unset). Read-only; returns payments, allocations, entitlements and webhook events with duplicate counts.
User ids are truncated in the UI and no emails are returned.

## Required Supabase migrations (not executed)

Order, staging project only, **after security review and written owner approval**:

1. Phase 2A foundation (`supabase/migrations/202610160001_myops_identity_foundation.sql`) — still unapplied.
2. `supabase/proposals/phase3_founders_100.sql`. It also **corrects a Phase 2A bug**: the
   `myops_product_or_bundle` check was inverted, which made every subscription row (per-app and bundle) impossible to insert.

Rollback (staging, after exporting data because these are financial records): drop the five tables
(`myops_payment_events`, `myops_lifetime_entitlements`, `myops_founder_allocations`, `myops_payments`,
`myops_plans`) and the `myops_*` functions; restore the original constraint only if a bundle row is not needed.

### Security review checklist
- [ ] `SECURITY DEFINER` functions: `search_path=''`, schema-qualified, `EXECUTE` only for `service_role`.
- [ ] RLS enabled; no client write policies; only self-read of active lifetime entitlements.
- [ ] Advisory-lock key does not collide with other uses.
- [ ] Constraint correction to `myops_product_or_bundle` approved.
- [ ] Approve use of a server-only service-role key (see below).
- [ ] Approve plan catalog prices/limits and that all proposed plans remain `enabled = false`.
- [ ] Approve `myops_provision_profile` (insert-only, service_role) as the source of account type.

## Environment (Preview only; never commit values)

| Variable | Purpose |
| --- | --- |
| `MYOPS_SERVICE_ROLE_KEY` | Server-only Supabase secret key (`sb_secret_…`). Needed to call the payment functions and by the webhook. **New privilege; needs owner approval.** |
| `TOYYIBPAY_SANDBOX_SECRET_KEY`, `TOYYIBPAY_SANDBOX_CATEGORY_CODE` | Sandbox account credentials |
| `MYOPS_ADMIN_USER_IDS` | Comma-separated admin user UUIDs |
| `MYOPS_APP_URL_<SLUG>` | HTTPS launch URL per app |
| Existing | `MYOPS_SESSION_SECRET`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` |

## Blockers and known limits

- Supabase SQL (Phase 2A + Phase 3) unapplied; nothing works end to end until approved and applied.
- Sandbox credentials and Preview variables not set; webhook and checkout untested against real ToyyibPay.
- Vercel Deployment Protection on Previews will block the webhook; needs a protection-bypass for
  `/api/toyyibpay-callback` (or a non-protected domain).
- Existing users without a `myops_profiles` row cannot buy until a profile is provisioned (backfill is a
  separate, unapproved data operation).
- Late Founder payments need a manual refund process (none exists; ToyyibPay refunds are done by staff).
- No refund/revocation workflow (revocation is a manual, audited SQL operation today).
- Single-app plan is a manual-renewal one-month payment per app, not auto-billing.
- Admin audit lists only the most recent 200 rows per table.
- Lifetime entitlement applies to this site's launch gate; cross-app SSO is not implemented.
