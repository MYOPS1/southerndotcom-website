# MYOPS Multi-platform architecture decision (2026-10-15)

## Product surfaces
1. MYOPS corporate website (this repository): marketing, product discovery, pricing, links. **No checkout or payment API**.
2. MYOPS Workspace web: separate authenticated portal, app launcher and shared navigation. Each module is served by its own application/backend.
3. MYOPS Super App (Expo React Native): Android/iOS shell, shared navigation and modular native screens.
4. Standalone OpsFinance, OpsFlow, OpsPS, OpsHub experiences remain available on web; mobile standalone apps may follow.

## Identity and data
- Target: standards-based OIDC single sign-on with a central identity provider; do not treat separate Supabase Auth projects as automatically sharing login sessions.
- Each application owns its own Supabase project and its own data/API. Shared identity subject is mapped to local app users; never share service-role credentials between apps or ship them to browsers.
- Shared workspace only requests access via secure module APIs. No direct cross-database joins from client apps.

## Billing
- Website: no checkout.
- Each paid app: own checkout and billing backend, with provider compliance review.
- Bundle plans: defer until shared entitlement registry, cross-app purchase ownership, refund and access synchronization are designed. Do not charge for bundles before entitlement system exists.
- Apple/Google digital purchase rules must be checked for native mobile distribution. Do not assume FPX/DuitNow web checkout is permitted in-app.

## Existing draft branch cleanup
- The prior ToyyibPay website sandbox scaffold and Supabase migration on this branch are **superseded** and must be removed before merging this PR.
- Keep marketing pricing UI only after clearly distinguishing proposed plans from purchasable plans.
- Move relevant payment architecture to each app repository; no credentials or live payment acceptance yet.

## Delivery sequence
1. Inventory web/mobile capabilities and existing auth for all four apps.
2. Build independent MYOPS Workspace web repo with app launcher and mock entitlement states.
3. Choose and implement central OIDC provider, integrate one app first.
4. Implement app-specific billing in sandbox and server-side entitlement checks.
5. Reuse navigation/design system in Expo super app; validate App Store/Play policies before mobile payment release.
6. Add Duo/Complete cross-app bundles only after entitlement synchronization tests.
