# The apply path: from ready documents to the employer page

Ticket: #631. Epic: #644. Reference bar: `docs/ux/references.md`, section 7. Out of scope: automatic submission (#627).

## How this was measured

- Walked in code on origin/master (32acb28), not in a running app. I did not run the app. Every step below cites the file that produces it, and the sequence was checked against the committed e2e specs `apps/desktop/e2e/manual-application-review.spec.ts` (Search, Get ready to apply, review dialog, Review, Skip, Open the posting) and `apps/desktop/e2e/tailoring-case.spec.ts` (CV page, open case, export, review and accept each file).
- "Documents ready" means: for the vacancy path, the attempt settles on `needs_user` with "Your application documents are ready." (`electron/application-pipeline.ts:781`); for the CV path, the case's Files step is Done, so a file was exported, read and accepted (`src/components/cv/case-progress.ts:168-181`).
- "Tracked" means the Applications row says the person applied (`Applied`, with a date). The row itself exists from the moment an attempt is created (`syncApplicationForAttempt`, `electron/workspace/repository.ts:2366`), but until then it reads "Needs your input under Ready to apply."
- Screens are in-app views or dialogs. The employer page (system browser) is listed on its own line. Clicks are deliberate clicks or key presses on controls; typing into a field is listed separately. Optional clicks are counted separately from required ones.
- Every real employer site is a manual target today: the target allowlist holds only local fixture pages (#627), so `resolveTargetPolicyId` returns nothing and the review always uses the manual card (`ApplicationReviewSession.tsx:193-202`). The live-view path with Send application (#443) is not part of this count.

## Baseline A: from a vacancy, "Get ready to apply"

Before documents are ready (not in the count, listed for context):

1. Search, vacancy detail: click **Get ready to apply** (`search/VacancyDetail.tsx:301-315`). Main creates the saved job if needed, creates the attempt and queues it (`electron/main.ts:2231-2257`). The Applications row appears as Preparing; the saved job moves to Preparing (`workspace/attempt-application-sync.ts:109`).
2. The app switches to Applications, tab **Ready to apply**, sub-view **Preparing**, with the attempt drawer open over it (`App.tsx:301-307`, `ApplicationsPage.tsx:198-205`, `:249-262`).
3. Wait: reading the job, tailoring, rendering, the cover letter. The page polls every 1.5 s (`ApplicationsPage.tsx:174-196`). An OS notification says the application is ready (`electron/application-preparation-notify.ts`); it has no click action.

From documents ready to the employer page, best case (the person stayed on the page):

| # | What happens | Screen | Click | Wait / state change |
|---|---|---|---|---|
| 1 | Next poll sees `needs_user`; the drawer closes and the review dialog opens by itself, "1 of 1 ready" (`ApplicationsPage.tsx:249-256`) | Applications, Ready to apply | | up to 1.5 s poll |
| 2 | Dialog resolves the target, shows "Getting your application ready" (`ApplicationReviewSession.tsx:572-577`) | Review dialog | | short IPC wait |
| 3 | Manual card: Tailored CV and Cover letter, each with **Review** and **Save copy** (`ManualApplicationReviewCard.tsx:156-190`) | Review dialog | Review CV, Review letter (optional, 2); Save copy (optional, up to 2, each with a save dialog) | system viewer opens per document |
| 4 | Click **Open the posting**; the employer page opens in the browser (`ApplicationReviewSession.tsx:394-398`) | Employer page | 1 | nothing recorded; the card swaps to Not yet / I applied |
| 5 | The person applies, then switches back to the app | | | context switch |
| 6 | Click **I applied** (`ManualApplicationReviewCard.tsx:235-252`); `recordUserReportedSubmission` sets `user_reported`, the row becomes Applied with today's date, the saved job Applied (`application-review-session.ts:947-991`) | Review dialog closes | 1 | tracked |

"Not yet" closes the dialog and records nothing (`onStillInProgress`, `ApplicationReviewSession.tsx:588`). The next visit to Ready to apply opens the same review again (`ApplicationsPage.tsx:264-270`).

Variants that add steps:

- Closed the drawer while preparing: the view stays on Preparing and no review opens by itself. +1 click on **Review (1)** (`ApplicationsPage.tsx:286-290`, `:534-544`).
- Left the page while preparing: +2 clicks (sidebar **Applications**, tab **Ready to apply**) and +1 screen (the Active tab shows first, `ApplicationsPage.tsx:92`).
- Started from Saved jobs instead of Search: the app stays on Saved jobs with a notice; +1 click on **View application** (`saved/SavedJobsPage.tsx:298-309`).
- Already applied to this job: the completed-application guard throws (`workspace/repository.ts:2338`); `startApplicationAttempt` does not catch it (`application-pipeline.ts:297-307`), so Search shows an error banner carrying the repository's technical message instead of "you applied on this date".

## Baseline B: from the CV workspace tailoring case

Starts on CV, **Get ready to apply**, the paste form (`cv-library/ManualCaseForm.tsx`), then the seven-step workspace (`cv/case-progress.ts`). Documents ready is the end of step 7: PDF exported through a save dialog, pages shown in the app, "I read every page and it looks right", optionally the Word file and "I reviewed this in my editor" (`cv/CvArtifactPanel.tsx`, `e2e/tailoring-case.spec.ts:102-154`). The case list then says Done (`cv-library/tailoring-cases.ts:62`).

From there to the employer page and tracked:

| # | What happens | Screen | Click | Typing / wait |
|---|---|---|---|---|
| 1 | There is no button to the employer page. The pasted link is shown only as text inside a collapsed job description disclosure (`cv/JdReview.tsx:213-216`) | CV workspace | open the disclosure (1) | select and copy the link by hand |
| 2 | Switch to the browser and paste the link | Employer page | | context switch |
| 3 | Cover letter, if wanted: it is under **Other tools** and is text only, with Copy to clipboard; it is not stored with the case (`cv/CvAssistant.tsx:403-413`, `cv/CoverLetter.tsx:174-187`) | CV workspace | Other tools, Generate, Copy (optional, 3) | AI run |
| 4 | Nothing is tracked. Sidebar **Applications**, **Add application** (`ApplicationsPage.tsx:457-462`) | Applications, then the New application drawer | 2 | |
| 5 | Type role and company, set Status to Applied, set the date, **Create application** (`ApplicationDrawer.tsx:94-98`, `:205-235`, `:320`) | New application drawer | 3 (status, date, create) | 2 fields typed |

The manual row is not linked to any attempt, so the completed-application guard never sees it: starting Get ready to apply later on the same job from Search creates a fresh attempt.

## Target flow

One **Apply** screen per application. It is a page under Applications (not a dialog), opened straight from Get ready to apply, from the ready notification, from a row under Ready to apply, and from a finished tailoring case.

What the screen shows, top to bottom:

1. Heading "{role} at {company}" (focused on arrival) and one status line: Getting your documents ready, Ready to apply, or what needs attention.
2. While preparing: the same progress the drawer shows today, in place, in a polite live region. The person may leave; the screen becomes ready in place when the poll sees the new checkpoint.
3. Documents: Tailored CV and Cover letter, each with **Open** and **Save copy** (the existing artifact calls).
4. Copy helpers: **Copy letter text**, and Name, Email, Phone, Location and Links from the reviewed CV, each value shown next to its own Copy button. Nothing is copied without a click.
5. One primary button: **Open the employer page**. Secondary: **Skip** (the existing skip with its 10 s undo).

Tracking at open time: clicking Open the employer page records the time the page was opened on the attempt, and the Applications row says "You opened the employer page on {date}." The status does not become Applied: only a receipt or the person's own word does that (#271, #444). The attempt stays non-terminal, so the duplicate guards keep working (below).

The single "Did you apply?" prompt: the first time the app window regains focus after the page was opened, the Apply screen shows an inline bar (not a modal): "Did you apply?" with **I applied** and **Not yet**, and a close button. I applied uses the existing `recordUserReportedSubmission`. Not yet changes nothing and the prompt comes back after the next open. Close (or Escape) dismisses it for this application; the Applications row keeps the opened date and an I applied action. The issue's third option "Skip" is the close button here, because a third button labelled Skip would collide with the Skip that drops the application. It never blocks: every other control on the screen works while it is shown.

Duplicates, reusing what exists:

- Same job already in progress (including opened, not confirmed): the concurrency guard returns the existing attempt (`repository.ts:2316-2326`, mapped to `ok` in `main.ts:2252`), and the Apply screen opens on it.
- Already applied (`submitted`, `user_reported`, `submission_unknown`): the completed-application guard (#275) is caught and returned as a reason with the date; Get ready to apply reads "Applied on {date}" and opens the Applications row. Reapply stays the explicit, recorded path; it is not offered as a default.
- A finished tailoring case handed to Apply creates a linked attempt, so the same two guards apply to it.

Failure states, reusing the existing phases and copy:

- Letter missing: the CV row is ready, the letter row says why and offers Try again and Generate letter (`letter-blocker.ts`). Open the employer page stays enabled; the note says the letter can be added on the employer site.
- Provider limit: the usage limit notice with its reset time (`PipelineLimitNotice`); Try again stays disabled until the reset (`useWaitingForReset`). If the CV is ready, the employer page still opens.
- No documents (tailoring stopped): Use my CV as it is and Try again become the primary actions; Open the employer page stays available as a secondary button, so the person is never stuck.
- No CV, or no link: the reason is shown on the vacancy or the Apply screen with the one action that fixes it (Add your CV; Add the link to the posting), never only in a tooltip (#641).

Keyboard and screen reader:

- Arrival moves focus to the heading; the tab order is documents, copy helpers, Open the employer page, Skip.
- Progress and "Copied email" style confirmations are announced through `role="status"`; errors through `role="alert"`, as today.
- The return prompt is announced politely and does not take focus or trap it; Escape closes it.
- No gestures: the swipe stays off (#630). Every action is a button with a visible label. Reduced motion handling is unchanged.

### Target, vacancy path

| # | What happens | Screen | Click |
|---|---|---|---|
| 1 | Get ready to apply opens the Apply screen; documents become ready in place | Apply | |
| 2 | Open the tailored CV (and letter) to read it | Apply | 1 (review) |
| 3 | Open the employer page; the application is tracked as opened | Employer page | 1 |
| 4 | Back in the app: "Did you apply?", I applied | Apply | 1, optional, never required |

### Target, CV workspace path

| # | What happens | Screen | Click |
|---|---|---|---|
| 1 | Files step Done: **Get ready to apply** on the case hands the accepted files to a new linked attempt | Apply | 1 |
| 2 | Open the employer page; tracked as opened. The files were already read page by page in the case, so no second review is needed | Employer page | 1 |
| 3 | "Did you apply?", I applied | Apply | 1, optional |

## Step counts

From documents ready to the employer page open and the application tracked. In-app screens exclude the employer page itself.

| Path | In-app screens | Required clicks | Optional clicks | Typed fields | Waits after ready | Tracked |
|---|---|---|---|---|---|---|
| A today, best case | 2 (Ready to apply, review dialog) | 2 (Open the posting, I applied) | 2 to 4 (Review, Save copy) | 0 | poll up to 1.5 s, target check | only after I applied |
| A today, left the page | 3 (Active tab, Ready to apply, dialog) | 4 | 2 to 4 | 0 | as above | only after I applied |
| A today, from Saved jobs | 2 | 3 (View application, Open the posting, I applied) | 2 to 4 | 0 | as above | only after I applied |
| B today | 3 (workspace, Applications, drawer) | 6 (disclosure, sidebar Applications, Add application, status, date, create) | 3 (letter) | 2, plus copying the link by hand | none | only by hand, not linked to the guard |
| A target | 1 (Apply) | 2 (open a document, Open the employer page) | 1 (I applied) | 0 | none | at open time, Applied after I applied |
| B target | 1 (Apply) | 2 (Get ready to apply, Open the employer page) | 1 (I applied) | 0 | none | at open time, Applied after I applied |

With the review of both documents, which the person needs before applying, path A today is 2 screens plus the employer page and 4 clicks; the target is 1 screen and 2 clicks. That meets the bar in `references.md`.

## What each removed step protected, and where that lives now

| Removed step | What it protected | Where it lives in the target |
|---|---|---|
| Attempt drawer while preparing | Seeing progress and a failure as it happens | Progress and failures in place on the Apply screen, in a live region; the OS notification stays and gains a click that opens the screen |
| Switching to Ready to apply and its Review sub-view | One list of everything waiting, with history | The Ready to apply tab stays as that list; it is no longer a required stop |
| Review dialog over the page, "1 of 1 ready" | Document review (Review, Save copy) and the person's final decision | The same Open and Save copy controls on the Apply screen; the person still submits on the employer site, the app sends nothing |
| I applied as the only moment anything is recorded | That Applied means a receipt or the person's word | The open time is recorded automatically, but Applied still needs I applied or a receipt; the deriving rule in `attempt-application-sync.ts` is unchanged |
| Not yet / I applied swap on the card | Not losing an application the person has not finished | The opened date on the row plus one prompt on return; the attempt stays non-terminal until the person answers |
| Raw error when the job was already applied to | Not sending a second application to the same job (#275) | The same guard, shown as "Applied on {date}" with a link to the row |
| CV path: hunting for the link | Nothing | The link is the Open the employer page button; a case without a link asks for it |
| CV path: Add application drawer by hand | Control over what the tracker says | The row is created and kept in step from the attempt (#444), and stays editable in the drawer |

Not removed: the live view, the field review and the two-step Send application for allowlisted targets (#202, #443); the completed-application guard and the reapply path (#275); Skip with undo (#468); the PDF page review before a case's file can be accepted (#435).

## Risks

- "Tracked at open time" can be read as "applied". The row wording must say opened, not applied, and the status must not change until the person answers.
- Opening the page needs a new stored value on the attempt (the open time). It should not be a new checkpoint, so the guards and the sync mapping keep their meaning; it needs a migration and a reconcile for older rows.
- Focus return is a guess: the person may come back before applying. Not yet and the close button keep it harmless, and the prompt shows once per open.
- Copy helpers put personal data on the clipboard, where a clipboard history may keep it. Copy only on a click, show the value first, and never copy several fields at once.
- The letter is stored only as a PDF today (`application_artifacts` has no text column). Copy letter text needs the text kept at staging time.
- A manual tailoring case may have no link and no requisition, which makes the duplicate identity weaker. The handoff should require a link before the employer page button is enabled.
- Several ready applications at once: the Apply screen shows one; it needs a plain "Next ready application" link so the list is not the only way on.
- These counts come from code and specs, not from a session in the running app. The usability test in #644 should check them once before and once after.

## Follow-up tickets

Each is independently shippable and links back to #644. The ones marked "works on today's card" can ship before #657.

| Ticket | What | Depends on |
|---|---|---|
| #657 | One Apply page from Get ready to apply to the employer page | none |
| #658 | Track the application when the employer page is opened | none (works on today's card) |
| #659 | Ask "Did you apply?" once when the app regains focus | #658 for the opened date on the row |
| #660 | Copy buttons for the letter text and contact fields | none (works on today's card) |
| #661 | Show "Applied on {date}" instead of an error for a job already applied to | none |
| #662 | Hand a finished tailoring case to the Apply page and track it | none (falls back to today's dialog) |
