## Goal
Delete four independently-confirmed dead code items across `vacancy-engine` and `application-executor` -- each a small, zero-caller deletion, bundled into one cleanup ticket because none of them is worth its own review cycle on its own.

## Why now
All four were confirmed against the real source this session, not inferred:
- `findCrossCompanyDuplicateGroups` (`packages/vacancy-engine/src/reporting/cross-company-duplicates.ts`) is a real, tested (`packages/vacancy-engine/test/reporting/cross-company-duplicates.test.ts`), tuned algorithm -- 5-word-shingle Jaccard similarity at a >=0.75 threshold, union-find grouping -- with zero callers anywhere in the shipped app. A grep across the repo turns up only its own definition, its own test, and a barrel re-export in `packages/vacancy-engine/src/index.ts`.
- `DETERMINISTIC_SCORING_VERSION` (`packages/vacancy-engine/src/filtering/relevance.ts:12`) is declared and never read anywhere outside its own declaration and a barrel re-export.
- `target-policy.ts`'s `timeoutMs` field (`packages/application-executor/src/target-policy.ts:68`) is declared and set to a real-looking `60000` in the one fixture policy (`application-target-policies.ts:74`), but a grep across all of `packages/application-executor/src` shows it is never consumed by the executor. This one is actively misleading rather than merely unused -- it implies a per-target timeout safety guarantee that does not exist anywhere in the execution path.
- `fetchAiDevJobDetail` and `fetchRemooteJobDetail` (`packages/vacancy-engine/src`, per `ai-dev-jobs-discovery.ts`) are two pre-built, working detail-fetchers, never called from anywhere in the shipped app.

Leaving these in place costs nothing at runtime, but each one is a small trap for a future reader: a "used" barrel export that isn't, a version constant nobody reads, and worst, a timeout field that reads as a real safety guarantee and isn't one.

## Scope
- Delete `findCrossCompanyDuplicateGroups`, its test file, and its barrel re-export from `src/index.ts`.
- Delete `DETERMINISTIC_SCORING_VERSION` and its barrel re-export.
- Decide and act on `target-policy.ts`'s `timeoutMs`: either wire it into a real timeout path in the executor (so the fixture's `60000` starts doing something), or delete the field and its use in the fixture policy. Deleting alone leaves no timeout at all at that spot in the executor, which is a behavior change worth calling out explicitly to whoever picks this up -- this ticket does not pre-decide which way to go.
- Re-confirm `fetchAiDevJobDetail` and `fetchRemooteJobDetail` are truly unreferenced with a fresh grep at implementation time (not just trusting this ticket's citation), then delete both if that holds.

## Non-goals
- No change to any code path that does have live callers -- this ticket touches only the four items named above.
- No decision made here on the `timeoutMs` wire-in-vs-delete question; that's for whoever picks up the ticket, informed by whatever the executor's real timeout story is at that time.
- No broader dead-code sweep beyond these four confirmed items -- this is not an invitation to go looking for more in the same pass.

## Acceptance criteria
- `findCrossCompanyDuplicateGroups`, its test, and its barrel export are gone; `packages/vacancy-engine/src/index.ts` no longer references it.
- `DETERMINISTIC_SCORING_VERSION` and its barrel export are gone.
- `target-policy.ts`'s `timeoutMs` is either genuinely consumed by the executor's timeout handling (with a test proving a slow target actually gets cut off at that value) or removed entirely from the type and the fixture policy, with a one-line note in the PR explaining which path was chosen and why.
- `fetchAiDevJobDetail` and `fetchRemooteJobDetail` are deleted, confirmed via a fresh grep at implementation time to have zero remaining callers.
- Full test suite passes after each deletion; no barrel export in `src/index.ts` points at a removed symbol.

## Risk
Low. All four items are confirmed zero-caller as of this session, and deletion of dead code carries little regression risk by itself. The one item requiring judgment -- `timeoutMs` -- is a behavior question, not a risk to this deletion pass: if the implementer chooses to delete rather than wire it in, the resulting behavior (no per-target timeout) is exactly today's real behavior, just no longer misrepresented by a field that looks wired in but isn't.
