# Release notes: v0.1.2

Windows x64 MVP release candidate for clean-machine testing.

Independent acceptance is tracked in [issue #354](https://github.com/jortega0033/open-vacancy-radar/issues/354).

## What's new since v0.1.1

- Adds three grounded CV-only tools: resume audit, achievement rewrites and realistic best-fit role directions.
- Renames vacancy gap analysis to ATS fit and routes it through the shared generation input bundle, including reviewed CV facts, complete-posting requirements and input-completeness warnings.
- Keeps ATS-fit and CV-tool results review-only and copyable. No result automatically changes the master CV.
- Groups CV-only and vacancy-specific actions more clearly and verifies the controls at supported desktop window sizes.

## Existing MVP capabilities

- Vacancy discovery with progressive results, deduplication, source warnings and filters for role or keyword, location, employment type and advertised salary.
- Saved jobs, application tracking, CV library, letter generation and the human-reviewed Search to Applications flow.
- Local-first storage with no account, analytics, cloud sync or automatic submission to real employers.

## Safety and privacy

Automated form filling and submission remain enabled only for the bundled test fixture. Real applications require explicit human review and submission on the employer site.

AI-assisted CV parsing, review, tailoring, matching and letter drafting send the relevant CV and vacancy text through the locally installed Claude Code or Codex CLI selected by the user. The app stores no provider API key. Generated CV reviews and drafts do not overwrite the master CV.

## Known limitations

- Windows 10 or later, x64 only.
- The installer is unsigned. Windows SmartScreen may show an unknown-publisher warning.
- Claude Code or Codex must be installed and authenticated separately for AI features.
- No in-app backup, restore, automatic update or production auto-submit support.
- Public vacancy cache has no automatic retention limit.
