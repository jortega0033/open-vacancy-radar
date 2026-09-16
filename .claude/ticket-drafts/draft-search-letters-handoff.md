## Goal
Wire the "Search -> Letters" live-vacancy handoff. `LetterGenerator`/`LettersPage` already accept an optional `vacancy: SelectedVacancy` prop whose own doc comment says it exists for "the Search page's 'Generate Letter' action" -- but that action does not exist anywhere in `SearchPage.tsx`/`VacancyDetail.tsx` (only a "Save job" button), and `App.tsx` renders `<SearchPage />` with zero props and `<LettersPage onLettersChanged={refreshCounts} />` with no `vacancy` passed. The prop, the plumbing on the Letters side, and the doc comment describing the intended flow all already exist. The action that triggers it does not.

## Why now
Confirmed independently by three separate review passes as the single highest-confidence, lowest-risk item found while researching AI feature opportunities across the app (see the sibling drafts in this folder) -- it needs no AI, no new data flow, and no new infrastructure, and it unblocks real value today: right now, generating a letter for a vacancy found via Search means retyping or pasting the posting into the manual Letters form by hand.

## Scope
- Add a "Generate Letter" action on `VacancyDetail.tsx` (alongside the existing "Save job" action), producing a `SelectedVacancy` from the vacancy lead already in hand.
- Lift the selected-vacancy state into `App.tsx` (or an equivalent shared location) and thread it through the nav transition into `LettersPage`/`LetterGenerator`.
- `App.tsx` today renders pages as mutually-exclusive conditionals (`nav === 'search' && <SearchPage/>`, `nav === 'letters' && <LettersPage .../>`) with no cross-page state; this is the first time two pages need to hand off state; confirm `LetterGenerator` doesn't already own conflicting local state for "current vacancy" before wiring the external prop through.
- Add a consume/clear step so a later, unrelated manual visit to Letters doesn't replay a stale handed-off vacancy.

## Non-goals
- No AI changes. This is pure UI/state wiring.
- Does not address the fact that `VacancyLead`/saved jobs don't carry posting `description`/`requirements` text today (see the draft on persisting gap analysis for why that matters elsewhere) -- the handoff should carry whatever fields `SelectedVacancy` already models, nothing more.

## Acceptance criteria
- From `VacancyDetail.tsx`, clicking "Generate Letter" navigates to the Letters page with that vacancy pre-selected, no manual retyping.
- A manual visit to Letters (not via handoff) behaves exactly as it does today.
- Existing Letters/Search tests unaffected; new test(s) cover the handoff path end-to-end (selecting a vacancy in Search, following the action, asserting `LetterGenerator` receives the expected `SelectedVacancy`).

## Risk
Low. No new external data flow, no privacy-doc changes, no policy surface.
