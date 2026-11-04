# Release notes: v0.1.6

Windows x64 release.

Clean-machine and installed-app QA (docs/release-checklist.md sections 4 and 5) is a manual step on
the tagged build. These notes do not claim it was done.

## What's new since v0.1.5

Built from the 4 commits between `v0.1.5` and `master` at `5760c99`
(`5760c99ad009d4632a301eb2c30219a91f30fb17`, the merge of PR #727). They are the simplification batch
tracked under #683: one Windows provider fix and three application changes. Before each of these 4
PRs was merged, its exact final head passed the status checks that branch protection requires on
`master`: Lint/typecheck/test/build, Electron e2e, Windows installer packaging, the Windows full
suite (Node 22), gitleaks and CodeQL. Each final head also had an independent review by a separate
Claude reviewer agent. That review is a recorded verdict, not a GitHub pull-request approval. The PR
and merge-commit numbers below point to the full detail.

**Windows: Claude Code CLI startup**

- The app now finds a Claude Code CLI it can actually start on Windows. With an npm global install,
  `where claude` lists the extensionless `sh` shim before `claude.cmd`. v0.1.5 used that first line
  as is, so detection reported `claude --version failed` and AI sessions were killed. Now every
  `where` line is considered: the first usable native `.exe` wins, otherwise the first usable
  `.cmd`. Extensionless shims, `.ps1`, `.bat`, stale paths and directories are skipped. A `.cmd` is
  never handed to a shell. It always runs through the shipped Job Host with an absolute
  `System32\cmd.exe /d /v:off /s /c` command line, including the short `--version` and
  `auth status` probes. Every Node spawn stays `shell: false`, the provider environment allowlist is
  unchanged, and a probe timeout or cancel still tears down the whole process tree. POSIX keeps the
  first `which` line. See [providers.md](providers.md). (#719, PR #721, `dbdaeb3`)

**Posting liveness and Ashby**

- Ashby postings can now be checked. Ashby has no public single-posting route, so the check reads the
  employer's official board (the same URL the Ashby source reads, `no-store`, no validators, one
  request) and looks the job up by its id. A job that a well-formed board does not list, or lists as
  unlisted, is closed/removed. A missing board (404/410) or a malformed answer is "could not check",
  never closed. Five sources can now be checked: the four from v0.1.5 plus Ashby.
- Preparation now stops before any AI work on "could not check", unless an open answer from the last
  24 hours, an explicit **Get ready anyway**, or your own **It's open** from the last 24 hours stands
  behind the posting. **It's open** is recorded with its time and shown under **How we know**. A
  later check that finds the posting closed still stops preparation. In v0.1.5, "could not check"
  continued on the stored text.
- Search results show one of four plain states beside the fit score: **Open**, **Not checked yet**,
  **Couldn't check** or **Closed/removed**. Showing a result in the detail pane checks that one
  posting once, through the same verifier and freshness windows; a fresh stored result is reused with
  no request. Searching itself still never checks the list of results as a whole. These summaries
  are kept in memory only and are bounded, so after a restart results read **Not checked yet** again.
  A result a check found closed cannot use the primary **Apply**. The secondary **Prepare anyway**
  starts without AI work, and **Get ready anyway** stays the recorded override. See
  [posting-verification.md](posting-verification.md). (#720, PR #723, `7ec9d31`)

**Blind Apply (opt-in), with zero real employer targets in this build**

- A new, explicit, opt-in mode for frontend roles. Settings > Blind Apply > **Turn on…** shows the
  app's own native dialog (Cancel is the default) listing the role family, the search profile's hard
  filters, the CV it will use and where it can send. After that one confirmation it checks, prepares
  and sends supported applications without a per-job review, and records what happened in one
  activity feed on Applications. **Stop Blind Apply** is one immediate control. There is no daily
  limit, per-employer rule, expiry or artificial wait, by the owner's explicit choice.
- **It submits to zero real employers in this release.** The only compiled target policy that allows
  an unattended send is the local, test-only fixture policy, which resolves only bundled `file://`
  fixture pages by exact path. The UI and the confirmation dialog say so. Every real site, Workable
  and Ashby included, is **Apply yourself**: no tailoring is spent on it, it is never reported as
  submitted, and **Open** starts the normal reviewed flow. Enabling any real target needs a separate,
  human-reviewed policy change with applicant-side terms evidence. This release does not provide
  real unattended submission to any applicant tracking system.
- What has been exercised is synthetic: three local fixture forms (one that can be completed and sent,
  one with questions no stored answer covers, one behind a bot-check marker), unit and runner tests,
  a contract test that runs the real DOM extractor and validator over the fixture HTML, and an
  Electron end-to-end spec. No real employer, real CV, real profile or login was used.
- Checks run in a fixed order before any tailoring: the authorization is active and the CV and
  profile are unchanged since it was confirmed, the role family is frontend, the hard filters pass
  (unknown does not pass), the apply link is verified, the role is not a duplicate, a policy permits
  unattended sending, and the posting is confirmed open now.
- A field is filled only when its whole label equals a known label for a value already in your CV or
  profile, or exactly matches a question you answered and chose to remember. No model chooses a
  submitted value, and job-description text is never an input. Consent boxes, sign-ins, verification
  codes, bot checks and demographic questions are never handled for you: that one application stops
  as **Needs you** (or **Needs one answer**) and the others continue.
- Only an observed confirmation or printed reference makes an item **Submitted**. No confirmation is
  **Sent? Couldn't confirm**, and it is never retried. A Stop is checked immediately before the send
  click; a send already past that point is not interrupted, and completed records are never changed
  by Stop. See [blind-apply.md](blind-apply.md). (#722, PR #726, `6831f16`)

**Submission records**

- An application attempt found at `submitting` after a crash or forced quit now becomes
  `submission_unknown` ("Sent? Couldn't confirm") with a receipt row, and is never restarted or
  clicked again. This gap predated Blind Apply and applies to the reviewed flow too. (PR #726)
- In the new workspace below, **I submitted it** and, when you come back later, **I already submitted
  it** record your own submission through the existing user-reported path. The app never submits for
  a site without a target policy. (PR #727)
- The submitted search intent from v0.1.5 (#684, PR #695) is unchanged in this release.

**One Review & apply workspace**

- On the Search vacancy detail, **Apply** is the one primary action. It builds a draft for review and
  sends nothing. Save job, Compare with my CV and Open posting moved to a secondary group, still
  visible and one Tab away. Apply opens the workspace in place of the detail pane, with the results
  list still on screen: no tab switch and no dialog.
- The same workspace opens from Ready to apply, Saved jobs, a Blind Apply **Apply yourself** item, the
  scheduled-send banner, the return from Letters and a click on the "Application ready" notification.
  A finished application opens the existing history drawer instead.
- Preparation streams in place as plain steps (Checking the posting, Writing your CV, Writing your
  letter and files, Ready to review) in a polite live region. A send in flight reads "Sending your
  application…" and offers no manual submit, Approve or Skip.
- The ready view shows the tailored CV and cover letter together, an optional collapsed **Second
  opinion** (the v0.1.5 critique), then **Approve package**, **Open the employer form** and **I
  submitted it**. Failures (letter missing, provider limit, tailoring stopped, no documents, errors)
  stay in the workspace with their action. Skip keeps an Undo in place. Focus moves deliberately
  after each step. Sites with a target policy still hand over to the existing review dialog with its
  live view and **Send application** gate, unchanged. (#657, PR #727, `5760c99`)

## Safety and privacy

Unchanged: the reviewed flow can fill and send forms only for a site with a compiled target policy,
and the only such policy is the bundled test fixture. Real applications need your review and your
submission on the employer site, whether Blind Apply is on or off. This release adds no mailbox,
calendar, email sending, outreach, automatic learning or real-site automatic application.

New network behaviour:

- Showing a search result in the detail pane checks that one posting once, through the app's
  existing safe HTTP client and source policy (a fresh stored result is reused; a link with no route
  costs no request). An Ashby check reads the employer's public board.
- Blind Apply makes no request to any real employer site in this build. Its preparation uses the
  existing Claude Code or Codex CLI you installed, only after you turn it on.

The Claude CLI fix changes how the CLI is launched, not what it is sent.

New local data in `workspace.db`: migration 0041 adds `blind_apply_authorizations`,
`blind_apply_items`, `blind_apply_events` (append-only) and `blind_apply_answers` (answers you chose
to remember). Posting checks can now record **It's open** as your decision. Settings > Advanced >
Reset application data clears the four Blind Apply tables. Liveness summaries beside search results
are kept in memory only. See [blind-apply.md](blind-apply.md#local-record) and
[posting-verification.md](posting-verification.md). [privacy.md](privacy.md) does not list the Blind
Apply tables or the detail-pane posting check yet; these notes and those two pages are the current
record.

## Known limitations

- Windows 10 or later, x64 only. The installer is unsigned, so SmartScreen may warn about an
  unknown publisher.
- Claude Code or Codex must be installed and signed in separately for AI features.
- The Windows Claude startup fix (#719) is covered by unit tests and Windows-only tests that use the
  real `where`, the Job Host and `cmd.exe`. A normal installed-app launch against a real npm-installed
  Claude has not been verified on this build, and #719 stays open until it is. A CLI reachable only
  through a Microsoft Store app-execution alias may be reported as not installed (a review finding,
  not confirmed for Claude or Codex).
- Blind Apply sends to zero real employers. It has only synthetic fixture coverage and no measured
  real-site success rate. Radio buttons and plain checkboxes that a page requires stop the item as
  **Needs you**. An item that needs one answer is prepared again, including tailoring, after you
  answer. A posting that could not be confirmed open is skipped for the rest of that authorization,
  not retried later. An item you finish in the reviewed flow keeps its earlier Blind Apply label.
- For an Ashby posting, closed means "absent from the employer's official board". A board that drops
  a live posting by mistake reads as closed; you can still open the posting and choose **Get ready
  anyway**. A posting behind a sign-in, a denial or an unsupported source cannot be checked.
- A "Closed/removed" state beside a search result is reused for 24 hours, and Search has no Check
  again; **Prepare anyway** still works. The saved-job drawer shows a match score without a liveness
  state.
- "Could not check" now stops preparation until you confirm the posting or choose **Get ready
  anyway**. This adds a step for sources the app cannot check.
- **Approve package** in the workspace is not saved to disk or to the database. **I already
  submitted it** covers coming back later. Apply is the start label only on the Search
  detail; Saved jobs and the CV library still say **Get ready to apply**. #658 to #662 (open-time
  tracking, a "did you apply" prompt, copy helpers, an "Applied on" date, tailoring hand-off) are not
  in this release.
- No in-app backup, restore or automatic update. Migration 0041 runs forward on first launch, and
  there are no down-migrations. Going back to v0.1.5 after running v0.1.6 is not verified, so back
  up first (see [migration-recovery-runbook.md](migration-recovery-runbook.md#downgrade)).
- Role scoring is still frontend-specific, and Blind Apply accepts only the frontend role family.
- Open Dependabot alerts when these notes were written (2026-11-04). `pnpm audit --prod` reports no
  known vulnerabilities. Alerts remain open, some of them critical or high, for build, test, lint and
  asset tooling. This release does not upgrade them:
  - Pillow and CairoSVG, pinned in `scripts/assets/requirements.txt` for the maintainer asset
    validation and icon generation scripts. They are not part of the app.
  - Vite, @vitest/mocker, source-map-js and brace-expansion, development dependencies used to
    build and test the app.
  - minimatch (medium, opened 2026-10-31). `pnpm why minimatch -r --prod` finds no production path;
    it is reached through ESLint and typescript-eslint.

  The release checklist asks for no open Dependabot alert above low severity. Because these
  tooling alerts are open, that line is not literally met. Tagging remains the maintainer's
  decision.

## Deferred

- Any real employer target policy for Blind Apply (each needs its own human-reviewed policy change).
- Removing the now-unreachable manual branch of the review dialog.
- #658 to #662.
- Code signing.
