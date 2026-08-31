# Release notes — v0.1.0

First packaged release. Windows only.

## What's in

- **Vacancy discovery** across the public sources in
  [job-source-policy.md](job-source-policy.md) (ATS APIs, RSS feeds, official registries), scored
  and deduplicated by the local vacancy engine.
- **Application tracker**: save jobs, log applications, track status.
- **CV library**: upload/manage multiple CVs, AI-assisted parsing into structured profile data
  (see issue #25's delivered work — replaces the earlier OCR-based approach).
- **Letters**: AI-assisted cover-letter drafting per application, with copy-to-clipboard and
  export (md/docx/pdf).
- **AgentDock runtime**: BYOS model — features that use AI run through your own installed and
  authenticated `claude` or `codex` CLI. This app never holds an API key and never talks to an
  AI provider directly; see [README.md#what-this-is-not](../README.md#what-this-is-not).
- **Optional MCP job-source providers**: no provider is registered in this release, so there is
  nothing to connect from the app yet — see
  [SECURITY.md#three-separate-kinds-of-credential-not-one](../SECURITY.md#three-separate-kinds-of-credential-not-one)
  for the current status and what the credential-storage mechanism does once one is registered.
- No telemetry, no account, no cloud sync — see [privacy.md](privacy.md).

## Known limitations

- **Windows only.** macOS and Linux are untested and unpackaged; see
  [packaging.md#platform-matrix](packaging.md#platform-matrix).
- **Unsigned installer.** Expect a Windows SmartScreen warning on first run; see
  [packaging.md#unsigned-installer-and-smartscreen](packaging.md#unsigned-installer-and-smartscreen).
- **No backup/restore feature.** Your data is a plain SQLite file you'd copy yourself; see
  [troubleshooting.md#backing-up-and-restoring-your-workspace](troubleshooting.md#backing-up-and-restoring-your-workspace).
- **No vacancy-cache pruning.** `vacancy-engine.db` grows unbounded over time (safe to delete; see
  [privacy.md#retention-and-deletion](privacy.md#retention-and-deletion)).
- **Single instance only.** Launching a second copy focuses the existing window rather than
  running two daemons concurrently; see
  [daemon.md#single-instance-behavior](daemon.md#single-instance-behavior).
- AI features require you to separately install and authenticate a `claude` or `codex` CLI
  yourself — this app doesn't bundle or provision one.
- **No MCP job-source provider is registered yet** — see "Optional MCP job-source providers" above.
- **A session's event history does not survive a daemon restart.** This was a deliberate scope
  decision for this milestone, not an oversight; see [architecture.md](architecture.md), section
  "Deliberate omissions (v0.2)". Verified against the real daemon and client: a client that
  reconnects to a session id from before a restart gets a clean `404 session not found`, and a
  session whose daemon connection is lost mid-run (rather than a stale id after the fact) now
  surfaces that failure immediately as a normal error message, not a multi-minute stall — never a
  silent hang or crash either way.

## Privacy implications

Using the AI-assisted features (CV parsing, gap analysis, letter drafting) sends your CV text and
job details as a prompt to whichever CLI/provider you've chosen, subject to that provider's own
terms — not this project's. Everything else (saved jobs, applications, settings, navigation) never
leaves your machine. Full detail in [privacy.md](privacy.md).

## Deferred to a future release

- macOS/Linux packaging and code signing.
- In-app backup/export/restore.
- Vacancy-cache pruning/retention limits.
- Branch-protection and CI release-gating policy decisions.
