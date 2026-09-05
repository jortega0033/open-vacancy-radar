import { app, BrowserWindow, ipcMain, dialog, Menu, Tray, shell } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { cp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createSessionRequestSchema,
  mcpCredentialInputSchema,
  mcpProviderIdSchema,
  mcpSearchRequestSchema,
  providerIdSchema,
  sessionIdParamSchema,
  workspaceTrustViewSchema,
  type ProviderId,
  type WorkspaceTrustView,
} from '@agent-dock/shared';
import { AgentDockClient } from '@agent-dock/client';
import {
  candidateProfileSchema,
  createDatabaseClient,
  createLogger,
  createScanLock,
  loadCandidateProfile,
  loadConfig,
  migrateDatabase,
  readGlobalRemoteReport,
  runGlobalRemoteScan,
  type CandidateProfile,
  type Database,
  type GlobalRemoteReport,
  type ScanLock,
} from '@open-vacancy-radar/vacancy-engine';
import {
  AGENT_WORKSPACE_ACTIVITY_CHANNEL,
  createSessionAliasBook,
  registerAgentWorkspaceHandlers,
} from './agent-workspace-ipc.js';
import { AgentWorkspaceRelay } from './agent-workspace-relay.js';
import type { ActivityPush } from './agent-workspace-types.js';
import { ApplicationQueueRelay, type ApplicationQueueEventSource } from './application-queue-relay.js';
import type { ApplicationQueueEvent } from './application-queue-types.js';
import { daemonSessionRefusalReason } from './daemon-session-refusals.js';
import { isSafeExternalUrl } from './external-url.js';
import { buildDaemonEnvironment } from './daemon-environment.js';
import { createGuardedIpc } from './ipc-sender-guard.js';
import { resolveDaemonEntry } from './resolve-daemon-entry.js';
import { resolveTrayIcon, resolveWindowIcon } from './resolve-window-icon.js';
import {
  resolveVacancyEngineDataRoot,
  resolveVacancyEngineMigrationsFolder,
} from './resolve-vacancy-engine-paths.js';
import { sendToRenderer } from './send-to-renderer.js';
import { CV_FILE_EXTENSIONS, readCvFile, type CvFileContent } from './cv-text.js';
import { createScanGuard, isExpectedScanBusyError } from './scan-guard.js';
import { shouldRunScheduledScan } from './scheduled-scan.js';
import { confirmWorkspaceGrant } from './workspace-confirm.js';
import {
  WorkspaceGrantManager,
  WorkspaceGrantRefusedError,
  type DaemonConsumeOutcome,
  type DaemonCreateSessionOutcome,
  type GrantExpiryReason,
} from './workspace-grant.js';
import { createWorkspaceDb, type WorkspaceDb } from './workspace/client.js';
import * as workspace from './workspace/repository.js';
import {
  parseApplicationFilter,
  parseApplicationInput,
  parseApplicationPatch,
  parseCvDocumentInput,
  parseCvDocumentPatch,
  parseIdAndPatch,
  parseIdEnvelope,
  parseLetterInput,
  parseLetterPatch,
  parseSavedJobInput,
  parseSavedJobPatch,
  parseSettingsPatch,
} from './workspace/validate.js';
import { parseCandidateProfilePatch } from './vacancy-profile-validate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Electron's default `app.getPath('userData')` etc. derive from `app.getName()`, which falls back
// to package.json's `name` field (`@agent-dock/desktop`, an internal workspace name) when nothing
// sets it explicitly. Left unset, every user-data path (workspace/vacancy-engine databases, the
// Chromium profile) would live under a directory named after that internal package rather than
// the product name shown everywhere else (the installer, the window title, the docs). Must run
// before any `app.getPath(...)` call below, so it comes first, right after `app` becomes usable.
app.setName('Open Vacancy Radar');

// Electron's default application menu (File/Edit/View/Window) is generic boilerplate this app has
// no use for: no menu-driven File action exists, and standard text-field editing (copy/paste/undo)
// works through Chromium's native input handling regardless of whether an application menu is
// installed, not through the menu's accelerators. Removing it entirely reads as a finished product
// instead of an unconfigured Electron shell.
Menu.setApplicationMenu(null);

// Two AgentDock windows would each spawn their own daemon sidecar and race over the same
// discovery file (the daemon's own single-instance guard, see SECURITY.md, would make the
// second one fail to start), rather than let that surface as a confusing "daemon unavailable"
// error, refuse to open a second window at all and focus the existing one instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

/**
 * Renderer status only: never the token or base URL. The renderer talks to the daemon
 * exclusively through the IPC handlers below, which delegate to `@agent-dock/client`; the
 * `AgentDockClient` instance (which carries the bearer token) never crosses into the renderer
 * process. See SECURITY.md.
 */
type DaemonStatus = { state: 'connecting' } | { state: 'ready' } | { state: 'unavailable'; error: string };

let daemonChild: ChildProcess | undefined;
let client: AgentDockClient | undefined;
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
/**
 * Mirrors the `minimizeToTrayOnClose` workspace setting for the `close` handler below, which
 * cannot `await workspace.getSettings()` mid-event -- `close` is synchronous and a queued async
 * read would let the default (unwanted) OS close behavior proceed before the answer arrives.
 * Hydrated once from the database after `ensureWorkspaceDb()` resolves, and kept in sync by the
 * `workspace:settings:update` handler on every write (ADI-22).
 */
let minimizeToTrayOnClose = false;
/**
 * Set only by the real quit paths (tray "Quit", `before-quit`). The `close` handler checks this
 * to tell "user clicked the window's X button" (hide to tray) apart from "the app is actually
 * quitting" (let the window close for real) -- both fire the same `close` event.
 */
let isQuitting = false;
/**
 * Mirrors the `autoScanEnabled` workspace setting for the background-scan timer below (#195),
 * hydrated and kept in sync the same way and for the same reason as `minimizeToTrayOnClose`: the
 * timer tick is synchronous plumbing around an async scan call, and reading a live setting on
 * every 5-minute tick is needless DB traffic when this mirror is already kept current.
 */
let autoScanEnabled = false;
/**
 * The `WebContents` id of the window `createWindow()` built, and the only sender any IPC handler in
 * this file will answer (ADI-16).
 *
 * Captured at window creation and cleared on that window's destruction, for the same reason the
 * ADI-06 grant channels capture `webContents.id` eagerly: reading it later, from a `BrowserWindow`
 * Electron has already torn down, is reading a property of a destroyed object -- and "the window is
 * gone" is exactly the moment the guard needs an answer. `undefined` (no window yet, or none any
 * more) rejects every call rather than allowing one: see electron/ipc-sender-guard.ts.
 */
let mainWindowWebContentsId: number | undefined;
/**
 * The single source of truth `daemon:get-status` reads from. Without this, that handler had to
 * re-derive a status from `client` alone (set or not), which can only ever mean "ready" or
 * "connecting" -- it has no way to represent "already failed", so a pull-based query made any time
 * after a startup failure incorrectly reported "connecting" forever, no matter how long ago the
 * daemon actually died. `sendStatus` is the only place that both updates this and pushes to the
 * renderer, so the two can never disagree.
 */
let latestDaemonStatus: DaemonStatus = { state: 'connecting' };

/**
 * Every in-flight **v1** event forward, keyed by session id (ADI-07).
 *
 * This replaces the single `activeStreamAbort` module global that used to sit here alongside an
 * `activeSessionId`. That pair was a single-slot relay: `forwardSessionEvents` overwrote both on
 * every new session, so a second concurrent session silently orphaned the first one's abort
 * controller and `killDaemon` could only ever abort whichever stream started last. `activeSessionId`
 * itself was pure write-only bookkeeping -- it was assigned by `daemon:create-session` and cleared
 * at a terminal event, and **nothing ever read it** (the shutdown path had already moved to
 * `sessions.cancelAll()` for exactly this reason, see AD-12) -- so it is simply gone.
 *
 * Keying by session id is the same fix ADI-07 makes for the new v2 relay in
 * `agent-workspace-relay.ts`, applied to the v1 path so the two cannot disagree about what
 * "shut down every stream" means. The forwarding itself is untouched: same channel, same raw
 * envelope, same synthesized error event on failure.
 */
const v1EventForwards = new Map<string, AbortController>();

/**
 * The daemon's loopback address and per-launch bearer token, kept here so the ADI-06 workspace
 * routes can be called directly.
 *
 * `AgentDockClient` deliberately has no workspace methods: adding them would widen a package that
 * three other consumers depend on, for one caller. This is the same token and the same origin the
 * client already uses, so nothing new is exposed -- and, as everywhere else in this file, it never
 * crosses into the renderer (see SECURITY.md and the preload bridge's own docstring).
 */
