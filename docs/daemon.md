# Daemon

`apps/daemon` is a standalone Fastify HTTP+SSE server. It has no Electron dependency and no
required parent process: `pnpm daemon` runs and can be `curl`'d directly, with no display server
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

The daemon binds `127.0.0.1` only, never `0.0.0.0`, and never the IPv6 loopback (`::1`) either; it
answers on IPv4 only (`apps/daemon/src/index.ts`). By default it asks the OS for an ephemeral port
(`AGENT_DOCK_PORT` unset or `0`); set `AGENT_DOCK_PORT=<port>` to request a fixed one. Whichever
port it ends up on is written to the discovery file and printed to stdout: there's no way to know
it in advance otherwise.

## Discovery file

The daemon writes `{ port, token, pid, startedAt }` to `os.tmpdir()/agent-dock/<app-id>.json` once
it's listening (the file mode `0600`, and the containing directory created/verified mode `0700`
on POSIX; see [SECURITY.md](../SECURITY.md#local-auth-token) for why, including the Windows
caveat). This is a **filesystem handoff, not a network one**: a client reads the file directly
(it has to be running as the same OS user), rather than the daemon ever broadcasting the token
over the network.

`<app-id>` defaults to `agent-dock` and is set via `AGENT_DOCK_APP_ID` (see
[Single-instance behavior](#single-instance-behavior) below for why it exists and how it's
validated).

## Auth token

Every route except `GET /health` requires `Authorization: Bearer <token>`, checked with a
timing-safe comparison. The full threat model and reasoning live in
[SECURITY.md](../SECURITY.md); this file only covers operational behavior, not why it's safe.

## Single-instance behavior

The daemon refuses to start if its app id's discovery file's recorded pid is still alive
(`apps/daemon/src/discovery-file.ts#assertNoLiveDaemon`):

```
Error: another agent-dock daemon (app id "agent-dock") is already running (pid <pid>,
discovery file <path>). Only one daemon per app id is supported at a time: stop it first.
```

This is a **per app id** guarantee, not a machine-global one. `AGENT_DOCK_APP_ID` (default
`agent-dock`) namespaces the discovery filename, so two different products built on this
boilerplate (each launched with its own app id) run their own daemons side by side without
colliding; two daemons started with the *same* app id still race for the same file and the second
one refuses to start, which is the actual invariant this exists to guarantee. The app id is
validated before it's used to build a path: 1–64 characters, letters/digits/`-`/`_` only, must
start with a letter or digit, rejected outright (the daemon fails to start with a clear error)
rather than sanitized, so it can't be used for path traversal or to point outside the discovery
directory entirely.

A discovery file whose recorded pid is no longer running (a stale file left by a crash or
force-kill) is treated as safe to overwrite: nothing is listening at that pid anymore, and a
corrupt/partially-written file is treated the same way. A stale file for one app id never affects
another app id's daemon, since they're different files. See
[troubleshooting.md](troubleshooting.md#daemon-fails-to-start) if you hit this unexpectedly.

## Routes

| Route | Auth | Behavior |
|---|---|---|
| `GET /health` | none | `{ status: 'ok', uptimeSeconds, protocolVersion, supportedProtocolVersions, daemonInstanceId }`. `protocolVersion` is frozen at `1` forever; `supportedProtocolVersions` is `[1, 2]` when the durable store opened, and `[1]` when it did not (see [v2 read routes](#v2-read-routes) and [protocol-v1.md](protocol-v1.md)). `daemonInstanceId` is a UUID minted once per daemon **process** and stable for its lifetime: a client that sees it change knows this is a different daemon, even though the port, the token, and the discovery file may all be identical (see [Workspace trust routes](#workspace-trust-routes)) |
| `GET /providers` | required | `{ providers: ProviderStatus[] }`: runs each adapter's `detect()` |
| `GET /providers/:providerId` | required | One `ProviderStatus`, or `404` for an unregistered id |
| `POST /sessions` | required | Body validated against `createSessionRequestSchema`. `400` for an unknown provider, a `resumeProviderSessionId` on a provider whose `capabilities.resume` is `false`, or a `cwd` that doesn't exist. `409` when the [active-session limit](#active-session-limits) is reached, `507` when the session store has no room. `201` + `AgentSession` on success |
| `GET /sessions/:sessionId` | required | Current `AgentSession` record, or `404` |
| `GET /sessions/:sessionId/events` | required | SSE stream (see [Event history and replay](#event-history-and-replay) below) |
| `POST /sessions/:sessionId/cancel` | required | `202` + `{ status: 'cancelling' }`. `404` for an unknown id **or** a session that's already terminal: cancelling a finished session is never reported as a success |
| `POST /sessions/cancel-all` | required | Cancels every in-flight session. Narrow and single-purpose (not a generic process-control endpoint), exists specifically for Electron's shutdown path, see [Shutdown](#shutdown) below. `202` + `{ status: 'cancelling' }` |
| `DELETE /sessions/:sessionId` | required | Cancels if still running, then removes the record. `204`, or `404` |

Every request body/param is Zod-validated before touching any handler logic
(`packages/shared/src/schemas.ts`); invalid input gets a `4xx` with a short JSON error message,
never a stack trace. See the full request-validation and error-handler behavior in
[SECURITY.md](../SECURITY.md#request-validation).

Wire shapes (route bodies, the `AgentEvent`/`AgentEventEnvelope` format) are documented in
[protocol-v1.md](protocol-v1.md), not duplicated here.

### v2 read routes

ADI-05 adds five **read-only** routes, registered only when the durable session store opened
successfully (see [Durable session state](#durable-session-state) below). When it did not, none of
them exist and every path below returns the ordinary `404`.

| Route | Behavior |
|---|---|
| `GET /v2/providers` | `{ schemaVersion: 1, providers: [...] }`: the v1 `detect()` result plus the transport id, whether the installed CLI version is in the reviewed compatibility manifest, its accepted-work boundary, and current capacity |
| `GET /v2/providers/:providerId` | One provider view. `400 { code: 'invalid_provider_id' }` for a malformed id, `404 { code: 'provider_not_found' }` for a well-formed but unregistered one |
| `GET /v2/sessions?cursor=&limit=` | `{ schemaVersion: 1, sessions, nextCursor?, capacity }`, newest-first. Default `limit` 50, maximum 100. `400 { code: 'invalid_cursor' }` for a malformed cursor or one addressing an evicted record |
| `GET /v2/sessions/:sessionId` | One session view, or `404 { code: 'session_not_found' }` |
| `GET /v2/sessions/:sessionId/events?cursor=&limit=` | A **JSON page** of the durable, redacted event log -- not an SSE stream. The live v1 stream at `GET /sessions/:id/events` is unchanged and remains the way to watch a session in progress |

There is deliberately **no `POST /v2/sessions`**, no `DELETE`, and no v2 cancel. Creating a session
over v2 means accepting a capability-negotiation request shape this repo does not have, and
inventing one here would freeze a public request contract nobody has reviewed. Session creation and
control stay on the v1 routes. See
[the ADR](adr-agentdock-v2-provenance.md#adi-05-durable-session-state-active-session-limits-and-the-v2-read-surface)
for the full deferral note.

### Workspace trust routes

ADI-06 adds four routes governing whether a session may run in a real directory of the user's, plus
one read route over the audit log. They are registered only when **both** the workspace trust store
and the audit store opened successfully (`openWorkspaceStores`, and see
[Workspace trust and the audit log](#workspace-trust-and-the-audit-log) below). When either did not,
none of them exist, every path below returns the ordinary `404`, and nothing can be granted at all:
the downgrade path here is closed, not open.

| Route | Behavior |
|---|---|
| `POST /v2/workspaces/inspect` | Body `{ path, provider }`. Resolves the workspace identity and returns `{ schemaVersion: 1, workspace }`, a trust view carrying **no path**: two digests, a bounded folder basename, an optional Git branch, a dirty flag, a reusable flag, and the trust state. `400 { code: 'unc_workspace_unsupported' }` for a network location, `400 { code: 'invalid_workspace_path' }` for anything else unresolvable. Writes no audit entry: inspection is not a decision |
| `POST /v2/workspaces/consume-grant` | Body `{ path, provider, workspaceId, incarnation, sessionId? }`. **The only route that can produce `state: 'trusted'`.** Re-resolves the identity from `path` and refuses unless it matches the claimed pair (`409 { code: 'workspace_identity_drift' }`), refuses a non-reusable identity (`409`), and refuses a revoked workspace (`403`). Audits `grant.consumed`, persists trust, audits `trust.granted`, and only then answers |
| `PUT /v2/workspaces/:workspaceId/trust` | Body `{ state: 'untrusted' \| 'revoking' }`. **Cannot raise trust**: `state: 'trusted'` is answered with `400 { code: 'trust_not_self_assertable' }`. Blocks admission synchronously, then cancels every live session in the workspace and persists the new state. `404` for a workspace nothing was ever granted for |
| `POST /v2/workspaces/grant-events` | Body `{ event: 'grant.issued' \| 'grant.denied', workspaceId, incarnation, provider, reason?, actor }`. The narrow channel through which the desktop app's main process reports the two grant-lifecycle facts only it can observe. The enum admits **only** those two events: everything else in the audit vocabulary is a decision the daemon makes and writes itself |
| `GET /v2/audit?cursor=&limit=` | `{ schemaVersion: 1, entries, nextCursor?, unhealthy }`, oldest-first. Read-only: there is no delete and no clear verb. Cursor and limit reuse the same `opaqueCursorV2Schema`/`pageLimitV2Schema` rules as the v2 session routes |

The load-bearing property across all of these is that **no HTTP caller, including the desktop app's
own main process, can set a workspace trusted by asking**. Trust is only ever a side effect of the
daemon consuming a grant whose claimed identity it re-derived from the filesystem itself and found
unchanged. In the shipped app such a pair exists only because the user picked the folder in a native
picker and approved it in a native confirmation dialog. See
[the ADR](adr-agentdock-v2-provenance.md#adi-06-workspace-identity-trust-grants-leases-audit-and-exact-approvals)
for the full contract and for why this diverges from upstream.

### Active session limits

A session is one provider CLI process spawned into the user's working directory, so the daemon caps
how many may run at once: **4 globally, 2 per provider**
(`ACTIVE_SESSION_LIMITS` in `apps/daemon/src/active-session-limiter.ts`). Exceeding either returns
`409`:

```json
{
  "error": "too many active sessions",
  "code": "active_session_limit",
  "scope": "global",
  "capacity": { "global": { "active": 4, "limit": 4 }, "provider": { "active": 2, "limit": 2 } }
}
```

`scope` is `"global"` when the machine-wide cap is what refused the request and `"provider"` when
only that provider's bucket is full -- the global check runs first, because "switch providers" is
useless advice when the machine itself is at capacity.

A refused request leaves **no trace**: the reservation is taken before any durable record is written
and before `startSession` is called, so nothing was spawned and nothing needs cleaning up. The
reservation is returned in `SessionManager.consume()`'s `finally`, which is the single release site
covering every terminal path -- completion, failure, cancellation, `DELETE`, `cancel-all`, shutdown,
a provider generator that throws, and an abandoned stream.

The check-then-reserve step is synchronous and contains no `await`, which is what makes it
un-raceable on Node's single thread: no second request can observe the counters between the check
and the increment. `apps/daemon/test/server.limits.test.ts` proves this with genuinely concurrent
HTTP requests parked inside the route's real `await providerImpl.detect()`.

`507 { code: 'storage_full' }` is the other refusal: the durable store's retention budget is
exhausted and every remaining lineage is still active, so there is nothing evictable. Like the
`409`, it is raised before anything irreversible happens.

## Session lifecycle: SessionManager, SessionStore

`SessionManager` (`apps/daemon/src/session-manager.ts`) orchestrates everything: creates a session
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

`MemorySessionStore` is the only implementation of this interface and remains the daemon's live
source of truth for the v1 `AgentSession` shape, fully synchronous (so is the interface).

The store owns only the `AgentSession` record. A session's live process handle (an
`AsyncGenerator` plus a `cancel()` closure, not serializable at all) and its buffered event
history are kept as separate, non-persistable runtime state inside `SessionManager`, specifically
so `SessionStore` never grows into an accidental event-history database with its own
schema-design questions.

## Durable session state

ADI-05 adds a second, *parallel* store rather than a persistent `SessionStore` implementation:
`SessionLineageStore` (`apps/daemon/src/session-lineage-store.ts`). The two answer different
questions, which is why neither replaced the other -- `MemorySessionStore` answers "what is this
session doing right now, in v1's vocabulary", and the lineage store answers "what happened, and is
it safe to run it again".

### What it is for

The one question it exists to answer across a crash is **whether the provider had already been
handed the user's prompt**. A session interrupted by a restart is otherwise indistinguishable from
one that never started, and an automatic retry of work that already ran duplicates a side effect in
the user's own working directory. This closes the gap ADI-04 left open explicitly (see
[the ADR](adr-agentdock-v2-provenance.md#limitation-accepted-work-state-is-in-memory-only)).

### Where it lives

Under `AGENT_DOCK_STATE_DIR` when set (the desktop app sets it to
`<userData>/agentdock-state`), otherwise the platform's per-user application-data root for the app
id: `%LOCALAPPDATA%\<appId>` on Windows, `~/Library/Application Support/<appId>` on macOS,
`$XDG_STATE_HOME/<appId>` elsewhere. `resolveStateDirectory` refuses any root that overlaps a
product database path, so the store can never be carried off by a backup, a migration, or a
workspace reset.

```
<stateRoot>/sessions-v1/
  manifest.json                     {"schemaVersion":1}
  lineages/<rootSessionId>/
    records/<sessionId>.json        session metadata, atomically replaced
    events/<sessionId>.jsonl        one redacted event per line, append-only
  tombstones/<rootSessionId>.json   the commit record of an eviction
  quarantine/                       anything corrupt. Never auto-deleted
  .trash/                           two-phase eviction staging only
```

### What is never written

No event content, ever: prompt text, assistant messages, thinking deltas, tool inputs and results,
and error messages are all replaced by a `{ bytes, sha256 }` pair before anything reaches the disk.
This is enforced structurally, not by convention -- see
`apps/daemon/src/persisted-session-schema.ts` for the exhaustive switch (adding an `AgentEvent`
variant without a redaction rule is a compile error) and
`apps/daemon/test/persisted-session-schema.test.ts` for the runtime coverage check and the
sentinel sweep over the whole on-disk tree.

Three identifiers *are* kept verbatim, because a reader acts on them: `model`, `providerSessionId`,
and `toolCallId`. All three are **capped at 256 UTF-8 bytes** on the way in (the same treatment
`status` and `toolName` already got), everywhere they are copied -- into an event line, into the
session record, and in the store's own `setProviderSessionId`. A real value is a handful of bytes,
so the cap costs nothing legitimate; what it removes is the one route by which an oversized value
from a provider's stdout, or from a client request body, could park content in a store whose whole
point is that it holds none.

The bounded, content-free `unknownFrames` ledger (one `{kind, eventType, bytes, sha256,
occurrences}` entry per distinct kind of provider output this repo could not interpret, never the
line itself) is written into the record when a session reaches a terminal state.

### Restart recovery

Recovery runs **synchronously in the store's constructor**, which `index.ts` calls before
`buildServer()` and `app.listen()`. "Recovery finishes before the daemon accepts new work" is
therefore structural rather than a convention: the server cannot exist until the constructor
returns.

A session found `starting`/`running` with no terminal event in its log gets a synthetic
`session.interrupted` event and is recorded as `status: 'interrupted'`,
`terminalReason: 'daemon_restart'`. Its `acceptedWork` is carried across **verbatim** and is never
downgraded. `'interrupted'` exists only in v2's vocabulary; a v1 client reading
`GET /sessions/:id` sees `status: 'failed'` with
`error: "daemon restarted before the session completed"`.

### Corruption, retention, and future versions

- **Corrupt metadata record** → the whole lineage is quarantined (a half-loaded lineage would serve
  a record whose parent link points at a session the store cannot describe). Siblings are
  unaffected.
- **Torn or out-of-order event tail** → the log is truncated to its last good line and the removed
  bytes are quarantined separately. The lineage survives.
- **Nothing is ever deleted by corruption handling.** Quarantine is a move, not a delete.
- **Retention**: 30 days, 500 records, or 64 MB, whichever binds first, evicting whole lineages
  oldest-terminal-first. An active lineage is never evicted. Eviction is two-phase -- rename into
  `.trash/`, write the tombstone (**the commit point**), delete the trashed copy -- so an interrupted
  eviction is either rolled back or completed on the next start, never left half-done.
- **Event log past 5,000 lines** → further events are counted but not stored (`eventsTruncated`
  flips to `true`). Because the log can no longer speak for the counter, every suppressed event
  checkpoints the record's `eventCount`, so a crash after the cap recovers the true count rather
  than the frozen line count.
- **A future schema version anywhere** → a read-only preflight throws before any directory is
  created or any file opened for writing, the daemon logs it and starts on the memory store alone,
  and the newer state is left byte-identical. "Anywhere" covers the manifest, every record, every
  tombstone, every `events/*.jsonl` line (which carries `v`, not `schemaVersion`), any stray `.tmp`
  beside either, and everything staged under `.trash/` -- each of which a later startup step would
  otherwise quarantine, rewrite, restore, or delete. See
  [the rollback runbook](rollback-runbook-agentdock-v2.md#agentdock-state-the-v2-durable-session-store-adi-05).

## Workspace trust and the audit log

Two stores live beside the durable session store under the same state root.

`workspace-trust/trust.json` records which workspaces the user approved, and at which
**incarnation**. A workspace is identified by the filesystem object it is (`dev` + `ino`, plus the
Git worktree and common directory when it is a repository), not by its path string: on Windows one
directory has several canonical-looking spellings (`C:\PROGRA~1\x` and `C:\Program Files\x`, or two
paths differing only in case), and keying on the string would hand the same physical directory two
different ids. The incarnation *does* include the canonical path, so a rename requires the user to
re-confirm even though the underlying object is the same.

A workspace whose filesystem cannot give a stable object identity (`dev`/`ino` of 0, an SMB share,
or two consecutive stats disagreeing) gets random values that can never match on a later check, and
the trust store refuses to remember it at all. Network locations reached over UNC are rejected even
earlier, at the boundary, with their own error code.

`workspace-audit/audit.jsonl` is the append-only record of every trust decision. Its retention rule
is the **inverse** of the session store's: at its 64 MB cap it refuses to write rather than evicting
its oldest entry, and a refused write denies the action that needed it. An audit log that silently
forgets is not an audit log, so "the decision was refused" is the correct outcome and "the decision
happened but nothing recorded it" is not. One failed write latches the store permanently unwritable
for the life of the process, so no entry can ever land out of order after a failure. On startup the
log's sequence numbers are validated as contiguous from zero; any gap, truncated head, or
unparseable line quarantines the whole file (never deletes it) and starts a fresh one.

Entries hold only digests, enums, a uuid, and a timestamp. There is no path and no folder name in
them, by schema, and the daemon's tests grep the whole on-disk tree after a full
issue-consume-revoke cycle to keep that honest.

There is deliberately no hash chain. This repo's threat model names a same-user local attacker (see
[SECURITY.md](../SECURITY.md)), who could recompute one; contiguous-sequence validation makes the
smaller claim that can actually be kept, which is that truncation and deletion are detectable.

### Execution leases ship dormant

`apps/daemon/src/workspace-execution-lease.ts` implements reader/writer leases keyed on the same
workspace identity, with a writer excluding everything, a reader refused while a writer holds the
workspace, two readers sharing a clean tree freely, and two readers sharing a **dirty** tree only
with an explicit opt-in. `git status` failing counts as dirty: failing to prove cleanliness must not
authorize sharing.

**Nothing calls `acquire()` today.** Leases only matter at v2 session creation, which does not exist
yet, so the manager ships fully unit-tested and unwired, the same way ADI-04's fallback gate did.
ADI-13 is the ticket that gives it a caller.

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
including the terminal event: the cap only ever bounds replay history, never live delivery.
`sequence` is stamped from a counter independent of the history buffer's length, so it keeps
incrementing past the cap rather than resetting or gapping. The daemon logs a warning once history
stops growing, rather than growing memory unbounded. This is regression-tested directly in
`apps/daemon/test/session-manager.test.ts` (drives a session past the cap and asserts the terminal
event still arrives live). See [protocol-v1.md#ordering-guarantees](protocol-v1.md#ordering-guarantees)
for the full ordering contract this upholds.

## Session retention

Once a session reaches a terminal state, its runtime state (buffered event history, listener set)
isn't deleted immediately: a client that hasn't seen the terminal event yet still needs to
replay/receive it. But retaining every completed session forever would grow memory without bound
for a long-lived daemon whose client never calls `DELETE`, so `SessionManager` keeps only the most
recently completed 50 sessions' runtime state (`MAX_RETAINED_COMPLETED_SESSIONS`), evicting the
oldest (and its `AgentSession` record with it) once a 51st completes. This is a simple bound, not
a cache-replacement policy: the daemon is local and single-user, and a bound that's simple to
reason about was preferred over one that's optimal. `DELETE /sessions/:id` removes a session
immediately regardless of this cap, and removes it from the retention tracking too.

Sessions recovered from the durable store at startup enter the same FIFO, in completion order, and
are trimmed by the same pass -- otherwise a store holding its full 500-record budget would seed all
500 into memory and keep them for the daemon's lifetime, reaching the exact unbounded growth this
cap exists to prevent by way of a restart. The trim is in-memory only: durable retention is a
separate and deliberately more permissive policy, so nothing leaves the disk.

`SessionManager.cancel()` also refuses to report success for a session that's already terminal
(see the routes table above), so a stale UI action against a long-finished session gets `404`, not
a misleading `202`.

## Cancellation and process-tree kill

`POST /sessions/:id/cancel` calls the session's runtime handle's `cancel()`, which kills the
provider CLI's whole process tree, not just the direct child, so a cancelled session can't leave
a grandchild process (e.g. a shell command the CLI itself launched) orphaned:

- **Windows**: `taskkill /pid <pid> /T /F`
- **POSIX**: the child is spawned detached in its own process group; cancellation sends
  `SIGTERM` to the group (`process.kill(-pid, 'SIGTERM')`), then escalates to `SIGKILL` after 5
  seconds if it hasn't exited

See [SECURITY.md](../SECURITY.md#process-hygiene) for what was empirically verified here (Windows
grandchild-process test) versus documented-but-not-independently-reconfirmed (the POSIX path).
`DELETE /sessions/:id` cancels first (if the session is still `starting`/`running`) before removing
the record, so deleting a live session doesn't orphan its process either.

## Shutdown

On `SIGINT`/`SIGTERM`, the daemon (`apps/daemon/src/index.ts`): cancels every in-flight session and
waits (bounded, 5 seconds by default) for their processes to actually exit
(`SessionManager.cancelAll()`), closes the Fastify server, removes the discovery file, then exits.
This is idempotent: a second signal while shutdown is already in progress is a no-op. The bounded
wait means shutdown won't hang forever if a child ignores termination, but also won't return
instantly while a child is still mid-teardown: `cancel()` on a runtime handle only *initiates*
termination (fires a signal/`taskkill` and returns), so without the wait the daemon could exit
while a process was still alive.

**Windows limitation**: Node's `child.kill()` maps to `TerminateProcess` on Windows, which does not
deliver a real `SIGTERM` the daemon's own shutdown handler can catch, so when Electron kills the
daemon child process directly (e.g. on app quit), the daemon's own `cancelAll()` above never runs
at all on that platform. Electron compensates by calling `POST /sessions/cancel-all` over HTTP
*before* killing the daemon child process. HTTP is a request Windows can deliver reliably, unlike
a signal to the daemon's own process, so every in-flight session is confirmed cancelled before the
daemon process is force-killed, not just the one session the desktop UI happens to be tracking. See
`killDaemon()` in `apps/desktop/electron/main.ts` and
[architecture.md#known-limitations](architecture.md#known-limitations) for what this does and
doesn't cover on POSIX. The daemon process itself has always been confirmed to exit alongside the
app in testing; what can be left behind is a stale discovery file, which is harmless (see
[Single-instance behavior](#single-instance-behavior) above).

## Logging

`packages/agent-runtime/src/logger.ts`'s `createConsoleLogger` writes structured JSON lines to
stdout/stderr. Set `AGENT_DOCK_LOG_LEVEL=debug` to see `debug`-level lines (default is `info`). Any
log metadata key matching `/token|secret|password|authorization|api[-_]?key|credential/i` is
redacted to `[redacted]` regardless of level (see [SECURITY.md](../SECURITY.md#what-the-daemon-will-never-do)).
