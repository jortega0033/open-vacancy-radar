## Goal
Wire the existing, currently-empty `SemanticScorer` seam (`packages/vacancy-engine/src/scoring/semantic-contract.ts`) to a real LLM provider, as an **optional secondary layer** on top of the existing deterministic scoring pipeline (`src/filtering/relevance.ts`'s `DETERMINISTIC_SCORING_VERSION`/`scoreVacancy`, run through `src/scoring/service.ts`'s `scoreActiveVacancies`) -- never as a replacement for it.

## Why this is deferred, not built now
- The seam already exists on purpose but was deliberately shipped empty: `semantic-contract.ts` says outright *"V1 intentionally ships without a paid provider implementation."* This ticket is picking up exactly the item that comment names, not inventing new scope.
- `domain/models.ts`'s `semanticScoreSchema` (`relevant`, `score`, `technicalFit`, `seniorityFit`, `languageFit`, `locationFit`, `dutchRequired`, `primaryFit`, `matchingSkills`, `gaps`) is already the right shape for this -- structured, bounded fields an LLM call would fill in per vacancy, not freeform text.
- No provider is wired yet and no existing ticket tracks doing so (confirmed via `gh issue list --search "semantic"` returning nothing on point) -- this is genuinely new scope, deferred until deterministic scoring's own roadmap (the v11 relevance algorithm, `RELEVANCE_THRESHOLD`) has room for a secondary pass, and until the cost/latency of a per-vacancy LLM call across potentially hundreds of active vacancies is worked out.
- Discussed alongside a Resumator (iO Digital) precedent: a search page where a manager's free-text query gets AI-ranked against resumes by skillset. That's the shape of **option 2** (`draft-freetext-semantic-search.md`) -- a different, larger piece of work with its own ticket. This ticket is deliberately the narrower version: enrich the *existing* profile-based deterministic pipeline, not add a new query surface.

## What would need to be true before this is worth building
1. A real product need for nuance the deterministic v11 algorithm can't express -- e.g. borderline cases near `RELEVANCE_THRESHOLD` where a human would clearly see a skill match the keyword/pattern-based `relevance.ts` concepts miss.
2. A decision on how the LLM call is made without violating this project's standing "never hold an API key, never read Claude's credential storage" invariant (see `.claude/ticket-drafts/adi-08c.md`) -- most likely by routing through the existing daemon/agent-runtime session infrastructure the same way other AI features in this app already do, rather than a raw provider API call from `vacancy-engine`.
3. A cost/latency model for scoring at the volume `scoreActiveVacancies` already operates at (every active vacancy, every scoring run) -- likely means this only runs semantic scoring on a bounded subset (e.g. vacancies already above some deterministic floor) rather than everything.

## Scope (when picked up)
- Implement `SemanticScorer` against whatever provider path is decided (see point 2 above).
- Call it only for vacancies that already pass deterministic scoring's own bar, or some other bounded subset -- never as the sole gate.
- Persist `SemanticScore` alongside the existing `DeterministicScore` per vacancy (schema/versioning following the same pattern `scoring/repository.ts` already uses for deterministic scores), so a semantic score is always traceable to its `configVersion` and never silently overwrites the deterministic result.
- Surface both scores (or a clearly-labeled combination) in the UI -- never blend them into one opaque number a user can't audit back to "why."

## Non-goals
- Do not make semantic scoring the primary or sole ranking mechanism -- this project's deterministic, auditable scoring is a standing design choice (see the "no default role/country/salary bias" precedent), and an LLM call is inherently less auditable than `relevance.ts`'s pattern-based concepts.
- Do not add a free-text search query box -- that's option 2's scope, not this ticket's.
- Do not implement this speculatively before a provider/cost/latency plan exists per the "what would need to be true" section.

## Risk
Medium if picked up without the above resolved first: an unbounded per-vacancy LLM call path could get expensive fast, and blending semantic scores into ranking without clear provenance would erode the auditability this project has otherwise protected deliberately.
