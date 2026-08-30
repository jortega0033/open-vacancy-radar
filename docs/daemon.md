# Daemon

`apps/daemon` is a standalone Fastify HTTP+SSE server. It has no Electron dependency and no
required parent process. `pnpm daemon` runs and can be `curl`'d directly, with no display server
or GUI test harness required.

## Running it standalone

```bash
pnpm daemon
```

This runs `apps/daemon/src/index.ts` directly through `tsx` (`pnpm --filter @agent-dock/daemon run
start`). On startup it prints the URL it's listening on and where it wrote its discovery file. In
another terminal:

```bash
curl http://127.0.0.1:<port>/health
```

`pnpm --filter @agent-dock/daemon run dev` does the same thing with `tsx watch` for auto-restart on
source changes.

## Binding and port

The daemon binds only to IPv4 address `127.0.0.1`, not `0.0.0.0` or the IPv6 loopback `::1`
(`apps/daemon/src/index.ts`). By default it asks the OS for an ephemeral port
(`AGENT_DOCK_PORT` unset or `0`); set `AGENT_DOCK_PORT=<port>` to request a fixed one. Whichever
port it ends up on is written to the discovery file and printed to stdout. There's no way to know
it in advance otherwise.

## Discovery file

The daemon writes `{ port, token, pid, startedAt }` to `os.tmpdir()/agent-dock/<app-id>.json` once
it is listening. On POSIX, the file uses mode `0600`, and the containing directory is created or
verified with mode `0700` (see [SECURITY.md](../SECURITY.md#local-auth-token), including the Windows
caveat). This is a **filesystem handoff, not a network one**. A client reads the file directly
(it has to be running as the same OS user), rather than the daemon ever broadcasting the token
over the network.

`<app-id>` defaults to `agent-dock` and is set via `AGENT_DOCK_APP_ID`. See
[Single-instance behavior](#single-instance-behavior) below for why it exists and how it's
validated.

## Auth token

Every route except `GET /health` requires `Authorization: Bearer <token>`, checked with a
timing-safe comparison. The full threat model and reasoning live in
[SECURITY.md](../SECURITY.md). This file only covers operational behavior, not why it's safe.

## Single-instance behavior

The daemon refuses to start if its app id's discovery file's recorded pid is still alive
(`apps/daemon/src/discovery-file.ts#assertNoLiveDaemon`):

```
Error: another agent-dock daemon (app id "agent-dock") is already running (pid <pid>,
discovery file <path>). Only one daemon per app id is supported at a time. Stop it first.
```

This is a **per app id** guarantee, not a machine-wide one. `AGENT_DOCK_APP_ID` (default
`agent-dock`) defines the discovery filename. Two products with different app ids can run daemons
side by side. Two daemons with the same app id use the same file, so the second one refuses to
start. The app id is
validated before it's used to build a path: 1–64 characters, letters/digits/`-`/`_` only, must
start with a letter or digit. Invalid values cause startup to fail instead of being rewritten, so
the app id cannot be used for path traversal or to point outside the discovery directory.

A discovery file whose recorded pid is no longer running (a stale file left by a crash or
force-kill) is treated as safe to overwrite. Nothing is listening at that pid anymore, and a
corrupt/partially-written file is treated the same way. A stale file for one app id never affects
another app id's daemon, since they're different files. See
[troubleshooting.md](troubleshooting.md#daemon-fails-to-start) if you hit this unexpectedly.

## Routes

| Route | Auth | Behavior |
|---|---|---|
| `GET /health` | none | `{ status: 'ok', uptimeSeconds, protocolVersion }` |
| `GET /providers` | required | `{ providers: ProviderStatus[] }`. Runs each adapter's `detect()` |
| `GET /providers/:providerId` | required | One `ProviderStatus`, or `404` for an unregistered id |
| `POST /sessions` | required | Body validated against `createSessionRequestSchema`. `400` for an unknown provider, a `resumeProviderSessionId` on a provider whose `capabilities.resume` is `false`, or a `cwd` that doesn't exist. `201` + `AgentSession` on success |
| `GET /sessions/:sessionId` | required | Current `AgentSession` record, or `404` |
| `GET /sessions/:sessionId/events` | required | SSE stream. See [Event history and replay](#event-history-and-replay) below |
| `POST /sessions/:sessionId/cancel` | required | `202` + `{ status: 'cancelling' }`. `404` for an unknown id **or** a session that's already terminal. Cancelling a finished session is never reported as a success |
| `POST /sessions/cancel-all` | required | Cancels every in-flight session. This endpoint is used only by Electron's shutdown path; see [Shutdown](#shutdown). `202` + `{ status: 'cancelling' }` |
| `DELETE /sessions/:sessionId` | required | Cancels if still running, then removes the record. `204`, or `404` |

Every request body/param is Zod-validated before touching any handler logic
(`packages/shared/src/schemas.ts`); invalid input gets a `4xx` with a short JSON error message,
never a stack trace. See the full request-validation and error-handler behavior in
[SECURITY.md](../SECURITY.md#request-validation).

Wire shapes (route bodies, the `AgentEvent`/`AgentEventEnvelope` format) are documented in
[protocol-v1.md](protocol-v1.md), not duplicated here.

## Session lifecycle: SessionManager, SessionStore

`SessionManager` (`apps/daemon/src/session-manager.ts`) creates a session
through the provider registry, consumes its normalized `AgentEvent` stream, and keeps the
`AgentSession` record's `status` up to date as terminal events arrive
(`starting` → `running` → one of `completed` / `failed` / `cancelled`).

The `AgentSession` record itself lives behind a `SessionStore` interface
(`apps/daemon/src/session-store.ts`):

```ts
interface SessionStore {
  create(session: AgentSession): void;
  get(id: string): AgentSession | undefined;
  update(id: string, session: AgentSession): void;
  delete(id: string): void;
  list(): AgentSession[];
}
```

`MemorySessionStore` is the only implementation and the daemon's default. It and the interface are
synchronous, and **sessions do not survive a daemon restart**. A future persistent store, such as a
`SQLiteSessionStore`, should implement this interface without changing `SessionManager`'s lifecycle
logic. The interface would probably need to become asynchronous as part of that change.

The store contains only the `AgentSession` record. A session's live process handle (an
`AsyncGenerator` plus a `cancel()` closure) and buffered event history are separate,
non-persistable runtime state inside `SessionManager`. This prevents `SessionStore` from implicitly
becoming an event-history database.

## Event history and replay

`SessionManager` buffers every session's emitted `AgentEventEnvelope`s in memory, capped at 5,000
per session (`MAX_STORED_EVENTS_PER_SESSION`). `GET /sessions/:id/events`:

1. Writes an SSE `:ok` comment immediately, then the standard `text/event-stream` headers.
2. Replays every buffered event from `sequence` 0 (or from `Last-Event-ID + 1`, if that header was
   sent) as `id: <sequence>\nevent: <type>\ndata: <json>\n\n` frames.
3. Keeps the connection open and streams new events live as they arrive.
4. Closes the response itself once a terminal event (`session.completed` / `session.failed` /
   `session.cancelled`) is written. The client never has to guess whether more events might still
   arrive.

Past 5,000 buffered events, further events are no longer available to replay to a *new*
subscriber, but they are always still delivered live to every currently-connected subscriber,
including the terminal event. The cap only ever bounds replay history, never live delivery.
`sequence` is stamped from a counter independent of the history buffer's length, so it keeps
incrementing past the cap rather than resetting or gapping. The daemon logs a warning once history
stops growing, rather than growing memory unbounded. This is regression-tested directly in
`apps/daemon/test/session-manager.test.ts` (drives a session past the cap and asserts the terminal
event still arrives live). See [protocol-v1.md#ordering-guarantees](protocol-v1.md#ordering-guarantees)
for ordering details.

## Session retention

Once a session reaches a terminal state, its runtime state (buffered event history, listener set)
isn't deleted immediately. A client that hasn't seen the terminal event yet still needs to
replay/receive it. But retaining every completed session forever would grow memory without bound
for a long-lived daemon whose client never calls `DELETE`, so `SessionManager` keeps only the most
recently completed 50 sessions' runtime state (`MAX_RETAINED_COMPLETED_SESSIONS`). When a 51st
session completes, the oldest runtime state and its `AgentSession` record are removed. This is a
fixed memory bound, not a cache-replacement policy. `DELETE /sessions/:id` removes a session
immediately regardless of this cap, and removes it from the retention tracking too.

`SessionManager.cancel()` also refuses to report success for a session that is already terminal;
see the routes table above. A stale UI action against a finished session gets `404`, not
a misleading `202`.

## Cancellation and process-tree kill

`POST /sessions/:id/cancel` calls the session's runtime handle's `cancel()`, which kills the
provider CLI's whole process tree, not just the direct child. A cancelled session cannot leave
a grandchild process (e.g. a shell command the CLI itself launched) orphaned:

- **Windows**: `taskkill /pid <pid> /T /F`
- **POSIX**: the child is spawned detached in its own process group; cancellation sends
  `SIGTERM` to the group (`process.kill(-pid, 'SIGTERM')`), then escalates to `SIGKILL` after 5
  seconds if it hasn't exited

See [SECURITY.md](../SECURITY.md#process-hygiene) for the Windows grandchild-process test and the
POSIX behavior that has not been tested independently in this project.
`DELETE /sessions/:id` cancels first (if the session is still `starting`/`running`) before removing
the record, so deleting a live session doesn't orphan its process either.

## Shutdown

On `SIGINT` or `SIGTERM`, the daemon (`apps/daemon/src/index.ts`) cancels every in-flight session and
waits up to five seconds for the processes to exit (`SessionManager.cancelAll()`). It then closes
the Fastify server, removes the discovery file, and exits. This is idempotent; a second signal while
shutdown is already in progress is a no-op. The bounded
wait means shutdown won't hang forever if a child ignores termination, but also won't return
instantly while a child is still stopping. `cancel()` on a runtime handle only *initiates*
termination (fires a signal/`taskkill` and returns), so without the wait the daemon could exit
while a process was still alive.

**Windows limitation:** Node's `child.kill()` maps to `TerminateProcess` on Windows, which does not
deliver a real `SIGTERM` the daemon's own shutdown handler can catch. So when Electron kills the
daemon child process directly (e.g. on app quit), the daemon's own `cancelAll()` above never runs
at all on that platform. Electron compensates by calling `POST /sessions/cancel-all` over HTTP
*before* killing the daemon child process. Windows can deliver this HTTP request reliably, unlike
a signal to the daemon process. Every in-flight session is confirmed cancelled before the
daemon process is force-killed, not just the one session the desktop UI happens to be tracking. See
`killDaemon()` in `apps/desktop/electron/main.ts` and
[architecture.md#known-limitations](architecture.md#known-limitations) for what this does and
does not cover on POSIX. Tests confirm that the daemon exits with the app. A stale discovery file
can remain, but it is safe to overwrite. See
[Single-instance behavior](#single-instance-behavior) above.

## Logging

`packages/agent-runtime/src/logger.ts`'s `createConsoleLogger` writes structured JSON lines to
stdout/stderr. Set `AGENT_DOCK_LOG_LEVEL=debug` to see `debug`-level lines (default is `info`). Any
log metadata key matching `/token|secret|password|authorization|api[-_]?key|credential/i` is
redacted to `[redacted]` regardless of level. See [SECURITY.md](../SECURITY.md#what-the-daemon-will-never-do).
