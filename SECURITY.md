# Security

The daemon can run local coding agents that read and write files and execute shell commands. This
document defines AgentDock's protections, trust boundaries, and exclusions. Notes marked
"Verified" identify behavior tested against a running instance; other statements describe the
implemented design.

## What this protects against

- A malicious or compromised **webpage running in an ordinary browser tab** that sends requests to
  the daemon's `127.0.0.1` port and tries to make Claude or Codex read or modify local files.
- The **renderer process** (React UI) reading the daemon's bearer token or base URL, or reaching
  any daemon route beyond the seven narrow IPC capabilities the `agentDock` preload bridge exposes.
  Other Open Vacancy Radar namespaces also expose only named operations: `vacancyRadar` provides
  engine status, stored reports, and scan commands for both markets; `cv` provides a
  native-dialog-gated file pick that returns extracted text rather than a path, plus an app-owned
  workspace-directory getter; `workspace` manages validated local records and settings; and
  `system` provides launch-at-login settings, the app version, and native-dialog-gated exports.
  Each namespace can be reviewed or removed without changing the others.
- A request choosing **which executable runs**. `POST /sessions` only accepts a `provider`
  id from a closed enum; the actual binary path is always resolved internally.
- **Shell interpolation.** Every provider CLI is spawned with `shell: false` and an argv array;
  nothing request-supplied is ever concatenated into a shell string.
- **Credential exposure.** The daemon never reads a credential file, keychain entry, or OAuth
  token itself, never logs one, and never returns its own bearer token in any API response.

## What this does NOT claim to protect against

- **Another process running as the same OS user with equivalent privileges.** If a process can
  already read your files, it can already do everything the CLI itself can do. This is a
  localhost trust boundary, not a sandbox between OS users or processes.
- **A compromised Claude Code or Codex CLI installation.** AgentDock spawns the CLI you already
  installed and authenticated; it does not vet, sandbox, or restrict what that CLI does once
  running.
- **Malicious code already running with equivalent local privileges**, such as another app on the
  same machine, running as the same user, that decides to read the discovery file or plant a
  symlink at its path before the daemon writes it. A same-user attacker in that position already
  has your files.
- **Provider-side security issues.** Anything in Anthropic's or OpenAI's own infrastructure, auth
  systems, or CLI implementations is out of this project's scope entirely.

## Renderer never talks to the daemon directly

This boundary is required because a browser request from the renderer to the daemon cannot
complete, even with the right token. An `Authorization` header makes the request non-simple and
requires a CORS preflight. The daemon does not return `Access-Control-Allow-Origin`, so Chromium
refuses to send the authenticated request. **Verified:** from a browser tab using the Vite dev
server, `fetch()` with a valid token failed with `TypeError: Failed to fetch`. DevTools reported:
*"Response to preflight request doesn't pass access control check: No 'Access-Control-Allow-Origin'
header is present."* This is true in a packaged build too: a `file://`-loaded page is still a
distinct origin from `http://127.0.0.1:<port>` and still triggers the same preflight.

All daemon HTTP/SSE traffic therefore runs in Electron's main process
(`apps/desktop/electron/main.ts`, via `@agent-dock/client`), which uses Node's networking stack.
CORS is enforced by Chromium's renderer process, not by Node's `fetch`. **Verified:** the same
request that failed from a browser tab succeeds from Node `fetch()`
against the same daemon. The renderer talks to main only through seven narrow, typed IPC
capabilities (`electron/preload.ts`): `getDaemonStatus()`, `onDaemonStatus()`, `listProviders()`,
`createSession()`, `cancelSession()`, `onSessionEvent()`, `selectDirectory()`. **The daemon's
bearer token and base URL never cross into the renderer.** They stay in main-process memory. The
two status-reporting functions
(`getDaemonStatus`/`onDaemonStatus`) reconstruct a clean `{ state, error? }` object from whatever
main sends rather than passing the IPC payload through unvalidated, specifically so an accidental
extra field on the main-process side (a token or base URL) cannot cross into the renderer. See
`apps/desktop/test/preload.test.ts` for the regression test.

