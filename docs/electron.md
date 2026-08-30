# Electron

`apps/desktop` is the Open Vacancy Radar Electron + React application. It uses
`@agent-dock/client` to communicate with the daemon and has no provider-specific execution logic.

## The three-layer boundary

```
Renderer (React)  ──IPC (contextBridge)──▶  Electron main  ──@agent-dock/client──▶  Daemon
```

The renderer **never** calls the daemon's HTTP+SSE API directly. Only the main process does,
through one `AgentDockClient` instance. A renderer `fetch()` to the daemon cannot complete because
the daemon does not approve CORS preflight requests. See
[SECURITY.md](../SECURITY.md#renderer-never-talks-to-the-daemon-directly) for details. In this
codebase:
keep new daemon calls in `electron/main.ts`, never add a `fetch()` to the daemon from anywhere
under `src/` (the renderer).

## BrowserWindow security settings

`electron/main.ts` creates its window with:

```ts
webPreferences: {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  preload: join(__dirname, 'preload.js'),
}
```

`webSecurity` is never overridden. `setWindowOpenHandler` denies every `window.open`/`target=_blank`
popup and opens the URL in the OS browser instead. `will-navigate` (`isAllowedNavigationTarget()`
in `main.ts`) allows only: in dev mode, the exact dev-server *origin* (a real `new URL(...).origin`
comparison, not a `startsWith` prefix match; a prefix check would allow
`http://localhost:5173.evil.example` through against an allowed `http://localhost:5173`); in
packaged mode, the exact `file://` URL of the app's own `dist/index.html`, not any local file path.
Anything else redirects to the OS browser instead. A `session.setPermissionRequestHandler` denies
every permission request by default (camera, microphone, geolocation, notifications, and others).
The navigation checks protect vacancy links loaded from external job sources. The current UI does
not request device permissions. See
[SECURITY.md](../SECURITY.md#electron-hardening).

## The preload bridge

`electron/preload.ts` exposes seven functions on `window.agentDock` through `contextBridge`. It
does not expose a generic IPC method, the daemon's base URL, or its bearer token.
`getDaemonStatus` and `onDaemonStatus` create a new status object containing only the allowed
fields. See `apps/desktop/test/preload.test.ts` for the regression test:

```ts
interface AgentDockBridge {
  getDaemonStatus(): Promise<DaemonStatus>;
  onDaemonStatus(callback: (status: DaemonStatus) => void): () => void;
  listProviders(): Promise<ProviderStatus[]>;
  createSession(input: CreateSessionInput): Promise<AgentSession>;
  cancelSession(sessionId: string): Promise<void>;
  onSessionEvent(callback: (sessionId: string, event: AgentEvent) => void): () => void;
  selectDirectory(): Promise<string | null>;
}
```

Each maps to one `ipcMain.handle(...)` in `main.ts`. Add each new renderer capability as a specific,
typed function. Do not add a generic method that accepts an arbitrary IPC channel and payload.

## Daemon lifecycle from Electron's side

On `app.whenReady()`, `main.ts` spawns the daemon as a child process
(`spawn(process.execPath, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, ... })`),
using `resolveDaemonEntry()` (`electron/resolve-daemon-entry.ts`) to choose the entry point for
development, packaged, and unpacked runs. See
[packaging.md](packaging.md#resolvedaemonentry) for the three cases. It
then polls the discovery file (`waitForDaemonReady`, 200ms interval, 15s timeout) until it can read
a port and token and successfully call `client.health()`. That call checks both readiness and
protocol compatibility. `daemon:status` IPC events (`connecting` / `ready` / `unavailable`) let the
renderer show the connection state without receiving the token or other daemon internals.

`app.requestSingleInstanceLock()` makes a second launch focus the existing window instead of
opening another window, which would otherwise spawn a second daemon and lose the
single-instance race described in [daemon.md#single-instance-behavior](daemon.md#single-instance-behavior).

On quit, `killDaemon()` aborts the active SSE subscription, best-effort calls
`POST /sessions/cancel-all` over HTTP to cancel *every* in-flight session (not just the one the UI
happens to be tracking), then kills the daemon child process. This exists specifically because
Windows' `child.kill()` doesn't deliver a real `SIGTERM` the daemon's own shutdown handler could
otherwise catch. See [daemon.md#shutdown](daemon.md#shutdown) for details.

## Renderer trust assumptions

The renderer is treated as **semi-trusted, not adversarial**. It is this repository's React code,
sandboxed by Electron's process isolation, but it's still the layer closest to whatever the CLI's
output ends up rendering. Concretely: the renderer never receives the daemon's token or base URL
(so a compromised renderer cannot reach the daemon directly), and every IPC input from
the renderer is re-validated against the Zod schemas at the `ipcMain.handle` boundary in `main.ts`
instead of being trusted because it came from the preload bridge. See the comment on
`daemon:create-session` in `electron/main.ts` for why that revalidation is a distinct concern from
`@agent-dock/client`'s own validation of the daemon's response.

## Session working directories

`selectDirectory()` opens a native OS directory picker (`dialog.showOpenDialog`) from the main
process and returns the chosen path (or `null` if cancelled) to the renderer. Callers that allow a
user-selected working directory can pass that path as a session's `cwd`. The current CV and letter
features instead call `getWorkspaceDir()` and use the app-owned AI workspace. The renderer cannot
read either directory directly, but the generic `createSession` bridge still accepts the `cwd` it
supplies.

## Provider and AI feature flow

1. The AI Runtime page calls `listProviders()` and shows each provider's installation and
   authentication state.
2. The user can save a default provider in workspace settings and verify its executable, version,
   and authentication status without making a model request.
3. CV and letter features use `useAgentRun` to call `createSession(input)` with the selected
   provider and a feature-specific prompt.
4. `main.ts` forwards that session's SSE events to the renderer through `onSessionEvent`.
5. `useAgentRun` reads normalized `AgentEvent` values and does not branch on provider id. See
   [protocol-v1.md](protocol-v1.md) for the event union.

## Where to safely add native functionality

- **A new daemon capability the UI needs**: add the IPC handler in `main.ts`, the typed function in
  `preload.ts`'s `AgentDockBridge`, and call it from the renderer through `window.agentDock`. Do not
  add a daemon call directly in renderer code.
- **A new native OS integration** (file picker, notifications, tray icon, etc.): same pattern. Main
  process owns the Electron/Node API, preload exposes a specific typed function, and the renderer calls it.
  Never enable `nodeIntegration` or disable `contextIsolation`/`sandbox` to shortcut this.
- **Rendering content that isn't this repo's own UI** (e.g. a tool result containing a link or
  HTML): route external links through `shell.openExternal` (already the default for any navigation
  away from the app, see [BrowserWindow security settings](#browserwindow-security-settings) above)
  rather than loading them in-window.

## Build tooling

`vite-plugin-electron/simple` (`vite.config.ts`) bundles `electron/main.ts` and `electron/preload.ts`
with esbuild and starts the Electron process during `vite dev` (launch and reload on change); `vite
build` produces the same `dist-electron/` output for packaging. `preload.js` is forced to CommonJS
output (`format: 'cjs'`) since Electron's sandboxed preload loader doesn't support ESM, even though
the rest of this project is `"type": "module"`.
