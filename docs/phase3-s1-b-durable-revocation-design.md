# Phase 3 S1-B — Durable Server-Side Revocation Design

Baseline: `2f5981e` · Branch `feature/myops-founders-100` · PR #13
Status: **DESIGN ONLY.** No application code changed, no SQL executed, nothing deployed. All SQL below is a proposal for owner approval and independent security review. Statements about behavior of the current code are CODE REVIEW; statements about the proposal are UNVERIFIED until built and tested locally and on staging.

## 1. Current implementation (signed-cookie retry)

- `__Host-myops-identity` (12 h) and `__Host-myops-revoke` (24 h) are HMAC-signed cookies ([auth.js](/workspaces/southerndotcom-website/server/auth.js) lines 11, 63-76). `settleRevocation` (line 195) revokes every verified id plus the pending id; a failure re-sets the marker (lines 199-200); retry runs at the start of every `/api/auth` request (lines 204-205); login/callback are blocked while pending.
- Revocation itself is the idempotent service-only RPC `myops_revoke_user_app_access`, which revokes unused tickets and **all** of the user's app sessions.
- Strengths: no browser-supplied id is trusted; fail-closed on logout; no repeated 500s.
- Gaps (all CODE REVIEW):
  1. **Browser-dependent.** If the browser closes, cookies are deleted, or the user never returns, nobody retries.
  2. **Single pending user** per browser (line 199 stores only `failed[0]`).
  3. **Inactivity is detected lazily.** MYOPS learns the user went idle only when that browser sends a request. A user who just closes the tab triggers no revocation at all; the app session ends only by its own idle limit, *and only if the app keeps calling MYOPS*, and an app's `activity:true` can extend it (verification finding M-2).
  4. **Over-broad.** Revoking "all of the user's app sessions" on any logout/expiry cannot distinguish two devices.
  5. If the database is down, the cookie cannot be turned into a durable record: the marker is the only record and it lives in the browser.

## 2. The fundamental constraint

Any server-side record of "revoke this" needs a writable server store. If that store (the Supabase database) is down at the moment of logout, nothing durable can be written there, so a *queue in the same database cannot by itself survive a database outage*. Two things are still true during an outage:

- App servers cannot verify entitlements either, so with the existing fail-closed contract they **deny** (503) — nobody gains access while the database is down.
- What matters is the state **after recovery**: a session that should have ended must not become valid again. That requires the validity decision to be derived from durable facts that do not depend on a write having succeeded at logout time.

This is the key design insight: **derive validity from time-bounded facts (login-session liveness) instead of relying on a revocation event being delivered.**

## 3. Approaches compared

| | A. Current signed cookie (baseline) | B. DB revocation queue (outbox + worker) | C. Login-session binding / generation (state-derived) | D. Separate durable store for the outbox (for example a second managed KV) |
|---|---|---|---|---|
| Survives browser closure / cookie deletion | No | Only if the original write succeeded | **Yes** (idle expiry is a database fact) | Yes |
| Survives DB outage at logout | Partly (browser must return) | **No** (queue is in the failed DB) | **Partly**: denial during outage; after recovery the session is bounded by ≤ 15 min idle (see §6) | Yes, if the second store is up |
| Inactivity enforced without a browser request | No | No (needs a trigger) | **Yes** | No (needs a trigger) |
| Complexity / new moving parts | Low | Medium (worker, retries, dead-letter) | Medium (one table, throttled touch) | High (new vendor, secrets, consistency between stores) |
| New attack surface | Cookie forgery (mitigated by HMAC) | Queue poisoning if enqueue is exposed | Session-id forgery (mitigated: server-generated, signed, DB-checked) | Another credential set |
| Idempotent / concurrent | Yes | Yes (needs dedupe) | **Yes** (state, not events) | Yes |
| Can revoke a single device | No | Yes | **Yes** | Yes |

## 4. Recommendation

**Adopt C as the primary mechanism, plus a small DB outbox (B-lite) and a sweeper, and keep the existing signed cookie as a best-effort fast path.**

1. **Login-session binding (C).** Every MYOPS login creates a server-owned row `myops_login_sessions`. Tickets and app sessions are bound to that row. App validation requires the login session to be *live* (not revoked, idle < 15 min, age < 12 h). Revocation of a login session instantly invalidates all of its app sessions with no per-session work, and expiry happens with no browser involved.
2. **Sweeper (B-lite).** A scheduled function marks expired login sessions and records audit rows, retries any `pending` revocation requests, and purges old data. It is an optimization/cleanup; **correctness does not depend on it**, because validation re-derives liveness each time.
3. **Keep the signed cookie** only as a retry hint when the write to the database failed (existing behavior), extended to carry the login-session id, so a returning browser can complete the write.
4. **Do not introduce D** unless the owner requires logout to be durable *during* a database outage; its cost and risk are disproportionate (see §10).

