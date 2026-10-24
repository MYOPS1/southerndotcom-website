# MYOPS Supabase staging configuration

New dedicated Supabase project reference supplied by owner (connectivity not verified): `uhuukcztdifvpjuopdea`.

Expected project URL: `https://uhuukcztdifvpjuopdea.supabase.co` (format-derived; connectivity not verified).

## Safe setup

1. In Supabase Dashboard, verify this project is owned by MYOPS and is appropriate for staging. **Do not run the draft migration against a production database.**
2. In Vercel's **Preview** environment (not Production), configure:
   - `VITE_SUPABASE_URL=https://uhuukcztdifvpjuopdea.supabase.co`
   - `VITE_SUPABASE_PUBLISHABLE_KEY=<publishable key from Supabase dashboard>`
3. Never commit service-role keys, database passwords, refresh tokens or user credentials to GitHub. Publishable keys are intended for frontend use, but must still be paired with proper RLS and backend authorization.
4. Before enabling authentication, configure Supabase Auth allowed redirect URLs for the exact approved preview and application domains. Review email confirmation and SMTP settings.
5. Review `supabase/migrations/202610160001_myops_identity_foundation.sql` with the actual Supabase schema and existing app authentication before applying to staging.
6. Confirm Supabase migrations and RLS in staging; then implement actual sign-in, account creation, and server-side session and entitlement verification.
7. Test inactivity timeout with actual backend enforcement (15 minutes). Frontend timers alone are insufficient.

## Current status

- Account routes are **preview-only**, not functional.
- No Supabase API calls or migrations have been run.
- No secret keys have been requested or stored.
- Do not merge PR #7 or deploy to production until end-to-end checks pass.
