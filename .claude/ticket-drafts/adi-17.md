## Objective
Add byte-bounded backpressure to the v1 SSE/replay path, closing an unbounded-memory-growth gap in currently-shipped code.

## Why this matters
Verified directly: this repo's `MAX_STORED_EVENTS_PER_SESSION = 5,000` caps event *count* per session but has no byte cap; `apps/daemon/src/routes/sessions.ts` calls `reply.raw.write(...)` unconditionally, ignoring the backpressure return value Node's stream API provides; there is no dedicated bounded SSE writer module; and `packages/client/src/client.ts` has no per-frame byte ceiling on the client side either. A single session emitting unusually large provider JSONL lines (a large tool result, a verbose assistant response), or one slow SSE subscriber that never drains, can grow daemon memory without a hard limit.

Upstream added real bounds for this (commit `24d3c69`, PR #71): a 16 MiB per-session replay byte cap, a 1 MiB per-envelope ceiling (an oversized envelope synthesizes a `session.failed` event and reaps the session rather than growing unbounded), a generic `BoundedSseWriter` abstraction, a dedicated SSE writer module respecting connection-level bounds (256 frames / 4 MiB), and a matching 1 MiB frame cap enforced client-side too.

## Scope
- Port the per-envelope byte ceiling and the "oversized envelope synthesizes `session.failed` and reaps" behavior into the session-run path.
- Add a per-session replay byte cap alongside the existing count cap in the durable/in-memory session stores.
- Extract or port a bounded SSE writer respecting connection-level frame-count and byte bounds in `routes/sessions.ts`'s SSE handler, actually checking the backpressure return of `reply.raw.write` rather than ignoring it.
- Add a matching per-frame byte cap in `packages/client/src/client.ts`'s SSE consumption path.

## Non-goals
Do not change the existing 5,000-event count cap's semantics -- this ticket adds a byte dimension alongside it, it doesn't replace the count-based mechanism.

## Dependencies
Interacts with ADI-05's durable-store truncation design: that ticket's `eventCount`-past-truncation checkpointing logic assumes a line-count cap only. Adding a byte cap needs that reconciliation logic revisited in the same change, not bolted on separately.

## Acceptance criteria
- [ ] An oversized single event (above the per-envelope ceiling) does not grow daemon memory unbounded; the session terminates cleanly with a synthesized failure rather than crashing or hanging.
- [ ] A session's total replay buffer is bounded in bytes, not just event count.
- [ ] A slow or non-draining SSE subscriber cannot cause unbounded server-side buffering -- the writer respects backpressure.
- [ ] The durable store's truncation/checkpoint logic correctly accounts for both the count and byte caps without double-counting or under-counting.

## Tests
A test feeding an oversized single event through the session-run path and confirming the synthesized failure + clean reap, not a crash. A test simulating a non-draining SSE consumer and confirming the writer stops accepting new writes past its bound rather than buffering indefinitely. A durable-store test confirming the byte cap and count cap interact correctly (extending ADI-05's existing truncation tests).

## Rollback
Remove the new caps; behavior reverts to count-only bounding. No persisted-schema change is expected, but confirm before shipping.

## Stop conditions
Stop if the new bounds cause a legitimate, normally-sized session to be truncated or fail -- the caps must be generous enough for real usage (check this product's actual typical event sizes, e.g. a full CV-parse or gap-analysis response, before finalizing the byte constants) while still bounding the pathological case.

## Ownership and routing
Backend Architect. Balanced specialist model at high reasoning.
