# Security

The daemon can invoke powerful local coding agents that read and write files and run shell
commands. This document states exactly what AgentDock defends against, how, and what's explicitly
out of scope, so a fork of this boilerplate can reason about its own trust boundary instead of
inheriting one on faith. It has been through an adversarial audit (reproducing attacks against a
running instance, not just reviewing the code). See the "Verified" notes throughout for what was
actually demonstrated versus what follows from the design.

## What this protects against

- A malicious or compromised **webpage running in an ordinary browser tab** (anywhere, not just
  inside this app) issuing requests to the daemon's `127.0.0.1` port and getting Claude/Codex to
  read or modify local files.
- The **renderer process** (React UI) reading the daemon's bearer token or base URL, or reaching
  any daemon route beyond the seven narrow IPC capabilities the `agentDock` preload bridge exposes.
  Two later, independent bridges follow the same discipline for OpenVacancyRadar's own features:
  `vacancyRadar` (three capabilities: engine status, last report, run a scan, no daemon token,
  no filesystem access) and `cv` (two capabilities: a native-dialog-gated file pick that returns
  already-extracted text, never a path, and a workspace-directory getter), each independently
  auditable and each deletable on its own without touching the others.
- A request choosing **which executable runs**: `POST /sessions` only ever accepts a `provider`
  id from a closed enum; the actual binary path is always resolved internally.
- **Shell interpolation**: every provider CLI is spawned with `shell: false` and an argv array;
  nothing request-supplied is ever concatenated into a shell string.
- **Casual credential leakage**: the daemon never reads a credential file/keychain entry/OAuth
  token itself, never logs one, and never returns its own bearer token in any API response.

## What this does NOT claim to protect against

- **Another process running as the same OS user with equivalent privileges.** If a process can
  already read your files, it can already do everything the CLI itself can do: this is a
  localhost trust boundary, not a sandbox between OS users or processes.
- **A compromised Claude Code or Codex CLI installation.** AgentDock spawns the CLI you already
  installed and authenticated; it does not vet, sandbox, or restrict what that CLI does once
  running.
- **Malicious code already running with equivalent local privileges**: e.g. another app on the
  same machine, running as the same user, that decides to read the discovery file or plant a
  symlink at its path before the daemon writes it. A same-user attacker in that position already
  has your files.
- **Provider-side security issues**: anything in Anthropic's or OpenAI's own infrastructure, auth
  systems, or CLI implementations is out of this project's scope entirely.

## Renderer never talks to the daemon directly

This is the load-bearing design decision, and it exists because of something an earlier version of
this project got wrong and an adversarial audit caught: **a browser fetch from the renderer to the
daemon cannot actually complete**, even with the right token. Any request carrying an
`Authorization` header is non-simple and forces a CORS preflight; the daemon deliberately never
answers a preflight with `Access-Control-Allow-Origin` (see below), so Chromium (which is exactly
what an Electron renderer uses for networking) refuses to send the real request at all. **Verified**:
reproduced with a real browser tab pointed at the Vite dev server, `fetch()`ing the daemon with a
valid token failed with `TypeError: Failed to fetch`, and DevTools showed the actual cause:
*"Response to preflight request doesn't pass access control check: No 'Access-Control-Allow-Origin'
header is present."* This is true in a packaged build too: a `file://`-loaded page is still a
distinct origin from `http://127.0.0.1:<port>` and still triggers the same preflight.

The fix is architectural, not a CORS exception: **all daemon HTTP/SSE traffic happens in Electron's
main process** (`apps/desktop/electron/main.ts`, via `@agent-dock/client`), which uses Node's
networking stack: CORS is a browser/fetch-spec concept enforced by Chromium's renderer process,
not by the `fetch` function itself, so main-process fetch was never subject to it. **Verified**: the
same request that failed from a real browser tab succeeds immediately from plain Node `fetch()`
against the same daemon. The renderer talks to main only through seven narrow, typed IPC
capabilities (`electron/preload.ts`): `getDaemonStatus()`, `onDaemonStatus()`, `listProviders()`,
`createSession()`, `cancelSession()`, `onSessionEvent()`, `selectDirectory()`. **The daemon's
bearer token and base URL never cross into the renderer at all** (they live only in main-process
memory), which closes off "token leaks into the DOM/renderer console/a crash report" by
construction rather than by convention. The two status-reporting functions
(`getDaemonStatus`/`onDaemonStatus`) reconstruct a clean `{ state, error? }` object from whatever
main sends rather than passing the IPC payload through unvalidated, specifically so an accidental
extra field on the main-process side (a token, a base URL) can never cross into the renderer even
by mistake. See `apps/desktop/test/preload.test.ts` for the regression test against the real
module, not a mock of it.

