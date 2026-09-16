## Goal
Decide, as a product decision, whether `applications.role`/`company`/`location`/`verification` (`apps/desktop/electron/workspace/schema.ts:105-122`) are meant to stay frozen at the moment an application is created from a saved job, or should re-derive from the live `saved_jobs` row whenever `saved_job_id IS NOT NULL`. Right now neither behavior is documented as intentional -- the fields are just populated once and never revisited. This ticket is to record the decision, not to implement it.

## Why now
Found during the audit's state/footprint review. `applications.role`, `company`, `location`, and `verification` are populated once at creation time from the source `saved_jobs` row and are never re-read from it afterward. `repository.ts:255-261`'s `deleteSavedJob` comment explains the FK's `on delete set null` behavior (deleting a saved job detaches its applications rather than removing them), but that comment -- and every other comment near this code -- only addresses deletion. Nothing addresses updates: if a user edits a saved job after an application already exists for it (correcting a typo in the role/company, fixing the location, or updating verification status through `SavedJobDrawer`), that edit never propagates to the already-created `applications` row. The two rows silently diverge and nothing in the code path says whether that's expected.

The codebase already has a template for handling this exact kind of decision explicitly: `application_attempts.sourceCvContentHash` and `jdSnapshotHash` (`schema.ts:169-179`) carry doc comments that state, in plain terms, why the duplication exists -- `sourceCvContentHash` is described as "the attempt's only durable 'CV version'" because `cvDocuments` has no version history and the CV can change or be deleted later. That's a documented design choice, arrived at on purpose. `applications`'s role/company/location/verification duplication has no equivalent statement anywhere. It reads as unowned behavior that happened to fall out of "populate these columns from the saved job at insert time," not a decision anyone made about what an application record should mean.

## Scope
- Product/eng review of `applications.role`, `company`, `location`, `verification` (`schema.ts:105-122`) against `saved_jobs`'s equivalent fields, to settle which of two semantics is correct:
  1. **Frozen record** -- an application is a snapshot of what was applied to at the time of creation, matching the precedent `application_attempts` already sets for CV/JD content. A later saved-job edit intentionally does not touch existing applications.
  2. **Live join** -- when `saved_job_id IS NOT NULL`, the UI should read (or the row should be kept in sync with) the current `saved_jobs` values, so a correction made in `SavedJobDrawer` is reflected everywhere that vacancy is shown.
- Write up both options with enough detail for a product owner to decide, including the migration-risk note below for option 2.
- No code changes in this ticket. A follow-up ticket implements whichever option is chosen.

## Non-goals
- Not implementing either option here.
- Not touching `application_attempts.sourceCvContentHash`/`jdSnapshotHash`, which already has documented, intentional frozen-snapshot semantics and is not in question.
- Not changing `deleteSavedJob`'s existing `on delete set null` detach behavior, which is unrelated to this update-sync gap.

## Acceptance criteria
- A written decision (in this ticket or a linked doc) stating which semantic applications.role/company/location/verification follow: frozen-at-creation or live-derived-from-saved_jobs.
- If frozen-at-creation is chosen: a doc comment added to `schema.ts` near `applications` (105-122), modeled on the `sourceCvContentHash` comment at `schema.ts:170-172`, stating explicitly that these fields are a snapshot and will not reflect later `saved_jobs` edits.
- If live-derived is chosen: a follow-up ticket is opened scoping the read-time join or sync mechanism, including how existing rows that have already diverged from their `saved_jobs` source are reconciled or flagged.
- No code shipped from this ticket itself -- it closes on a documented decision, not a merged change.

## Risk
Low as a decision-only ticket. The risk is deferred to whichever implementation path follows: switching to a read-time join changes what the UI displays for every existing application whose `saved_jobs` row has already drifted since creation, which is a behavior change for historical data, not just new rows, and needs its own migration/backfill plan before it ships. Leaving it as an undocumented frozen snapshot costs nothing today but continues to let users believe (reasonably, from `SavedJobDrawer`'s edit affordance) that a correction there updates everywhere the vacancy is referenced, when it currently does not.
