## Objective
Rotate the workspace audit log to an immutable archive segment when it fills, instead of permanently denying every future trust grant once it hits its size cap.

## Why this matters
This repo's `audit-store.ts` (ADI-06) deliberately throws `AuditCapacityError` at its 64 MB cap forever, on the reasoning that "an audit log that silently forgets is not an audit log" -- a defensible design at the time, but its consequence is a real availability cliff: once the cap is hit, the daemon can never grant a new workspace trust decision again, because ADI-06's own audit-before-effect discipline makes every trust grant depend on a successful audit write.

Upstream solved this without abandoning the "never silently forget" principle (commit `f237302`, PR #91): the audit log rotates to an immutable, timestamped archive segment (a fresh live file starts at sequence 0) instead of failing permanently, with a 90-day archive expiry. Nothing is lost -- old entries move to a sealed, still-inspectable file -- but new grants can keep happening.

## Scope
- Extend `apps/daemon/src/audit-store.ts` (or add a sibling module) to rotate the live log to a timestamped, sealed archive file when it reaches its cap, resetting the live file's sequence counter, rather than throwing `AuditCapacityError` and staying unhealthy forever.
- Add archive expiry (matching upstream's 90-day default, or a value this repo's own retention conventions suggest) for the sealed segments -- they should eventually be cleaned up, not accumulate forever, mirroring the durable session store's own retention discipline from ADI-05.
- Confirm the contiguous-sequence validation this repo's audit store already does on load correctly handles "sequence resets at 0 in a new segment" rather than misreading it as a gap/corruption.

## Non-goals
Do not change the audit entry schema or what's recorded in it -- this ticket is purely about the rotation/retention mechanism, not the content.

## Dependencies
None -- extends the already-shipped ADI-06 audit store.

## Acceptance criteria
- [ ] The audit log rotates to a sealed archive segment on reaching its size cap instead of permanently denying further writes.
- [ ] No audit entry is ever lost across a rotation -- every entry that existed before rotation is still readable from the archive segment afterward.
- [ ] New trust grants continue to succeed after a rotation, where they would previously have failed forever.
- [ ] Archive segments expire (are cleaned up) after their retention window, without ever removing the currently-live segment.
- [ ] The existing contiguous-sequence-on-load validation still correctly distinguishes "this is a fresh segment starting at 0" from "this is a corrupt/truncated log."

## Tests
Fill the audit log to its cap and confirm a rotation occurs rather than a permanent failure; confirm a subsequent trust grant succeeds; confirm every pre-rotation entry is still readable from the sealed archive; confirm archive expiry removes only segments past their retention window and never the live one; confirm the sequence-validation-on-load logic handles a multi-segment history correctly (extending ADI-06's existing corruption/quarantine test suite).

## Rollback
Disable rotation; audit store reverts to the existing terminal-failure-at-cap behavior. Existing sealed archive segments (if any were created) are left in place, never deleted by a rollback.

## Stop conditions
Stop if rotation can ever lose an entry, or if a rotation's timing could create a window where a trust decision's audit entry ends up split awkwardly across the rotation boundary in a way that makes it ambiguous which segment truly recorded it first.

## Ownership and routing
Backend Architect with Security review. Strongest reasoning model at high reasoning, given this touches ADI-06's audit-before-effect security discipline directly.
