## Goal
Close the two residual gaps the P0 preparation-fence fix (this session) documented on itself as known, accepted limitations at the time it shipped: an irreducible write-already-started window in PDF staging, and a queue-release call in `main.ts` that doesn't check whether the release actually succeeded.

## Why now
The preparation-fence fix (`apps/desktop/electron/application-pipeline.ts`'s `fencedWrite`/`stillLiveCheck`/`abandonPreparationFence` machinery, `electron/application-artifact-staging.ts`'s `StagingAbandonedError`) went through two rounds of independent adversarial review this session and is merged, closing the real, reproduced bug where an abandoned run's late artifact write could overwrite a replacement run's CV/cover-letter file. The implementer's own final report was explicit that two smaller gaps remain, deliberately left open rather than rushed:

1. **The irreducible staging window.** `writeAndRegisterArtifact` (`application-artifact-staging.ts`) checks `stillLive()` as its first statement, before the path is computed -- but the `await`s after that check (`rm`, `mkdir`, `writeFile`) still run to completion regardless of abandonment once the check has passed. This is a millisecond-scale window, not the minutes-scale render the main fix closed, but it is a real gap in the same class: nothing can cancel an already-issued filesystem write from this process. Unlike the field-map-apply residual (which the fix already documented in the code itself), this one is not yet called out in `writeAndRegisterArtifact`'s own doc comment.
2. **`applicationQueuePort.release` doesn't check `res.ok`.** In `apps/desktop/electron/main.ts`, the abandonment path's call to release the daemon's lease does not verify the HTTP response actually succeeded. A daemon-side refusal of that release call today resolves successfully from the caller's point of view and logs nothing -- the one condition under which the queue could still end up wedged after an abandonment, silently.

## Scope
- For (1): decide and implement one of -- a best-effort compensating cleanup pass that runs after the fact and deletes an abandoned run's now-orphaned write if it lands after the fence moved (matching the spirit of the already-existing orphaned-PDF-artifact cleanup work), or an explicit, tightened doc comment on `writeAndRegisterArtifact` stating this specific millisecond-scale window as a permanently accepted limitation (mirroring how the field-map-apply residual is already documented) if a real fix isn't worth the complexity for a window this narrow.
- For (2): make `applicationQueuePort.release`'s caller in `main.ts` check `res.ok` and, on failure, log loudly (this is the one condition that can still wedge the queue) -- does not need to retry or throw, just needs to stop being silent.

## Non-goals
- No change to the daemon's own `release()` method or lease semantics -- both are confirmed correct by this session's adversarial review.
- No attempt at true write cancellation (an `AbortController` threaded through every filesystem call) -- that's a larger, separate hardening effort the original audit already flagged as out of scope for the fencing fix.

## Acceptance criteria
- (1) has an explicit, deliberate resolution -- either a real compensating-cleanup mechanism with a test proving it, or an accepted-limitation doc comment matching the field-map-apply residual's existing style, not silence.
- (2) has a test: a mocked failed `release` response from the daemon results in a logged error, not a silent success.

## Risk
Low-medium. Both are narrow, well-scoped edits to code that was just adversarially reviewed and is well understood. The main risk is (1) turning into scope creep toward general write-cancellation if not deliberately bounded to "close this one specific window or explicitly accept it."