let daemonConnection: { baseUrl: string; token: string } | undefined;
/**
 * The UUID `/health` reports for the currently-connected daemon process (ADI-06, D7).
 *
 * A change means the daemon that the user granted workspace access to no longer exists, so every
 * outstanding grant refers to an approval its replacement never saw. Comparing this on every
 * readiness transition is what makes "restarting the daemon revokes outstanding grants" structural
 * rather than something a future edit has to remember.
 */
let daemonInstanceId: string | undefined;

let vacancyDb: Database | undefined;
let vacancyEngineInit: Promise<Database> | undefined;
let vacancyScanLock: ScanLock | undefined;
let latestVacancyReport: GlobalRemoteReport | undefined;

/**
 * Guards the vacancy scan against overlapping with itself. See electron/scan-guard.ts for why the
 * in-process half and the cross-process advisory lock are both needed.
 */
const { runExclusiveScan, isScanInFlight } = createScanGuard(() => vacancyScanLock);

let workspaceDb: WorkspaceDb | undefined;
let workspaceInit: Promise<WorkspaceDb> | undefined;
/** Closed on quit so the WAL is checkpointed rather than left for the next launch to recover. */
let closeWorkspaceDb: (() => void) | undefined;

/**
 * Where `config/global-remote-profile-v1.json` and `reports/global-remote/*` live for the vendored
 * engine, in dev/unpacked mode: the monorepo layout (`apps/desktop/dist-electron` three levels
 * under the repo root, next to `packages/vacancy-engine`).
 */
function vacancyEngineProjectRoot(): string {
  return join(__dirname, '..', '..', '..', 'packages', 'vacancy-engine');
}

