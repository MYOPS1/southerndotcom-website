# Preview registration investigation — 2026-10-16

## Confirmed findings

The branch alias resolved to Ready deployment CptsbCW6yGSpYLTNrHwJniynsWSB.
Build logs identify commit bafc3e6 and `preview-auth` mode; the deployment includes
`api/auth`. This is the functional portal, not the disabled design mockup.
CDN request records show four POST /api/auth requests between 03:42:16 and
03:42:30 UTC returning 503 on the trusted branch alias. The bounded runtime-log
query returned no entries, not proof of healthy execution.

Environment metadata for `preview vercel-agent/myops-server-auth` lists only
VITE_SUPABASE_URL. VITE_SUPABASE_PUBLISHABLE_KEY is absent. The server rejects this
configuration before initializing Supabase. No credential values were inspected.
The configured URL's value has not been validated, only its presence.

Additionally, registration previously returned a confirmation-style success for
all upstream errors except rate limiting, masking disabled signup, weak password,
and provider failures. The fix returns safe actionable errors without echoing
upstream messages or exposing existing-account details. The form now handles
network and non-JSON responses, shows a pending button and password/browser guidance.
Form serialization is inside the error boundary so unexpected failures are visible.

## Verification and limits

23 local tests pass, including rendered React registration interaction in jsdom,
API validation/configuration rejection and SDK PKCE with mocked transport.
ESLint, production-safe build and Preview-auth build pass. This is not real-browser
or live Supabase signup verification. Existing npm audit reports four dependency
vulnerabilities (one moderate, three high); no unrelated upgrade was attempted.

No deployed HTTP/browser access or authenticated Supabase access is available in
this sandbox. No real signup, email delivery, user-row creation, callback allowlist
or live Auth rejection has been verified. No SQL or Production change was made.

## Owner unblock and retest

1. Vercel project Settings > Environment Variables: select Preview and branch
   `vercel-agent/myops-server-auth`. Verify VITE_SUPABASE_URL matches the dedicated
   staging project, and add VITE_SUPABASE_PUBLISHABLE_KEY from that project's API
   Keys page. Never use a secret/service-role key. Leave Production unchanged.
2. Redeploy this branch's latest Preview after saving variables.
3. In the dedicated Supabase project's Authentication settings, enable email
   signup/confirmation and configure working SMTP. Under URL Configuration allow
   exactly this redirect (no wildcard):
   https://southerndotcom-website-git-vercel-ag-be2b7d-mohd-syaiful-nizam1.vercel.app/auth/callback
   Use standard ConfirmationURL templates for PKCE.
4. Open that branch alias at /register. Confirm the page says Development Preview,
   not Design preview only. Use a dedicated inbox you control, a full name and a
   12–128 character strong password. Click Register once; verify pending state.
5. Browser Network: POST /api/auth must return JSON. A 503 means configuration or
   signup remains unavailable; report only sanitized status/message, not request
   bodies, passwords, cookies or email-link codes.
6. On success read the check-email message, verify the user in Supabase
   Authentication > Users, then open the email in the SAME browser that registered.
   Confirm redirect through /auth/callback to /account, and email confirmation in
   Supabase. Profile onboarding may remain unavailable pending separate SQL review;
   do not execute PR #8's proposal as part of this fix.
7. Try an invalid email/short password (browser validation), and controlled network
   failure (visible error/re-enabled button). Do not interpret mocked tests as live
   email evidence.