### Why this is the safest practical choice
- Removes the dependence on browser return for the inactivity case (the largest gap).
- State-derived: repeated, concurrent and replayed requests are naturally idempotent; there is no event to lose.
- Fail-closed everywhere: unverifiable ⇒ deny.
- Narrow change: reuses the existing app-session, ticket and entitlement paths.

## 5. Design

### 5.1 Data model (proposal)

```text
myops_login_sessions
  id               uuid primary key default gen_random_uuid()   -- server generated, never client chosen
  user_id          uuid not null references auth.users(id) on delete cascade
  created_at       timestamptz not null default now()
  last_activity_at timestamptz not null default now()           -- throttled, written by MYOPS only
  revoked_at       timestamptz
  ended_reason     text check (ended_reason in ('logout','password_reset','inactivity','absolute','admin','swept'))
myops_app_tickets.login_session_id   uuid references myops_login_sessions(id)  -- bound at issuance
myops_app_sessions.login_session_id  uuid references myops_login_sessions(id)  -- copied at redeem
myops_revocation_requests            -- outbox for work that could not be completed inline
  id bigint identity primary key
  user_id uuid not null references auth.users(id) on delete cascade
  login_session_id uuid          -- null = every login session of the user (password reset, admin)
  reason text not null
  created_at, attempts int default 0, last_attempt_at, completed_at
  unique (user_id, login_session_id, reason) where completed_at is null   -- dedupe
```

### 5.2 Functions (all `security definer`, `search_path = ''`, execute granted to `service_role` only)

- `myops_login_start(p_user_id)` → new row id. Also enforces a maximum number of live sessions per user (for example 10; oldest revoked).
- `myops_login_touch(p_id, p_user_id)` → sets `last_activity_at = now()` **only if** the row matches the user, is not revoked, and is within 15 min idle and 12 h absolute; throttled by `last_activity_at < now() - interval '30 seconds'` to limit write load. Returns boolean.
- `myops_login_end(p_id, p_user_id, p_reason)` → idempotent revoke of that login session and its unused tickets and app sessions.
- `myops_login_end_all(p_user_id, p_reason)` → idempotent revoke for password reset/admin.
- `myops_enqueue_revocation(...)` → upsert into the outbox (deduped).
- `myops_sweep_logins()` → (a) revoke login sessions that are idle > 15 min or older than 12 h, (b) revoke app sessions/tickets whose login session is not live, (c) process pending outbox rows with a retry cap, (d) delete old rows (retention as in the existing cleanup function). Safe to run concurrently (`for update skip locked`).
- Revised `myops_validate_app_session` and `myops_redeem_app_ticket`: join `myops_login_sessions` and require it live, in the same transaction as the existing app-session checks. The existing 15 min idle (app activity) and 12 h absolute (app session age) rules **stay**; the login-session rule is an additional, independent bound.

### 5.3 Request flow

1. **Login/callback:** after the existing email-confirmation checks, MYOPS calls `myops_login_start`, then stores the new id in the signed identity cookie together with the user id (HMAC over both). The id has no meaning without the database row.
2. **Activity:** the existing signed activity cookie logic is unchanged; additionally MYOPS calls `myops_login_touch` (throttled) on authenticated requests. If the touch fails because the database is unavailable, MYOPS still enforces the cookie-based 15 min limit for the browser; apps fail closed because they cannot verify.
3. **Launch:** ticket issuance copies the caller's verified `login_session_id`; redeem copies it into the app session.
4. **Logout / password reset / detected inactivity:** call `myops_login_end` (or `_end_all`). On failure, write the signed pending marker (existing) now carrying `login_session_id`, and attempt `myops_enqueue_revocation` best-effort.
5. **App check:** `myops_validate_app_session` returns inactive if the bound login session is revoked or not live ⇒ app denies.

## 6. How revocation survives each failure