/** Read-only migration SQL, shipped as an extraResource (see electron-builder.yml). */
function vacancyEngineMigrationsFolder(): string {
  return resolveVacancyEngineMigrationsFolder({
    vacancyEngineProjectRoot: vacancyEngineProjectRoot(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
}

let vacancyEngineDataRootInit: Promise<void> | undefined;

/**
 * Where the engine reads `config/*.json` (including `company-domain-candidates-v1.json`, which it
 * also *writes* back to across scans — not purely static input) and writes `reports/`/`.data/`.
 * Once packaged, this seeds `config/` from the read-only copy shipped as an extraResource.
 * `force: false` skips only the individual destination files that already exist (so an
 * update-carried-forward `company-domain-candidates-v1.json` is never overwritten by the packaged
 * default) rather than gating on whether the whole directory exists: a launch interrupted mid-copy,
 * or a future release adding a new config file, both still complete on the next call instead of
 * leaving a partial `config/` permanently stuck. Retries on failure like the two lazy-init
 * functions below, for the same reason: a transient error (disk full, AV lock) shouldn't wedge
 * every scan for the rest of the process's lifetime.
 */
async function vacancyEngineDataRoot(): Promise<string> {
  const root = resolveVacancyEngineDataRoot({
    vacancyEngineProjectRoot: vacancyEngineProjectRoot(),
    isPackaged: app.isPackaged,
    userDataPath: app.getPath('userData'),
  });
  if (!app.isPackaged) return root;
  vacancyEngineDataRootInit ??= cp(
    join(process.resourcesPath, 'vacancy-engine', 'config'),
    join(root, 'config'),
    { recursive: true, force: false },
  );
  try {
    await vacancyEngineDataRootInit;
    return root;
  } catch (error) {
    vacancyEngineDataRootInit = undefined;
    throw error;
  }
}

/**
 * Hydrates `latestVacancyReport` from the `latest.json` a previous process lifetime's scan wrote
 * to disk (#195) -- without this, a scan that finished before this launch (including one from
 * before this feature existed) stays invisible to `vacancy:get-report` until the next scan Electron
 * itself runs in the current process. Pre-warm only, exactly like `ensureVacancyEngine`/
 * `ensureWorkspaceDb` below: `vacancyEngineDataRoot()` can itself throw in packaged mode (it awaits
 * a first-run config seed copy), so this is wrapped failure-tolerant -- on any error,
 * `latestVacancyReport` is simply left `undefined`, exactly like today, never a new startup failure.
 */
async function hydrateLatestVacancyReport(): Promise<void> {
  try {
    latestVacancyReport = await readGlobalRemoteReport(await vacancyEngineDataRoot());
  } catch {
    // Tolerated -- see doc comment above.
  }
}

/**
 * The database itself lives under the OS-provided per-user app data directory, never inside the
 * (potentially read-only, once packaged) install location. The whole point of this engine being
 * embedded is that an end user never touches a file path or a database server.
 */
async function ensureVacancyEngine(): Promise<Database> {
  if (vacancyDb) return vacancyDb;
  // Memoized on the in-flight promise, not just the settled result: `app.whenReady` pre-warms the
  // engine at the same moment the window is created, so a renderer call landing during the initial
  // migration must join that run rather than start a second `createDatabaseClient` + `migrateDatabase`
  // against the same SQLite file.
  vacancyEngineInit ??= (async () => {
    const config = vacancyEngineConfig();
    const { db } = createDatabaseClient(config.databasePath);
    // `migrateDatabase`'s default migrations folder is the relative path `drizzle`, which only
    // resolves when the process cwd happens to be `packages/vacancy-engine`, never true once
    // Electron actually launches. Resolve it explicitly instead of relying on cwd.
    await migrateDatabase(db, vacancyEngineMigrationsFolder());
    vacancyDb = db;
    // Created once, alongside the database it guards: `createScanLock` takes exclusivity on a
    // sidecar SQLite file keyed to this database path, so it is meaningful across processes
    // (a `pnpm vacancies:scan` run against the same userData database, a second app instance
    // that somehow got past the single-instance lock), not just within this one.
    vacancyScanLock = createScanLock(config.databasePath);
    return db;
  })();

  try {
    return await vacancyEngineInit;
  } catch (error) {
    vacancyEngineInit = undefined; // a later call retries rather than replaying the failure forever
    throw error;
  }
}

function vacancyEngineConfig() {
  return loadConfig(
    { ...process.env, DATABASE_PATH: 'vacancy-engine.db', HTTP_CACHE_DIR: '.cache/http' },
    app.getPath('userData'),
  );
}

/**
 * Opens the personal-workspace database, on the same lazy-init-once contract as
 * `ensureVacancyEngine` above and for the same reasons: `app.whenReady` pre-warms it while the
 * window is being created, so a renderer call arriving mid-migration joins that run instead of
 * starting a second `migrate()` against the same SQLite file.
 */
async function ensureWorkspaceDb(): Promise<WorkspaceDb> {
  if (workspaceDb) return workspaceDb;
  workspaceInit ??= (async () => {
    const { db, close } = createWorkspaceDb(app.getPath('userData'));
    workspaceDb = db;
    closeWorkspaceDb = close;
    // ADI-22: hydrate the `close`-handler and background-scan-timer mirrors once, here, since
    // neither can await a fresh read at the moment they need the answer. Kept in sync afterward
    // by the `workspace:settings:update` handler.
    const settings = workspace.getSettings(db);
    minimizeToTrayOnClose = settings.minimizeToTrayOnClose;
    autoScanEnabled = settings.autoScanEnabled;
    return db;
  })();

  try {
    return await workspaceInit;
  } catch (error) {
    workspaceInit = undefined;
    throw error;
  }
}

// Namespaces the daemon rendezvous per application (AD-02). See apps/daemon/src/discovery-file.ts
// for the daemon side of this. A fork shipping its own product under a different name should set
// this to its own id (env var, or hardcode a different literal here) so it doesn't collide with
// another AgentDock-based app's daemon on the same machine; the reference app just uses the
// default. The daemon validates/sanitizes this value itself and refuses to start on an invalid
// one, so it isn't duplicated here.
const APP_ID = process.env.AGENT_DOCK_APP_ID?.trim() || 'open-vacancy-radar';

function discoveryFilePath(): string {
  return join(tmpdir(), 'agent-dock', `${APP_ID}.json`);
}

function sendStatus(status: DaemonStatus): void {
  latestDaemonStatus = status;
  sendToRenderer(mainWindow, 'daemon:status', status);
}

function spawnDaemon(): void {
  const { cwd, args } = resolveDaemonEntry({
    mainDir: __dirname,
    isDevServer: !!process.env.VITE_DEV_SERVER_URL,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  const spawnedAt = Date.now();

  daemonChild = spawn(process.execPath, args, {
    cwd,
    env: {
      ...buildDaemonEnvironment(process.env),
      ELECTRON_RUN_AS_NODE: '1',
      AGENT_DOCK_APP_ID: APP_ID,
      // ADI-05: pins the daemon's durable v2 session state under the same per-user data root that
      // already holds workspace.db and vacancy-engine.db, in its own subdirectory. Without this the
      // daemon would fall back to its own platform-native location (%LOCALAPPDATA%\<appId> and
      // friends), creating a second, undocumented product-data directory that a user uninstalling
      // or resetting the app would never find. The subdirectory matters as much as the root: the
      // daemon refuses a state root that overlaps a product database path (see
      // apps/daemon/src/state-directory.ts), so that a backup, a drizzle migration, or a workspace
      // reset can never carry the session store along with it.
      AGENT_DOCK_STATE_DIR: join(app.getPath('userData'), 'agentdock-state'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // Bounded, matching the same snippet-size convention `run-session.ts` uses for a provider CLI's
  // stderr: a crash reason (missing native module, a thrown error on require(), a missing system
  // library) is almost always in the first couple thousand characters, and this is forwarded to
  // the renderer's "Daemon unavailable" banner, not just logged, so it must stay short.
  let stderrSnippet = '';
  daemonChild.stdout?.on('data', (chunk: Buffer) => {
    // The daemon's own logger already redacts secrets; forward for local debugging only.
    console.log(`[daemon] ${chunk.toString('utf8').trim()}`);
  });
  daemonChild.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    console.error(`[daemon] ${text.trim()}`);
    if (stderrSnippet.length < 2000) stderrSnippet = (stderrSnippet + text).slice(0, 2000);
  });

  // If the daemon exits before ever becoming ready, `waitForDaemonReady` below would otherwise run
  // out its full timeout and report a generic "timed out" message, discarding the one piece of
  // information that actually explains what happened: the exit code and whatever the process
  // printed to stderr before dying (a thrown require() error, a missing native module, a missing
  // system library). Racing this against `waitForDaemonReady` lets whichever failure is real win.
  let rejectOnEarlyExit!: (error: Error) => void;
  const earlyExit = new Promise<never>((_resolve, reject) => {
    rejectOnEarlyExit = reject;
  });

  daemonChild.on('exit', (code, signal) => {
    if (!client) {
      const detail = stderrSnippet.trim() ? `: ${stderrSnippet.trim()}` : '';
      rejectOnEarlyExit(new Error(`process exited before starting (code ${code ?? 'null'}, signal ${signal ?? 'null'})${detail}`));
      return;
    }
    client = undefined;
    sendStatus({ state: 'unavailable', error: `daemon process exited unexpectedly (code ${code ?? 'null'}, signal ${signal ?? 'null'})` });
  });

  Promise.race([waitForDaemonReady(spawnedAt), earlyExit]).catch((err: Error) => {
    sendStatus({ state: 'unavailable', error: `daemon failed to start: ${err.message}` });
  });
}

async function waitForDaemonReady(spawnedAt: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const file = discoveryFilePath();

  while (Date.now() < deadline) {
    if (existsSync(file) && statSync(file).mtimeMs >= spawnedAt - 1000) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { port: number; token: string };
        const baseUrl = `http://127.0.0.1:${parsed.port}`;
        const candidate = new AgentDockClient({ baseUrl, token: parsed.token });
        // health() also verifies protocol compatibility (see @agent-dock/client). This doubles
        // as both the readiness check and the version-compatibility check in one call.
        const health = await candidate.health();
        client = candidate;
        daemonConnection = { baseUrl, token: parsed.token };
        // ADI-06: a daemon whose instance id differs from the one grants were issued against is a
        // different process, so every outstanding approval is void. Done before the status goes
        // `ready`, so no renderer can consume a stale grant against the new daemon.
        adoptDaemonInstance(health.daemonInstanceId);
        sendStatus({ state: 'ready' });
        // #200: unlike the AI-workspace relay (per-session, only attached on a renderer's own
        // request), there is exactly one application queue and no per-session redaction concern,
        // so this attaches proactively -- "reopening the window reflects current queue state"
        // needs the stream live before any renderer even asks.
        applicationQueueRelay.attach();
        return;
      } catch {
        // discovery file mid-write, daemon not reachable yet, or (in dev only, across a protocol
        // bump) a stale daemon still shutting down: keep polling rather than fail on one miss
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('timed out waiting for daemon to become ready');
}

/*
 * ---------------------------------------------------------------------------------------------
 * ADI-06: workspace grants.
 *
 * Everything below keeps one rule: the renderer never sees a filesystem path. It asks for a grant
 * (naming only a provider), main runs the native picker and the native confirmation dialog, and
 * what comes back is an opaque handle plus a bounded folder name. The path lives in the grant
 * record in this process and is handed only to the daemon, over loopback, at consumption time.
 * ---------------------------------------------------------------------------------------------
 */

const PROVIDER_DISPLAY_NAMES: Readonly<Record<ProviderId, string>> = Object.freeze({
  claude: 'Claude Code',
  codex: 'Codex',
});

/** One authenticated request to a daemon route `@agent-dock/client` does not model. */
async function daemonFetch(path: string, init: { method: string; body?: unknown }): Promise<Response> {
  if (!daemonConnection) throw new Error('daemon is not ready yet');
  return fetch(`${daemonConnection.baseUrl}${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${daemonConnection.token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

/** Every message this process is willing to show for a daemon refusal, keyed by the daemon's code. */
const DAEMON_REFUSAL_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  unc_workspace_unsupported:
    'network locations are not supported as agent workspaces. Choose a folder on a local drive: a ' +
    'network path cannot be given a stable identity, so the app cannot guarantee that the folder ' +
    'you approve is the folder the agent later runs in.',
  invalid_workspace_path: 'this folder could not be read, so it cannot be used as an agent workspace',
  workspace_not_reusable:
    'this folder cannot be used as an agent workspace: the filesystem does not report a stable ' +
    'identity for it. Choose a folder on a local disk.',
  audit_log_full:
    'the security log is full, so this action was refused rather than performed unrecorded. ' +
    'Archive it and restart the app.',
  audit_unavailable:
    'the security log is not writable, so this action was refused rather than performed unrecorded. ' +
    'Restart the app.',
  audit_write_failed: 'this action could not be recorded in the security log, so it was not performed',
});

/**
 * The renderer-facing message for a daemon refusal, chosen from the closed table above by the
 * daemon's machine-readable `code` and **never** taken from its `error` text.
 *
 * The previous version returned `body.error` verbatim, which is a path leak waiting to happen: an
 * audit-store failure's message quotes the filesystem error that caused it, and that error names the
 * daemon's log file. Reading only `code` means a message this process did not write can never reach
 * the renderer, whatever a future daemon build decides to put in `error`. It is the same defensive
 * shape `consumeGrant` below already used, applied to the two calls that did not have it.
 *
 * An unrecognized code falls back to the caller's own fixed message rather than to the daemon's
 * text, so a code added daemon-side later degrades to a vague message, never to an unreviewed one.
 */
async function daemonRefusal(res: Response, fallback: string): Promise<{ message: string; code: string }> {
  let code = '';
  try {
    const body = (await res.json()) as { code?: unknown };
    if (typeof body.code === 'string') code = body.code;
  } catch {
    // A body that is not JSON tells us nothing beyond the status, which the fallback already covers.
  }
  return { message: DAEMON_REFUSAL_MESSAGES[code] ?? fallback, code };
}

/**
 * Replaces the tracked daemon instance, expiring every outstanding grant when it actually changed.
 *
 * The first observation (`daemonInstanceId === undefined`) is adoption, not a change, so a normal
 * startup expires nothing. Every later differing value is a restart.
 */
function adoptDaemonInstance(nextInstanceId: string | undefined): void {
  if (daemonInstanceId !== undefined && nextInstanceId !== daemonInstanceId) {
    const expired = workspaceGrants.expireAll('daemon_generation');
    if (expired.length > 0) {
      void workspaceGrants.reportExpiries(expired, 'daemon_generation', 'daemon_restart');
    }
  }
  daemonInstanceId = nextInstanceId;
}

const workspaceGrants = new WorkspaceGrantManager({
  async inspectWorkspace({ path, provider }): Promise<WorkspaceTrustView> {
    const res = await daemonFetch('/v2/workspaces/inspect', { method: 'POST', body: { path, provider } });
    if (!res.ok) {
      const refusal = await daemonRefusal(res, 'this folder could not be inspected');
      throw new WorkspaceGrantRefusedError(refusal.message, refusal.code || 'inspect_failed');
    }
    const body = (await res.json()) as { workspace?: unknown };
    // Parsed rather than cast: this response feeds a security confirmation dialog, and a malformed
    // one must fail loudly instead of rendering `undefined` where a folder name belongs.
    return workspaceTrustViewSchema.parse(body.workspace);
  },

  async consumeGrant(input): Promise<DaemonConsumeOutcome> {
    const res = await daemonFetch('/v2/workspaces/consume-grant', { method: 'POST', body: input });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { code?: unknown };
    // The daemon's machine-readable code is mapped onto the local reason vocabulary. Anything
    // unrecognized becomes `not_trusted`, which is the fail-closed direction: an outcome this build
    // cannot interpret must never read as success.
    const code = typeof body.code === 'string' ? body.code : '';
    if (code === 'workspace_identity_drift') return { ok: false, reason: 'identity_drift' };
    if (code === 'workspace_revoked') return { ok: false, reason: 'trust_revoked' };
    if (code === 'audit_log_full' || code === 'audit_unavailable' || code === 'audit_write_failed') {
      return { ok: false, reason: 'audit_failure' };
    }
    return { ok: false, reason: 'not_trusted' };
  },

  /**
   * `POST /v2/sessions` (ADI-13).
   *
   * The response body carries the daemon's full v2 session view, and that view has a `cwd` field --
   * a real filesystem path. So the result is **rebuilt field by field** here rather than passed
   * through, on the same principle as `toGrantOffer` in preload.ts: a path cannot cross a boundary
   * it was never copied across, whatever a future daemon build decides to include.
   *
   * Failures are mapped from the daemon's machine-readable `code` only, never from its `error` text,
   * for the reason `daemonRefusal` documents: an audit-store failure's message quotes the filesystem
   * error that names the daemon's log file.
   */
  async createSession(input): Promise<DaemonCreateSessionOutcome> {
    const res = await daemonFetch('/v2/sessions', { method: 'POST', body: input });

    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { session?: unknown };
      const session = body.session as Record<string, unknown> | undefined;
      if (!session || typeof session.id !== 'string') return { ok: false, reason: 'refused' };
      return {
        ok: true,
        session: {
          sessionId: session.id,
          // The provider the caller's ref named, never the one the response claimed: this process
          // knows which workspace it asked about, and echoing the body would be one more field a
          // future change could widen.
          provider: input.provider,
          status: typeof session.status === 'string' ? session.status : 'starting',
          ...(typeof session.model === 'string' ? { model: session.model } : {}),
        },
      };
    }

    const body = (await res.json().catch(() => ({}))) as { code?: unknown };
    const code = typeof body.code === 'string' ? body.code : '';
    return { ok: false, reason: daemonSessionRefusalReason(code) };
  },

  async recordGrantEvent(input): Promise<void> {
    const res = await daemonFetch('/v2/workspaces/grant-events', { method: 'POST', body: input });
    if (!res.ok) {
      // `audit_failure` is kept as the code regardless of which audit fault the daemon reported:
      // this is the grant manager's own reason vocabulary, and the daemon's finer distinction
      // (full vs unwritable) is already reflected in the message chosen from the closed table.
      const refusal = await daemonRefusal(
        res,
        'this action could not be recorded in the security log, so it was not performed',
      );
      throw new WorkspaceGrantRefusedError(refusal.message, 'audit_failure');
    }
  },

  async pickDirectory(): Promise<string | null> {
    if (!mainWindow) return null;
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a folder for the agent to work in',
      properties: ['openDirectory'],
    });
    const picked = result.filePaths[0];
    if (result.canceled || !picked) return null;
    return picked;
  },

  confirm: (input) => confirmWorkspaceGrant(mainWindow, input),
  daemonInstanceId: () => daemonInstanceId,
  providerName: (provider) => PROVIDER_DISPLAY_NAMES[provider],
  onEvent: (message, meta) => console.warn(`[workspace-grant] ${message}`, meta ?? {}),
});

/** Expires (and audits) every grant a `WebContents` holds. Wired to navigation and destruction. */
function expireGrantsForWebContents(webContentsId: number, reason: GrantExpiryReason): void {
  const expired = workspaceGrants.expireForWebContents(webContentsId, reason);
  if (expired.length === 0) return;
  void workspaceGrants.reportExpiries(
    expired,
    reason,
    reason === 'navigation' ? 'navigation' : 'policy',
  );
}

/**
 * Streams one v1 session's **raw** events to the renderer on `daemon:session-event`.
 *
 * This is the CV/Letters path (`useAgentRun`), and ADI-07 leaves what it *does* byte-identical:
 * every envelope is pushed unmodified, on the same channel, and a stream failure still synthesizes
 * the same non-recoverable `error` event that `useAgentRun` depends on to stop waiting for a
 * terminal event that can no longer come.
 *
 * The only change is bookkeeping: the controller is registered per session id in `v1EventForwards`
 * instead of overwriting one shared `activeStreamAbort`, and the terminal-event branch no longer
 * writes to a global nothing read. See `v1EventForwards` for why that pair had to go.
 *
 * It is deliberately **not** replaced by ADI-07's sanitizing relay. The two serve different
 * consumers over different contracts: this one hands raw envelopes to a one-shot text runner
 * working in an app-owned scratch directory, while the new relay carries sanitized entries for
 * concurrent sessions running in the user's own folders. Folding them together would either
 * redact v1 (breaking `useAgentRun`) or un-redact v2 (breaking the boundary ADI-07 exists to add).
 */
function forwardSessionEvents(sessionId: string): void {
  if (!client) return;
  const controller = new AbortController();
  v1EventForwards.set(sessionId, controller);
  const activeClient = client;

  void (async () => {
    try {
      for await (const event of activeClient.sessions.events(sessionId, { signal: controller.signal })) {
        sendToRenderer(mainWindow, 'daemon:session-event', { sessionId, event });
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      sendToRenderer(mainWindow, 'daemon:session-event', {
        sessionId,
        event: { type: 'error', message: `event stream failed: ${(err as Error).message}`, recoverable: false },
      });
    } finally {
      // Guarded on identity so a re-forwarded session id does not have its successor's
      // registration deleted by its predecessor's late teardown.
      if (v1EventForwards.get(sessionId) === controller) v1EventForwards.delete(sessionId);
    }
  })();
}

async function killDaemon(): Promise<void> {
  // Every stream, not "whichever one started last". ADI-07 replaced a single `activeStreamAbort`
  // global with these two keyed registries precisely so this line means what it always claimed to.
  agentWorkspaceRelay.detachAll();
  applicationQueueRelay.detach();
  for (const controller of [...v1EventForwards.values()]) controller.abort();
  v1EventForwards.clear();
  if (client) {
    try {
      // Cancels every in-flight session over HTTP, not just `activeSessionId`: on Windows,
      // daemonChild.kill() below maps to TerminateProcess, which never gives the daemon's own
      // SIGTERM handler (and its cancelAll()) a chance to run, so this HTTP call is the only
      // reliable way to stop every session's CLI process on that platform. Tracking a single
      // `activeSessionId` was previously the only thing cancelled here, which orphaned every
      // other session's process for any fork that runs more than one at a time (AD-12).
      await client.sessions.cancelAll();
    } catch {
      // best effort; the daemon's own shutdown handler is the fallback (SIGTERM on POSIX)
    }
  }
  daemonChild?.kill();
}

const packagedEntryUrl = pathToFileURL(join(__dirname, '..', 'dist', 'index.html')).href;

/**
 * Scopes `will-navigate` to exactly the app's own content instead of "any http(s) origin that
 * happens to start with the dev-server URL" or "any file:// path at all". Both of the previous
 * checks were prefix-based (`url.startsWith(...)`), which a URL like
 * `http://localhost:5173.evil.example` passes against an allowed `http://localhost:5173`. Real
 * origin comparison (dev) and exact-path comparison against the one file this app ever loads
 * (packaged) close that gap.
 */
function isAllowedNavigationTarget(url: string): boolean {
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    try {
      return new URL(url).origin === new URL(devServerUrl).origin;
    } catch {
      return false;
    }
  }
  return url === packagedEntryUrl;
}

/** Drops any non-http(s) URL rather than handing it to the OS shell. See external-url.ts. */
function openExternalIfSafe(url: string): void {
  if (!isSafeExternalUrl(url)) return;
  void shell.openExternal(url);
}

function createWindow(): void {
  const icon = resolveWindowIcon({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    ...(icon ? { icon } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, 'preload.js'),
    },
  });

  // Defense in depth for forks of this boilerplate that later render untrusted content (e.g. a
  // link in a tool result): never let the window navigate away from our own app, and never let
  // it spawn an unrestricted child window. Legitimate external links go to the OS browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url);
    return { action: 'deny' };
  });

  // Captured eagerly, and used by both handlers below. Reading `webContents.id` inside the
  // `destroyed` handler would be reading a property of an object Electron has already torn down,
  // which is exactly the moment the id is needed.
  const webContentsId = mainWindow.webContents.id;
  // ADI-16: the same id, published to the IPC sender guard. Assigned here rather than derived from
  // `mainWindow` on demand so that the guard reads a plain number and never touches a possibly
  // destroyed `BrowserWindow`, and so a window recreated by macOS's `activate` (which reassigns
  // `mainWindow`) simply replaces it.
  mainWindowWebContentsId = webContentsId;

  mainWindow.webContents.on('will-navigate', (event, url) => {
    // ADI-06: every navigation attempt expires this WebContents' grants, including one to an
    // allowed target. A grant is bound to the page the user was looking at when they approved it,
    // and a reload replaces that page: the new document never showed anyone a dialog, so it must
    // ask again. Expiring before the allow-check means a same-origin reload is covered too.
    expireGrantsForWebContents(webContentsId, 'navigation');
    if (isAllowedNavigationTarget(url)) return;
    event.preventDefault();
    openExternalIfSafe(url);
  });

  // A destroyed WebContents can never present a handle again, but the record would otherwise sit in
  // the map until its TTL, still consumable by a `webContentsId` the OS is free to reuse.
  mainWindow.webContents.on('destroyed', () => {
    expireGrantsForWebContents(webContentsId, 'webcontents_destroyed');
    // ADI-16: stop answering IPC for an id whose window no longer exists. Guarded on identity so a
    // late teardown of an older window cannot clear the id of the one that replaced it -- the same
    // reason `forwardSessionEvents` checks controller identity before deleting its registration.
    if (mainWindowWebContentsId === webContentsId) mainWindowWebContentsId = undefined;
  });

  // Deny every permission request by default except the one this UI genuinely uses:
  // `clipboard-sanitized-write`, requested by `navigator.clipboard.writeText` for the "Copy to
  // clipboard" (CoverLetter.tsx, LetterGenerator.tsx) and "Copy diagnostics" (AboutSection.tsx)
  // buttons. Nothing here reads the clipboard or asks for camera, microphone, geolocation,
  // notifications, etc, so there's no other legitimate request to allow. Electron's own
  // per-permission/per-platform defaults are inconsistent; this makes the policy explicit and
  // uniform instead of relying on them.
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'clipboard-sanitized-write');
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.webContents.on('did-finish-load', () => {
    if (client) sendStatus({ state: 'ready' });
  });

  // #194: when the setting is on, closing the window hides it to the tray instead of quitting --
  // `isQuitting` (set only by the tray's own "Quit" item and `before-quit`) distinguishes that from
  // an actual app quit, since both reach this same `close` event.
  mainWindow.on('close', (event) => {
    if (isQuitting || !minimizeToTrayOnClose) return;
    event.preventDefault();
    mainWindow?.hide();
  });
}

/**
 * Windows-only (see electron-builder.yml: no `linux:`/`mac:` target). Built once and held at
 * module scope -- Electron destroys a `Tray` instance the moment it's garbage-collected, so a
 * local variable here would silently vanish the tray icon at an unpredictable point.
 */
function createTray(): void {
  const iconPath = resolveTrayIcon({
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  if (!iconPath) return;

  tray = new Tray(iconPath);
  tray.setToolTip('Open Vacancy Radar');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Open Open Vacancy Radar',
        click: () => {
          if (!mainWindow) {
            createWindow();
            return;
          }
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', () => {
    if (!mainWindow) {
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

/*
 * ---------------------------------------------------------------------------------------------
 * ADI-16: every channel below is registered through `guardedIpc`, never through `ipcMain` directly.
 *
 * `guardedIpc.handle` is `ipcMain.handle` with one thing added: before the listener runs at all, the
 * invoking event's sender is checked to be the top-level frame of the window `createWindow()` built.
 * Anything else -- a subframe, a second window, a `<webview>`, a devtools-hosted page -- is refused
 * with a fixed message and never reaches the handler body. See electron/ipc-sender-guard.ts for what
 * "the main window's own top-level frame" means mechanically and why `event.sender.id` alone is not
 * it.
 *
 * A direct registration on `ipcMain` anywhere under electron/ fails test/ipc-sender-guard.test.ts, so a
 * handler added later without this cannot ship unverified. `ipcMain` is imported solely to be handed
 * to `createGuardedIpc` below.
 * ---------------------------------------------------------------------------------------------
 */
const guardedIpc = createGuardedIpc(ipcMain, {
  mainWindowWebContentsId: () => mainWindowWebContentsId,
  onRejected: ({ channel }) =>
    // No payload, no sender id, no frame detail: a rejection is a security event worth seeing in the
    // log, and the channel name alone says which surface was probed. Everything else would either
    // repeat what the renderer already sent or describe this process's internals.
    console.warn(`[ipc-sender-guard] refused an invoke on '${channel}' from an unverified sender`),
});

guardedIpc.handle('daemon:get-status', (): DaemonStatus => latestDaemonStatus);

guardedIpc.handle('daemon:list-providers', async () => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.providers.list();
});

guardedIpc.handle('daemon:mcp-statuses', async () => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.mcp.statuses();
});

guardedIpc.handle('daemon:mcp-search', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.mcp.search(mcpSearchRequestSchema.parse(input));
});

guardedIpc.handle('daemon:mcp-set-credential', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  await client.mcp.setCredential(mcpCredentialInputSchema.parse(input));
});

guardedIpc.handle('daemon:mcp-remove', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  await client.mcp.remove(mcpProviderIdSchema.parse(input));
});

guardedIpc.handle('daemon:create-session', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  // Validated here too, at the IPC boundary from the (untrusted) renderer. @agent-dock/client
  // validates again before it ever builds a request, but that's a different concern (protecting
  // the client's own contract), not a substitute for validating what crossed the privileged
  // boundary from the renderer in the first place.
  //
  // `cwd` is parsed away and never read from `input` (issue #175): a renderer that attaches one
  // has it dropped here, the same rule the workspace-grant channels already apply to `path`/`cwd`.
  // main always substitutes the app-owned AI-workspace scratch dir itself, so this channel can no
  // more be pointed at an arbitrary directory than those are -- the daemon's own `cwd` validation
  // (`existsSync`/`isDirectory` in `routes/sessions.ts`) is intentionally left permissive, since it
  // is reached only by this now-pinned call, never directly by the renderer.
  const parsed = createSessionRequestSchema.omit({ cwd: true }).parse(input);
  const cwd = await ensureAiWorkspaceDir();
  const session = await client.sessions.create({ ...parsed, cwd });
  // `activeSessionId = session.id` used to sit here. It was write-only state (see `v1EventForwards`
  // above): nothing ever read it, and tracking "the one session" is the shape ADI-07 removes.
  forwardSessionEvents(session.id);
  return session;
});

guardedIpc.handle('daemon:cancel-session', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const { sessionId } = sessionIdParamSchema.parse({ sessionId: input });
  await client.sessions.cancel(sessionId);
});

/*
 * ---------------------------------------------------------------------------------------------
 * Workspace grant IPC (ADI-06).
 *
 * Three channels, and **none of them accepts a path**. `workspace-grant:request` takes a provider
 * id and nothing else, so a renderer that sends a path along has it dropped here; the folder can
 * only ever come from the native picker main opens. `workspace-grant:consume` and
 * `workspace-grant:status` take a 43-character opaque handle. Every response is built field by
 * field from a bounded display object, never passed through from the grant record.
 *
 * `dialog:select-directory` above is deliberately NOT retrofitted into this system. It is a
 * pre-v2 bridge the existing Run panel depends on, grandfathered per ADI-07's framing, and folding
 * it in would change v1 behavior that this ticket promises to leave byte-identical.
 * ---------------------------------------------------------------------------------------------
 */

guardedIpc.handle('workspace-grant:request', async (event, input: unknown) => {
  // Parsed from the whole payload's `provider` field only. Anything else a renderer attached
  // (a `path`, a `cwd`, a pre-baked workspace id) has no reader here and cannot reach the daemon.
  const provider = providerIdSchema.parse(
    input && typeof input === 'object' ? (input as { provider?: unknown }).provider : input,
  );
  return workspaceGrants.requestGrant(provider, event.sender.id);
});

guardedIpc.handle('workspace-grant:consume', async (event, input: unknown) => {
  const handle = input && typeof input === 'object' ? (input as { grantHandle?: unknown }).grantHandle : input;
  // `event.sender.id` is Electron's own, unspoofable identification of the calling frame: the
  // renderer cannot claim to be a different WebContents than the one the grant was issued to.
  return workspaceGrants.consumeGrant(handle, event.sender.id);
});

guardedIpc.handle('workspace-grant:status', (event, input: unknown) => {
  void event;
  const handle = input && typeof input === 'object' ? (input as { grantHandle?: unknown }).grantHandle : input;
  return workspaceGrants.grantStatus(handle);
});

/**
 * `workspace:start-session` (ADI-13): the fourth channel, and the first one that starts real work.
 *
 * It takes an opaque workspace session ref, a prompt, and optionally a resume target and a
 * capability list. **Exactly four fields are read**, and none of them can name a location: a
 * renderer that attaches `path`, `cwd`, `workspaceId`, or `incarnation` has those arguments dropped
 * here, because nothing below looks for them. The real path and identity come from the ref record
 * held in this process, which was populated when the daemon confirmed the user's grant.
 *
 * The response is rebuilt in `createSession` above and is reason-only on failure, so no path and no
 * daemon-authored text crosses back either.
 */
guardedIpc.handle('workspace:start-session', async (event, input: unknown) => {
  const payload = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  return workspaceGrants.startSession(
    {
      workspaceSessionRef: payload.workspaceSessionRef,
      prompt: payload.prompt,
      resumeProviderSessionId: payload.resumeProviderSessionId,
      capabilities: payload.capabilities,
    },
    // Electron's own unspoofable identification of the calling frame, same as the consume channel.
    event.sender.id,
  );
});

/*
 * ---------------------------------------------------------------------------------------------
 * AI Workspace IPC (ADI-07): the seventh preload namespace.
 *
 * The five channels, their paging helpers, and their per-session tool-call alias book all live in
 * electron/agent-workspace-ipc.ts, not here. Nothing in this module's scope belongs to the feature
 * beyond the handful of lines below, and that is the point: main.ts's other ~fifty channels cannot
 * be reached by it, and rolling the feature back is deleting one call rather than untangling
 * shared globals. See that module's docstring for the no-location rule all five channels keep.
 * ---------------------------------------------------------------------------------------------
 */

/** Shared by the live relay and the history reader so both agree on a session's tool aliases. */
const aliasesForSession = createSessionAliasBook();

const agentWorkspaceRelay = new AgentWorkspaceRelay({
  // Read fresh rather than captured: `client` is replaced on a daemon restart.
  client: () => client,
  aliasesFor: aliasesForSession,
  push: (message: ActivityPush) => sendToRenderer(mainWindow, AGENT_WORKSPACE_ACTIVITY_CHANNEL, message),
  onEvent: (message, meta) => console.warn(`[agent-workspace] ${message}`, meta ?? {}),
});

/** One authenticated GET against a v2 read route, returning the parsed body or `undefined`. */
async function daemonGetJson(path: string): Promise<Record<string, unknown> | undefined> {
  const res = await daemonFetch(path, { method: 'GET' });
  if (!res.ok) {
    if (res.status === 404) return undefined;
    // No daemon-authored text crosses: the caller turns this into its own fixed message, the same
    // discipline `daemonRefusal` applies to the workspace routes.
    throw new Error(`the agent runtime refused this request (status ${res.status})`);
  }
  const body: unknown = await res.json().catch(() => undefined);
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
}

registerAgentWorkspaceHandlers(guardedIpc, {
  getJson: daemonGetJson,
  aliasesFor: aliasesForSession,
  relay: agentWorkspaceRelay,
});

/*
 * ---------------------------------------------------------------------------------------------
 * #200: the daemon-owned application queue. Content-free by design (see
 * `application-queue-store.ts`'s own doc comment) -- these handlers only ever pass an opaque
 * attempt id back and forth, never a job description, a CV, or a rendered file. Reaches the daemon
 * via `daemonFetch`/`daemonGetJson` rather than `@agent-dock/client`, matching every other v2
 * surface in this file (see that pair's own doc comments for why).
 * ---------------------------------------------------------------------------------------------
 */

/**
 * Incrementally parses the daemon's application-queue SSE byte stream. A close cousin of
 * `@agent-dock/client`'s internal `parseSseStream`, reimplemented locally rather than imported: that
 * one is tied to `agentEventEnvelopeSchema` (the AI-session protocol), and this stream carries a
 * different, much simpler event shape this app's own daemon defines, not a shared protocol type.
 */
async function* parseApplicationQueueSseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<ApplicationQueueEvent, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const onAbort = () => void reader.cancel().catch(() => {});
  signal.addEventListener('abort', onAbort);
  try {
    while (true) {
      if (signal.aborted) return;
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex: number;
      while ((separatorIndex = buffer.indexOf('\n\n')) >= 0) {
        const rawFrame = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        const dataLine = rawFrame.split('\n').find((line) => line.startsWith('data: '));
        if (!dataLine) continue; // comment/keepalive frame (the daemon's leading ":ok")
        try {
          yield JSON.parse(dataLine.slice('data: '.length)) as ApplicationQueueEvent;
        } catch {
          // A malformed frame from this app's own daemon is not worth ending the whole relay over;
          // the next well-formed frame still arrives.
        }
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

const applicationQueueEventSource: ApplicationQueueEventSource = {
  events({ signal, lastEventId }) {
    return {
      async *[Symbol.asyncIterator]() {
        if (!daemonConnection) return;
        const headers: Record<string, string> = { Authorization: `Bearer ${daemonConnection.token}` };
        if (lastEventId) headers['Last-Event-ID'] = lastEventId;
        const res = await fetch(`${daemonConnection.baseUrl}/v2/applications/events`, { headers, signal });
        if (!res.ok || !res.body) return;
        yield* parseApplicationQueueSseStream(res.body, signal);
      },
    };
  },
};

/** Not an `ipcMain.handle` channel: main sends on it. Mirrors `AGENT_WORKSPACE_ACTIVITY_CHANNEL`'s
 * own "one-way push, not a handle channel" rule. */
const APPLICATION_QUEUE_ACTIVITY_CHANNEL = 'application-queue:activity';

const applicationQueueRelay = new ApplicationQueueRelay({
  // Read fresh rather than captured, for the same reason `agentWorkspaceRelay` does: a daemon
  // restart replaces `daemonConnection`, and a relay holding the old one would stream from a
  // process that no longer exists.
  client: () => (daemonConnection ? applicationQueueEventSource : undefined),
  push: (event: ApplicationQueueEvent) => sendToRenderer(mainWindow, APPLICATION_QUEUE_ACTIVITY_CHANNEL, event),
  onEvent: (message, meta) => console.warn(`[application-queue] ${message}`, meta ?? {}),
});

/** The renderer-facing message for a queue-route refusal, chosen from a closed table by the
 * daemon's machine-readable `code` -- never its `error` text -- matching `daemonRefusal`'s own
 * discipline for the same reason: a message this process did not write must never reach the
 * renderer verbatim. */
async function applicationQueueRefusal(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { code?: unknown };
  if (body.code === 'application_not_found') return 'no such attempt is in the queue';
  if (body.code === 'invalid_transition') return 'that action cannot be applied to this attempt right now';
  return fallback;
}

function parseAttemptId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
    throw new Error('"attemptId" must be a non-empty string');
  }
  return value;
}

guardedIpc.handle('application-queue:enqueue', async (_event, input: unknown) => {
  const attemptId = parseAttemptId(input);
  const res = await daemonFetch('/v2/applications', { method: 'POST', body: { attemptId } });
  if (!res.ok) throw new Error(await applicationQueueRefusal(res, 'could not add this attempt to the queue'));
  return ((await res.json()) as { entry: unknown }).entry;
});

/**
 * The shared body for pause/resume/skip/cancel: identical shape, only the daemon path verb
 * differs. Each channel is still registered through its own separate, literal-string
 * `guardedIpc.handle` call below, rather than this function looping over a channel list --
 * `test/ipc-sender-guard.test.ts` finds every registration by scanning main.ts's source text for
 * exactly that call shape with a literal first argument, so a channel name built from a variable
 * would be invisible to that audit even though the guard itself would still work correctly at
 * runtime.
 */
async function applicationQueueTransition(verb: 'pause' | 'resume' | 'skip' | 'cancel', input: unknown) {
  const attemptId = parseAttemptId(input);
  const res = await daemonFetch(`/v2/applications/${encodeURIComponent(attemptId)}/${verb}`, { method: 'POST' });
  if (!res.ok) throw new Error(await applicationQueueRefusal(res, `could not ${verb} this attempt`));
  return ((await res.json()) as { entry: unknown }).entry;
}
guardedIpc.handle('application-queue:pause', (_event, input: unknown) => applicationQueueTransition('pause', input));
guardedIpc.handle('application-queue:resume', (_event, input: unknown) => applicationQueueTransition('resume', input));
guardedIpc.handle('application-queue:skip', (_event, input: unknown) => applicationQueueTransition('skip', input));
guardedIpc.handle('application-queue:cancel', (_event, input: unknown) => applicationQueueTransition('cancel', input));

guardedIpc.handle('application-queue:get-status', async () => {
  const body = await daemonGetJson('/v2/applications');
  return body ?? { entries: [], lease: null };
});

guardedIpc.handle('dialog:select-directory', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

/**
 * A scratch directory `daemon:create-session` pins as every v1 session's `cwd` (issue #175). The
 * daemon requires an existing directory, but the CV/AI features this channel serves are one-shot
 * text generation: the CLI is never asked to touch a file. Pointing it at a dedicated, empty,
 * app-owned folder (rather than the user's repo, their home directory, or `os.tmpdir()` which
 * other processes share) means an agent that decided to look around on its own finds nothing of
 * the user's in reach. The renderer only ever learns this one path; it still cannot read or write
 * it, and as of #175 it can no longer name a different one either -- `daemon:create-session` never
 * reads a `cwd` field from the renderer at all, so this is an enforced boundary, not merely a
 * convention the caller happens to follow.
 */
async function ensureAiWorkspaceDir(): Promise<string> {
  const dir = join(app.getPath('userData'), 'ai-workspace');
  await mkdir(dir, { recursive: true });
  return dir;
}

guardedIpc.handle('cv:get-workspace-dir', (): Promise<string> => ensureAiWorkspaceDir());

/**
 * Opens a native file picker and returns the CV's extracted plain text: never a path the renderer
 * could then ask something else to open, and never raw filesystem access. The renderer cannot
 * choose *which* file is read: only the user can, through the OS dialog. Mirrors
 * `dialog:select-directory` above (null on cancel / no window); a genuine read or parse failure
 * rejects, so the UI can show the reason instead of a silent empty state.
 */
guardedIpc.handle('cv:select-and-read', async (): Promise<CvFileContent | null> => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select your CV',
    properties: ['openFile'],
    filters: [{ name: 'CV documents', extensions: [...CV_FILE_EXTENSIONS] }],
  });
  const filePath = result.filePaths[0];
  if (result.canceled || !filePath) return null;
  return readCvFile(filePath);
});

interface SaveFileFilter {
  name: string;
  extensions: string[];
}

interface SaveFileInput {
  suggestedName: string;
  data: string;
  encoding: 'utf8' | 'base64';
  filters: SaveFileFilter[];
}

/** Generous for a one-page letter (even a real .docx/.pdf), still a finite bound on what the
 * renderer can make main write to disk. */
const MAX_EXPORT_BYTES = 20_000_000;

function assertSaveFileInput(input: unknown): asserts input is SaveFileInput {
  if (typeof input !== 'object' || input === null) throw new Error('invalid export request');
  const { suggestedName, data, encoding, filters } = input as Record<string, unknown>;
  if (typeof suggestedName !== 'string' || !suggestedName.trim()) {
    throw new Error('"suggestedName" is required');
  }
  if (typeof data !== 'string') throw new Error('"data" must be a string');
  if (encoding !== 'utf8' && encoding !== 'base64') throw new Error('"encoding" must be "utf8" or "base64"');
  if (!Array.isArray(filters) || filters.length === 0) throw new Error('"filters" is required');
  for (const filter of filters) {
    if (typeof filter !== 'object' || filter === null) throw new Error('invalid filter');
    const { name, extensions } = filter as Record<string, unknown>;
    const validExtensions = Array.isArray(extensions) && extensions.every((ext) => typeof ext === 'string');
    if (typeof name !== 'string' || !validExtensions) throw new Error('invalid filter');
  }
}

/**
 * Saves already-finished file bytes to a user-chosen path via the native save dialog. The
 * renderer builds the actual export content (plain markdown text, or a real .docx/.pdf buffer via
 * the `docx`/`jspdf` packages) and hands it across as one payload; main only ever names a path and
 * writes bytes, never generates document content itself.
 */
guardedIpc.handle('system:save-file', async (_event, input: unknown): Promise<{ saved: boolean; path?: string }> => {
  assertSaveFileInput(input);
  if (!mainWindow) return { saved: false };
  const buffer = Buffer.from(input.data, input.encoding);
  if (buffer.byteLength > MAX_EXPORT_BYTES) throw new Error('export is too large');

  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export letter',
    defaultPath: input.suggestedName,
    filters: input.filters,
  });
  if (result.canceled || !result.filePath) return { saved: false };

  await writeFile(result.filePath, buffer);
  return { saved: true, path: result.filePath };
});

