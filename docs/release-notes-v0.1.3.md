# Release notes: v0.1.3

Windows x64 MVP release candidate for clean-machine testing.

Independent acceptance is tracked in [issue #354](https://github.com/jortega0033/open-vacancy-radar/issues/354).

## What's new since v0.1.2

**Search and matching**

- Live scan progress no longer dims the results/detail pane; a saved report and an in-progress
  rescan can be viewed side by side with an explicit saved/live toggle.
- "Why this matches you" now shows the full deterministic profile-score breakdown (technical/role/
  seniority fit, matching skills, gaps) for freshly scanned vacancies, not just a bare score. Older
  saved reports without a breakdown say so honestly rather than showing a stale or invented one.
- ATS fit replaces its four fixed prose sections with a requirement-by-requirement evidence matrix:
  each requirement is anchored to a job-posting quote and a CV source, with an explicit matched /
  gap / unknown status -- never a numeric score or percentage.
- Resume audit accepts an optional target-role focus, independent of any vacancy.
- CV upload now accepts DOCX files, alongside PDF/TXT/MD.
- A capped, no-auth InfoSec Job Board source is available for cybersecurity roles (see "Safety and
  privacy" below for exactly what it does and does not send).

**Applications**

- Saved answers: an answer you write for a recurring application-form question can be saved and
  reused on a later application with one explicit "Use this answer" click -- never auto-filled.
  Manage saved answers from Settings > Workspace.
- Prepare interview: a grounded, review-only prep pack (likely questions, claims to be ready to
  defend, gaps and how to bridge them, STAR candidates, questions to ask, a before-the-call
  checklist) for an application in recruiter-screen or interview stage, built only from data
  already in your workspace. Nothing is invented, missing context is always stated as missing, and
  nothing is saved automatically.

**Fixes**

- The Search page's "no search profile yet" state no longer surfaces a raw filesystem error.
- The vacancy list no longer collapses to a near-invisible sliver at narrow window widths.
- Escape now closes every dialog, drawer and popover in the app.
- A duplicate-application race, two discovery sources that were feeding the wrong text into the
  job-description field, and a cross-origin iframe field-fill path (a real data-exposure risk) are
  all fixed, following a ground-up architecture and security audit of the whole Search-to-Apply
  pipeline.
- Local workspace database and generated-artifact file permissions are hardened to match the
  daemon's own stores; a stale daemon lease is now reconciled rather than trusted verbatim on
  startup, backed by a bounded auto-respawn with backoff.

**AI Runtime**

- The provider panel now shows context-window pressure and rate-limit headroom for a running
  session, keeps a bounded store of full tool output, and supports bounded search over session
  history.

## Existing MVP capabilities

- Vacancy discovery with progressive results, deduplication, source warnings and filters for role
  or keyword, location, employment type and advertised salary.
- Saved jobs, application tracking, CV library, letter generation and the human-reviewed Search to
  Applications flow.
- Local-first storage with no account, analytics, cloud sync or automatic submission to real
  employers.

## Safety and privacy

Automated form filling and submission remain enabled only for the bundled test fixture. Real
applications require explicit human review and submission on the employer site.

AI-assisted CV parsing, review, tailoring, matching, interview prep and letter drafting send the
relevant CV, application and vacancy text through the locally installed Claude Code or Codex CLI
selected by the user. The app stores no provider API key. Generated reviews, prep packs and drafts
do not overwrite the master CV, application record or letter unless you explicitly save them.

The daemon ships one reviewed MCP provider, InfoSec Job Board: a public, no-auth vacancy-search
server. It needs no credential from you, is not part of the automatic vacancy scan, and has no
screen in the app yet -- only the daemon and Electron's typed bridge can reach it today. A search
through it sends only your search query and a bounded result limit; no CV, letter, application
answer, or Claude/Codex credential is ever part of that request path. See
[docs/privacy.md](privacy.md) for the full detail, including the exact retention bound.

## Known limitations

- Windows 10 or later, x64 only.
- The installer is unsigned. Windows SmartScreen may show an unknown-publisher warning.
- Claude Code or Codex must be installed and authenticated separately for AI features.
- No in-app backup, restore, automatic update or production auto-submit support.
- Public vacancy cache has no automatic retention limit.