The daemon therefore has no browser-origin allowlist. It rejects every request that carries an
`Origin` header (see [Origin validation](#origin-validation)), and the renderer's CSP uses
`connect-src 'self'`. The HTTP+SSE API remains available to non-browser clients such as `curl`, a
CLI, or a VS Code extension.

## Local-auth token

The daemon generates a random 32-byte token (`crypto.randomBytes(32).toString('hex')`) at
**every** startup. It is never persisted across restarts or hardcoded. Every route except
`GET /health` requires it:

```
Authorization: Bearer <token>
```

Requests without a valid token get `401`, compared with `crypto.timingSafeEqual` to avoid a timing
side-channel (`apps/daemon/src/auth-token.ts`).

The token reaches Electron's main process through a **filesystem handoff, not a network one**. It
never reaches the renderer. The daemon writes `{ port, token, pid, startedAt }` to a discovery
file once it's listening, and main reads that file directly (it runs as the same OS user). The
file itself is written mode `0600`; its containing directory (`os.tmpdir()/agent-dock/`, shared by
every AgentDock-based app on the machine) is created mode `0700` on POSIX, and if it already
exists, the daemon verifies that it is still owned by the current user with mode `0700` before
writing into it. The daemon refuses to start otherwise. `os.tmpdir()` can be a shared,
world-writable root on
Linux (Windows and macOS both return a per-user directory already), so without this check a
different local user could have pre-staged the directory to intercept the handoff. There is no
equivalent POSIX-style check on Windows: NTFS ACLs are inherited from the parent by default, which
for a per-user temp root is already restrictive, and a `chmod`-style check would be a claim this
codebase cannot verify there. See `apps/daemon/src/discovery-file.ts`.

The discovery *filename* is namespaced per application id (default `agent-dock`, overridable via
`AGENT_DOCK_APP_ID`) rather than one fixed name. See
[Single daemon instance](#single-daemon-instance) below for why.

### Why a bearer token defeats the "malicious webpage" threat specifically

A page running in a browser tab at an origin such as `http://evil.example` can send a request to
`http://127.0.0.1:<port>`. Listening only on localhost does not prevent that. The following controls
block the request:

1. **It doesn't know the token.** The token lives in a discovery file with restrictive permissions
   and never crosses into any renderer; a webpage has no filesystem access at all.
2. **The daemon never sends CORS headers.** No CORS plugin is installed, and no route ever sets
   `Access-Control-Allow-Origin`. `Authorization` is a
   ["non-simple" header](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS#simple_requests),
   so a cross-origin `fetch` that sets it triggers a CORS preflight (`OPTIONS`) first. Because
   the daemon never answers a preflight with permission, the browser refuses to send the real
   request at all. **Verified**: a preflight `OPTIONS /sessions` from a disallowed origin gets
   `403` from our own Origin check before Fastify would even route it to a handler, and no route
   ever adds `Access-Control-Allow-*` response headers regardless.

Without permissive CORS, a browser does not let cross-origin script read the response of a
state-changing request, even for
requests that *don't* need a preflight (e.g. a plain `<form>` POST, or a `fetch` with
`Content-Type: text/plain`), but the request could still be sent. Every mutating
route additionally requires the token: form-based "blind" CSRF can't set a custom `Authorization`
header, so it can't pass the token check either. **Verified**: a simulated cross-origin form-style
POST (`Content-Type: text/plain`, no auth header, `Origin: http://evil.example`) to `POST /sessions`
was rejected by the Origin check before session creation.

## Origin validation

`apps/daemon/src/server.ts` also validates the `Origin` header independently of the token, and
does so before the auth check runs. **Any request that carries an `Origin` header is treated as
browser-authored and rejected with `403`.** There is no allowlist, scheme parsing, or configuration
option. Requests with no `Origin` header, including `curl`, another local process, and Electron's
main process, pass this check and fall
through to the token check, since a real browser cannot omit `Origin` on a cross-origin request;
only non-browser contexts can.

This replaced an earlier version that only recognized the literal string `"null"` and
`/^https?:\/\//i` as "browser-authored," with an `AGENT_DOCK_ALLOWED_ORIGINS` allowlist meant to
permit a future browser client. Two problems with that version, both fixed by the current policy:
a `chrome-extension://` (or any other non-`http(s)`, non-`"null"` scheme) origin fell straight
through unrecognized, since it matched neither check; and the allowlist itself was inert even when
populated because nothing paired it with an `Access-Control-Allow-Origin` response header. An
allowlisted browser origin still could not complete a request, as described in
[Renderer never talks to the daemon directly](#renderer-never-talks-to-the-daemon-directly) above.
Since there is no legitimate browser-originated caller of this API today, the fix was to delete the
allowlist rather than complete it. The daemon only needs to accept non-browser callers.

## What the daemon will never do

- Read a Claude/Codex/any-provider credential file, keychain entry, or OAuth token directly.
- Accept an executable path or name from a request body. `POST /sessions` only accepts a
  `provider` id from a closed enum (`packages/shared/src/schemas.ts`); the actual executable is
  always resolved internally via `findExecutable()`. **Verified**: an unknown `provider` value
  fails Zod validation with `400` before reaching any handler; extra/unknown body fields (e.g. an
  `executable` or `env` field slipped into the request) are silently dropped by Zod, never read.
- Interpolate a prompt (or anything else request-supplied) into a shell string. Every process is
  spawned with `shell: false` and an argv array (`packages/agent-runtime/src/process/spawn-process.ts`).
- Listen on any interface other than `127.0.0.1` by default. **Verified**: `http://[::1]:<port>`
  (IPv6 loopback) gets no response because the daemon binds IPv4 only.
- Log a complete environment, a raw auth-status response, or a full prompt at the default log
  level (`packages/agent-runtime/src/logger.ts` redacts any meta key matching
  `/token|secret|password|authorization|api[-_]?key|credential/i`). A non-zero process exit *does*
  log a bounded 2,000-character stderr snippet at `warn`. This is the CLI's diagnostic output, not
  daemon secrets, and it is needed to diagnose a failed process. See
  [docs/providers.md](docs/providers.md) for why this exists.
- Leak the token back through any API response, even an error body. **Verified** by regression
  test (`apps/daemon/test/server.test.ts`).

## Request validation

Every request body and path/query parameter that reaches a route handler is validated with Zod
(`packages/shared/src/schemas.ts`) before the route performs its action. Invalid input, such as an
unknown provider, a non-UUID session id, an oversized prompt, a field with the wrong type,
malformed JSON, or an oversized body, gets a sanitized `4xx` response with a short error message
and no stack trace
(`app.setErrorHandler` in `apps/daemon/src/server.ts` preserves Fastify's own `4xx` status codes
for genuine client errors like "malformed JSON" but flattens anything without one to a generic
`500`, so an unexpected internal error never leaks implementation detail while a bad request still
gets an accurate status).

## Process hygiene

See [docs/architecture.md](docs/architecture.md#dependency-graph) and
`packages/agent-runtime/src/process/spawn-process.ts` for details. Every provider CLI is spawned
detached from the daemon (in its own process group on
POSIX) and killed as a whole tree on cancellation (`taskkill /pid <pid> /T /F` on Windows, a
negative-pid `SIGTERM`→`SIGKILL` escalation on POSIX). **Verified on Windows**: a test fixture that
spawns a real grandchild process (simulating a CLI that itself launches a tool subprocess)
confirmed the grandchild stops running within ~1s of cancellation, not just the direct child
(`packages/agent-runtime/test/run-session.test.ts`). The POSIX path uses the equivalent,
well-established process-group mechanism but was not independently re-verified on macOS/Linux in
this audit because no such machine was available. Treat it as documented behavior rather than a
platform-tested result.

## Environment inheritance

Provider CLIs are spawned with the daemon's **full environment** (`process.env`) unless a caller
overrides `StartSessionOptions.env`, which nothing in this codebase currently does. The
`claude` and `codex` CLIs need `PATH`, `HOME`/`USERPROFILE`, and
platform-specific variables to even locate their own config and credentials, and stripping the
environment down to a selected subset could break CLI authentication. The daemon itself
never returns its environment (or the child's) through any API response or log line. If you fork
this project into a context where the daemon's own process might carry secrets unrelated to the
providers (e.g. it's started from a shell profile that also exports cloud credentials), that's a
reason to start the daemon from a more restricted environment.

## Single daemon instance

Every client discovers a given application's daemon through one fixed, namespaced discovery-file
path (`os.tmpdir()/agent-dock/<app-id>.json`, with `<app-id>` defaulting to `agent-dock`; see
`apps/daemon/src/discovery-file.ts`), so two daemons *sharing the same app id* running at once
would race to overwrite it. The last process to write the file would leave the other process alive
but unreachable through discovery. The daemon therefore refuses to start if
the discovery file's recorded pid is still alive, and treats a stale file (dead pid, or corrupt
from an interrupted write) as safe to overwrite. **Verified**: starting a second `pnpm daemon`
while the first is still running fails with an explicit "already running (pid ...)" error
instead of silently binding a second instance.

This is a per-app-id guarantee, not a machine-global one: two different products built on
AgentDock, each launched with its own `AGENT_DOCK_APP_ID`, run their own daemons and
independent single-instance locks, side by side without colliding. The app id itself is validated
before it is used to build a path (`sanitizeAppId()`: letters, digits, `-`, `_` only, 1–64
characters, and the first character must be a letter or digit). Invalid values are rejected, so
the app id cannot be used for path traversal (`../../etc/passwd`) or to escape the discovery
directory entirely (an absolute path). Electron's desktop app passes its app id to the daemon via
that same environment variable at spawn time, and computes the matching discovery path itself to
read the file back. See `apps/desktop/electron/main.ts`.

## Electron hardening

`apps/desktop/electron/main.ts` creates its `BrowserWindow` with:

```ts
webPreferences: {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  preload: join(__dirname, 'preload.js'),
}
```

`webSecurity` is never disabled, so Electron's default remains active. The window also denies
`window.open`/`target=_blank` popups and any in-window
navigation away from the app's own content (`setWindowOpenHandler` returning `{ action: 'deny' }`;
a `will-navigate` handler that compares full origins in development, not a `startsWith` prefix
check, which a URL like `http://localhost:5173.evil.example` would have passed against an allowed
`http://localhost:5173`, and in packaged mode allows only the exact `file://` URL of the app's own
`dist/index.html`, not any local file path); anything else opens in the OS's default browser
through `shell.openExternal`, **but only when it is an `http:` or `https:` URL**
(`electron/external-url.ts`). The scheme check is required because `shell.openExternal` passes the
string to the OS shell, which supports more than web links. A `file:` URL can launch a local
executable or reach a UNC path (sending an SMB handshake to a host named by an attacker), and any
protocol handler an installed application has registered is reachable by name. A
`session.setPermissionRequestHandler` denies every permission request (camera, microphone,
geolocation, notifications, etc.) by default, since nothing in this UI asks for any of them.

These navigation handlers protect the Search page, which renders `vacancy.url` from
third-party job feeds as an `<a target="_blank">`. Electron routes that click through
`setWindowOpenHandler` into `openExternal`. The scheme is checked on
both sides of that path: the engine constrains a discovered vacancy URL to `http(s)` when it parses
the feed (`httpUrl()` in `packages/vacancy-engine/src/global-remote/discovery-shared.ts`), and main
re-checks it at the point the OS action is actually taken. The renderer's CSP (`script-src 'self'`,
no `unsafe-inline`) independently neutralizes a `javascript:` URL, which React 18 does not block on
its own; it only warns.

The preload script (`electron/preload.ts`) exposes single-purpose, typed operations through
`contextBridge`, grouped into five namespaces. It does not expose a generic IPC invocation method
or the daemon's connection information (see "Renderer never talks to the daemon directly" above):

- `agentDock`: daemon status (queried once and pushed on change), list providers, create a
  session, cancel a session, subscribe to session events, open a native directory picker.
- `vacancyRadar`: engine status, stored reports, and scan commands for both markets. It has no
  daemon token or filesystem access.
- `workspace`: settings and counts, plus saved-job, application, CV, and letter records in the
  local workspace database.
- `cv`: a native-dialog-gated file pick that returns already-extracted text rather than a path,
  and a scratch-workspace-directory getter.
- `system`: launch-at-login settings, the app version, and a native-dialog-gated file export.

`apps/desktop/test/preload.test.ts` checks each namespace's key set against the module, so adding a
capability requires a corresponding test update. The two daemon-status functions and
`cv.selectAndRead` construct new objects from the IPC payload instead of passing through extra
fields. This prevents a token, base URL, or absolute path added in the main process from reaching
the renderer. There is no `remote` module or `eval`, and the renderer cannot execute an arbitrary
shell command, read an arbitrary file, or reach a daemon route that the bridge does not expose.
The page's `Content-Security-Policy` is
`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'`.
It has no `unsafe-eval`, and `connect-src` is same-origin because the renderer makes no network
calls of its own.

## Reporting a vulnerability

This repository does not have a dedicated security contact address. Report vulnerabilities through
[this repository's private security advisory form](https://github.com/jortega0033/open-vacancy-radar/security/advisories/new)
rather than filing a public issue, pull request, or exploit writeup. Include reproduction steps,
affected versions, impact, and any suggested mitigation. Avoid disclosing details publicly until a
fix or coordinated disclosure is ready.