/**
 * Awaits the engine rather than sampling it. The renderer asks once, on mount, and treats
 * `{ ready: false }` as terminal ("Vacancy engine unavailable") with no retry. So a bare
 * `!!vacancyDb` snapshot lost a startup race: `app.whenReady` starts the first-run migration and
 * creates the window in the same tick, and whenever the React mount won, the Vacancy Leads screen
 * stayed permanently unavailable until the app was restarted, despite a perfectly healthy engine.
 * Awaiting the initialization means "not ready yet" is simply a slower answer, covered by the
 * panel's existing "Checking vacancy engine status…" state, and `{ ready: false }` now means only
 * what the renderer already assumes it means: initialization actually failed.
 */
guardedIpc.handle('vacancy:get-status', async (): Promise<{ ready: boolean; error?: string }> => {
  try {
    await ensureVacancyEngine();
    return { ready: true };
  } catch (error) {
    return { ready: false, error: (error as Error).message };
  }
});

guardedIpc.handle('vacancy:get-report', (): GlobalRemoteReport | null => latestVacancyReport ?? null);

/**
 * Lets a (re)mounted Search page notice a scan already in flight -- most often its own, started
 * before the user navigated to another page and back. The scan itself lives entirely in this
 * process and is never tied to any renderer window's lifetime, so this is the only way the
 * renderer can tell "idle" and "already running, just not the one I started" apart.
 */