One consequence: the daemon no longer needs *any* browser origin allowlisted, in dev or production.
There is no configuration knob for this at all: the daemon rejects every request that carries an
Origin header, unconditionally (see [Origin validation](#origin-validation) below), and the
renderer's CSP `connect-src` is just `'self'` (it makes zero network calls to the daemon to
restrict). The daemon's HTTP+SSE API is unchanged and still fully usable by any *non-browser*
client (`curl`, a future CLI client, a VS Code extension) exactly as designed; only the desktop
app's own renderer was ever the problem, and only the desktop app's own transport changed.

## Local-auth token

The daemon generates a random 32-byte token (`crypto.randomBytes(32).toString('hex')`) at
**every** startup. It is never persisted across restarts and never hardcoded. Every route except
`GET /health` requires it:

```
Authorization: Bearer <token>
```

Requests without a valid token get `401`, compared with `crypto.timingSafeEqual` to avoid a timing
side-channel (`apps/daemon/src/auth-token.ts`).

The token reaches Electron's main process (never the renderer, see above) through a **filesystem
handoff, not a network one**: the daemon writes `{ port, token, pid, startedAt }` to a discovery
file once it's listening, and main reads that file directly (it runs as the same OS user). The
file itself is written mode `0600`; its containing directory (`os.tmpdir()/agent-dock/`, shared by
every AgentDock-based app on the machine) is created mode `0700` on POSIX, and if it already
exists, the daemon verifies it's still owned by the current user with mode `0700` before writing
into it, refusing to start otherwise: `os.tmpdir()` is a shared, sometimes world-writable root on
Linux (Windows and macOS both return a per-user directory already), so without this check a
different local user could have pre-staged the directory to intercept the handoff. There is no
equivalent POSIX-style check on Windows: NTFS ACLs are inherited from the parent by default, which
for a per-user temp root is already restrictive, and a `chmod`-style check would be a claim this
codebase can't actually verify there. See `apps/daemon/src/discovery-file.ts`.

The discovery *filename* is namespaced per application id (default `agent-dock`, overridable via
`AGENT_DOCK_APP_ID`) rather than one fixed name. See
[Single daemon instance](#single-daemon-instance) below for why.

### Why a bearer token defeats the "malicious webpage" threat specifically

A page running in a real browser tab, at some `http://evil.example` origin, can absolutely send a
request to `http://127.0.0.1:<port>`. That's just how the web works, and no amount of "the server
only listens on localhost" changes that. What stops it:

1. **It doesn't know the token.** The token lives in a discovery file with restrictive permissions
   and never crosses into any renderer; a webpage has no filesystem access at all.
2. **The daemon never sends CORS headers.** No CORS plugin is installed, and no route ever sets
   `Access-Control-Allow-Origin`. `Authorization` is a
   ["non-simple" header](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS#simple_requests),
   so a cross-origin `fetch` that sets it triggers a CORS preflight (`OPTIONS`) first, and because
   the daemon never answers a preflight with permission, the browser refuses to send the real
   request at all. **Verified**: a preflight `OPTIONS /sessions` from a disallowed origin gets
   `403` from our own Origin check before Fastify would even route it to a handler, and no route
   ever adds `Access-Control-Allow-*` response headers regardless.

Point 2 is the one that actually matters even if a token somehow leaked: without permissive CORS,
a browser will not let cross-origin script read the response of a state-changing request even for
requests that *don't* need a preflight (e.g. a plain `<form>` POST, or a `fetch` with
`Content-Type: text/plain`), but the request could still fire. That's exactly why every mutating
route additionally requires the token: form-based "blind" CSRF can't set a custom `Authorization`
header, so it can't pass the token check either. **Verified**: a simulated cross-origin form-style
POST (`Content-Type: text/plain`, no auth header, `Origin: http://evil.example`) to `POST /sessions`
was rejected before session creation, by the Origin check specifically.

## Three separate kinds of credential, not one

This project handles three distinct things that all sound like "authentication" but protect
different boundaries, are stored differently, and never mix:

1. **The daemon token above** — authenticates the local HTTP protocol between Electron's main
   process and the daemon. Random per launch, never persisted, never touches an AI provider or a
   job source. This is the only credential this codebase itself generates.
2. **Claude/Codex CLI authentication** — entirely out of this project's hands. The daemon spawns
   the user's already-installed `claude`/`codex` binary as a child process and reads its stdout; it
   never sees, stores, or forwards whatever login state that CLI already holds (its own OS keychain
   entry, config file, or session token — this project doesn't know or care which). Logging in and
   out happens directly with the CLI (`claude auth login` / `codex login`), never through this app.
   See [What this is not](README.md#what-this-is-not).
3. **Optional MCP job-source credentials** — the daemon and desktop bridge already implement full
   support for connecting an MCP-based job-source provider (see
   [docs/mcp-source-policy.md](docs/mcp-source-policy.md)) that needs its own API key or token,
   unrelated to either of the above, but **no provider is registered in this build**: the daemon
   wires its `McpConnectionManager` with an empty policy list (`apps/daemon/src/index.ts`), so every
   `/mcp/providers/:providerId/...` route currently answers "not allowlisted" for any id, and the
   desktop app has no screen that calls it. Once a provider is registered, a credential would be
   written through `PUT /mcp/providers/:providerId/credential` (bearer-token-protected, like every
   other route) and stored via `apps/daemon/src/mcp/credential-store.ts`, which delegates to the
   OS's native credential store — Windows Credential Manager, macOS Keychain, or the Linux Secret
   Service — through `@napi-rs/keyring`, under a service name namespaced to this app
   (`open-vacancy-radar.mcp`). No route ever reads a stored credential back out: the daemon can set
   one, delete one, and report a provider's connection *status* (connected/not), but there is no API
   that returns the credential value itself once it's been written.

Losing the daemon token exposes only the local AgentDock protocol (see the CSRF analysis above).
Losing a CLI's own login state is a threat model that CLI's own security documentation owns, not
this one. Losing an MCP credential exposes only that one provider's account, and only if an
attacker already has OS-user-level access to read that user's own credential store — a strictly
higher bar than reading this project's own files, since it means they could already read the
daemon's discovery-file token directly.

## Origin validation

`apps/daemon/src/server.ts` also validates the `Origin` header independently of the token, and
does so before the auth check runs. The policy is deliberately simple: **any request that carries
an `Origin` header at all is treated as browser-authored and rejected with `403`**, unconditionally:
no allowlist, no scheme parsing, no configuration knob. Requests with no `Origin` header at
all (`curl`, another local process, Electron's own main process) pass this check and fall
through to the token check, since a real browser cannot omit `Origin` on a cross-origin request;
only non-browser contexts can.

This replaced an earlier version that only recognized the literal string `"null"` and
`/^https?:\/\//i` as "browser-authored," with an `AGENT_DOCK_ALLOWED_ORIGINS` allowlist meant to
permit a future browser client. Two problems with that version, both fixed by the current policy:
a `chrome-extension://` (or any other non-`http(s)`, non-`"null"` scheme) origin fell straight
through unrecognized, since it matched neither check; and the allowlist itself was inert even when
populated, since nothing ever paired it with a real `Access-Control-Allow-Origin` response header:
an allowlisted browser origin still could not have completed a request, per
[Renderer never talks to the daemon directly](#renderer-never-talks-to-the-daemon-directly) above.
Since there is no legitimate browser-originated caller of this API today, the fix was to delete the
allowlist rather than complete it: treating every `Origin` header as disqualifying is simpler, and
correct for what this daemon actually needs to be reachable by.

## What the daemon will never do

- Read a Claude/Codex/any-provider credential file, keychain entry, or OAuth token directly.
- Accept an executable path or name from a request body: `POST /sessions` only accepts a
  `provider` id from a closed enum (`packages/shared/src/schemas.ts`); the actual executable is
  always resolved internally via `findExecutable()`. **Verified**: an unknown `provider` value
  fails Zod validation with `400` before reaching any handler; extra/unknown body fields (e.g. an
  `executable` or `env` field slipped into the request) are silently dropped by Zod, never read.
- Interpolate a prompt (or anything else request-supplied) into a shell string. Every process is
  spawned with `shell: false` and an argv array (`packages/agent-runtime/src/process/spawn-process.ts`).
- Listen on any interface other than `127.0.0.1` by default. **Verified**: `http://[::1]:<port>`
  (IPv6 loopback) gets no response. The daemon binds IPv4-only, not dual-stack.
- Log a complete environment, a raw auth-status response, or a full prompt at the default log
  level (`packages/agent-runtime/src/logger.ts` redacts any meta key matching
  `/token|secret|password|authorization|api[-_]?key|credential/i`). A non-zero process exit *does*
  log a bounded (2000-char) stderr snippet at `warn`: that's the CLI's own diagnostic output, not
  daemon secrets, and a failure with zero visible reason is undebuggable. See
  [docs/providers.md](docs/providers.md) for why this exists.
- Leak the token back through any API response, even an error body. **Verified** by regression
  test (`apps/daemon/test/server.test.ts`).

## Request validation

Every request body and path/query parameter that reaches a route handler is validated with Zod
(`packages/shared/src/schemas.ts`) before touching any business logic. Invalid input (an unknown
provider, a non-UUID session id, a prompt over the size cap, a wrong-typed field, malformed JSON,
an oversized body) gets a sanitized `4xx` with a short error message, never a stack trace
(`app.setErrorHandler` in `apps/daemon/src/server.ts` preserves Fastify's own `4xx` status codes
for genuine client errors like "malformed JSON" but flattens anything without one to a generic
`500`, so an unexpected internal error never leaks implementation detail while a bad request still
gets an accurate, actionable status).

## Process hygiene

See [docs/architecture.md](docs/architecture.md#dependency-graph) and
`packages/agent-runtime/src/process/spawn-process.ts` for the full detail; the security-relevant
summary is that every provider CLI is spawned detached from the daemon (its own process group on
POSIX) and killed as a whole tree on cancellation (`taskkill /pid <pid> /T /F` on Windows, a
negative-pid `SIGTERM`→`SIGKILL` escalation on POSIX). **Verified on Windows**: a test fixture that
spawns a real grandchild process (simulating a CLI that itself launches a tool subprocess)
confirmed the grandchild stops running within ~1s of cancellation, not just the direct child
(`packages/agent-runtime/test/run-session.test.ts`). The POSIX path uses the equivalent,
well-established process-group mechanism but was not independently re-verified on macOS/Linux in
this audit (no such machine was available). Treat it as documented behavior, not empirically
re-confirmed on every platform.

## Environment allowlist for spawned provider processes

Provider CLIs are spawned with a **default-deny environment allowlist**
(`packages/agent-runtime/src/providers/common/provider-environment.ts`), not with the daemon's own
environment. A child receives only the platform and provider-config variables it actually needs;
everything else is dropped, including variables that match no "secret-looking" pattern at all.

### What this replaced, and why the old reasoning was half right

This section previously documented full `process.env` inheritance as *a deliberate tradeoff, not an
oversight*, on the grounds that `claude`/`codex` need `PATH`, `HOME`/`USERPROFILE` and
platform-specific variables to locate their own config and credentials, and that "stripping the
environment down to a hand-picked safe subset risks silently breaking legitimate CLI
authentication" — a worse failure for a project whose whole point is "use the CLI's own auth".

That risk was real and is still taken seriously; it is why over-restriction is treated as a genuine
regression rather than an inconvenience. What the old reasoning got wrong was treating the safe
subset as unknowable. It was never measured. It has been now, against the real installed binaries
rather than asserted from documentation: under an environment restricted to exactly the allowlist,
`claude --version`, `codex --version`, `where claude`/`where codex`, `claude auth status --json`
(`{"loggedIn": true, "authMethod": "claude.ai", ...}`) and `codex login status`
(`Logged in using ChatGPT`) all behave identically to a full-inheritance run. **OAuth**
authentication is unaffected, because it resolves through the CLI's own on-disk state, which this
daemon still never reads or touches. A per-variable removal sweep additionally identified `PATHEXT`
as independently load-bearing — without it, executable detection fails outright.

Stated precisely, because "authentication is unaffected" without qualification would overclaim what
was measured: **environment-variable-based authentication is deliberately no longer supported.**
Three configurations stop working, and cannot be re-enabled by the user, since a name must clear
both lists and no allowlist entry overrides a denied one:

- **API-key auth** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). A real configuration, not a hypothetical:
  `parseCodexLoginStatus` already recognizes a "Logged in using API key" state.
- **Bedrock routing** (`CLAUDE_CODE_USE_BEDROCK`, `ANTHROPIC_BEDROCK_BASE_URL`, `AWS_*`).
- **Vertex routing** (`ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`,
  `GOOGLE_APPLICATION_CREDENTIALS`).

That is taken knowingly. A long-lived API key or a set of cloud credentials handed to a process that
reads untrusted scraped content and can reach the network is exactly the authority this change
withdraws, and this product's premise is the CLI's own OAuth session. But an affected user's symptom
is a false "not authenticated", so it is written down here rather than left to be rediscovered.
Re-enabling any of it is a policy decision to be made in review, not a flag.

So the tradeoff is not deleted, it is resolved: the failure mode it feared is the one the
measurement rules out, and the exposure it accepted is no longer necessary to accept.

### Why this mattered here specifically

Not hypothetical. `packages/vacancy-engine/src/config.ts` reads this product's own vacancy-source
credentials (`AI_API_KEY`, `BRAVE_SEARCH_API_KEY`, `ADZUNA_APP_ID`/`ADZUNA_APP_KEY`,
`JOOBLE_API_KEY`, `REED_API_KEY`, `JOBSPIPE_API_KEY`) directly from `process.env`, and
`apps/desktop/electron/main.ts` spawns the daemon with `{ ...process.env, ... }`. On a machine
where those are exported, they previously reached the daemon and then every provider CLI child
verbatim, along with `AGENT_DOCK_STATE_DIR`, `AGENT_DOCK_APP_ID` and anything else in the launching
shell. A provider session reads untrusted content by design (a scraped job posting can carry
injected instructions) and can reach the network, so "the child could read the environment" was a
real path, not a theoretical one.

The daemon's keyring-backed MCP credential store (`apps/daemon/src/mcp/credential-store.ts`, via
`@napi-rs/keyring`) was checked and is **not** part of this exposure: it never places a secret in
any process environment. Nor is the per-launch discovery token an environment variable — it is
written to a `0600` discovery file and held in memory (see [Single daemon instance](#single-daemon-instance)).

### The two lists

Same shape as the tool restriction in `providers/claude/build-args.ts`:

1. **A required allowlist**, stated positively so a variable introduced by a future dependency is
   not granted by default. Drift therefore fails closed (something goes missing, visibly) rather
   than open. On Windows: `PATH`, `PATHEXT`, `COMSPEC`, `SystemRoot`, `SystemDrive`, `windir`,
   `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `ProgramData`,
   `ProgramFiles`, `ProgramFiles(x86)`, `ProgramW6432`, `TEMP`, `TMP`, `NUMBER_OF_PROCESSORS`,
   `OS`, `PROCESSOR_ARCHITECTURE`. On POSIX the structural analogue (`HOME`, `TMPDIR`, `SHELL`,
   `USER`, `LOGNAME`, the `LANG`/`LC_*` and `XDG_*` roots, plus `XDG_RUNTIME_DIR` and
   `DBUS_SESSION_BUS_ADDRESS`, without which a libsecret/gnome-keyring credential lookup fails and
   the CLI reports itself not logged in). Plus, on both: each provider's own config namespace
   (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`) and the proxy/CA variables a CLI needs to reach its auth
   endpoint on a managed network (`ALL_PROXY` included — Codex is Rust/reqwest and honors it).
2. **An always-enforced deny list**, applied as a conjunction with the allowlist rather than a
   sequential override, so a credential-shaped name can never reach a child even if a later edit
   adds an overlapping entry to the allowlist. It covers the usual credential shapes (`SECRET`, `TOKEN`, `PASSWORD`,
   `CREDENTIAL`, `API_KEY`, `_KEY$`, `AWS_`/`AZURE_`/`GCP_`/`GOOGLE_APPLICATION_`/`GH_`/`GITHUB_`/
   `NPM_`/`OPENAI_`/`ANTHROPIC_`/`SSH_`/`VAULT_`) *and* this daemon's and product's own internals
   (`AGENT_DOCK_*`, `ELECTRON_*`, and the vacancy-source credential names above). A granted name
   must clear the allowlist *and* this list — a conjunction, not an evaluation order, so "deny wins"
   describes the result rather than a sequence. The two lists are disjoint today, which means the
   deny branch never fires in production and its veto cannot be observed by ordinary use; a test
   constructs the overlap on purpose so the veto is exercised rather than merely asserted.

`StartSessionOptions.env` and `SpawnOptions.env` now select *which* environment gets filtered, not
whether filtering happens. There is no opt-out: every `spawnProcess` caller in this repo is a
provider CLI or a `where`/`which` lookup on behalf of one, so the policy is applied once, at the
single point where the process is actually created, and every other entry point (`exec-capture.ts`,
`detect-executable.ts`, `run-session.ts`, both providers' `detect.ts`) inherits it structurally
rather than re-implementing it. Provider *detection* therefore runs under the same environment a
real session does, which is what makes a detection result mean anything about a later session.

### This bounds the session's tools, not only the CLI

Everything the agent runs *inside* a session — build commands, test runners, `git`, an MCP server it
starts — are descendants of the bounded child and inherit the same environment. `PATH` survives, so
most tooling still resolves, but toolchain variables do not (`JAVA_HOME`, `CARGO_HOME`, `GOPATH`,
`VIRTUAL_ENV`, `CONDA_PREFIX`, `PYENV_ROOT`, `NVM_DIR`, `ANDROID_HOME`, `NODE_OPTIONS`), and
`SSH_AUTH_SOCK` is denied, so agent-forwarded `git push` over SSH will not work from inside a
session. That is the intended posture — an SSH agent socket reachable by a process that reads
untrusted scraped postings is authority worth withdrawing — but it is a real behavior change for a
toolchain-heavy workspace, and it fails in ways that will not look like an environment problem.

### Enforcing the choke point

`packages/agent-runtime/src/process/spawn-process.ts` holds the only `spawn()` call in the package,
with the filter applied on the line above it. That the guarantee is *structural* rather than
conventional is enforced by an ESLint `no-restricted-imports` rule on `node:child_process` (and the
equivalent bare `child_process` specifier) across `packages/agent-runtime/src/**`, `apps/daemon/
src/**`, and `apps/desktop/electron/**` (issue #176): without it, a future `execFile` import in any
of the three would bypass the relevant environment filter silently and no test would notice. Each
covered directory has exactly one named exception -- `spawn-process.ts` here, `workspace-identity.ts`
(the `git` spawn, filtered via the same allowlist -- see "A related choke point" below) and `main.ts`
(the daemon sidecar spawn, filtered by `daemon-environment.ts`, ADI-21) in the other two.

### A related choke point: Git spawns in `workspace-identity.ts`

`apps/daemon/src/workspace-identity.ts`'s `runGit` is a second, narrower choke point: the only place
this repo invokes `git` on a user's workspace directory. Its environment is built by `gitSafeEnv`,
which as of issue #176 applies this same allowlist (via `buildProviderEnvironment`) rather than its
original upstream-derived mechanic of scrubbing only the `GIT_*` namespace and forwarding everything
else -- that older approach left every secret in the daemon's own environment reaching `git`
verbatim. The allowlist closes both problems structurally: no `GIT_*` name is on it (so every
redirect-capable Git variable is already absent, with nothing to track release to release), and
every credential-shaped name is denied the same way it is for a provider CLI child.

### Two honest limits

- **Windows re-adds eleven variables regardless.** libuv merges its own `required_vars` in from the
  real parent environment, so even `spawn(..., { env: {} })` produces a child with `HOMEDRIVE`,
  `HOMEPATH`, `LOGONSERVER`, `PATH`, `SYSTEMDRIVE`, `SYSTEMROOT`, `TEMP`, `USERDOMAIN`, `USERNAME`,
  `USERPROFILE`, `WINDIR`. **Verified directly** by spawning a `process.env` dump with an empty env.
  None is credential-shaped, and a test asserts the deny list never claims to block one of them —
  because the runtime would silently override it and the guarantee would be a fiction. The
  allowlist is deliberately *not* padded with these to make the subset assertion look tidier.
- **A proxy URL can embed credentials.** `HTTP_PROXY`/`HTTPS_PROXY` are allowlisted because without
  them a CLI behind a corporate proxy cannot reach its own auth endpoint — the exact false "not
  authenticated" this design is trying to avoid — and no name-based pattern can tell
  `http://proxy.example` from `http://user:pass@proxy.example`. Named here rather than left implicit.

The daemon still never returns its environment (or a child's) through any API response or log line.
The environment builder reports which variables it dropped by **name only**; a dropped variable's
value is the thing most likely to be a secret, so the return type gives a caller nothing to log by
accident.

The POSIX allowlist is the one part not empirically re-verified: no macOS or Linux machine was
available, the same caveat this document already carries for the POSIX process-group termination
path. Treat it as documented intent pending a first-run check on those platforms.

## Single daemon instance

Every client discovers a given application's daemon through one fixed, namespaced discovery-file
path (`os.tmpdir()/agent-dock/<app-id>.json`, `<app-id>` defaulting to `agent-dock`, see
`apps/daemon/src/discovery-file.ts`), so two daemons *sharing the same app id* running at once
would silently race over it: whichever started last "wins" the file, leaving the other alive but
unreachable through discovery. Rather than accept that ambiguity, the daemon refuses to start if
the discovery file's recorded pid is still alive, and treats a stale file (dead pid, or corrupt
from an interrupted write) as safe to overwrite. **Verified**: starting a second `pnpm daemon`
while the first is still running fails fast with an explicit "already running (pid ...)" error
instead of silently binding a second instance.

This is a per-app-id guarantee, not a machine-global one: two different products built on this
boilerplate, each launched with its own `AGENT_DOCK_APP_ID`, run their own daemons, and their own
independent single-instance locks, side by side without colliding. The app id itself is validated
before it's ever used to build a path (`sanitizeAppId()`: letters, digits, `-`, `_` only, 1–64
characters, must start with a letter or digit), rejected outright rather than sanitized-by-best-
effort, so it can't be used for path traversal (`../../etc/passwd`) or to escape the discovery
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

`webSecurity` is never disabled (there is no override anywhere in this codebase, leaving it at its
secure default). The window also denies `window.open`/`target=_blank` popups and any in-window
navigation away from the app's own content (`setWindowOpenHandler` returning `{ action: 'deny' }`;
a `will-navigate` handler that compares real origins in dev mode (not a `startsWith` prefix
check, which a URL like `http://localhost:5173.evil.example` would have passed against an allowed
`http://localhost:5173`), and in packaged mode allows only the exact `file://` URL of the app's own
`dist/index.html`, not any local file path); anything else opens in the OS's default browser
instead via `shell.openExternal`, **but only when it is an absolute `https:` URL with a non-empty
host and no embedded userinfo** (`electron/external-url.ts`). That check is not optional politeness:
`shell.openExternal` hands the string to the OS shell, which acts on far more than web links:
`file:` can launch a local executable or reach a UNC path (leaking an SMB handshake to an
attacker-named host), and any protocol handler an installed application has registered is reachable
by name. `http:` used to pass this check and no longer does: a cleartext link handed to the OS
browser is one whose destination anything on the path can rewrite, and the string being handed over
was scraped from a third-party page to begin with. Embedded userinfo is rejected for a different
reason — `https://www.boards.greenhouse.io@attacker.invalid/` is a URL whose *host* is
`attacker.invalid` while its visible prefix is a brand the user trusts. UNC (`\\host\share`),
drive-letter, rooted and protocol-relative forms all fail too, because `new URL` is called with no
base and so parses absolute URLs only. A
`session.setPermissionRequestHandler` denies every permission request (camera, microphone,
geolocation, notifications, etc.) by default, since nothing in this UI asks for any of them.

An earlier version of this section called the navigation handlers non-load-bearing, "cheap defense
in depth for forks of this boilerplate that later add [untrusted content or links]." OpenVacancyRadar
is now exactly such a fork, so that caveat no longer applies: the Vacancy Leads screen renders
`vacancy.url` (scraped from third-party job feeds, i.e. attacker-influenceable) as an
`<a target="_blank">`, and Electron routes that click straight through `setWindowOpenHandler` into
`openExternal`. These handlers are live controls here, not spare parts. The scheme is checked on
both sides of that path: the engine constrains a discovered vacancy URL to `http(s)` when it parses
the feed (`httpUrl()` in `packages/vacancy-engine/src/global-remote/discovery-shared.ts`), and main
re-checks it at the point the OS action is actually taken. The renderer's CSP (`script-src 'self'`,
no `unsafe-inline`) independently neutralizes a `javascript:` URL, which React 18 does not block on
its own. It only warns.

### Every IPC handler verifies its sender

`ipcMain.handle(channel, listener)` is process-global: it answers **any** frame in **any**
`WebContents` the main process hosts, and a handler that does not look at `event` cannot tell the
app's own window from an `<iframe>`, a `<webview>`, a second window, or a devtools-hosted page.
Until ADI-16 only the three `workspace-grant:*` channels looked at the caller at all, and even those
used `event.sender.id` to bind a *grant* to a `WebContents` — an authorization check on a handle,
not an authentication check on the caller.

Every one of the 51 `invoke` channels is now registered through `createGuardedIpc`
(`electron/ipc-sender-guard.ts`) instead of `ipcMain` directly. Before any listener runs, the
invoking event must satisfy both of:

1. `event.sender.id` equals the `WebContents` id captured when `createWindow()` built the app's
   window (cleared again when that window is destroyed, so there is no window-less "allow"); and
2. `event.senderFrame` is that `WebContents`' **top-level** frame — it has no parent, and its
   `frameTreeNodeId` matches `event.sender.mainFrame`'s. `frameTreeNodeId` is compared rather than
   object identity or `routingId` because Electron documents it as browser-global and fixed for the
   frame's lifetime, whereas `WebFrameMain` instances are re-created across a cross-process
   navigation and `routingId` is unique only within one renderer process.

Anything the check cannot positively confirm — no window yet, a `senderFrame` Electron has already
released, a `WebContents` throwing mid-teardown — is a refusal with a fixed message, not a guess.
`apps/desktop/test/ipc-sender-guard.test.ts` reads `electron/`'s own source and fails if a direct
`ipcMain.handle` appears anywhere, or if the set of guarded channels stops matching the set
`preload.ts` invokes, so a handler added later without the guard fails a test rather than shipping
unverified.

The preload script (`electron/preload.ts`) exposes seven narrow, single-purpose namespaces via
`contextBridge`, never a generic "invoke this IPC channel with this payload" tunnel, and never the
daemon's connection info (see "Renderer never talks to the daemon directly" above): `agentDock` (the
only one that talks to the daemon, via `AgentDockClient`), `vacancyRadar`, `workspace`, `cv`,
`system`, `workspaceGrant` (ADI-06's filesystem-trust boundary), and `agentWorkspace` (ADI-07's
read-only session views). See [docs/electron.md](docs/electron.md#the-preload-bridge) for what each
one actually exposes -- deliberately not repeated here as a maintained per-function count, since
that list drifts every time a namespace gains a function, which is exactly how this section came to
claim "twelve operations across three namespaces" long after a fourth, fifth, sixth, and seventh
namespace existed (issue #179).

`apps/desktop/test/preload.test.ts` pins each namespace's key set against the real module, so an
added capability fails the suite rather than arriving unnoticed. The daemon-status functions (and
`cv.selectAndRead`) reconstruct a clean object from the IPC payload rather than passing it through
once its shape looks roughly right, so an accidental extra field on the main-process side (a token,
a base URL, an absolute path) can't ride along. There is no `remote` module, no
`eval`, and no path by which the renderer
can execute an arbitrary shell command, read an arbitrary file, or reach any daemon route this
bridge doesn't explicitly expose. The page's `Content-Security-Policy` is
`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'`: no
`unsafe-eval`, and `connect-src` is just same-origin now that the renderer makes no network calls
of its own.

## Reporting a vulnerability

This repository does not have a dedicated security contact address. Report vulnerabilities through
[this repository's private security advisory form](https://github.com/jortega0033/open-vacancy-radar/security/advisories/new)
rather than filing a public issue, pull request, or exploit writeup. Include reproduction steps,
affected versions, impact, and any suggested mitigation. Avoid disclosing details publicly until a
fix or coordinated disclosure is ready.
