# Add retention for timestamped discovery report files (P2)

## Goal
Stop `reports/global-remote/` from growing without bound by adding a retention pass that deletes old timestamped report triples, mirroring the `HTTP_CACHE_RETENTION_DAYS` pattern the same package already uses for its HTTP cache.

## Why now
Flagged in this session's state/footprint audit. `writeGlobalRemoteReport` (`packages/vacancy-engine/src/global-remote/report.ts:209-247`) writes three new timestamped files every time it runs -- `<timestamp>.json`, `<timestamp>.html`, `<timestamp>.audit.ndjson` (lines 219-221, 231-238) -- alongside the `latest.*` files it overwrites in place. It runs on every background scan, scheduled every `BACKGROUND_SCAN_INTERVAL_MS` (4 hours, `apps/desktop/electron/main.ts:2038`) plus every manual scan the user triggers. None of the timestamped files are ever deleted: a repo-wide grep for retention/cleanup logic scoped to `reports/`, `global-remote/*` turned up nothing. That's a real gap, not an oversight the code already covers elsewhere -- this same package has an explicit precedent for exactly this problem: `HTTP_CACHE_RETENTION_DAYS` (`packages/vacancy-engine/.env.example:13`, default 90, validated in `packages/vacancy-engine/src/config.ts:27`) drives an actual purge mechanism for the HTTP cache. The report directory has no equivalent, so on a machine that runs this app continuously for months, it accumulates three new files roughly every 4 hours indefinitely.

## Scope
- Add a config key for report retention mirroring `HTTP_CACHE_RETENTION_DAYS` (same package, same validation shape in `packages/vacancy-engine/src/config.ts`).
- Add a retention pass that deletes timestamped triples (`<timestamp>.json` / `.html` / `.audit.ndjson`) older than the configured number of days, run opportunistically after each `writeGlobalRemoteReport` call (i.e. from the same call site that already invokes it, not a separate scheduled job).
- If the `discovery_runs` metadata table (tracked separately) has landed by the time this is picked up, key the retention query off that table's rows instead of listing the directory. If it hasn't landed yet, fall back to parsing timestamps out of filenames (or file mtimes) directly in `reports/global-remote/`.
- Never delete `latest.json`, `latest.html`, or `latest.audit.ndjson` -- those are read back on startup by `readGlobalRemoteReport` (`packages/vacancy-engine/src/global-remote/report.ts:259` onward) and must always be present once a scan has run at least once.

## Non-goals
- No change to what `writeGlobalRemoteReport` writes per scan, or to the `latest.*` overwrite behavior.
- No change to the HTTP cache's own retention mechanism -- this ticket only reuses its config pattern as a model.
- No new UI for report history browsing or manual purge controls; this is a background cleanup pass only.

## Acceptance criteria
- A new retention config key exists, validated the same way as `HTTP_CACHE_RETENTION_DAYS`, with a documented default in `.env.example`.
- After a scan writes a new timestamped triple, any timestamped triples older than the configured retention window are deleted from `reports/global-remote/`.
- `latest.json`, `latest.html`, and `latest.audit.ndjson` are never deleted by the retention pass, regardless of age.
- If `discovery_runs` exists at implementation time, the retention pass reads from it rather than doing a directory listing; if not, filename/mtime parsing is used and documented as the fallback.
- Test coverage: retention deletes files past the window, keeps files inside it, never touches the three `latest.*` files, and behaves correctly when the report directory has zero or only `latest.*` files (no crash on first run).

## Risk
Low. This is an additive cleanup pass on files nothing else depends on once they age out -- the `latest.*` files carry the only state anything reads back, and the timestamped files exist purely as a historical record. The main way to get this wrong is a bug in the age/filename parsing that deletes a `latest.*` file or a file that's still within the retention window; the acceptance criteria above are written to catch both directly.