guardedIpc.handle('vacancy:get-scan-status', (): { scanning: boolean } => ({ scanning: isScanInFlight() }));

/**
 * Shared by the `vacancy:run-scan` IPC handler and the background-scan timer (#195): a
 * `setInterval` callback has no IPC sender, so it cannot go through `guardedIpc` -- this is the
 * body the guard used to wrap directly, factored out so both callers run the identical scan path
 * (same lock, same report bookkeeping) rather than risking two copies drifting apart.
 */
async function runVacancyScan(query?: string): Promise<GlobalRemoteReport> {
  const db = await ensureVacancyEngine();
  return runExclusiveScan(
    async () => {
      const config = vacancyEngineConfig();
      const result = await runGlobalRemoteScan(db, config, createLogger(config), await vacancyEngineDataRoot(), {
        query,
      });
      latestVacancyReport = result.report;
      return result.report;
    },
    { takeAdvisoryLock: true },
  );
}

guardedIpc.handle('vacancy:run-scan', (_event, query: unknown): Promise<GlobalRemoteReport> =>
  runVacancyScan(typeof query === 'string' ? query : undefined),
);

// #195: fixed for v1, not user-configurable (see the ticket's own Non-goals) -- a schedule-picker
// UI is future scope, not this one.
const BACKGROUND_SCAN_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
// Cheap on its own (one timestamp comparison); only the scan `shouldRunScheduledScan` may trigger
// is expensive. A short tick avoids a raw long-period `setInterval`, which drifts and can fire an
// accumulated backlog after system sleep -- this instead re-derives "is it time yet" from the
// real last-scan timestamp on every tick.
const BACKGROUND_SCAN_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Started once in `app.whenReady()`, runs for the process's whole lifetime. `createScanGuard`
 * throws plain `Error`s, not a distinguishable subclass or code, so "another scan already owns
 * the lock" is recognized by comparing `error.message` against the guard's own exported
 * constants -- both are real, expected outcomes (a manual "Search" click won, or a `pnpm
 * vacancies:scan` in another process did) and are swallowed silently. Any other error is logged
 * (so a genuinely broken background scan doesn't fail forever in total silence) but never allowed
 * to escape as an unhandled rejection inside the timer callback, which would crash the process.
 */
function scheduleBackgroundScanTick(): void {
  setInterval(() => {
    if (!autoScanEnabled) return;
    if (!shouldRunScheduledScan(latestVacancyReport?.generatedAt, new Date(), BACKGROUND_SCAN_INTERVAL_MS)) return;
    void runVacancyScan().catch((error: unknown) => {
      if (isExpectedScanBusyError(error)) return;
      console.error('[background-scan] scheduled scan failed', error);
    });
  }, BACKGROUND_SCAN_CHECK_INTERVAL_MS);
}

async function candidateProfilePath(): Promise<string> {
  return join(await vacancyEngineDataRoot(), 'config', 'candidate-profile-v1.json');
}

guardedIpc.handle('vacancy:get-search-profile', async (): Promise<CandidateProfile> => {
  return loadCandidateProfile(await candidateProfilePath());
});

/**
 * Every field in the Settings > Search profile UI autosaves independently (on blur, or
 * immediately for a toggle), so two edits made in quick succession reach this handler as two
 * concurrent invocations. Without serializing them, both would read the same on-disk profile
 * before either write lands, and whichever write finished second would silently discard the
 * other's field. `profileSaveQueue` chains every save onto the previous one (success or failure)
 * so the read-modify-write in the handler below is never interleaved with another.
 */
let profileSaveQueue: Promise<unknown> = Promise.resolve();

function withProfileSaveQueue<T>(task: () => Promise<T>): Promise<T> {
  const run = profileSaveQueue.then(task, task);
  profileSaveQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Monotonically increasing even across same-millisecond saves, so `scoreActiveVacancies` (which
 * keys cached scores on an exact `candidateProfileVersion` match) can never see two different
 * profile contents share one version string. */
let lastProfileVersionStamp = 0;
function nextProfileVersion(): string {
  const now = Date.now();
  lastProfileVersionStamp = now > lastProfileVersionStamp ? now : lastProfileVersionStamp + 1;
  return `candidate-profile-${lastProfileVersionStamp}`;
}

/**
 * Merges an allow-listed patch (see vacancy-profile-validate.ts) onto the profile currently on
 * disk and writes the result back through a temp-file-then-rename, the same atomic-write idiom
 * `writeReportFiles`/`writeDomainCandidateCatalog` use elsewhere in the engine: a crash mid-write
 * (more likely here than for a full scan, since this can fire on every field blur) must never
 * leave `candidate-profile-v1.json` truncated, since there is no recovery path for a corrupt file.
 * `profileVersion` is always stamped fresh here, never taken from the caller: `scoreActiveVacancies`
 * keys its cached deterministic scores off this version, so a save that left it unchanged would let
 * stale scores survive a profile edit.
 */
guardedIpc.handle('vacancy:save-search-profile', async (_event, rawPatch: unknown): Promise<CandidateProfile> => {
  const patch = parseCandidateProfilePatch(rawPatch);
  return withProfileSaveQueue(async () => {
    const path = await candidateProfilePath();
    const current = await loadCandidateProfile(path);
    const next: CandidateProfile = candidateProfileSchema.parse({
      ...current,
      ...patch,
      constraints: { ...current.constraints, ...patch.constraints },
      profileVersion: nextProfileVersion(),
    });
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
    return next;
  });
});

/*
 * ---------------------------------------------------------------------------------------------
 * Personal workspace (saved jobs, applications, CV library, letters, settings).
 *
 * One channel per verb per entity, exactly like the `daemon:*` / `cv:*` handlers above: there is
 * no `workspace:query(sql)`, no `workspace:invoke(table, verb)`, and no channel that takes a
 * table name. Every payload is parsed by an allow-listing validator (workspace/validate.ts)
 * before it reaches Drizzle, and every response is a record built field by field in
 * workspace/repository.ts, so a column added to the schema is not automatically published to the
 * renderer.
 * ---------------------------------------------------------------------------------------------
 */

guardedIpc.handle('workspace:settings:get', async () => workspace.getSettings(await ensureWorkspaceDb()));

guardedIpc.handle('workspace:settings:update', async (_event, input: unknown) => {
  const updated = workspace.updateSettings(await ensureWorkspaceDb(), parseSettingsPatch(input));
  // ADI-22: keep both mirrors in sync with every write, not just the initial hydration.
  minimizeToTrayOnClose = updated.minimizeToTrayOnClose;
  autoScanEnabled = updated.autoScanEnabled;
  return updated;
});

/** Badge counts for the sidebar: a dedicated read so the shell never has to fetch three lists. */
guardedIpc.handle('workspace:counts:get', async () => workspace.getCounts(await ensureWorkspaceDb()));

guardedIpc.handle('workspace:saved-jobs:list', async () => workspace.listSavedJobs(await ensureWorkspaceDb()));

guardedIpc.handle('workspace:saved-jobs:create', async (_event, input: unknown) =>
  workspace.createSavedJob(await ensureWorkspaceDb(), parseSavedJobInput(input)),
);

guardedIpc.handle('workspace:saved-jobs:update', async (_event, input: unknown) => {
  const { id, patch } = parseIdAndPatch(input);
  return workspace.updateSavedJob(await ensureWorkspaceDb(), id, parseSavedJobPatch(patch));
});

guardedIpc.handle('workspace:saved-jobs:delete', async (_event, input: unknown) =>
  workspace.deleteSavedJob(await ensureWorkspaceDb(), parseIdEnvelope(input)),
);

guardedIpc.handle('workspace:applications:list', async (_event, input: unknown) =>
  workspace.listApplications(await ensureWorkspaceDb(), parseApplicationFilter(input)),
);

guardedIpc.handle('workspace:applications:create', async (_event, input: unknown) =>
  workspace.createApplication(await ensureWorkspaceDb(), parseApplicationInput(input)),
);

guardedIpc.handle('workspace:applications:update', async (_event, input: unknown) => {
  const { id, patch } = parseIdAndPatch(input);
  return workspace.updateApplication(await ensureWorkspaceDb(), id, parseApplicationPatch(patch));
});

guardedIpc.handle('workspace:applications:delete', async (_event, input: unknown) =>
  workspace.deleteApplication(await ensureWorkspaceDb(), parseIdEnvelope(input)),
);

guardedIpc.handle('workspace:cv-documents:list', async () => workspace.listCvDocuments(await ensureWorkspaceDb()));

guardedIpc.handle('workspace:cv-documents:create', async (_event, input: unknown) =>
  workspace.createCvDocument(await ensureWorkspaceDb(), parseCvDocumentInput(input)),
);

guardedIpc.handle('workspace:cv-documents:update', async (_event, input: unknown) => {
  const { id, patch } = parseIdAndPatch(input);
  return workspace.updateCvDocument(await ensureWorkspaceDb(), id, parseCvDocumentPatch(patch));
});

guardedIpc.handle('workspace:cv-documents:delete', async (_event, input: unknown) =>
  workspace.deleteCvDocument(await ensureWorkspaceDb(), parseIdEnvelope(input)),
);

guardedIpc.handle('workspace:cv-documents:set-default', async (_event, input: unknown) =>
  workspace.setDefaultCvDocument(await ensureWorkspaceDb(), parseIdEnvelope(input)),
);

guardedIpc.handle('workspace:letters:list', async () => workspace.listLetters(await ensureWorkspaceDb()));

guardedIpc.handle('workspace:letters:create', async (_event, input: unknown) =>
  workspace.createLetter(await ensureWorkspaceDb(), parseLetterInput(input)),
);

guardedIpc.handle('workspace:letters:update', async (_event, input: unknown) => {
  const { id, patch } = parseIdAndPatch(input);
  return workspace.updateLetter(await ensureWorkspaceDb(), id, parseLetterPatch(patch));
});

guardedIpc.handle('workspace:letters:delete', async (_event, input: unknown) =>
  workspace.deleteLetter(await ensureWorkspaceDb(), parseIdEnvelope(input)),
);

guardedIpc.handle('workspace:letters:duplicate', async (_event, input: unknown) =>
  workspace.duplicateLetter(await ensureWorkspaceDb(), parseIdEnvelope(input)),
);

/*
 * ---------------------------------------------------------------------------------------------
 * System integration for the Settings page. One narrow verb: mirror the persisted
 * "launch at login" preference into the OS login-item registration. The renderer sends a boolean
 * and nothing else (no app path, no arguments), so this can never register an arbitrary
 * executable. The OS keeps its own persistent record (registry key on Windows, login item on
 * macOS), so applying it once at toggle time is sufficient; no startup re-sync is needed.
 * Skipped in dev because `app.setLoginItemSettings` would register the bare Electron binary,
 * not this app. The preference still persists in settings and applies in packaged builds.
 * ---------------------------------------------------------------------------------------------
 */
guardedIpc.handle('system:set-login-item', (_event, input: unknown) => {
  if (typeof input !== 'boolean') throw new Error('"enabled" must be a boolean');
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: input });
});

