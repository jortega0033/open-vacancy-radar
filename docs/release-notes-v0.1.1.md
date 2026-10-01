# Release notes: v0.1.1

Windows x64 MVP release candidate.

## What's in

- Vacancy discovery across public ATS APIs, RSS feeds, official registries and curated sources,
  with deduplication, progressive results and source warnings.
- Search filters for role or keyword, location, employment type and advertised salary.
- Saved jobs, application tracking, CV library, CV matching and AI-assisted letter drafting.
- A direct Search to Applications flow. Preparing a vacancy creates a durable review item with
  tailored documents when generation succeeds.
- Manual swipe review for application decisions. Real employer links always continue with explicit
  human review and submission on the employer site.
- Local-first storage, no account, no analytics and no cloud sync.
- A complete application-data reset that clears personal records, generated application files,
  application queue ids, automation grants and the search profile. Public vacancy cache remains.

## Safety boundary

Automated form filling and submission are enabled only for the bundled test fixture. This release
has no production target policy that can automatically submit a real application. CAPTCHA,
unknown fields and unverified targets require human action.

AI-assisted CV parsing, tailoring, matching and letter drafting send the relevant CV and vacancy
text through the locally installed Claude Code or Codex CLI selected by the user. Provider terms
apply after the CLI sends that prompt. The app stores no provider API key.

## Known limitations

- Windows 10 or later, x64 only.
- Installer and app are unsigned. Windows SmartScreen may show an unknown-publisher warning.
- Claude Code or Codex must be installed and authenticated separately for AI features.
- No in-app backup or restore. Follow the manual three-item backup procedure in
  [troubleshooting.md](troubleshooting.md#backing-up-and-restoring-your-workspace).
- No automatic update mechanism. Install future versions manually.
- Public vacancy cache has no automatic retention limit. It can be deleted and rebuilt.
- No production MCP job-source provider is registered in this release.

## Deferred

- Production auto-fill and auto-submit policies.
- In-app backup, export and restore.
- Code signing and macOS or Linux packages.
- Automatic vacancy-cache pruning.