| Failure | Behavior |
|---|---|
| Browser closed / cookies deleted | `last_activity_at` stops advancing; after 15 min the login session is not live, so every app check is denied. The sweeper marks it ended and audits it. No browser request needed. |
| DB outage at logout | Logout reports failure (never success). Apps cannot verify so they deny (503). Signed marker retries when the browser returns. If the browser never returns: after recovery the login session is not live once its idle window passes, so the worst case is **≤ 15 minutes** of residual validity after recovery from the last recorded activity — the existing inactivity limit, not an additional one. |
| DB outage at inactivity | Same: liveness is derived from stored timestamps, not from a delivered event. |
| Repeated logout / repeated requests | `myops_login_end` and the outbox dedupe are idempotent; a revoked row stays revoked; no extra effect, no repeated 500s (errors are queued, not rethrown for passive requests). |
| Concurrent requests (logout racing redeem) | Redeem locks the ticket and checks login-session liveness inside the same transaction; `login_end` takes the same row lock. Either redeem wins and the session is revoked by `login_end` afterward, or redeem sees the revoked login session and denies. Existing per-user advisory lock is retained for the user-wide variants. |
| Worker failure | Outbox rows are retried with a capped `attempts`; after the cap they stay uncompleted and are reported by a monitoring query. Correctness still holds through validation-time derivation. |
| Multiple pending users | Outbox is per user/login session; the cookie fast path is optional. No single-slot limitation. |

## 7. Identity security

- Revocation can be triggered only from: a Supabase token verified by `getUser`, a server-signed identity cookie (HMAC, secret ≥ 32 bytes, 12 h cap), or the sweeper/admin using the service role. Browser-supplied user or session ids are never used alone; every function re-checks that `login_session_id` belongs to `user_id`.
- The login-session id is server-generated random, unguessable, and only meaningful with the matching user and signature. Compromise of an id cannot extend access (the id can only be ended, or checked live).
- A forged cookie can at worst cause a harmless revoke of a session whose id it knows *and* whose signature it forged — infeasible without the secret. The cookie cannot create or extend sessions.
- Denial-of-service by revoking others' sessions requires valid ids + signature; rate limits on `/api/auth` remain.
- Outbox and login tables: RLS enabled, no client policies, `revoke all … from public, anon, authenticated`, grants only to `service_role`.
- No raw tokens, emails or user ids in logs; audit rows keep only the opaque ids and a reason code.

## 8. Retry worker strategy

- Primary: **Vercel Cron** (or Supabase `pg_cron`; owner to choose) calling an authenticated server route every 1-5 minutes that runs `myops_sweep_logins()` with the service-role key (server-only). The route must be Preview/staging gated, require a dedicated `MYOPS_CRON_SECRET` header compare in constant time, return no data, and rate limit itself.
- Batching: process at most N rows per run, `for update skip locked`, so overlapping runs are safe.
- Retry: exponential back-off per row via `last_attempt_at`; cap attempts (for example 20); uncompleted rows alert through a monitoring query, not a user-visible error.
- No inbound webhooks from apps; apps pull (entitlement endpoint) so no new inbound trust path.
- Dependencies: scheduler choice and cost, secret provisioning, monitoring owner. All **UNVERIFIED** for this project.

## 9. App-side enforcement

No app contract change beyond S1-B: the app calls `/api/app/entitlement` with its session id. MYOPS now also returns `session_active:false` when the bound login session is not live, so the app must end its session and not retry. Requirements unchanged: validate on every protected route (or at most the approved short cache for normal browsing), fresh check before sensitive actions, `activity:true` only for user-initiated requests, deny on any non-200 (fail closed). **Residual:** an app that caches positively for up to 5 minutes may serve that long after MYOPS revocation; the app repositories are not yet integrated (S1-C).

## 10. Option D trade-off (why not recommended)
A second store (for example a hosted key-value service) would let logout succeed during a database outage, but it adds a new vendor, credentials and a consistency problem (the two stores can disagree). Because apps already fail closed during the outage and the post-recovery exposure is bounded by the 15-minute idle limit, the benefit is small. Revisit only if the owner requires zero post-outage exposure.

## 11. Proposed SQL (UNAPPLIED; file name proposal `supabase/proposals/202610170002_myops_login_sessions.sql`)

