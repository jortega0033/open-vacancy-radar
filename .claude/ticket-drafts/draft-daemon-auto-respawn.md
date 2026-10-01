## Goal
Auto-respawn the daemon process with a bounded, backed-off retry policy when it exits unexpectedly, so a daemon crash recovers on its own instead of leaving the app permanently in an "unavailable" state until the user restarts.

## Why now
From the audit's automation/AI architecture review: the daemon child exit handler in `main.ts:491-499` already turns an unexpected daemon crash into a renderer-visible `{state:'unavailable'}` status rather than taking down the whole Electron-main process -- a genuine, valuable crash-isolation property. But `spawnDaemon()` is called exactly once, at `main.ts:2595` (confirmed sole call site), so nothing ever calls it again after that exit handler runs. The result: the app correctly survives the crash but does not recover from it -- the user is stuck with "unavailable" until they fully restart the app themselves. A bounded respawn-with-backoff in the exit handler completes the isolation property that's already half-built.

This was previously flagged as unsafe to add: the adversarial reliability review that covered this area originally raised that auto-respawn, without startup lease reconciliation, would convert a loud "daemon unavailable" outage into a silent, permanent, self-reinforcing scheduling wedge (a crash-looping daemon endlessly re-claiming and re-losing leases with no path back to a clean state). That blocker is now resolved: `ApplicationQueueStore#reconcileStaleLeaseOnStartup` (`apps/daemon/src/application-queue-store.ts`) has landed and is covered by the "crash / restart recovery" describe block in `apps/daemon/test/application-queue-store.test.ts`. With stale-lease reconciliation in place on every daemon startup, a respawned daemon now starts from a clean, known state instead of inheriting a wedged one, so it is safe to add respawn now.

## Scope
- In the daemon child's exit handler (`main.ts:491-499`), on an unexpected exit (not a deliberate, user-initiated quit), trigger a respawn via the existing `spawnDaemon()` path instead of only setting `{state:'unavailable'}`.
- Bound the respawn attempts: a fixed or exponential backoff between attempts and a maximum retry count, so a daemon that crashes immediately on every start does not turn into a tight crash loop hammering the machine. Once the retry budget is exhausted, fall back to today's behavior -- surface `{state:'unavailable'}` and stop trying automatically.
- Log each respawn attempt clearly (attempt number, backoff delay, eventual give-up) so the behavior is visible to the user/support rather than silent.
- Respect any existing graceful-shutdown/quit-in-progress state: a deliberate app quit that also tears down the daemon child must never be mistaken for a crash and trigger a respawn.

## Non-goals
- No changes to `ApplicationQueueStore#reconcileStaleLeaseOnStartup` itself or its test coverage -- that work is already done and is only a precondition being relied on here.
- No change to how the daemon is spawned the first time (the existing `spawnDaemon()` call site at `main.ts:2595` stays as is); this ticket only adds retry calls into the same function after an unexpected exit.
- No new user-facing settings/UI for configuring retry count or backoff in this ticket -- reasonable hardcoded defaults are in scope; making them configurable is not.

## Acceptance criteria
- Killing/crashing the daemon process unexpectedly results in the app automatically respawning it and returning to a working (non-`unavailable`) state within the backoff window, without any user action.
- A daemon that crashes immediately and repeatedly is retried a bounded number of times with backoff between attempts, then gives up and shows `{state:'unavailable'}` -- it never retries forever or in a tight loop.
- A deliberate, user-initiated app quit that stops the daemon does not trigger a respawn attempt.
- Each respawn attempt (and the eventual give-up, if the budget is exhausted) is logged.
- New/updated tests cover: successful respawn after an unexpected exit, exhausting the retry budget and falling back to `unavailable`, and no respawn on a graceful quit.

## Risk
Low-medium. The unsafe precondition (respawn without stale-lease reconciliation) that made this risky is already resolved and tested, which is why this is now scoped as P2 rather than blocked. Remaining risk is standard for any retry-with-backoff logic: getting the "was this a crash or a deliberate quit" distinction wrong would either respawn during an intentional shutdown or fail to respawn after a real crash, so that check needs to be verified against the actual quit-in-progress state the app already tracks, not re-derived.
