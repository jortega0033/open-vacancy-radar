## Goal
Persist a saved job's most recent Gap Analysis result instead of discarding it when the user navigates away. Add a small text column + a "Save analysis" action, mirroring exactly how `letters.body` already persists AI-generated output.

## Why now
`GapAnalysis.tsx`/`useAgentRun.ts` currently hold the result only in transient React state. A user who ran gap analysis against 20 vacancies has nothing to show for it a day later, and can't compare across jobs. This is the app's best AI output today and it's the one piece of AI output the app throws away.

## Scope
- Add nullable `gapAnalysis` (text) + `gapAnalysisAt` (timestamp) columns to `savedJobs` in `apps/desktop/electron/workspace/schema.ts`, with a drizzle migration.
- Add a "Save analysis" action beside the existing "Copy to clipboard" action in `GapAnalysis.tsx`.
- Render the saved analysis in `SavedJobDrawer.tsx`, matching the existing pattern used for saved letters.

## Non-goals
- Does not change the gap-analysis prompt itself, or attempt to fix the fact that gap analysis today runs on title/company/location/salary/employment-type only (posting `description`/`requirements` text isn't currently mapped into `VacancyLead` for the UI layer, even though the underlying vacancy-engine DB stores it for scoring/hashing) -- that's a separate, larger mapping change and shouldn't block this ticket. The persisted artifact will be exactly as rich as what gap analysis produces today, no more.
- No new external data flow -- this persists output from a call the app already makes and already discloses.

## Compliance note
`docs/privacy.md` currently discloses that gap-analysis *prompts* (CV text + vacancy details) leave the machine via the CLI subprocess, but says nothing about the *output* being persisted long-term in `workspace.db`. This ticket should add one line to `docs/privacy.md`'s retention/deletion section covering the new stored field, so the doc keeps describing current, shipped behavior rather than going stale.

## Acceptance criteria
- Running gap analysis on a saved job and clicking "Save analysis" persists it; reopening `SavedJobDrawer` for that job later shows the saved result without re-running anything.
- `docs/privacy.md` updated to disclose the new persisted field.
- Existing `savedJobs`/`SavedJobDrawer` tests unaffected; new test covers save + reload.

## Risk
Low. No new AI infra, no new data leaving the machine, straightforward schema/UI addition.