```sql
begin;
create table if not exists public.myops_login_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  revoked_at timestamptz,
  ended_reason text check (ended_reason in ('logout','password_reset','inactivity','absolute','admin','swept'))
);
create index if not exists myops_login_sessions_user_idx
  on public.myops_login_sessions(user_id) where revoked_at is null;

create table if not exists public.myops_revocation_requests (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  login_session_id uuid references public.myops_login_sessions(id) on delete cascade,
  reason text not null check (reason in ('logout','password_reset','inactivity','admin')),
  created_at timestamptz not null default now(),
  attempts integer not null default 0,
  last_attempt_at timestamptz,
  completed_at timestamptz
);
create unique index if not exists myops_revocation_requests_open_idx
  on public.myops_revocation_requests (user_id, coalesce(login_session_id, '00000000-0000-0000-0000-000000000000'::uuid), reason)
  where completed_at is null;

alter table public.myops_app_tickets  add column if not exists login_session_id uuid references public.myops_login_sessions(id);
alter table public.myops_app_sessions add column if not exists login_session_id uuid references public.myops_login_sessions(id);

alter table public.myops_login_sessions enable row level security;
alter table public.myops_revocation_requests enable row level security;
revoke all on public.myops_login_sessions, public.myops_revocation_requests from public, anon, authenticated;

create or replace function public.myops_login_live(p_id uuid, p_user_id uuid)
returns boolean language sql security definer set search_path = '' stable as $$
  select exists (select 1 from public.myops_login_sessions
    where id = p_id and user_id = p_user_id and revoked_at is null
      and last_activity_at > now() - interval '15 minutes'
      and created_at > now() - interval '12 hours');
$$;

create or replace function public.myops_login_start(p_user_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  update public.myops_login_sessions set revoked_at = now(), ended_reason = 'swept'
    where id in (select id from public.myops_login_sessions
      where user_id = p_user_id and revoked_at is null order by created_at desc offset 9);
  insert into public.myops_login_sessions (user_id) values (p_user_id) returning id into v_id;
  return v_id;
end $$;

create or replace function public.myops_login_touch(p_id uuid, p_user_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not public.myops_login_live(p_id, p_user_id) then return false; end if;
  update public.myops_login_sessions set last_activity_at = now()
    where id = p_id and user_id = p_user_id and last_activity_at < now() - interval '30 seconds';
  return true;
end $$;

create or replace function public.myops_login_end(p_id uuid, p_user_id uuid, p_reason text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_reason text := case when p_reason in ('logout','password_reset','inactivity','absolute','admin') then p_reason else 'admin' end;
begin
  update public.myops_login_sessions set revoked_at = coalesce(revoked_at, now()), ended_reason = coalesce(ended_reason, v_reason)
    where id = p_id and user_id = p_user_id;
  update public.myops_app_tickets set revoked_at = now()
    where login_session_id = p_id and user_id = p_user_id and used_at is null and revoked_at is null;
  update public.myops_app_sessions set revoked_at = now(), ended_reason = 'myops_logout'
    where login_session_id = p_id and user_id = p_user_id and revoked_at is null;
  update public.myops_revocation_requests set completed_at = now()
    where user_id = p_user_id and login_session_id = p_id and completed_at is null;
  return true;
end $$;

create or replace function public.myops_login_end_all(p_user_id uuid, p_reason text)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));
  update public.myops_login_sessions set revoked_at = now(),
      ended_reason = case when p_reason in ('logout','password_reset','inactivity','absolute','admin') then p_reason else 'admin' end
    where user_id = p_user_id and revoked_at is null;
  get diagnostics v_count = row_count;
  perform public.myops_revoke_user_app_access(p_user_id, p_reason);
  update public.myops_revocation_requests set completed_at = now()
    where user_id = p_user_id and completed_at is null;
  return v_count;
end $$;

create or replace function public.myops_enqueue_revocation(p_user_id uuid, p_login_session_id uuid, p_reason text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  insert into public.myops_revocation_requests (user_id, login_session_id, reason)
    values (p_user_id, p_login_session_id, case when p_reason in ('logout','password_reset','inactivity','admin') then p_reason else 'admin' end)
    on conflict do nothing;
  return true;
end $$;

create or replace function public.myops_sweep_logins(p_batch integer default 200)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_expired integer; v_apps integer; v_retried integer := 0; r record;
begin
  with doomed as (
    select id, user_id from public.myops_login_sessions
    where revoked_at is null and (last_activity_at <= now() - interval '15 minutes' or created_at <= now() - interval '12 hours')
    order by last_activity_at limit greatest(1, least(p_batch, 1000)) for update skip locked)
  update public.myops_login_sessions s set revoked_at = now(), ended_reason = 'inactivity'
    from doomed where s.id = doomed.id;
  get diagnostics v_expired = row_count;
  update public.myops_app_sessions a set revoked_at = now(), ended_reason = 'myops_logout'
    where a.revoked_at is null and a.login_session_id is not null
      and exists (select 1 from public.myops_login_sessions s where s.id = a.login_session_id and s.revoked_at is not null);
  get diagnostics v_apps = row_count;
  for r in select * from public.myops_revocation_requests
      where completed_at is null and attempts < 20
        and (last_attempt_at is null or last_attempt_at < now() - (interval '1 minute' * power(2, least(attempts, 6))))
      order by created_at limit p_batch for update skip locked loop
    if r.login_session_id is null then perform public.myops_login_end_all(r.user_id, r.reason);
    else perform public.myops_login_end(r.login_session_id, r.user_id, r.reason); end if;
    update public.myops_revocation_requests set attempts = attempts + 1, last_attempt_at = now(), completed_at = now() where id = r.id;
    v_retried := v_retried + 1;
  end loop;
  return jsonb_build_object('expired_logins', v_expired, 'revoked_app_sessions', v_apps, 'retried', v_retried);
end $$;

revoke all on function public.myops_login_live(uuid,uuid), public.myops_login_start(uuid), public.myops_login_touch(uuid,uuid),
  public.myops_login_end(uuid,uuid,text), public.myops_login_end_all(uuid,text),
  public.myops_enqueue_revocation(uuid,uuid,text), public.myops_sweep_logins(integer) from public, anon, authenticated;
grant execute on function public.myops_login_live(uuid,uuid), public.myops_login_start(uuid), public.myops_login_touch(uuid,uuid),
  public.myops_login_end(uuid,uuid,text), public.myops_login_end_all(uuid,text),
  public.myops_enqueue_revocation(uuid,uuid,text), public.myops_sweep_logins(integer) to service_role;
commit;
-- Also required (not shown): replace myops_issue_app_ticket / myops_redeem_app_ticket /
-- myops_validate_app_session so they require public.myops_login_live(login_session_id, user_id).
```

