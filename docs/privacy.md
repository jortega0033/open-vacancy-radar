# Privacy and data handling

Open Vacancy Radar is a local-first desktop app. This page states plainly what data it stores,
where, what leaves your computer and to whom, and what you can do about it. It describes the
current, shipped behavior of this codebase, not aspirations.

## What is stored, and where

Everything the app stores lives in Electron's per-user application-data directory
(`app.getPath('userData')` — on Windows, `%APPDATA%\Open Vacancy Radar\`):

- **`workspace.db`** (SQLite): your saved jobs, applications, CV library entries (including any CV
  text you upload or type in), generated letters, and app settings. This is the personal data this
  app exists to manage.
- **`vacancy-engine.db`** (SQLite): the local cache of vacancies discovered from public sources
  (see [the job source policy](job-source-policy.md)) — job postings, not data about you.
- **`ai-workspace/`**: an empty scratch directory handed to AI CLI sessions as their working
  directory. The app doesn't write your data into it; a CLI invoked with a prompt referencing your
  CV text could, in principle, choose to (see "What leaves your computer" below).
- **`.cache/http`**: a local HTTP response cache for the vacancy-discovery pipeline, to avoid
  re-fetching the same public pages repeatedly. Contains fetched public job-listing pages, not
  personal data.

None of this is encrypted at rest beyond whatever your OS disk encryption already provides — it's a
plain SQLite file on your own disk, readable by anything running as your OS user, same as any other
desktop app's local data.

## What leaves your computer, and to whom

- **Vacancy discovery**: the app makes outbound HTTP requests to the public job sources listed in
  [the job source policy](job-source-policy.md) (ATS APIs, RSS feeds, official registries) to find
  vacancies. These requests carry no personal data — they're the same requests any visitor to those
  public pages would trigger.
- **AI features (gap analysis, letter drafting)**: when you use these, the relevant CV text and
  vacancy details are sent as a prompt to whichever AI CLI you've selected (`claude` or `codex`),
  run as a subprocess this app spawns. From there, that data is subject to **that CLI's own
  provider's terms and privacy policy** — Anthropic's for Claude Code, OpenAI's for Codex — not
  this project's. This app has no visibility into what that provider does with the prompt after the
  CLI sends it, and no control over it. See [What this is not](../README.md#what-this-is-not) for
  why this project itself never makes a direct API call or holds an API key.
- **Optional MCP job-source providers**: if you connect one, search queries and your MCP credential
  for that provider go to that specific provider only (see
  [SECURITY.md#three-separate-kinds-of-credential-not-one](../SECURITY.md#three-separate-kinds-of-credential-not-one)).
  No MCP provider is contacted unless you've explicitly connected it. No provider is registered in
  this build, so there is currently nothing to connect — this describes the mechanism's behavior
  once a provider is enabled in a future release.
- **Everything else** — navigation, saved jobs, applications, settings — never leaves your machine.
  There is no account, no cloud sync, and no analytics endpoint this app talks to.

## No telemetry

This app sends no usage analytics, crash reports, or telemetry of any kind to this project or
anyone else. There is no telemetry SDK in the dependency tree and no such endpoint in the daemon or
renderer code. If that ever changes, it will be opt-in and disclosed here first.

## Retention and deletion

- **Saved jobs, applications, CVs, letters**: retained until you delete them through the app (with
  confirm-before-delete and a short undo window on most deletes) or delete `workspace.db` directly.
- **Vacancy cache**: grows over time; there is currently no automatic pruning. Deleting
  `vacancy-engine.db` clears it with no loss of your personal tracker data — it will simply
  re-populate on the next scan.
- **Uninstalling the app**: see [docs/packaging.md](packaging.md) for exactly what the Windows
  uninstaller does and does not remove from `%APPDATA%`.
- **MCP credentials**: removed via the app's own "disconnect provider" action, which calls the same
  OS-credential-store deletion described in SECURITY.md — not simply left behind by uninstalling.

## What this project cannot promise

- It cannot audit or control what an installed `claude`/`codex` CLI, or an MCP provider you
  connect, does with data once it leaves this app's process — that's between you and that
  provider.
- There is currently no built-in export or backup tool beyond copying the files above yourself; see
  [docs/troubleshooting.md#backing-up-and-restoring-your-workspace](troubleshooting.md#backing-up-and-restoring-your-workspace).

## Questions or a data-handling concern

Open an issue on this repository, or see [SECURITY.md](../SECURITY.md#reporting-a-vulnerability)
if the concern is security-specific rather than a general privacy question.
