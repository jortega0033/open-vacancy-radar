## Goal
Close the one documented residual gap in cross-company duplicate grouping (issue #139, v3): two unrelated employers who both paste the same long third-party job-description template verbatim, with only a short employer-specific tail, currently score high enough on shingle Jaccard to be grouped as suspected duplicates even though they are genuinely different openings.

## Why now / what already exists
`packages/vacancy-engine/src/reporting/cross-company-duplicates.ts:119-134` documents this exact limitation and states the direction to fix it: "the natural next step, if this shows up in real reports, is corpus-relative rather than pairwise -- a block of text appearing verbatim across postings from many unrelated companies is a template, and that is a judgement only the whole report can make, not a pair." The limitation is not hidden -- it is asserted directly in `cross-company-duplicates.test.ts` (the round-3 fixture, ~0.88-0.98, must-group) with a comment explaining why, found during the ticket's own round-3 adversarial review.

The existing mitigation (`ats-boilerplate.ts`) already strips a fixed, hand-written phrase table before comparison, but that table can only ever cover boilerplate someone thought to write down in advance. A third-party template that isn't on the list -- an ATS vendor's own generated skeleton, a staffing-agency stock paragraph -- passes through untouched and inflates shingle similarity exactly like the round-3 fixture does.

## Scope
- A corpus-relative pre-processing pass, run once per full scan (not per-pair), over the full vacancy corpus before `findCrossCompanyDuplicateGroups()` is called (call site: `packages/vacancy-engine/src/reporting/repository.ts:364`).
- The pass identifies text blocks/shingles that appear verbatim across an unusually large number of *distinct companies* (a threshold to be set, e.g. 5+) and either:
  - excludes those blocks from the similarity computation entirely, by extending the existing boilerplate-stripping approach in `ats-boilerplate.ts` to include a corpus-derived exclusion set alongside the fixed hand-written one, or
  - otherwise discounts their contribution to the shingle Jaccard score.
- Purely local/statistical (shingle frequency counting across the corpus) -- no AI or network call, consistent with this module's existing "no model, no network" constraint.

## Non-goals
- Does not touch the fixed `BOILERPLATE_PHRASES`/`BOILERPLATE_TOKENS` table -- this is additive (corpus-derived), not a replacement.
- Does not change the "group, never merge" contract: this only tightens which groups form, it does not add a merge/removal path.
- Does not attempt to solve the general repost-detection recall the v3 rewrite deliberately gave up (a genuinely rewritten repost is still out of scope).

## Open question worth resolving before committing effort
Is the round-3 shape (many companies independently pasting the same long third-party template) actually showing up in real reports, or is it still only the synthetic adversarial fixture? The existing doc comment frames the corpus-relative pass as worth building "if this shows up in real reports" -- that condition should be checked against real scan data before implementation, since the added complexity (a corpus-wide pre-processing pass, a frequency threshold to tune, a new versioned artifact to test) is only justified if the narrow real-world case it closes actually occurs. If it does not occur in practice, the documented pairwise limitation is an acceptable permanent tradeoff and this ticket should stay unbuilt.

## Acceptance criteria
- [ ] A corpus-wide frequency count of substantive shingles (or blocks) across all companies in a scan, computed once per scan.
- [ ] Blocks appearing across >= N distinct companies (N to be decided, default suggestion 5) are excluded from or discounted in the pairwise shingle similarity computation.
- [ ] The round-3 fixture in `cross-company-duplicates.test.ts` (shared role-explainer paragraph, different jobs) no longer groups once enough distinct-company instances of that paragraph exist in the corpus.
- [ ] The existing true-positive fixtures (genuine repost, byte-identical repost) still group -- the corpus-relative pass must not regress recall on real reposts.
- [ ] A new test proves the corpus-relative exclusion requires genuine cross-company repetition -- i.e. a block appearing in only 2-3 companies (below threshold) is NOT excluded, so it doesn't accidentally suppress a real narrow-audience repost signal.

## Tests
Extend `cross-company-duplicates.test.ts` with a corpus-level fixture: N distinct companies all posting the round-3 shared-template paragraph with different job tails, verifying the pairwise grouping between any two of them no longer fires once the template is recognized as corpus-wide. Keep all existing pairwise fixtures passing unchanged.

## Risk
Low-medium. This only removes evidence (never adds it), so the failure mode of a bug here is under-grouping (a missed suggestion), not a false grouping -- consistent with the module's existing bias toward "no claim" over an unearned one. Main risk is threshold tuning (N too low discounts real narrow reposts, N too high never fires) and the added cost of a corpus-wide pass on every scan.

## Dependencies
Builds directly on `ats-boilerplate.ts` and `cross-company-duplicates.ts` (issue #139, v3). No blocking dependency; the open question above should be answered before scheduling implementation.
