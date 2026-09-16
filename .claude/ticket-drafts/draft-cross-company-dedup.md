## Goal
Extend the existing near-duplicate collapsing to catch the same listing reposted under a *different* company record (e.g. via a staffing agency, or the same employer registered under two names) -- narrower in scope than it might first sound, since same-company duplicate collapsing across sources already ships.

## Why now / what already exists
`packages/vacancy-engine/src/reporting/repository.ts` already dedupes report rows by `${companyId}:${createVacancySemanticFingerprint(vacancy)}` (normalized title + description + location), independent of which source/board found it -- confirmed in code, not a gap. `VACANCY_SEMANTIC_FINGERPRINT_VERSION` already exists as a versioned identity notion separate from the exact content hash. What is **not** covered: two different `companyId` rows that are really the same underlying employer/listing (a staffing agency repost, or a company scanned under two slightly different name variants). This is a real but much narrower gap than "cross-source dedup" as originally framed -- most of that was already solved.

## Scope
- A local heuristic ONLY -- no AI needed or wanted here. Compare fingerprints across *different* `companyId`s where company-name normalization (already used elsewhere in the codebase) suggests a plausible match, combined with the existing title/location/description fingerprint similarity.
- Present matches as a **grouping** in the UI ("also posted under N other company records") -- never a silent merge that removes a row.

## Non-goals
- Do not silently merge or delete rows. The project's existing sponsor-match precedent (issue #117: worldwide sponsor cross-check results are capped at `possible_sponsor_match`, never promoted to the curated pipeline's `recognised_sponsor` tier, specifically because that path lacks the curated pipeline's evidence rigor) establishes the house discipline here: a heuristic-level signal must never be presented with more confidence than it has earned. Collapsing two genuinely different roles at similarly-named companies into one visible row would be a real vacancy silently lost, which cuts against the project's stated "coverage is a product requirement" position -- worse than showing an occasional un-collapsed duplicate.
- No AI/LLM involvement -- this is pure local string/fingerprint comparison, matching the existing `createVacancySemanticFingerprint` machinery already in `vacancies/hash.ts`.

## Acceptance criteria
- Two rows for the same real listing under different company records are grouped and clearly labeled as likely duplicates, with both remaining independently visible/dismissible.
- No row is ever removed or hidden by this feature without explicit user action.
- Existing report/dedup tests unaffected; new tests cover: a true cross-company duplicate gets grouped; two genuinely different roles at similarly-named companies do NOT get grouped (a false-positive-avoidance test, not just a true-positive test).

## Risk
Low-medium. The main risk is a heuristic threshold tuned too aggressively, which the "group, never merge" design constraint directly mitigates -- worst case is an unhelpful grouping suggestion, never data loss.
