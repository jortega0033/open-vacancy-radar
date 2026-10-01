## Goal
Add a `discovery_runs` metadata table to `vacancy-engine.db` so scan history becomes queryable, by inserting one row per scan (id, generated_at, vacancy_count, report_json_path, report_html_path) at the same point `writeGlobalRemoteReport` already writes the report files to disk (`packages/vacancy-engine/src/global-remote/report.ts:209-247`).

## Why now
From the audit's state/footprint review: discovery/report data currently has no durable, queryable store. `writeGlobalRemoteReport` writes `reports/global-remote/latest.json` (overwritten on every scan) plus one timestamped copy per scan, and none of that ever gets inserted into `vacancy-engine.db`. The only durable database record of a discovered vacancy is whatever `saved_jobs` snapshots at save time -- `SearchPage.tsx:96-109` defensively copies role/company/location/salary/verification/matchPercent into the saved-job row precisely because there is no fallback re-hydration path back to the originating scan. Two concrete gaps follow from this: there is no way to answer "has this vacancy changed since it was saved" (no prior-scan record to diff against), and no way to answer "show me discovery history for vacancyKey X" without grepping timestamped JSON files on disk. This ticket is metadata-only and additive -- it doesn't touch the snapshot behavior in `SearchPage.tsx` or attempt a relational rebuild of the report -- but it's the prerequisite row-per-scan index that both of those features, and the separately-ticketed report-retention job, would key off instead of a directory listing.

## Scope
- New `discovery_runs` table in `vacancy-engine.db` with columns: `id`, `generated_at`, `vacancy_count`, `report_json_path`, `report_html_path`.
- One row inserted per scan, written at the same point `writeGlobalRemoteReport` (`packages/vacancy-engine/src/global-remote/report.ts:209-247`) already writes `latest.json` and the timestamped copy -- the insert records the paths of the files just written, not a copy of their contents.
- Migration for the new table, following whatever pattern the existing `vacancy-engine.db` schema/migrations already use.

## Non-goals
- No change to the JSON report format or to `writeGlobalRemoteReport`'s existing file-writing behavior -- the timestamped JSON dump on disk remains the source of truth for the full report; this table only indexes it.
- No change to `saved_jobs`' snapshot-copy behavior in `SearchPage.tsx:96-109` -- re-hydration/staleness-detection against `discovery_runs` is a follow-on feature, not part of this ticket.
- No staleness-detection UI, no "has this vacancy changed" diffing logic, and no history browser -- this ticket only creates the table and the write path; consuming it is future work.
- No relational breakdown of individual vacancies within a run -- `vacancy_count` is a scalar count, not a row-per-vacancy join table.

## Acceptance criteria
- `vacancy-engine.db` has a `discovery_runs` table with the five columns listed above, created via migration.
- Every completed global-remote scan produces exactly one new `discovery_runs` row, written at the same point in `writeGlobalRemoteReport` where the report files themselves are written, with `report_json_path`/`report_html_path` pointing at the actual files just written for that scan and `vacancy_count` matching the number of vacancies in that scan's report.
- A scan that fails before `writeGlobalRemoteReport` completes does not leave a partial or orphaned `discovery_runs` row.
- Existing report-writing tests continue to pass, plus new coverage asserting a `discovery_runs` row is inserted with correct paths and count after a scan.

## Risk
Low. This is a pure addition -- a new table and one insert alongside an existing, already-working write path -- with no changes to existing report generation, existing schema, or the `saved_jobs` snapshot flow. Main risk is scope creep into staleness/history features that this ticket deliberately excludes, or drift if `report_json_path`/`report_html_path` are recorded before the corresponding file write is confirmed to have succeeded.
