## Goal
Add a free-text search query (e.g. "Frontend developer with Angular skills") that gets AI-ranked against the vacancy pool -- the Resumator-style flow discussed: a manager types a description, the system ranks candidates (there: resumes; here: vacancies) by fit to that text, not just by a pre-set structured profile.

## Why this is deferred, not built now
- This app's whole search model today is profile-first, not query-first: the candidate sets a structured profile once (`packages/vacancy-engine/src/candidate/profile.ts` -- target roles, strongest skills, constraints), and `scoreActiveVacancies` (`src/scoring/service.ts`) deterministically scores every active vacancy against that standing profile. There is no free-text query surface anywhere in the current UI or pipeline -- this ticket would be a new input mode, not an enhancement of an existing one.
- It's a materially bigger piece of work than `draft-semantic-scorer-secondary-layer.md` (option 1): that ticket enriches the existing per-vacancy deterministic score with an LLM opinion; this one adds a whole new query path (parse free text -> some retrieval/ranking step -> results), closer to what Resumator did for resumes at iO Digital than to anything this repo has today.
- No product decision has been made about whether ad-hoc free-text search fits this app's model at all, versus the standing profile-based approach -- that's a real design question (does a one-off query bypass the profile's bias-prevention discipline covered by the "no default role/country/salary bias" memory?), not just an implementation gap.

## What would need to be true before this is worth building
1. A product decision that ad-hoc free-text queries are wanted alongside (not instead of) the standing profile-based scoring -- and how the two relate (e.g. does a free-text query filter within the profile-scored pool, or search independently of it?).
2. Option 1 (`draft-semantic-scorer-secondary-layer.md`) landed first, most likely -- a free-text ranking path would probably reuse whatever LLM-call plumbing (provider routing, cost/latency bounds) that ticket establishes, rather than building a second one from scratch.
3. A decision on how a free-text query interacts with this project's bias-prevention discipline: a query like "Frontend developer, must relocate to Amsterdam" typed by the user is different from a *shipped default* biasing every result, but still needs the same "never silently steer, always show what matched and why" discipline the deterministic scorer already has.

## Scope (when picked up)
- A search input in the desktop UI, separate from the standing candidate profile.
- A ranking step against the existing vacancies pool (`packages/vacancy-engine/src/vacancies/repository.ts`), most likely built on the same LLM-call plumbing as option 1 rather than a new one.
- Results labeled with what the AI matched on (skills, seniority, etc. -- reusing `semanticScoreSchema`'s `matchingSkills`/`gaps`/`primaryFit` shape from option 1 where it fits), so ranking stays explainable rather than a black-box reorder.

## Non-goals
- Do not build this before option 1 has a working LLM-call path to reuse.
- Do not replace or bypass the existing profile-based deterministic scoring -- this is an additional query mode, not a replacement for the standing search.
- Not scoping the UI/UX in detail yet -- that's for whenever this is actually picked up and the product decision in point 1 above has been made.

## Risk
Low to defer (pure addition, nothing depends on it yet); medium once picked up, for the same reasons as option 1 (auditability, cost/latency) plus the added question of how a one-off query coexists with the profile-based bias-prevention discipline.
