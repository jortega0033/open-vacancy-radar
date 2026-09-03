# Privacy and data handling

Open Vacancy Radar is a local-first desktop app. This page states plainly what data it stores,
where, what leaves your computer and to whom, and what you can do about it. It describes the
current, shipped behavior of this codebase, not aspirations.

## What is stored, and where

Everything the app stores lives in Electron's per-user application-data directory
(`app.getPath('userData')` — on Windows, `%APPDATA%\Open Vacancy Radar\`):

- **`workspace.db`** (SQLite): your saved jobs, applications, CV library entries (including any CV
  text you upload or type in), generated letters, any gap analysis you chose to keep, and app
  settings. This is the personal data this app exists to manage.
- **`vacancy-engine.db`** (SQLite): the local cache of vacancies discovered from public sources
  (see [the job source policy](job-source-policy.md)) — job postings, not data about you.
- **`ai-workspace/`**: an empty scratch directory handed to AI CLI sessions as their working
  directory. The app doesn't write your data into it; a CLI invoked with a prompt referencing your
  CV text could, in principle, choose to (see "What leaves your computer" below).
- **`.cache/http`**: a local HTTP response cache for the vacancy-discovery pipeline, to avoid
  re-fetching the same public pages repeatedly. Contains fetched public job-listing pages, not
  personal data.
- **`agentdock-state/`**: the runtime's durable record of AI CLI *sessions* — see the next section
  for exactly what it does and does not contain.

### `agentdock-state/`: session history without session content

When the app runs an AI CLI session (gap analysis, letter drafting), the local runtime daemon keeps
a small durable record of that session so it can answer one specific question after a crash or
restart: **had the CLI already been handed your prompt?** Without that record, a session interrupted
by a restart is indistinguishable from one that never started, and an automatic retry could run the
same work twice in your working directory.

What it holds, per session: the session id, which provider and model ran, the working directory, the
start and end timestamps, the final status, and a per-event line recording the event's *type*, its
sequence number, its timestamp, and — for any event that carried content — the content's **byte
length and SHA-256 hash**.

What it never holds: your prompt text, the assistant's replies, reasoning text, tool inputs or
outputs, or error messages. Those fields are replaced by the length-and-hash pair before anything is
written, structurally rather than by convention — the on-disk record has no field they could be
stored in, and the daemon's own tests fail the build if any event type is added without a redaction
rule for it. A SHA-256 hash cannot be reversed into the text it came from; it exists so two reports
of the same unexplained output can be recognized as the same one.

It lives in its own subdirectory, deliberately separate from `workspace.db` and `vacancy-engine.db`,
and the daemon refuses to start its store in any directory that overlaps them — so a backup, a
database migration, or a workspace reset can never take it along by accident.

### The workspace trust and security log

Alongside the session record, `agentdock-state/` holds two small files covering folder access:
`workspace-trust/trust.json` (which folders you have approved for an AI agent to work in) and
`workspace-audit/audit.jsonl` (an append-only record of each approval, use, and withdrawal).

Neither file contains a folder path or a folder name. A folder is recorded as a pair of SHA-256
digests derived from the filesystem's own identifiers for it — the values the operating system uses
internally to tell one directory from another — never from its name or location. Everything else in
a log line is a fixed keyword from a short list (what happened, why, and whether it was you or a
policy that caused it), a random line id, and a timestamp. There is no free-text field, no folder
name, and no Git branch name in either file, so there is nowhere for a project, client, or employer
name to end up. The app's own tests run a full approve-use-withdraw cycle and then search every byte
of both files for anything path-shaped.

The security log is capped at 64 MB and, unlike the session history, it **never** discards old
entries to make room: if it filled up, the app would refuse to approve new folder access rather than
allow access it could not record. In normal use that cap is tens of thousands of approvals away.

Approving a folder always requires you to pick it in a system folder picker and then confirm a
dialog that spells out what the agent will be able to do in it. The app's interface cannot name a
folder on your behalf and cannot approve one without that dialog.

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
- **Saved gap analyses**: when you click "Save analysis" on a gap-analysis result, that result — the
  AI CLI's own text about your CV against that vacancy — is stored in `workspace.db` on the saved
  job it is about, and is kept there until you delete that saved job. Nothing is stored unless you
  click that button; running an analysis and navigating away keeps nothing. This is storage only:
  the prompt behind it already left your machine when the analysis ran (see "What leaves your
  computer" above), and keeping the answer sends nothing anywhere.
- **Vacancy cache**: grows over time; there is currently no automatic pruning. Deleting
  `vacancy-engine.db` clears it with no loss of your personal tracker data — it will simply
  re-populate on the next scan.
- **Uninstalling the app**: see [docs/packaging.md](packaging.md) for exactly what the Windows
  uninstaller does and does not remove from `%APPDATA%`.
- **MCP credentials**: removed via the app's own "disconnect provider" action, which calls the same
  OS-credential-store deletion described in SECURITY.md — not simply left behind by uninstalling.
- **Session history (`agentdock-state/`)**: pruned automatically, oldest-first, on every daemon
  start. Three bounds apply and whichever is reached first wins: **30 days**, **500 retained
  sessions**, or **64 MB**. A session that is still running is never pruned, and pruning removes a
  session together with any sessions resumed from it rather than leaving a broken chain. Deleting
  the `agentdock-state/` directory yourself is safe at any time the app is closed: it holds no
  personal data and nothing in the app reads it except the restart-recovery check described above.
- **Workspace approvals and the security log (`agentdock-state/workspace-trust/`,
  `agentdock-state/workspace-audit/`)**: not pruned automatically, deliberately — a security log
  that quietly discards its own history is not a record of anything. Withdrawing a folder's approval
  through the app marks it withdrawn and adds a line saying so, rather than erasing the earlier
  lines. Deleting either file yourself, with the app closed, is safe: every folder simply becomes
  unapproved again and has to be re-approved through the same dialog.

## What this project cannot promise

- It cannot audit or control what an installed `claude`/`codex` CLI, or an MCP provider you
  connect, does with data once it leaves this app's process — that's between you and that
  provider.
- There is currently no built-in export or backup tool beyond copying the files above yourself; see
  [docs/troubleshooting.md#backing-up-and-restoring-your-workspace](troubleshooting.md#backing-up-and-restoring-your-workspace).

## Questions or a data-handling concern

Open an issue on this repository, or see [SECURITY.md](../SECURITY.md#reporting-a-vulnerability)
if the concern is security-specific rather than a general privacy question.
