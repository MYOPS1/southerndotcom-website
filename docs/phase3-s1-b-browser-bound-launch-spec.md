# Phase 3 S1-B — Browser-bound app launch security specification (H-1)

Status: Documentation only. Not active in staging or production. No app repository changes, no SQL execution, and no launch activation are part of this task.

## Purpose

This specification defines the fail-closed browser-bound launch flow for MYOPS-to-app handoff. The goal is to prevent a ticket from being exposed to logs, referrers, or server-side request paths while still allowing a verified product launch after a user is already authenticated to MYOPS.

The protocol is intentionally browser-bound and app-initiated. MYOPS does not trust any browser value as a privilege source. It only issues a short-lived ticket and a server-side entitlement check later validates the app and the live session.

## Security constraints

1. The launch ticket is not sent as a server-visible query parameter.
2. The ticket stays in the browser URL fragment only long enough for the destination app page to read it.
3. The app page immediately strips the fragment and replaces the history entry before the app sends anything to its own server.
4. The app server must never log, index, or report the ticket or its hash.
5. The app server must set `Referrer-Policy: no-referrer` and `Cache-Control: no-store` on the launch page response.
6. The app must read the fragment from `location.hash`, not from the page URL search string.
7. The app must reject stale, replayed, mismatched or expired tickets with a generic fail-closed denial.
8. The app server must verify the originating product slug and bound client before accepting the handoff.
9. If the app launch or entitlement verification fails, the app must deny access without revealing the user identity or entitlement reason.

## Approved flow

```text
MYOPS session is valid
    -> user requests app launch
    -> MYOPS issues a single-use ticket with a 60s expiry
    -> MYOPS redirects to registered app host /launch#t=<ticket>
    -> browser lands on the app launch page
    -> app page reads hash from location.hash
    -> app page history.replaceState() removes the ticket from the URL
    -> app page POSTs the ticket to its own secure server endpoint
    -> app server verifies the app identity, timestamp, nonce and ticket
    -> app server asks MYOPS for fresh entitlement validation
    -> app server creates its own internal session only after success
```

## Mandatory browser behavior

The app launch page is a transient browser-only handoff page. It must do all of the following:

- read the ticket from `location.hash` only;
- treat any value without a valid `t` key as a failed launch;
- call `history.replaceState({}, '', location.pathname + location.search)` immediately after reading the hash;
- avoid persisting the fragment in analytics, tracking pixels or logs;
- use a POST to the app's own backend endpoint rather than a client-side redirect carrying a query string;
- clear the browser state before any other page logic runs.

This prevents the ticket from appearing in browser history, server logs, or `Referer` headers even if the app host is open to the internet.

## MYOPS server-side rules

MYOPS must treat the browser value as a token to hand to the app, not as a trusted authorization input. The server-side duties are:

- create a short-lived ticket bound to the app product and user;
- enforce single-use and expiry semantics;
- reject disabled clients or mismatched product slugs;
- log only a nonce or bucketed event reference, never the ticket itself;
- deny any redemption that occurs after the ticket has expired or has already been used.

## App-side rules

The app side must implement the following policy:

- the target app URL must be HTTPS only;
- the target route must not include userinfo, query-string data, or a fragment;
- the launch page must not display the ticket in the DOM or markup;
- a failed launch must not show a success state;
- all requests must include a server-side verification step before user session creation;
- app session creation must be fail-closed if MYOPS is unavailable or denies the entitlement.

## Non-goals / do not activate yet

- This document is not an implementation plan for staging activation.
- This does not authorize any live product launch or remote SQL execution.
- This does not integrate OpsFinance, OpsFlow or OpsPS app repositories.
- This does not waive the requirement to keep the app launch ticket out of logs, analytics, and server-visible URL parameters.

## Acceptance criteria

The implementation is acceptable only when all of the following are true:

- Launch tickets are fragment-based and never delivered in the URL query string.
- The app removes the fragment before the first app-side request is issued.
- The app uses a backend POST exchange and does not directly trust the browser.
- A missing or stale ticket is denied without creating an app session.
- A revoked or expired entitlement is denied, and the app server clears its own local session.
- No ticket, hash, or sensitive user data is logged or sent in `Referer` headers.

## Risk statement

This protocol is intentionally conservative. The app launch is a handoff boundary, not a trust anchor. Until the app repositories are audited and integrated under the same fail-closed rules, the browser-bound launch remains a documented security control, not an activated deployment pathway.
