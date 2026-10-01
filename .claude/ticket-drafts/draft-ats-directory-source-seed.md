## Goal
Add a small, new ingestion loop that consumes a verified `(provider, slug)` company roster, calls this repo's existing (currently orphaned) ATS parsers for Greenhouse, Lever, Ashby, Recruitee, and Personio, and writes the results into the same vacancies store the worldwide `global-remote` pipeline already feeds. This is new, minimal orchestration, not a revival of anything that was deleted.

## Why now
Confirmed while researching moonie0201's Rippling findings on issue #147: `packages/vacancy-engine/src/ats/{greenhouse,lever,ashby,recruitee,personio}.ts` are fully working, tested parsers with **no caller anywhere in the codebase** right now (confirmed by grep). Their only caller, a company-discovery/domain-search/campaign-orchestration system (~35 files), was deleted the same day this ticket was drafted, in commit `aa6ec22` ("Remove curated Netherlands pipeline, unify on worldwide", #191). What's missing is only "which company do we scan," and a verified company roster answers that for free.

## Source, superseded once already -- follow the evidence, not the first find
Original candidate was `moonie0201/ats-directory` (CC0). A follow-up comment on #147 corrected that pick before anything was built against it -- exactly the outcome asking first was for:

- **`ats-directory` is a one-shot snapshot, not a feed.** Three commits, all 2026-08-26, no rebuild schedule, no probe-date field per row. 1,804 rows (1,444 `ok` / 329 `dead` / 31 `unconfirmed`), but Greenhouse/Ashby/Lever/Recruitee sit at exactly 400 each -- a deliberate cap, not a real count -- and **Personio was explicitly removed** from it (`fix: remove Personio rows`, 2026-08-26). moonie0201's own re-probe of 200 random `ok` rows 10 days later found 100% still answering and 96% still carrying a posting, so the data that's there is trustworthy, there's just not much of it and nothing refreshes it.
- **`kalil0321/ats-scrapers`** (MIT) is the better source for this ticket: per-provider CSVs at `storage.stapply.ai/jobhive/v1/{provider}/companies.csv`, an order of magnitude bigger, and it has Personio. moonie0201 independently probed all 16,286 of its slugs across six providers on 2026-09-04 and kept 12,669 (78% carried at least one posting): Ashby 82%, Greenhouse 82%, Lever 81%, Personio 77%, Rippling 67%, Recruitee 57% (flagged as possibly depressed by his own rate-limiting -- treat as a floor, not the true rate).

`ats-directory` stays useful as a small cross-check, not the primary source: its 1,444 `ok` rows are a second, independently-probed opinion on the same companies where they overlap.

## What the sources cover -- precise, not overclaimed

| Provider | This repo has a parser | `kalil0321/ats-scrapers` count | moonie0201's keep rate | In scope here |
|---|---|---|---|---|
| Greenhouse | Yes | 6,031 | 82% | Yes |
| Ashby | Yes | 3,448 | 82% | Yes |
| Lever | Yes | 2,402 | 81% | Yes |
| Personio | Yes | 2,463 | 77% | Yes |
| Recruitee | Yes | 1,164 | 57% (floor, see above) | Yes |
| Rippling | No parser yet | present in source | 67% | Out of scope (separate future ticket, pending #147's field-shape research) |

Personio is back in scope now that the source has it -- the earlier ticket draft (before this correction) had excluded it because `ats-directory` alone doesn't carry it.

## What this explicitly is not -- read before scoping work
`aa6ec22`'s own commit message states why the old system was removed: *"That split was itself the kind of default-country special-casing this app's 'no default country/role/salary bias' rule exists to prevent."* The deleted system was Netherlands-curated: a specific country's companies, mapped via IND-sponsor data, treated as a privileged subset.

This ticket is not that, and must not become that:
- Every source row is provider-keyed, not country-keyed. Every row in the filtered set is treated identically regardless of what country the company is in.
- No new code path in this ticket reads a country field to include, exclude, prioritize, or rank a company.
- This is not a restoration of the deleted domain-search/campaign machinery. That solved company *discovery*; this ticket only consumes companies already verified by someone else's live probes. No Wikidata/TED/IATI/Tenderned-style discovery code is being rebuilt.

## Scope
- **Import step** (one-time, and re-runnable on a deliberate refresh cadence -- not a live fetch at scan time): pull `kalil0321/ats-scrapers`'s per-provider CSVs, filter to the five providers above, store this repo's own local copy of the filtered `(provider, slug)` set.
- **Independent verification, regardless of moonie0201's own probe work.** His numbers are corroborating evidence, not a substitute for this repo doing its own spot-check before trusting the import -- the same "verify, don't just trust a credible source" discipline this project has applied to every external claim so far this session.
- **Scan step** (new, small orchestration): for each stored `(provider, slug)`, call the matching existing parser in `ats/*.ts` through `ats-http-client.ts`, and write normalized vacancies into the same store `global-remote`'s pipeline already writes to, so existing deterministic scoring, filtering, and dedup picks these up automatically with no special-casing.

## Non-goals
- No company/domain discovery from scratch. Only companies already verified by one of the two sources above are ever in scope.
- No country-based filtering, prioritization, weighting, or curation of the imported list, under any circumstance.
- No Rippling adapter (tracked separately).
- No live runtime dependency on either upstream source repo at scan time.
- Not asking moonie0201 to rebuild `ats-directory` with timestamps, even though he offered -- this repo's own re-runnable import script covers the same need (a periodic freshness check) without creating an ongoing maintenance obligation for someone volunteering their time.

## Acceptance criteria
- Vacancies from the five newly-seeded providers appear in the same shared store as every other worldwide source, scored and deduped the same way.
- A spot-check sample (e.g. 20 random rows per provider) is independently confirmed live against the provider's own endpoint before the first bulk import runs, regardless of moonie0201's own probe numbers.
- The import step is a script, not a manual one-off edit, so a future refresh is cheap and doesn't depend on anyone else's maintenance schedule.
- Code review confirms no country field from either source is read anywhere in the new code path.

## Risk
Low-medium. The access pattern matches what this repo's parsers were already built and reviewed for. Main risks: (1) accidentally reintroducing country-based special-casing through carelessness, mitigated by the explicit non-goal and the review step above, (2) data quality, mitigated by the independent spot-check requirement even where a corroborating probe already exists, and (3) `kalil0321/ats-scrapers`'s own freshness is unverified by this repo directly yet -- the spot-check step covers that gap before any bulk import runs.
