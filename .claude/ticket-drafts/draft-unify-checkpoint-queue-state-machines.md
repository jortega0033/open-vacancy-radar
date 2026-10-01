## Status: implemented (2026-09-15/16)

Everything below this line is the original ticket as drafted, describing this as a deliberately-deferred, design-only item. That framing is now stale: the product owner explicitly decided to attempt this in the same session, right after the ticket was drafted ("Attempt it now" over "keep deferred," when asked directly). It was implemented, shipped as part of PR #387 (`audit-implementation-2026-09-15` branch), and merged into the same batch as the P0 preparation-fence fix it was sequenced after.

**What actually shipped:** direction (b) from the Scope section below, not (a). A new module, `apps/desktop/electron/application-attempt-transitions.ts`, holds two small, orthogonal, exhaustively-typed fact tables (`APPLICATION_ATTEMPT_CHECKPOINT_ROLES`, one row per checkpoint; `APPLICATION_QUEUE_STATE_ROLES`, one row per queue state including the `absent` case) plus the combining functions (`resolveAttemptTransition`, `resolveAttemptRecovery`, `resolveQueueDirective`) that replace `SETTLED_CHECKPOINTS`, `IN_FLIGHT_CHECKPOINTS`, `UNSCHEDULED_QUEUE_STATES`, and the hand-written body of `queueStillWantsThis` that used to live in `application-pipeline.ts`. The daemon's own queue store (`apps/daemon/src/application-queue-store.ts`) was deliberately NOT touched -- it still owns its own six-state machine independently, with no direct `workspace.db` dependency, exactly preserving the content-free boundary the daemon's own header comment documents as deliberate. Only the *relationship* between the two moved, into one reviewable, exhaustively-typed place.

The module's own header comment explains why (a) was rejected: giving the daemon direct `workspace.db` access, or reducing it to a bare lease pointer read against that database, would have bought one state machine at the cost of the process-isolation the split exists for -- confirmed sound by the architecture audit's own KEEP verdict on the daemon boundary.

Regression coverage: `apps/desktop/test/application-attempt-transitions.test.ts` (23 tests) pins the completeness/consistency properties the module's own doc comments claim -- every checkpoint has exactly one role, `interruptedWhenAtRest`/`awaitsScheduling` both imply `preparationMayRun` and are mutually exclusive, the three facts partition every checkpoint into exactly one bucket, `user_reported` is correctly settled (the exact gap the old four-array approach missed and never caught), and `INTERRUPTED_ATTEMPT_RESTART`'s claimed invariant -- every interrupted checkpoint restarts identically regardless of queue state -- holds across all seven queue-state pairings. This test file did not exist when the migration work was originally interrupted mid-session; it was written afterward specifically because the module's own doc comments referenced a test file that didn't yet exist, which would itself have been misleading.

Independently adversarially re-reviewed (a second, fresh pass, separate from the implementer) against the exact four questions this ticket's Risk section worried about: whether stale/duplicate copies of the old logic still exist anywhere, whether every call site of the four old constant arrays was migrated, whether it interacts safely with the F-A fencing work, and whether any previously-reachable checkpoint x queue-state combination became unreachable or misrouted. No blocking findings.

---

*Original ticket text follows, preserved for the design discussion it documents:*

## Goal
Give the two independently-owned state machines that together describe one application attempt a single source of truth (or, short of that, a single explicit transition table) instead of the current hand-written reconciliation, so a stuck lease and a stale checkpoint can no longer silently disagree.

