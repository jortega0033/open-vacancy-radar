# ADR: Optional application reconciliation adapters

## Status

Accepted as a design boundary for issues #282 and #283. No adapter implementation is included.

## Context

The application workflow now records durable attempts and keeps delivery evidence separate from
hiring outcome. PR #302 (issues #271 and #275) adds receipt observation, protects
`submission_unknown` from blind retry, preserves `user_reported` separately, and deduplicates by
employer plus requisition with canonical URL and vacancy-key fallbacks.

Issue #282 asks whether an authorized mailbox can reconcile an unknown outcome. Issue #283 asks
whether an external sheet can mirror durable outcomes. Both are optional integrations and both must
remain downstream of the local attempt record. A mailbox or sheet must never become the executor's
source of truth.

## Decision

Define one provider-neutral reconciliation boundary around an existing application attempt:

```text
local attempt -> reconciliation candidate -> identity match -> durable evidence/outcome update
                                      \-> no match or unavailable provider -> remain unknown/pending
```

The first implementation, if funded, should be a pure matching and replay design exercised against
controlled fixtures. It must not start with a live connector.

### Mailbox evidence (#282)

- Match on the candidate recipient, employer or ATS tenant, requisition or role, and a bounded time
  window. Requisition identity has priority over URL or company-only matches.
- Import only the minimum metadata and bounded evidence reference needed to explain the match. Keep
  message bodies and candidate data local and out of logs, issues, and model prompts by default.
- Treat duplicate messages, pagination, delayed delivery, forwarded messages, old messages, another
  role at the same company, revoked authorization, and unavailable connectors as ordinary states.
- A matching acknowledgement or rejection may establish delivery evidence, but rejection is a
  separate hiring outcome. No matching email leaves the attempt `submission_unknown`; it never proves
  failure and never triggers an automatic retry.
- Gmail access must be separately authorized by OVR. Metadata-only access cannot use Gmail `q`
  search, and send or delete permission is not needed for reconciliation.

### Sheet synchronization (#283)

- Store the OVR attempt or lead ID, spreadsheet and tab identifiers, a stable row locator, and the
  expected vacancy identity. Do not use a mutable row number as the sole identity.
- Commit the local outcome before attempting the remote write. A failed write becomes pending sync,
  not a failed application and not a requeue.
- Before each mutation, re-read the target and verify the expected vacancy identity. Retry with an
  idempotency key so a partial or repeated sync cannot create a second outcome.
- Change only authorized columns. Preserve unrelated formulas and formatting.
- Report mutually exclusive primary statuses such as submitted, user-reported, pending, unknown,
  and skipped. Report evidence type, unique vacancy count, unique-company count, and attempt count
  separately; never add overlapping categories into a success total.

## Consequences

This keeps local durability, duplicate protection, and application execution independent of Gmail or
Sheets. It also makes offline use honest: the user can continue from the local record while an
external sync remains pending.

The cost is an adapter contract, durable sync/evidence records, and fixture coverage before any
provider integration. Provider-specific authentication, pagination, matching, retries, and API
limits remain adapter concerns. This design intentionally does not choose a Google connector or
change the current schema.

## Implementation gate

Do not start implementation from these tickets alone. Reopen a scoped implementation issue only when
there is a chosen provider, an authorization UX, a retention policy, and fixtures proving:

- ambiguous, stale, forwarded, duplicate, delayed, and missing mailbox evidence;
- row movement, edited identity, offline writes, retries, and partial sheet failures; and
- reconciliation of every primary status without changing executor or duplicate-protection rules.

The future adapter may consume the contracts from #302 and the review/read-back work in #303/#304,
but it must not modify those PRs' browser execution or form-verification paths.
