## Goal
Close the two residual gaps the P0 preparation-fence fix (this session) documented on itself as known, accepted limitations at the time it shipped: an irreducible write-already-started window in PDF staging, and a queue-release call in `main.ts` that doesn't check whether the release actually succeeded.

## Why now
The preparation-fence fix (`apps/desktop/electron/application-pipeline.ts`'s `fencedWrite`/`stillLiveCheck`/`abandonPreparationFence` machinery, `electron/application-artifact-staging.ts`'s `StagingAbandonedError`) went through two rounds of independent adversarial review this session and is merged, closing the real, reproduced bug where an abandoned run's late artifact write could overwrite a replacement run's CV/cover-letter file. The implementer's own final report was explicit that two smaller gaps remain, deliberately left open rather than rushed:

1. **The irreducible staging window.** `writeAndRegisterArtifact` (`application-artifact-staging.ts`) checks `stillLive()` as its first statement -- but every `await` after that check runs to completion regardless of abandonment once the check has passed. This is a millisecond-scale window, not the minutes-scale render the main fix closed, but it is a real gap in the same class: nothing can cancel an already-issued filesystem write from this process. Unlike the field-map-apply residual (which the fix already documented in the code itself), this one is not yet called out in `writeAndRegisterArtifact`'s own doc comment.
2. **`applicationQueuePort.release` doesn't check `res.ok`.** In `apps/desktop/electron/main.ts`, the abandonment path's call to release the daemon's lease does not verify the HTTP response actually succeeded. A daemon-side refusal of that release call today resolves successfully from the caller's point of view and logs nothing -- the one condition under which the queue could still end up wedged after an abandonment, silently.

## Scope
- For (1): decide and implement one of -- closing as much of the window as ordering allows and compensating for whatever is genuinely left, or an explicit, tightened doc comment on `writeAndRegisterArtifact` stating this window as a permanently accepted limitation (mirroring how the field-map-apply residual is already documented) if a real fix isn't worth the complexity.
- For (2): make `applicationQueuePort.release`'s caller in `main.ts` check `res.ok` and, on failure, log loudly (this is the one condition that can still wedge the queue) -- does not need to retry or throw, just needs to stop being silent.

## Non-goals
- No change to the daemon's own `release()` method or lease semantics -- both are confirmed correct by this session's adversarial review.
- No attempt at true write cancellation (an `AbortController` threaded through every filesystem call) -- that's a larger, separate hardening effort the original audit already flagged as out of scope for the fencing fix.
- No general assault on `main.ts`'s untestability. Extracting the one piece needed to test (2) is in scope; de-monolithing the file is not.

## Acceptance criteria
- (1) has an explicit, deliberate resolution -- either a real mechanism with a test proving it, or an accepted-limitation doc comment matching the field-map-apply residual's existing style, not silence.
- (2) has a test: a mocked failed `release` response from the daemon results in a logged error, not a silent success.

## Risk
Low-medium. Both are narrow, well-scoped edits to code that was just adversarially reviewed and is well understood. The main risk is (1) turning into scope creep toward general write-cancellation if not deliberately bounded.

---

## Corrections made while implementing (2026-09-16)

Four things in the draft above are wrong or incomplete, and one of them was steering toward a weaker fix than the code allows.

**There is no existing orphaned-PDF-artifact cleanup to mirror.** The draft named one as the model for (1). The closest thing is `workspace/repository.ts`'s `reconcileApplicationArtifacts`, which is neither a cleanup nor about this case: read-only and reporting-only by its own doc comment, and about the opposite direction (a manifest row whose file is gone, not a file no row claims).

**(1)'s damaging half is not the write.** The draft framed the window as "the new PDF lands after the fence moved". That is the harmless half -- an unreferenced file under the attempt's directory that nothing reads. What actually costs someone an application is the step `writeAndRegisterArtifact` did *first*: deleting the previous artifact's row and its file to make room. A run abandoned mid-function took the live run's current CV away and registered nothing in its place.

So (1) is an ordering problem, not a compensate-after-the-fact problem, and it has a real fix: move the destructive rows behind a second `stillLive` check placed after the last `await`, leaving nothing between the check and the writes it guards, and compensate only the one write that cannot wait. Both are implemented. The accepted-limitation doc comment is written too, for the much narrower residual left over.

**Compensation cannot be unconditional.** Staged files are named after their content hash, so a replacement run that rendered byte-identical output -- the likely result of re-preparing one attempt, not a corner case -- is registered at exactly the path the abandoned run just wrote. Deleting "the file this run wrote" would have deleted the live attempt's own current document: the fix causing the bug it prevents. The compensating delete skips any path a live artifact row claims.

**(2) could not be tested where it lived.** `main.ts` is not importable by a test -- importing it boots Electron, spawns the daemon sidecar and opens two SQLite databases -- which is why this call spent its whole life ignoring its own response. Meeting the draft's own acceptance criterion needed the queue port extracted into `electron/application-queue-port.ts` behind injected `request`/`getJson`/`log` callbacks, the same narrow extraction `tick.ts` made for the recurring worker and `draft-daemon-respawn-test-coverage.md` proposes for the respawn logic. The HTTP transport, authentication and base URL stay in `main.ts`; the non-goals above now say so.

## What shipped
- `electron/application-artifact-staging.ts`: `writeAndRegisterArtifact` reordered (write, then trailing `stillLive` check, then the row swap with no `await` between check and writes, then the superseded files); best-effort compensating delete of its own write, skipping any path a live row claims; `StagingAbandonedError` now promises "no row was registered" rather than "nothing was written", which is the claim callers actually depend on.
- `electron/application-queue-port.ts` (new): the four queue calls, with `release` checking `res.ok` and logging a refusal with status and an app-authored reason, without throwing.
- `electron/main.ts`: builds the port instead of declaring it inline; `applicationQueueRefusal` moved to the new module.
- `test/application-artifact-staging-fence.test.ts` (new): four cases against a real temp directory and a real workspace database, including the identical-content collision.
- `test/application-queue-port.test.ts` (new): ten cases, five of them on `release`.
