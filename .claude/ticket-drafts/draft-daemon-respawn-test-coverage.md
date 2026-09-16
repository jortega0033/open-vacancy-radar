## Goal
Give the daemon auto-respawn logic (shipped this session) real automated test coverage, closing the gap it shipped with rather than leaving it permanently untested.

## Why now
Bounded daemon auto-respawn with backoff (`apps/desktop/electron/main.ts`'s `scheduleDaemonRespawn`, `daemonRespawnAttempts`, `daemonGeneration`) was implemented and merged this session, safe now that the daemon's stale-lease-on-startup reconciliation exists. Its own implementer's report was explicit and honest about a real gap: `main.ts` is confirmed not importable in isolation by this codebase's own existing test comments ("importing it boots Electron, spawns the daemon sidecar, and opens two SQLite databases... a pre-existing architectural gap") -- a fact independently confirmed by two other test files earlier this session. So the respawn logic -- backoff timing, the `isQuitting` gate that must never respawn during a deliberate shutdown, the `daemonGeneration` guard against a stale ready-loop adopting a newer daemon instance -- shipped with zero automated regression coverage, relying entirely on code review and manual reasoning at implementation time.

This is the same class of gap that caused the real `daemonFetch`-hang incident earlier this session (a `main.ts`-resident piece of recurring-worker logic with no test coverage, that only got caught by hitting it live) -- except the respawn logic sits directly in the crash-recovery path, so a bug in it degrades exactly the resilience feature it exists to provide, at exactly the moment (a daemon crash) that resilience is needed most.

## Scope
- Extract the respawn decision logic (attempt counting, backoff delay calculation, the `isQuitting` gate check, the generation-guard check) into a small, pure, dependency-injectable module the same way `apps/desktop/electron/tick.ts` was extracted from `main.ts`'s ticker logic earlier this session -- not necessarily the whole `spawnDaemon`/`waitForDaemonReady` machinery, just the decidable parts: given "attempt N failed, is quitting = false, current generation = G", what should happen next (retry after delay D, or give up).
- Add real unit tests for that extracted module: backoff delays double up to the cap, gives up after the max attempt count, never retries when `isQuitting` is true (checked both before scheduling and again inside the delayed callback, matching the real implementation's stated behavior), and a stale generation's late resolution is correctly treated as a no-op.
- Leave `main.ts`'s own untestable IPC/Electron-boot surface alone -- this ticket does not attempt to fix `main.ts`'s broader untestability, only to pull the one piece of genuinely pure decision logic out where it can be tested, the same precedent `tick.ts` and (for the state machine) `application-attempt-transitions.ts` already established this session.

## Non-goals
- No attempt to make the whole of `spawnDaemon`/`waitForDaemonReady` importable/testable in isolation -- that's the larger, separate `main.ts`-de-monolithing effort the architecture audit already flagged as its own multi-step undertaking (ADI-07's precedent, applied incrementally elsewhere this session).
- No change to the respawn policy itself (attempt cap, backoff shape) unless testing it surfaces a real bug -- this ticket is about coverage, not redesign.

## Acceptance criteria
- A new, focused test file (or an extension of `test/tick.test.ts`'s pattern) exercises the respawn decision logic with a fake clock, matching the hang-simulation-test discipline `tick.test.ts` already established for this exact code class.
- The extraction is behavior-preserving: `main.ts`'s actual respawn behavior is unchanged, verified by the full `apps/desktop` suite staying green.

## Risk
Low. This is adding test coverage to already-shipped, already-reviewed logic via a small, precedented extraction pattern -- not new production behavior. The main risk is the extraction itself introducing a subtle behavior change if the pure logic isn't separated cleanly from its Electron-specific side effects (spawning the real child process); keep the extracted module's inputs/outputs narrow and injected, mirroring `tick.ts`'s own shape.
