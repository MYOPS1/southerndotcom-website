# MYOPS affordable pricing — implementation specification

Status: approved pricing proposal, **not yet deployed**. Currency MYR.

| Plan | Monthly price | Entitlement |
|---|---:|---|
| Starter | RM9.90 | Limited-use entry tier; precise quotas to be agreed before checkout |
| Single App | RM19.90 | Choose one of OpsPS, OpsFinance, OpsFlow |
| Duo | RM29.90 | Choose any two paid apps |
| Complete | RM39.90 | All three paid apps |
| OpsHub | RM0 subscription | Seller marketplace; transaction commission applies |

Free trial: 14 days for paid plans; one trial per eligible business, abuse prevention and clear renewal consent.

## OpsHub proposed monthly GMV commission tiers

- Under RM1,000: 3%
- RM1,000 through RM9,999.99: 2%
- RM10,000 and above: 1.5%

Use eligible completed product subtotal excluding tax and shipping. Store order-level rate snapshots; reverse commission on refunds; keep an immutable audit log of admin rate changes. Define whether monthly tier is retroactive or applies to subsequent orders before coding billing.

## Launch gates

- Define Starter feature limits, users, storage and transaction quotas.
- Validate processor fees, tax, payout schedule, refund handling and profitability.
- Implement server-side subscription entitlements and webhooks with idempotency.
- Confirm marketing copy, policies, trial cancellation and renewal disclosure.
- Test staging payments, access controls and commission calculations before enabling production checkout.

Related implementation issue: #1.
