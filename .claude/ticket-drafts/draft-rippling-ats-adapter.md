## Goal
Add a dedicated Rippling ATS adapter (`packages/vacancy-engine/src/ats/rippling.ts`), following the same pattern as the five that already exist (`greenhouse.ts`, `lever.ts`, `ashby.ts`, `recruitee.ts`, `personio.ts`).

## Why now
`rippling.com` already appears in `structured-discovery.ts`'s `FREEHIRE_ATS_HOSTS` allow-list, but that path relies on JSON-LD extraction (`ats/json-ld.ts`). Per the discussion on issue #147, Rippling posting pages don't carry JSON-LD at all -- the data lives in a Next.js `__NEXT_DATA__` client-rendered blob instead. So despite being on the allow-list, Rippling postings are not actually reachable through the existing generic path today. That same thread also surfaced an undocumented per-posting detail endpoint that reportedly returns clean structured fields directly, which is what this ticket would build against.

## Attribution and verification status
The technical specifics below come entirely from a third-party GitHub comment (issue #147, account `moonie0201`), reporting their own measurements against live Rippling boards on 2026-09-04. **None of it has been independently verified by anyone on this project.** Every number and endpoint shape here is a claim to confirm during implementation, not an established fact -- treat this section as a lead to investigate, not a spec to build blindly against.

### Reported (unverified)
- List endpoint `GET /platform/api/ats/v1/board/{slug}/jobs` returns only `uuid`, `name`, `department`, `url`, `workLocation` (singular) per row -- no description, date, or pay.
- A second, undocumented endpoint, `GET /platform/api/ats/v1/board/{slug}/jobs/{uuid}`, reportedly returns `description`, `createdOn`, and `employmentType` on effectively all sampled postings, `workLocations` (plural), and structured per-location `payRangeDetails` on roughly a third of sampled postings.
- The list endpoint reportedly returns one row per (posting x location) rather than one row per posting -- a posting open in two locations shows as two rows under different `workLocation` values but presumably the same `uuid`. Naive counting/deduping without grouping by `uuid` would double-count multi-location postings.
- No bulk "everything in one call" option was reported (unlike Greenhouse's `content=true`), so full detail is one list call plus one detail call per posting (N+1) -- reportedly why the commenter only fetches full detail for new/changed postings on their own sweep rather than every posting every run.

## Scope
- New adapter at `packages/vacancy-engine/src/ats/rippling.ts`, following the existing five's shape: fetch via `AtsHttpClient`/`http.ts`, normalize via `shared.ts`'s helpers (`makeVacancy` etc.), same error/detection conventions as `ats/detection.ts`.
- Independently verify the reported endpoint shapes and field-presence rates against real Rippling boards before trusting them in any test fixture or production parsing path.
- Implement uuid-based grouping so a multi-location posting normalizes to exactly one vacancy, with a test proving it -- this is the single most important correctness property here, per the reported gotcha above.
- Decide and implement a fetch strategy that respects the N+1 cost: most likely list-endpoint-only on the routine sweep, with detail-endpoint fetches gated to new or changed postings, rather than fetching full detail for every posting on every run.
- Wire the new adapter into `ats/detection.ts`/`ats/factory.ts`/`ats/index.ts` the same way the existing five are registered.
- Decide during implementation whether `rippling.com` should stay in `structured-discovery.ts`'s `FREEHIRE_ATS_HOSTS` (as a harmless no-op, since JSON-LD extraction against it returns nothing) or be removed now that a dedicated path exists -- not decided here.

## Non-goals
- Not implementing this now -- this ticket tracks the work; it is not the work itself.
- Not trusting any reported number, endpoint path, or field shape above as verified fact until confirmed independently during implementation.
- Not attempting to find or build a bulk "everything" call if Rippling genuinely doesn't expose one -- working politely within the N+1 constraint is the scope, not avoiding it.

## Acceptance criteria
- A real Rippling-hosted board's postings are ingested with description, posted date, and employment type populated.
- A posting open in more than one location normalizes to exactly one vacancy record, never one per location.
- Structured pay is captured when Rippling's per-location pay data is present, mapped onto whatever compensation model the other adapters already use.
- The new adapter has its own test fixtures built from real or realistic verified response shapes, following the same test pattern as the existing five adapters -- not fixtures copied uncritically from the unverified numbers above.

## Risk
Medium. The detail endpoint is reportedly undocumented, meaning no published, stable API contract -- it could change without notice, so parsing should be defensive (strict schema validation, fail loudly on an unexpected shape, matching this project's existing ATS adapter discipline) rather than assuming permanence. Being unauthenticated and reachable from the same page the employer's own board renders keeps this in the same "public endpoint, employer's own postings" category this project already accepts for the other five ATS platforms -- but that categorization itself should be re-confirmed for Rippling specifically during implementation, not assumed from the other five's precedent. The N+1 request cost also needs to stay polite at whatever board volume this project actually operates at, not copied from the commenter's own very different sweep scale.
