## Goal
Two small, independent workspace.db consistency fixes, bundled because both surfaced from the same audit pass over `workspace/schema.ts` and are cleanups of the same kind: (1) auto-populate `saved_jobs.arrangement` from discovery data instead of leaving it permanently empty until a user manually sets it, and (2) convert `application_attempts.prepared_fields` from a hand-rolled JSON-in-text column to Drizzle's typed `mode:'json'`, matching every other JSON-shaped column in the same file.

## Why now
Found during the audit's state/footprint review, not from a user report. Both are small enough that neither justified its own ticket, but both are genuine, verified gaps:

1. `saved_jobs.arrangement` is never auto-populated from discovery data, unlike every sibling snapshot field. `savedJobInputFor` (`apps/desktop/src/components/search/SearchPage.tsx:96-109`) sets `role`, `company`, `location`, `vacancyKey`, `salary`, `verification`, `matchPercent`, and `sourceUrl` from the live discovery result, but never `arrangement` -- despite `DiscoveryVacancyAudit.employmentType` (`models.ts:250`) already existing as a structured field that could seed it. `SavedJobDrawer.tsx:34,85,158-163` is the only place `arrangement` is read or written, entirely manually, so every saved job starts with an empty arrangement even when the discovery result already carried that information.

2. `application_attempts.prepared_fields` (`workspace/schema.ts:293`) is `text().notNull().default('')` -- a hand-rolled JSON column, manually `JSON.stringify`'d and parsed via `parsePreparedApplicationFields` (`repository.ts:681,1014,1082`), using `''` as a null-sentinel -- while every other JSON-shaped column in the same file (`cv_documents.profile`, `cv_documents.source_cv`, `app_settings.agent_archived_session_ids`, `app_settings.agent_unread_counts`) uses Drizzle's typed `mode:'json'`. This column is the odd one out, and the `''`-as-null convention is a footgun that the typed columns don't share.

## Scope
- Item 1: at save time (wherever `savedJobInputFor`'s output becomes the persisted `saved_jobs` row), populate `arrangement` from `DiscoveryVacancyAudit.employmentType` when present. Keep the existing manual-override path in `SavedJobDrawer.tsx` untouched -- a user's manual edit should still win.
- Item 2: convert `application_attempts.prepared_fields` in `workspace/schema.ts:293` to `text({ mode: 'json' }).$type<PreparedApplicationFields | null>()`. This requires a data migration converting existing `''` rows to `NULL`, and re-verifying every `parsePreparedApplicationFields` call site (`repository.ts:681,1014,1082`) against the new shape (no more manual `JSON.stringify`/`JSON.parse`, no more `''`-as-null check).

## Non-goals
- No change to any other `saved_jobs` field or to the manual-override UI in `SavedJobDrawer.tsx`.
- No change to the other already-typed JSON columns (`cv_documents.profile`, `cv_documents.source_cv`, `app_settings.agent_archived_session_ids`, `app_settings.agent_unread_counts`) -- they're already the target shape.
- No broader schema audit beyond these two columns.

## Acceptance criteria
- A saved job created from a discovery result whose `employmentType` is set has `arrangement` populated on save, without the user touching `SavedJobDrawer`.
- A user's manual edit to `arrangement` in `SavedJobDrawer` still persists and is not overwritten by the auto-populate logic.
- `application_attempts.prepared_fields` is `text({ mode: 'json' })`-typed in `workspace/schema.ts`, with a migration that converts existing `''` rows to `NULL` and leaves populated rows intact.
- All `parsePreparedApplicationFields` call sites (`repository.ts:681,1014,1082`) are updated for the new column shape and their existing tests still pass.
- No regression in existing `application-queue-store` or `workspace-repository` tests.

## Risk
Low for item 1 (`saved_jobs.arrangement`) -- it's an additive populate at save time with the manual-override path left intact, so worst case is a still-empty field, same as today.

Item 2 (`prepared_fields`) is the riskier half of this ticket: it's a schema/type change on a column with existing production rows, requires a real data migration (`''` to `NULL`), and touches three call sites that currently rely on manual `JSON.stringify`/`parse` and a `''`-as-null convention. Getting the migration or a call site wrong could corrupt or silently drop prepared-application data for in-flight application attempts. Should be scoped and tested independently from item 1 even though both land in this one ticket.
