# ToyyibPay sandbox integration — implementation contract

Status: development specification, **no live payment capability**.

## Architecture decision

This repository is a Vite/React static website, so never place ToyyibPay API credentials in Vite variables, browser JavaScript, or committed source. Provision a separate HTTPS backend/API with persistent database, or a serverless function plus persistent DB. Decide hosting and database before implementation.

## Planned API contract (not yet implemented)

- `POST /api/checkout/session` authenticated, CSRF-protected. Request: `{planId, selectedAppIds}`; server looks up the canonical price (never trust a client-supplied amount), creates pending order and requests ToyyibPay bill using server-only credentials. Response: hosted payment URL and order ID.
- `POST /api/payments/toyyibpay/callback` provider callback. Validate provider authenticity using the **currently documented ToyyibPay signature scheme**, reconcile the bill status via the provider's transaction/status API, and compare amount, currency, bill reference, and internal order. Never activate on a browser return alone. Record raw provider IDs without exposing personal information in logs.
- `GET /api/checkout/orders/:id` authenticated order status for polling after redirect. Response status: pending, paid, failed, expired, refunded.
- `POST /api/subscriptions/renew` creates a new monthly payment for an existing subscription; default customer-initiated renewal until provider-supported recurring authorization is verified.

## Data requirements

- `plans`: stable ID, price in MYR sen, currency, allowed apps, usage limits, version and active flag.
- `orders`: id, tenant_id, plan_id, plan_version, amount_sen, status, expires_at, created_at.
- `payment_attempts`: order_id, provider_bill_id (unique), provider_transaction_id (unique if present), status, verified_at.
- `subscriptions`: tenant_id, plan_id, valid_from, valid_until, status.
- `payment_events`: unique event fingerprint/provider event ID, receipt timestamp, processing result (for idempotency).
- `audit_events`: administrator actions and payment state transitions.

## Safety and business rules

- Price catalogue: Starter 990 sen, Single 1990 sen, Duo 2990 sen, Complete 3990 sen.
- 14-day trial planned; enforce trial eligibility server-side and explicit renewal consent.
- Subscription entitlement changes must be transactional and idempotent.
- Expired unpaid subscriptions should not renew automatically; define grace period and notices.
- Verify FPX and DuitNow QR eligibility and exact API fields against merchant account/docs before implementation.
- Never put sandbox/production secret keys in git, client bundles, logs or support messages.
- Staging tests: success, failure, duplicate callback, forged callback, delayed settlement, amount mismatch, refund, timeout and retry.
- Go-live gates: approved merchant account, published pricing/terms, cancellation/refund policy, payment provider fees, verified settlement and end-to-end staging test evidence.

## Dependencies / open decisions

1. Backend hosting choice and deployment access.
2. Persistent DB / tenant identity integration across MYOPS apps.
3. ToyyibPay sandbox category code and server-only secret (configured by owner in secret manager).
4. Provider confirmation of available DuitNow method and transaction fees.
5. Exact Starter plan limits and renewal grace period.

Related: website issue #1 and pricing PR #2.
