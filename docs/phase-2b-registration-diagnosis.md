# Registration diagnosis — 2026-10-16

The owner-controlled request at 09:22:28.414 UTC reached the diagnostic Preview
(commit `13267c5`). At 09:22:30.296 UTC, `myops_signup_error` recorded
`email_address_invalid`, numeric upstream HTTP status **400**. The matching
request returned application HTTP **502**. No live signup was performed by the agent.

Supabase documents this code as unsupported example/test email domains:
https://supabase.com/docs/guides/auth/debugging/error-codes
The submitted address was not inspected or logged. Its exact invalidity is not
independently established. This event is not evidence of SMTP delivery, redirect,
rate-limit, disabled-signup, hook or database failure.

The confirmed application defect was the fallback mapping of an email-validation
error to a retryable gateway error. It now returns HTTP 400 with a fixed,
actionable message; no upstream message or private data is exposed. Other error
mapping, Preview gates and privacy-safe diagnostics remain unchanged.

## Log verification

Both runtime and request queries covered 06:07–09:25 UTC, from deployment creation
through the reported attempt. Runtime was scoped only to the diagnostic deployment,
without severity, message or route filters. Requests were project-wide, filtered
only to `/api/auth`, so an old deployment could have been detected. Each returned
one matching record, no next page and no excluded intervals. The runtime entry is
warning-level: an error-only filter would hide it. Use UTC and include 09:22 UTC
when inspecting the dashboard.

## Owner action and limitations

No Supabase Auth setting or database change is indicated by this error. Use a
valid real inbox rather than an example/test address on the updated branch Preview;
do not repeatedly retry. Successful signup/email confirmation is not yet verified.
Authenticated Supabase access is unavailable in this session, so its Auth log
filters/time range, Postgres logs and hooks could not be inspected directly. For
independent confirmation, select project `uhuukcztdifvpjuopdea`, Auth logs, clear
filters, and include 09:20–09:25 UTC on 2026-10-16; inspect `/signup` and correlate
Postgres/hook logs only if an additional error points there. Share sanitized codes,
statuses and SQLSTATE only.

No SQL, Supabase settings, Production or merge changes were made.
