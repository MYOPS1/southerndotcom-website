# Phase 2B upstream signup investigation — 2026-10-16

## Confirmed evidence

The inspected Preview is Ready, built from ab06f180 on
`vercel-agent/myops-server-auth`. A bounded Vercel query for `/api/auth` from
05:21–06:06 UTC returned two POST request records: 05:49:30.813 and 05:49:37.951,
both HTTP 502. The matching runtime query returned zero entries, with no excluded
intervals or further pages. HTTP 502 is the application's response, NOT the
Supabase HTTP status or error code.

`server/auth.js` only returns the reported registration message after the SDK
returns an error other than HTTP 429 or the explicitly handled signup cases.
The configuration guard requires exactly the dedicated staging project URL and
constructs the client with that constant. Therefore this path cannot select a
different configured project. This does not independently prove receipt by the
remote Auth server or validity of the key's project association. No credential
values were read. A mocked factory regression test verifies the fixed destination.

The handler previously discarded all upstream diagnostics. New Preview-only
signup error logging emits only a fixed event name, an explicitly allowlisted
error code (otherwise `unclassified`), and an integer HTTP status in 100–599
(otherwise null). It never logs messages, stacks, request bodies, cookies, emails,
names, keys, passwords, tokens or arbitrary upstream strings. The diagnostic sink
cannot change auth responses. Client-facing messages and production gating remain
unchanged. This closes an observability gap, not a confirmed signup root cause.

## Unknown / not verified

The actual Supabase error code and root cause remain unknown. No authenticated
Supabase log/settings/database access is available in this session, and deployed
HTTP requests/external database connections are unsupported by the sandbox.
Email provider enablement, signup enablement, confirmation, redirects, SMTP,
rate limits, Auth hooks and live triggers/constraints have NOT been verified.
There is no evidence to select SMTP restrictions over a database/hook failure.
The repository's draft foundation SQL declares no auth.users signup trigger;
repository SQL is not evidence of what is installed remotely. It was read only.
No signup requests, SQL, Supabase setting changes or Production mutations occurred.

## Exact owner handoff (read-only investigation first)

1. Open Supabase project `uhuukcztdifvpjuopdea` > Logs > Auth. Inspect `/signup`
   around **2026-10-16 05:49:30–05:49:38 UTC**. Share only the error code and HTTP
   status. If a database error is indicated, correlate Postgres logs at those
   timestamps and share only SQLSTATE and redacted object identifiers. Do not
   share raw logs, email addresses, passwords, headers or tokens.
2. In Authentication, inspect (do not blindly change): Sign In / Providers >
   Email; signup enablement; Confirm email; URL Configuration; Email / SMTP;
   Rate Limits; and Hooks. Inspect database trigger/constraint definitions on
   auth.users read-only if Auth logs indicate a database failure. Obtain explicit
   owner approval before any settings or database correction; do not execute
   PR #8 provisioning SQL.
3. Check the exact callback allowlist entry:
   `https://southerndotcom-website-git-vercel-ag-be2b7d-mohd-syaiful-nizam1.vercel.app/auth/callback`.
   The app passes this fixed branch callback; live allowlist contents are unknown.
4. If historical Auth logs cannot identify the cause, wait for this PR's new
   Preview deployment to become Ready. From the trusted branch alias, make ONE
   owner-controlled signup attempt with a dedicated inbox. Read the Vercel
   `/api/auth` runtime event `myops_signup_error`, recording only code/status and
   timestamp. Do not repeatedly retry. A successful attempt may produce no event.
5. Select a correction only from confirmed evidence:
   - `email_address_not_authorized`: default SMTP restricts recipients to Supabase
     organization members; owner approval is needed to configure custom SMTP for
     general recipients. Do not disable confirmation as a workaround.
   - `over_email_send_rate_limit` / HTTP 429: wait for the applicable limit window;
     inspect Supabase and SMTP limits before any owner-approved change.
   - `unexpected_failure`: inspect Auth then Postgres/SMTP logs; the code alone
     does not distinguish a trigger, constraint, permissions or mail failure.
   - Hook errors: inspect the configured hook and its logs before proposing a fix.
6. Verify user creation in Authentication > Users, actual confirmation email
   delivery, and same-browser callback to `/account`. HTTP 200 or mocked tests
   alone do not prove signup/email success. Profile provisioning remains separate.

## Local validation

27 tests pass, including safe diagnostics, unknown-code/status redaction,
logging-sink failure isolation, Production gating, SDK PKCE and fixed project
selection. ESLint and both Preview-auth and Production-safe local builds pass.
No Production deployment was made. Existing dependency audit: one moderate and
three high vulnerabilities; no unrelated dependency upgrades attempted.
No successful live signup is verified and this issue is NOT claimed fixed.

## References

- Supabase error codes: https://supabase.com/docs/guides/auth/debugging/error-codes
- SMTP restrictions: https://supabase.com/docs/guides/auth/auth-smtp
- Auth 500 investigation: https://supabase.com/docs/guides/troubleshooting/resolving-500-status-authentication-errors-7bU5U8
- Database signup errors: https://supabase.com/docs/guides/troubleshooting/database-error-saving-new-user-RU_EwB
