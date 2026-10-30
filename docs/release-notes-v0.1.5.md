# Release notes: v0.1.5

Windows x64 release.

Clean-machine and installed-app QA (docs/release-checklist.md sections 4 and 5) is a manual step on
the tagged build. These notes do not claim it was done.

## What's new since v0.1.4

Built from the 26 commits between `v0.1.4` and `master` at `5f368ce`. Most of them are one batch
of AI job-search changes: two dependency security fixes, nine shipped features and two research
records (tracker #683). Before each of those 13 PRs was merged, its exact final head passed the six
status checks that branch protection requires on `master`: Lint/typecheck/test/build, Electron e2e,
Windows installer packaging, the Windows full suite (Node 22), gitleaks and CodeQL. That is ten
check runs per PR, because CodeQL runs four language analyses. Each final head also had an
independent review by a separate Claude reviewer agent. That review is a recorded verdict, not a
GitHub pull-request approval. The PR and merge-commit numbers below point to the full detail.

**Security**

- The shipped Electron runtime is now 44.9.3 (was 44.0.0). It fixes GHSA-jr5w-w6x2-84p9 (high),
  four medium and three low advisories for Electron 44. The jsPDF dependency's DOMPurify, which the
  renderer build bundles, is now 3.4.17 (was 3.4.14). It fixes GHSA-cg2g-xh64-v4q7 (critical),
  GHSA-mrv2-3pqr-j5jr (high) and three low advisories. This is a lockfile-only update inside the
  existing version ranges. A desktop test fails if Electron drops below 44.9.1 or DOMPurify
  below 3.4.17. (#716, PR #717, `5f368ce`)
- The production dependency audit is clean again. Patched releases of `@modelcontextprotocol/sdk`
  1.32.0, `@modelcontextprotocol/client` 2.3.0, zod 4.6.6 (the zod 3 packages moved to zod 4),
  fastify 5.12.7, undici 7.30.1, fast-uri 4.2.3, ip-address 10.7.5, body-parser 2.4.0 and qs 6.17.0
  are in. No advisory was ignored. (#696, PR #697, `d0aab56`)

**Search**

- AI web search now searches what you typed for this scan (role, country, employment type), not
  the saved profile. Saved skills are given only as background. "Unspecified location" is never
  searched as a place. The scan panel shows a "Searching for: ..." line. (#684, PR #695, `5428fd4`)
- Job-site results stream onto the Search page while the optional AI web search is still running.
  Before, the scan waited up to 90 s for the AI step first. AI rows are still deduplicated and
  scored into one report, and Stop cancels both. (#685, PR #699, `c2cf73d`)
- A reviewed search plan: approve equivalent titles, their languages and markets under "What you
  are looking for". Then turn on "Also search my N approved titles". The typed query still runs
  first. Every network request in the plan counts against one allowance: 1,000 requests, 15
  minutes and 5,000 matching rows. Each source row reports what was sent, refused or deferred.
  (#686, PR #700, `e3b32aa`)

**Applications**

- Before preparing, resuming or reopening an application, the app checks the live posting once.
  "Closed" stops before any AI work. "Requirements changed" shows the removed and added lines
  before anything is regenerated. "Could not check" says it does not mean closed. See
  [posting-verification.md](posting-verification.md). (#687, PR #701, `2393891`)
- A versioned application brief per saved job, shown in the saved-job and application drawers. It
  covers why the job was shortlisted, eligibility answers (unknown stays unknown), strengths and
  gaps against the reviewed CV when they were read against the same posting and CV, posting check,
  company evidence and what was sent. An optional "Assess selected jobs" batch takes at most 5
  jobs, one at a time, with at most 2 requests per job. No new job starts after 15 minutes, and you
  can cancel at any time. See
  [application-brief.md](application-brief.md). (#688, PR #703, `68b39c5`)
- Company evidence: claims about an employer with their public source, saved passage, check time
  and expiry. They are reused only in the prepared cover letter and in "Prepare interview". A claim
  is usable only when the app found the passage on the page and the claim repeats one whole
  sentence of it, or when you confirmed it yourself. "Research this company" is an explicit,
  bounded and cancellable Claude session. See [company-evidence.md](company-evidence.md). (#689,
  PR #702, `3b0c694`)
- Optional "Review this application" on a prepared package. It runs one closed-tool, no-network
  pass over the exact stored drafts. Findings are shown only with evidence the app checked itself.
  Suggested changes must pass the same validators drafting uses, and you choose Use this or Not
  now. See [application-critique.md](application-critique.md). (#690, PR #704, `7a73ccf`)
- Interview prep starts from the documents recorded at submission (by draft version and hash), not
  from today's CV library. You can record interview rounds, and your own notes feed the next prep
  pack, attributed to you. See [interview-context.md](interview-context.md). (#691, PR #705,
  `05860c1`)
- Local follow-ups on the Applications table: due actions with a named time zone, overdue and
  due-today counts, and history. They work with no AI, network or account. A follow-up message
  draft is written only when you press the button. You review it, and only your confirmed "I sent
  this" marks it sent. The app never sends it. See [follow-ups.md](follow-ups.md). (#692, PR #706,
  `29b69dd`)

**Research and decision records (no production behaviour)**

- Outcome and recurring-gap feedback (#693, PR #707, `d31a4b8`): a design and test-only
  prototype on synthetic data. The result is **do not ship automated calibration**. Today's
  recorded data cannot support it. Nothing in this release learns from outcomes, suggests profile
  changes or adds a feedback loop. See [outcome-gap-research.md](outcome-gap-research.md).
- Role scope (#694, PR #712, `1255010`): **frontend stays the only production role scope**. A
  backend role-family comparator was evaluated as research option B on a synthetic corpus. It is
  test-only and not selected for production. See [role-scope-research.md](role-scope-research.md).

**Earlier fixes since v0.1.4 (2026-10-06 and 07)**

- Onboarding: the company list downloads automatically on first launch. A switch under Settings,
  Search, Company list turns this off (#651). Setup hands off to a first search for the CV's role (#652).
  Upload your CV is the primary action on an empty CV page (#647). Saving a CV fills empty search
  profile fields (#632). The first window opens large enough to show sidebar labels (#648).
- A short "What you are looking for" summary replaces the long profile form (#654). One name per
  concept across profile and apply terms (#655, #656). Disabled controls explain themselves on the
  page, not in tooltips (#649). The swipe gesture is hidden on review cards (#645). A closed
  attempt flyout stays closed across refreshes (#646).
- Docs: UX reference flows (#650) and a QA wording correction in the v0.1.4 notes (#626).

**Release tooling**

- The release workflow refuses a tag that does not match the committed version, or a commit that
  is not on master. It builds and smoke-tests the installer on the tagged commit, then publishes
  from a separate job, so the build runs with a read-only token. It can also run as a
  non-publishing dry run. The `.sha256` file now names the asset as GitHub serves it, so
  `sha256sum -c` works after download. The v0.1.4 file named a path with spaces that downloads do
  not have.
- Every dry run now also rehearses the publish hand-off without publishing. A read-only job
  downloads the dry run's own installer artifact and re-checks it against the build's hash. It then
  composes the release notes with their provenance footer, exactly as the publish job does. It
  uploads nothing and cannot create a release. The installer artifact name now includes the run
  attempt, so re-running the whole workflow does not collide with an earlier attempt's artifact.

## Safety and privacy

Unchanged: automated form filling and submission work only for the bundled test fixture. Real
applications need your review and your submission on the employer site. This release adds no
mailbox, calendar, email sending, outreach, automatic learning or automatic application of any
kind.

New AI requests go through the Claude Code or Codex CLI you installed. Each starts only when you
press its button:

- "Assess selected jobs" sends the posting text, CV text and reviewed CV details of each selected
  job.
- "Research this company" uses Claude's web search and fetch, then the app fetches the cited pages
  itself.
- "Review this application" sends the stored drafts, the posting, the reviewed CV facts and the
  usable company facts.
- A follow-up draft sends the application context it is written from.

The posting check fetches the one posting URL through the app's existing safe HTTP client. The
first-launch company list download can be turned off in Settings.

New local data in `workspace.db`: application briefs, company evidence, critique drafts with CV and
letter text, submission manifests, interview rounds and notes, and follow-up actions and drafts.
Migrations 0033 to 0040 add these tables and the company-list setting. Settings > Advanced > Reset
application data deletes them. See [privacy.md](privacy.md).

## Known limitations

- Windows 10 or later, x64 only. The installer is unsigned, so SmartScreen may warn about an
  unknown publisher.
- Claude Code or Codex must be installed and signed in separately for AI features. Company
  research needs Claude.
- No in-app backup, restore or automatic update. Migrations 0033 to 0040 run forward on first
  launch, and there are no down-migrations. Going back to v0.1.4 after running v0.1.5 is not
  verified, so back up first (see
  [migration-recovery-runbook.md](migration-recovery-runbook.md#downgrade)).
- Unmeasured outcomes. All evaluations in this batch used synthetic fixtures with labels written by
  their author, not human judgements. No live provider or job site was contacted. No gain in search
  coverage, recall, cost, latency, decision quality or hiring outcome is claimed.
- Eligibility answers repeat what a posting or source said. They are not legal advice and do not
  guarantee work authorisation. Unknown stays unknown.
- A posting behind a sign-in, a denial or an unsupported source cannot be checked and shows as
  "could not check". Requirement-change detection is a heuristic.
- Company evidence is a wording check, not truth verification. True paraphrases stay leads.
- Search plan titles are matched against job titles, and plan coverage arrives with the final
  report, not streamed.
- Role scoring is still frontend-specific. Saved target roles from another field do not change
  scores.
- Open Dependabot alerts when these notes were last updated (2026-10-30). The 13 Electron and
  DOMPurify alerts were closed by #717, and no open alert names a package that ships in the
  installer. Alerts remain open, some of them critical or high, for build, test and asset tooling
  that is not packaged. This release excludes them and does not upgrade them:
  - Pillow and CairoSVG, pinned in `scripts/assets/requirements.txt` for the maintainer asset
    validation and icon generation scripts. CI installs them to validate the committed assets.
    They are not part of the app.
  - Vite, @vitest/mocker, source-map-js and brace-expansion, development dependencies used to
    build and test the app. Dependabot classifies them as development scope. The Vite alerts
    concern its dev server and editor launch.

  The release checklist asks for no open Dependabot alert above low severity. Because these
  tooling alerts are open, that line is not literally met. Tagging remains the maintainer's
  decision.

## Deferred

- Any production feedback loop from outcomes (#693 lists the instrumentation it would need).
- A production non-frontend role family (#694 records option B as research only).
- Code signing.