Notes: this sketch has **not been run, linted or tested** — it must go through local PostgreSQL tests and independent review first (UNVERIFIED). Known review items: the `myops_login_end_all` call to the existing revoke function should be tested for lock ordering; the retry loop marks rows complete after one attempt (an in-transaction failure rolls the whole sweep back, which is intended to be reconsidered with per-row exception handling).

## 12. Rollback

- Disable the sweeper route/cron first, then set `MYOPS_ENVIRONMENT` unset (app endpoints return 503).
- Revert application code to `2f5981e` behavior (signed-cookie retry).
- Down script (proposal, to be written and tested with the migration): restore the previous `myops_validate_app_session` / ticket / redeem function bodies, drop the new functions, `drop column login_session_id` from tickets and app sessions, then drop `myops_revocation_requests` and `myops_login_sessions`. Staging only, backup first. Because validation is additive, rolling back reverts to the existing idle/absolute limits, not to open access.
- Rollout order: migrate with code disabled → deploy code writing login sessions but not yet requiring liveness → verify → turn on liveness enforcement (feature flag) → enable cron.

## 13. Testing plan (to implement after approval)
Local PostgreSQL: login start/touch throttle/end/end_all idempotency; ownership mismatch rejected; 15 min idle and 12 h absolute; concurrent redeem vs logout; sweep with skip-locked concurrency; outbox dedupe/retry cap; grants and RLS; down script. Handler tests: failed `login_end` queues and returns error; passive requests do not 500; forged/other-user ids ignored; multiple pending users; DB outage then recovery; no browser return ⇒ denied after idle. No staging claims until run.

## 14. Remaining risks
1. During a DB outage at logout, validity after recovery is bounded only by the 15-minute idle window (not instant). Accepting this is an owner decision (alternative: option D).
2. Throttled touch (30 s) adds a ≤ 30 s granularity.
3. Extra write per authenticated request (throttled) and a new cron dependency.
4. Apps with positive caches can extend exposure up to the approved 5 minutes; apps not integrated (S1-C).
5. `activity:true` abuse (finding M-2) is bounded by the login-session liveness: a user who goes idle at MYOPS loses app access after 15 min of MYOPS silence **only if** MYOPS activity is the clock. Decision needed: should app activity also count as MYOPS activity? Counting it keeps users working inside an app from being logged out; not counting it forces periodic return to MYOPS.
6. Supabase project isolation still unconfirmed.

## 15. Decisions requiring owner approval
1. Approve approach C + sweeper + signed-cookie hint (recommended), or option D.
2. Does app activity extend MYOPS login-session liveness (§14.5)? Recommended: **no** extension from apps; apps keep their own 15 min idle and users re-launch through MYOPS (simpler and safer), unless the business requires otherwise.
3. Scheduler: Vercel Cron vs Supabase `pg_cron`, and who monitors failures.
4. Max concurrent login sessions per user (proposed 10) and touch throttle (30 s).
5. Accept the ≤ 15 min post-outage window.
6. Approval to write the migration and tests locally (no execution on Supabase without a separate approval).
