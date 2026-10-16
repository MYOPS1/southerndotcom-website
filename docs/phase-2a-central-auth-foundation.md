# MYOPS Phase 2A — Central Account & Access Foundation

Status: architecture draft; **not live**. No existing production authentication is changed.

## Approved product requirements

- One MYOPS account, either **Personal** or **Business**.
- User signs in at MYOPS and opens only subscribed/authorized applications without entering credentials again.
- Each user has their own identity. Business Admin can invite users and grant access within the company's seat limit.
- **15-minute inactivity logout** across MYOPS and opened apps. Activity inside an app counts. Expired/revoked sessions must be rejected by the server.
- Individual app subscriptions or MYOPS Complete bundle.
- Business plans: Basic (up to 5 seats), Pro (up to 20), Enterprise (contract-defined).
- Payment methods planned: FPX/online banking and debit/credit cards, subject to gateway capability.
- **Auto-renew is opt-in**, manual renewal is supported. Payment gateway webhooks are authoritative for subscription state.
- OpsWMS and OpsHR are Coming Soon and inaccessible until launched.

## Existing repo audit

- This repo is a React 19 / Vite 5 corporate landing site, with no existing authentication SDK or backend.
- Do not add a client-only login form that pretends to protect apps. Real access requires backend-issued sessions and server-side entitlement checks.
- OpsFinance, OpsFlow and OpsPS are separate deployments; audit their existing identity systems and backend routes before integrating.

## Proposed data model (to validate against existing databases)

- `profiles`: user_id (auth provider UUID), display_name, account_type.
- `organizations`: id, name, owner_user_id, plan_tier, seat_limit.
- `organization_members`: organization_id, user_id, role, status; unique (organization_id, user_id).
- `products`: id, slug, launch_status.
- `subscriptions`: id, account_type, personal_user_id / organization_id, product_slug or bundle_id, status, renewal_mode, current_period_end, gateway_customer_id.
- `app_entitlements`: account/user/product access derived from active subscriptions and org role grants.
- `app_sessions`: session_id, user_id, client_app, last_activity_at, revoked_at; expire after 15 minutes of inactivity.

## Security and integration contracts

1. Use a common identity provider with secure OAuth 2.0/OIDC authorization-code + PKCE handoff between domains; no passwords or bearer tokens in query strings.
2. Each app validates identity and entitlement server-side on every sensitive request. Never rely only on disabled UI buttons.
3. Use secure, HttpOnly, SameSite-appropriate cookies and CSRF protections; avoid storing long-lived tokens in localStorage.
4. Each app periodically reports meaningful authenticated activity to the central session service. The server uses a sliding 15-minute inactivity window; background polling must not reset it.
5. On logout or inactivity expiry, revoke central and app sessions; app APIs reject stale credentials even if a browser tab stays open.
6. Business users receive only explicitly granted app access; apply database row-level security and tenant isolation.
7. Payment webhooks must be verified, idempotent and recorded for audit; failed/expired subscriptions revoke entitlements based on policy.
8. Keep existing product deployments working during migration; launch behind feature flags after integration testing.

## Implementation sequence

1. Confirm identity provider, Supabase project ownership, and each app's current authentication implementation.
2. Add database migrations, policies and secure server endpoints in an appropriate backend repository.
3. Implement MYOPS registration/login, account type selection and dashboard.
4. Integrate secure app handoff and entitlement checks one app at a time.
5. Implement cross-app inactivity expiry and logout.
6. Add subscription checkout, renewal choice, webhook reconciliation and admin tools.
7. End-to-end test Personal and Business accounts, seat limits, expired plans, multi-tab sessions and inactivity behavior.

## Not yet decided

- Whether an individual can belong to multiple organizations and switch active organization.
- Business seat pricing, product pricing and Complete bundle discount.
- Payment gateway selection and supported recurring-payment methods.
- Exact app deployment domains and current identity provider configurations.
