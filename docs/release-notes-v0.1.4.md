# Release notes: v0.1.4

Windows x64 MVP release candidate for clean-machine testing.

Independent acceptance is tracked in [issue #354](https://github.com/jortega0033/open-vacancy-radar/issues/354).
The manual installed-app smoke test and the clean-machine QA (#354, #39) have NOT been done for
this build yet.

## What's new since v0.1.3

Built from the 101 commits between `v0.1.3` and `master`. The PR numbers below point to the full
history.

**Search and discovery sources**

- Czech MPSV open vacancy data is available as a source. It is off a role-gated scan and keeps
  only the newest 5,000 rows. Personal contact details are not ingested (#615).
- TheirStack paid Jobs API is off unless you set the `THEIRSTACK_API_KEY` environment variable and
  enable the source (#616).
- PhilJobNet is off by default. A terms review is still pending, so it stays opt-in (#618).
- An opt-in background ATS source scout runs in the desktop lifecycle (#614).
- Y Combinator Startup Jobs and Work at a Startup are marked prohibited. There is no scraper, no
  provider and no login automation, and AI web discovery drops those hosts (#619, #620).
- On-demand AI web search for vacancies (#410). Results with no score rank by query-match strength
  before recency (#409). On-site and hybrid vacancies are flagged (#596).
- Scans that match nothing keep the previous report and show a hint (#572, #583). Browse-all
  scans ignore leftover filters (#406), and just-submitted role and location filters apply to
  live results (#397).
- Secondary Search filters moved into one Filters popover with active-filter chips (#606).
- Source access desk research was added for further candidate sources (#613, #621). It does not
  add sources by itself.

**Applications and CV tailoring**

- A tailoring case flow for CVs: case inputs and job-description completeness gating, requirement
  and evidence review with per-fact and per-wording approval, a hardened assembler, export of a
  frozen snapshot with DOCX validation, and main-process enforcement of source review (#430 to
  #433, #437, #438, #439).
- Every PDF page can be read inside the review panel, and approved claims are checked against the
  PDF text (#440).
- A reviewed AI transcription fallback for scanned PDF CVs (#411).
- A local MCP layer for the tailoring case: transport, grants, audit, staging layer and tools
  (#420, #423, #426).
- Clearer review outcomes, undoable skip and a two-pane review dialog (#517). Answering "I don't
  know" closes a requirement question as a confirmed gap (#581).
- Letters: export file names carry the right extension and company (#592), a letter saved from the
  review hand-off links to its application (#603), and a missing cover letter now says why and
  offers Try again (#594).
- A one-time Support dialog after the first sent application, plus a Support section in Settings
  (#520). The setup checklist can be reopened from Settings (#591).
- Diagnostics include engine, page and provider state with a reviewable preview, and file paths
  containing spaces are redacted (#518, #600).

**UX text and accessibility fixes**

- Shorter text across Search, CV, applications, letters, Settings and runtime pages, with
  technical internals moved to Advanced, and no dashes or jargon in UI text, kept in check by a
  copy test (#516, #537, #542, #543, #544).
- Accessibility: scan announcements, keyboard zoom, control contrast, reduced motion (#512),
  readable secondary text and a shared warning banner (#515), shared Tabs and Menu components
  (#513), and a jsx-a11y lint rule with an axe audit that fails only on new violations (#519,
  #598).
- Guided provider-limit notices (#546, #547, #570) and plain AI helper errors with Try again
  (#514).
- Layout fixes: saved jobs table at 1280px and desktop widths (#511, #571), at least four Search
  rows at 1000x700 (#576), banner buttons within bounds (#567), sidebar badge shows the count only
  (#566), dark theme hint contrast (#568), and no raw HTML tags in excerpts and job descriptions
  (#574).
- Other fixes: an approved CV is no longer revoked by unrelated actions (#584), saved search role
  and date show after restart (#602), and the Maximum projects field no longer silently blocks
  Save (#504).

**Packaging and CI**

- Packaged Windows smoke, an NSIS lifecycle gate, and a migration and recovery runbook (#617).
- Daemon startup: a slow-but-alive boot gets one more ready window before respawn (#429), and the
  app attaches to the winning daemon on a lock conflict (#424).
- Test stability: raised timeouts and limited CI parallelism (#597), fake timers for crawler
  timeout tests (#586), and several flaky suites made deterministic (#417, #422, #569, #604).
- A canonical capability matrix with a mechanical check (#612).

**Dependencies**

- Bumps include @electron/rebuild 4.2.0 (#226), @testing-library/jest-dom 7.0.1 (#224),
  globals 17.13.0 (#610), @types/node 22.20.5 (#609), the production minor and patch groups
  (#425, #607), GitHub Actions (#244) and cairosvg for the asset scripts (#14).

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

AI-assisted CV parsing, review, tailoring, matching, interview prep, letter drafting, scanned-PDF
transcription and AI web search send the relevant CV, application and vacancy text through the
locally installed Claude Code or Codex CLI selected by the user. The app stores no provider API
key. Generated output does not overwrite the master CV, application record or letter unless you
explicitly save it.

New sources and privacy:

- MPSV is public, keyless open data. Its dataset is flagged as containing personal data, so
  contact details are not ingested.
- TheirStack sends your search query to a paid third-party API with the key you provide. It is
  disabled until you enable it. The API charges one credit per returned job to the account that
  owns the key.
- PhilJobNet is fetched without login and the Apply login is never followed. It stays off until
  you enable it.
- The ATS source scout is opt-in.
- Y Combinator hosts are blocked by policy. A pasted job description or an external employer link
  still works through the manual flow, and OVR does not fetch the YC page behind it.

See [docs/privacy.md](privacy.md) and [docs/job-source-evidence.md](job-source-evidence.md) for
the full detail.

## Known limitations

- Windows 10 or later, x64 only.
- The installer is unsigned. Windows SmartScreen may show an unknown-publisher warning.
- The manual installed-app smoke test and clean-machine QA (#354, #39) are not done for this
  build.
- Claude Code or Codex must be installed and authenticated separately for AI features.
- No in-app backup, restore, automatic update or production auto-submit support.
- Public vacancy cache has no automatic retention limit.
- MPSV keeps only the newest 5,000 rows.
- A Dependabot high alert on http-cache-semantics is open. It is a dev-only dependency reached
  through electron-builder, and no patched version exists.

## Deferred

- PhilJobNet default-on, pending a terms review.
- Any Y Combinator integration, pending an official feed or written permission.
- Other sources covered only by desk research (#613, #621).
- Code signing.