## Why now
From the audit's DX and state/footprint reviews. `ApplicationAttemptCheckpoint` (`apps/desktop/electron/workspace/types.ts:243-262`) has 12 states -- `queued`, `reading_jd`, `tailoring`, `rendering`, `filling`, `ready`, `submitting`, `submitted`, `needs_user`, `skipped`, `failed`, `submission_unknown`, plus `user_reported` -- and lives in `workspace.db`, owned by the Electron main process. `ApplicationQueueEntryState` (`apps/daemon/src/application-queue-store.ts:43`) has 6 states -- `queued`, `active`, `paused`, `cancelled`, `done`, `failed` -- and lives in the daemon's separate file-based `ApplicationQueueStore`. Nothing owns both. The two are reconciled only by hand-written functions and constant arrays in `application-pipeline.ts`: `queueStillWantsThis` (`apps/desktop/electron/application-pipeline.ts:339`), `SETTLED_CHECKPOINTS` (`:308`), `IN_FLIGHT_CHECKPOINTS` (`:320`), and `UNSCHEDULED_QUEUE_STATES` (`:794`) -- four separately-named arrays that each encode a partial view of the same underlying pairing, and that pairing is never written down anywhere else in the repo. This desync is the root cause underlying the F-A lease-deadlock bug family (a stuck lease and a stale checkpoint can silently disagree about whether an attempt is still in flight) and the DX audit separately flagged it as the single most confusing part of the codebase for a new engineer to reconstruct by reading code alone.

## Scope
- Design (not yet implement) one of two directions:
  - (a) Make the daemon's queue store hold nothing but a lease pointer (attempt id + lease id + expiry) and read/write everything else -- including the actual attempt state -- directly against `workspace.db`'s checkpoint through the existing client SDK, eliminating `ApplicationQueueEntryState` as a second source of truth.
  - (b) If the daemon must stay database-agnostic (no direct `workspace.db` dependency), publish one explicit, exported `checkpoint x queue-state -> allowed-next-state` map that replaces `SETTLED_CHECKPOINTS`, `IN_FLIGHT_CHECKPOINTS`, `UNSCHEDULED_QUEUE_STATES`, and the logic inside `queueStillWantsThis` with a single reviewable table.
- Produce a written comparison of (a) vs (b) -- ownership, migration cost, blast radius on the Electron/daemon boundary -- as the actual deliverable of a first follow-up session, before any code changes.
- Sequence this after F-A (`draft-fence-abandoned-pipeline-tick-lease.md`) has shipped and proven out in production, per the audit's own stated ordering.

## Non-goals
- No implementation in this pass, or in the immediate next one -- this ticket exists to preserve the design options above, not to schedule the migration itself.
- Not a prerequisite for F-A: F-A's lease-fencing fix stands on its own and should land first, independent of this ticket.
- No new states added to either machine as a side effect of this ticket; scope is unification of ownership, not redesign of the state vocabulary.
- No change to `application-pipeline.ts`'s current reconciliation logic until the direction (a) vs (b) is chosen and reviewed.

## Acceptance criteria
This ticket's own "done" is a decision document, not shipped code:
- A written recommendation between direction (a) and (b) above, with the ownership and migration trade-offs made explicit.
- If (a): a concrete plan for how the daemon calls into `workspace.db` (which client SDK surface, what changes on the Electron side) and how existing `ApplicationQueueEntryState` data migrates.
- If (b): the actual exported transition table, reviewed against every current call site of `SETTLED_CHECKPOINTS`, `IN_FLIGHT_CHECKPOINTS`, `UNSCHEDULED_QUEUE_STATES`, and `queueStillWantsThis` to confirm the table reproduces today's behavior before any call site is touched.
- Confirmation that F-A has shipped and been running in production without a recurrence of the lease-deadlock family before this ticket's actual migration work begins.

## Risk
High, which is exactly why this pass deliberately did not implement it. This is the deepest, most architecturally invasive item identified in the audit: it touches the Electron-main/daemon process boundary fundamentally, spans two persistence layers (`workspace.db` and the daemon's file-based queue store), and any bug in the migration risks the same class of silent desync it's meant to fix, but now across a half-migrated state instead of two static ones. Doing this via an automated pass without a dedicated session, careful incremental migration, and real regression testing at each step risks destabilizing the whole Search -> Apply pipeline -- which is why the audit places it after F-A has proven out, not in a first batch.

*(In the event, the product owner accepted this risk explicitly and asked for it to be attempted in the same session -- see Status above.)*
