# Troubleshooting

## Claude/Codex not detected (`installed: false`)

`GET /providers` reports `installed: false` when `findExecutable()` couldn't locate the CLI binary
at all. See [providers.md#executable-discovery](providers.md#executable-discovery) for exactly how
it searches (a `where`/`which` lookup, then a short list of common install directories).

- Confirm the CLI actually works from a terminal: `claude --version` / `codex --version`.
- If it works in a terminal but the daemon still reports `installed: false`, the daemon's process
  may have started with a different `PATH` than your shell. This is especially common for a GUI
  app launched from a desktop/Start Menu shortcut rather than a terminal. `findExecutable()`'s
  fallback directory list exists specifically for this; if your install location isn't in it
  (`packages/agent-runtime/src/detect-executable.ts#commonInstallDirs`), report the missing path or
  add it to the list.
- Restart the daemon after installing a CLI for the first time. `findExecutable()` runs fresh on
  every `GET /providers` call, but a shell-level `PATH` change made *after* the daemon's own
  process started won't be picked up without restarting the daemon itself (the daemon inherits its
  environment once, at spawn time).

## What `authenticated: "unknown"` means

This is a distinct state, not a bug. See
[providers.md#providerstatus](providers.md#providerstatus). It means the adapter's own login-status
check (`claude auth status --json` / `codex login status`) failed, timed out, or returned output the
parser couldn't confidently interpret. It is **never** coerced to `true`. Run the CLI's own status
command directly (`claude auth status`, `codex login status`) to see the current state. If that
succeeds but the daemon still reports `unknown`, the adapter's parser may need updating for a
CLI output format that changed. See the relevant `parser.ts` and its test fixtures in
[providers.md](providers.md).

## Daemon fails to start

**"another agent-dock daemon is already running (pid ..., discovery file ...)"**: see
[daemon.md#single-instance-behavior](daemon.md#single-instance-behavior). Either a daemon really is
already running (check the pid with your OS's task manager / `ps`), or a previous run left a
discovery file whose pid happens to be reused by an unrelated process now running (rare, but
possible on a long-lived machine). If no daemon is using it, delete the discovery file and start
the daemon again. Its default path is `os.tmpdir()/agent-dock/agent-dock.json`. Read
[daemon.md](daemon.md#single-instance-behavior) before removing it.

**Port already in use**: this applies only if you set `AGENT_DOCK_PORT` to a fixed value; the default
(`0`, an OS-assigned ephemeral port) can't collide. Either free the port or unset
`AGENT_DOCK_PORT`.

**No visible error**: run with `AGENT_DOCK_LOG_LEVEL=debug pnpm daemon` for more detail; see
[daemon.md#logging](daemon.md#logging).

## Protocol mismatch

`ProtocolMismatchError` from `@agent-dock/client` means the client's `AGENT_DOCK_PROTOCOL_VERSION`
and the running daemon's don't match. In this repo, the client and daemon are built from the same
workspace and versioned together, so this should only happen if you're running a daemon built from
a different checkout than the desktop app (e.g. an old `pnpm daemon` left running from before a
protocol-affecting change, still holding the discovery file). Stop the stale daemon and let the
current one start. See [Daemon fails to start](#daemon-fails-to-start) above if that's the
symptom. See [protocol-v1.md](protocol-v1.md) for what counts as a breaking, version-bumping
change.

## Session starts but no events arrive

1. Confirm the session actually started: `GET /sessions/:id` should show `status: "running"` (or
   `"failed"` with the relevant `error` message).
2. Check the daemon's own log output. A non-zero CLI exit logs a bounded stderr snippet at `warn`
   (see [SECURITY.md#what-the-daemon-will-never-do](../SECURITY.md#what-the-daemon-will-never-do)
   for what is and is not logged). This is usually the fastest way to see what went wrong in the
   CLI because a `session.failed` message is intentionally generic.
3. If you're calling the SSE endpoint directly (not through `@agent-dock/client`), confirm you're
   reading the stream incrementally, not buffering the whole response. Some HTTP clients (and some
   `curl` flag combinations) don't stream by default.
4. A working directory that doesn't exist fails fast at `POST /sessions` with `400`, before any
   process is spawned. This is not a "no events" case. The request is rejected before it starts.

## Cancellation doesn't seem to fully stop things

Cancellation kills the provider CLI's process tree, not just the direct child. See
[daemon.md#cancellation-and-process-tree-kill](daemon.md#cancellation-and-process-tree-kill) for the
mechanism for each platform. A Windows test confirmed that a grandchild process stopped within
about one second. The POSIX path uses the standard process-group
mechanism but hasn't been independently re-verified on macOS/Linux in this project. If you find a
case where a POSIX grandchild survives cancellation, report it with reproduction steps.

## Windows SmartScreen warning on the installed app

Expected. The installer and app are unsigned. See
[packaging.md#unsigned-installer-and-smartscreen](packaging.md#unsigned-installer-and-smartscreen).
Resolving the warning requires a code-signing certificate, which is out of scope for this project.

## `pnpm build` succeeded but the packaged app doesn't work

`pnpm build` and `pnpm package:win` catch different failure classes. See
[packaging.md#verifying-a-packaging-sensitive-change](packaging.md#verifying-a-packaging-sensitive-change).
If you changed anything under `apps/desktop/electron/` or `electron-builder.yml`, `pnpm build`
alone does not cover packaging-only failures. Run
`pnpm package:win` and launch `dist-packages/win-unpacked/Open Vacancy Radar.exe`.

## Testing without a real Claude/Codex account

You do not need one. The test suite does not call a provider CLI or use API credit. See
[DEVELOPMENT.md](../DEVELOPMENT.md#testing-without-paid-providers) for how the fixture-based
approach works (`describeProviderContract()` runs against small `node` scripts that represent the
CLI). `pnpm test` passes from a clean checkout with neither `claude` nor `codex` installed.