/** Reads `package.json`'s `version` via Electron's own resolution: never a hand-maintained
 * string the Settings page's About section could drift from. */
guardedIpc.handle('system:get-app-version', (): string => app.getVersion());

if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    spawnDaemon();
    createWindow();
    createTray();
    // Pre-warm only: any failure is reported to the renderer by `vacancy:get-status`, which awaits
    // this same initialization. Swallowed here so an engine problem never becomes an unhandled
    // rejection during startup.
    ensureVacancyEngine().catch(() => {});
    // Same deal for the workspace database: the first `workspace:*` call awaits this very
    // promise, so a failure here surfaces as that call rejecting with the real reason. It also
    // hydrates the `minimizeToTrayOnClose`/`autoScanEnabled` mirrors the `close` handler and the
    // background-scan timer read synchronously.
    ensureWorkspaceDb().catch(() => {});
    // #195: pick up a report a previous process lifetime's scan already wrote to disk.
    void hydrateLatestVacancyReport();
    scheduleBackgroundScanTick();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else mainWindow?.show();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // #194: registered before the existing `before-quit` listener below, so `isQuitting` is already
  // true by the time that listener (and any `close` handler still pending) runs. Without this, the
  // tray's own "Quit" item would set it too late relative to a `close` event already in flight.
  app.on('before-quit', () => {
    isQuitting = true;
  });

  // Separate from the daemon shutdown below on purpose: `will-quit` always fires, whereas the
  // `before-quit` handler returns early when there is no daemon child to stop. Closing the SQLite
  // connection checkpoints its WAL, so the next launch opens a clean file instead of recovering.
  app.on('will-quit', () => {
    closeWorkspaceDb?.();
    closeWorkspaceDb = undefined;
  });

  let shuttingDown = false;
  app.on('before-quit', (event) => {
    if (shuttingDown || !daemonChild) return;
    shuttingDown = true;
    event.preventDefault();
    void killDaemon().finally(() => app.quit());
  });
}
