import { app, BrowserWindow, ipcMain, dialog, Menu, shell } from 'electron';
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
  sessionIdParamSchema,
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
  runEndToEndScan,
  runGlobalRemoteScan,
  type CandidateProfile,
  type Database,
  type GlobalRemoteReport,
  type JobRadarReport,
  type ScanLock,
} from '@open-vacancy-radar/vacancy-engine';
import { isSafeExternalUrl } from './external-url.js';
import { resolveDaemonEntry } from './resolve-daemon-entry.js';
import { resolveWindowIcon } from './resolve-window-icon.js';
import {
  resolveVacancyEngineDataRoot,
  resolveVacancyEngineMigrationsFolder,
} from './resolve-vacancy-engine-paths.js';
import { sendToRenderer } from './send-to-renderer.js';
import { CV_FILE_EXTENSIONS, readCvFile, type CvFileContent } from './cv-text.js';
import { createScanGuard, SCAN_BUSY_OTHER_PROCESS } from './scan-guard.js';
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
/**
 * The single source of truth `daemon:get-status` reads from. Without this, that handler had to
 * re-derive a status from `client` alone (set or not), which can only ever mean "ready" or
 * "connecting" -- it has no way to represent "already failed", so a pull-based query made any time
 * after a startup failure incorrectly reported "connecting" forever, no matter how long ago the
 * daemon actually died. `sendStatus` is the only place that both updates this and pushes to the
 * renderer, so the two can never disagree.
 */
let latestDaemonStatus: DaemonStatus = { state: 'connecting' };
let activeSessionId: string | undefined;
let activeStreamAbort: AbortController | undefined;

let vacancyDb: Database | undefined;
let vacancyEngineInit: Promise<Database> | undefined;
let vacancyScanLock: ScanLock | undefined;
let latestVacancyReport: GlobalRemoteReport | undefined;
let latestNetherlandsReport: JobRadarReport | undefined;

/**
 * One guard for *both* scan kinds, not one per kind: the two pipelines write the same engine
 * database, so running them together is exactly as damaging as running two of either. See
 * electron/scan-guard.ts for why the in-process half and the cross-process advisory lock are both
 * needed.
 */
const runExclusiveScan = createScanGuard(() => vacancyScanLock);

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
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AGENT_DOCK_APP_ID: APP_ID },
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
        const candidate = new AgentDockClient({ baseUrl: `http://127.0.0.1:${parsed.port}`, token: parsed.token });
        // health() also verifies protocol compatibility (see @agent-dock/client). This doubles
        // as both the readiness check and the version-compatibility check in one call.
        await candidate.health();
        client = candidate;
        sendStatus({ state: 'ready' });
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

/** Streams one session's events to the renderer and clears `activeSessionId` at its terminal event. */
function forwardSessionEvents(sessionId: string): void {
  if (!client) return;
  const controller = new AbortController();
  activeStreamAbort = controller;
  const activeClient = client;

  void (async () => {
    try {
      for await (const event of activeClient.sessions.events(sessionId, { signal: controller.signal })) {
        sendToRenderer(mainWindow, 'daemon:session-event', { sessionId, event });
        if (event.type === 'session.completed' || event.type === 'session.failed' || event.type === 'session.cancelled') {
          if (activeSessionId === sessionId) activeSessionId = undefined;
        }
      }
    } catch (err) {
      if (controller.signal.aborted) return;
      sendToRenderer(mainWindow, 'daemon:session-event', {
        sessionId,
        event: { type: 'error', message: `event stream failed: ${(err as Error).message}`, recoverable: false },
      });
    }
  })();
}

async function killDaemon(): Promise<void> {
  activeStreamAbort?.abort();
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
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigationTarget(url)) return;
    event.preventDefault();
    openExternalIfSafe(url);
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
}

ipcMain.handle('daemon:get-status', (): DaemonStatus => latestDaemonStatus);

ipcMain.handle('daemon:list-providers', async () => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.providers.list();
});

ipcMain.handle('daemon:mcp-statuses', async () => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.mcp.statuses();
});

ipcMain.handle('daemon:mcp-search', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  return client.mcp.search(mcpSearchRequestSchema.parse(input));
});

ipcMain.handle('daemon:mcp-set-credential', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  await client.mcp.setCredential(mcpCredentialInputSchema.parse(input));
});

ipcMain.handle('daemon:mcp-remove', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  await client.mcp.remove(mcpProviderIdSchema.parse(input));
});

ipcMain.handle('daemon:create-session', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  // Validated here too, at the IPC boundary from the (untrusted) renderer. @agent-dock/client
  // validates again before it ever builds a request, but that's a different concern (protecting
  // the client's own contract), not a substitute for validating what crossed the privileged
  // boundary from the renderer in the first place.
  const parsed = createSessionRequestSchema.parse(input);
  const session = await client.sessions.create(parsed);
  activeSessionId = session.id;
  forwardSessionEvents(session.id);
  return session;
});

ipcMain.handle('daemon:cancel-session', async (_event, input: unknown) => {
  if (!client) throw new Error('daemon is not ready yet');
  const { sessionId } = sessionIdParamSchema.parse({ sessionId: input });
  await client.sessions.cancel(sessionId);
});

ipcMain.handle('dialog:select-directory', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

/**
 * A scratch directory the CV/AI features hand to `createSession` as its `cwd`. The daemon requires
 * an existing directory, but these two features are one-shot text generation: the CLI is never
 * asked to touch a file. Pointing it at a dedicated, empty, app-owned folder (rather than the
 * user's repo, their home directory, or `os.tmpdir()` which other processes share) means an agent
 * that decided to look around on its own finds nothing of the user's in reach. The renderer only
 * ever learns this one path; it still cannot read or write it.
 *
 * Be precise about what this is and isn't: it is a good *default*, not an enforced sandbox.
 * `daemon:create-session` accepts whatever `cwd` the renderer sends (the Run panel in App.tsx
 * exists to let the user pick an arbitrary one), so "the CV features run in an empty directory" is
 * a convention the renderer follows, not a boundary the main process imposes. Enforcing it would
 * mean main choosing the `cwd` itself for these sessions: worth doing if the generic
 * arbitrary-`cwd` Run panel is ever removed, but pointless while it is still there.
 */
async function ensureAiWorkspaceDir(): Promise<string> {
  const dir = join(app.getPath('userData'), 'ai-workspace');
  await mkdir(dir, { recursive: true });
  return dir;
}

ipcMain.handle('cv:get-workspace-dir', (): Promise<string> => ensureAiWorkspaceDir());

/**
 * Opens a native file picker and returns the CV's extracted plain text: never a path the renderer
 * could then ask something else to open, and never raw filesystem access. The renderer cannot
 * choose *which* file is read: only the user can, through the OS dialog. Mirrors
 * `dialog:select-directory` above (null on cancel / no window); a genuine read or parse failure
 * rejects, so the UI can show the reason instead of a silent empty state.
 */
ipcMain.handle('cv:select-and-read', async (): Promise<CvFileContent | null> => {
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
ipcMain.handle('system:save-file', async (_event, input: unknown): Promise<{ saved: boolean; path?: string }> => {
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
ipcMain.handle('vacancy:get-status', async (): Promise<{ ready: boolean; error?: string }> => {
  try {
    await ensureVacancyEngine();
    return { ready: true };
  } catch (error) {
    return { ready: false, error: (error as Error).message };
  }
});

ipcMain.handle('vacancy:get-report', (): GlobalRemoteReport | null => latestVacancyReport ?? null);

ipcMain.handle('vacancy:run-scan', async (): Promise<GlobalRemoteReport> => {
  const db = await ensureVacancyEngine();
  return runExclusiveScan(
    async () => {
      const config = vacancyEngineConfig();
      const result = await runGlobalRemoteScan(db, config, createLogger(config), await vacancyEngineDataRoot());
      latestVacancyReport = result.report;
      return result.report;
    },
    { takeAdvisoryLock: true },
  );
});

/**
 * The Netherlands half of the Search page: the IND recognised-sponsor pipeline, exposed on the
 * same two-channel shape as the global-remote pair above (`get-*` reads whatever the last run
 * produced without triggering network activity; `run-*` performs the scan).
 *
 * `runEndToEndScan` takes the engine's advisory lock itself and answers
 * `{ status: 'skipped', reason: 'already-running' }` rather than throwing when it cannot get it,
 * so that outcome is translated into the same error message `vacancy:run-scan` uses: from the
 * renderer's point of view "another scan is running" is one condition, not two.
 */
ipcMain.handle('vacancy:get-nl-report', (): JobRadarReport | null => latestNetherlandsReport ?? null);

ipcMain.handle('vacancy:run-nl-scan', async (): Promise<JobRadarReport> => {
  const db = await ensureVacancyEngine();
  const lock = vacancyScanLock;
  if (!lock) throw new Error('vacancy engine is not initialized');

  return runExclusiveScan(
    async () => {
      const config = vacancyEngineConfig();
      const result = await runEndToEndScan(db, config, createLogger(config), lock, {
        // This is where the engine reads `config/candidate-profile-v1.json` and writes `reports/`.
        projectRoot: await vacancyEngineDataRoot(),
      });
      if (result.status === 'skipped') throw new Error(SCAN_BUSY_OTHER_PROCESS);
      latestNetherlandsReport = result.report;
      return result.report;
    },
    { takeAdvisoryLock: false },
  );
});

async function candidateProfilePath(): Promise<string> {
  return join(await vacancyEngineDataRoot(), 'config', 'candidate-profile-v1.json');
}

ipcMain.handle('vacancy:get-search-profile', async (): Promise<CandidateProfile> => {
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
ipcMain.handle('vacancy:save-search-profile', async (_event, rawPatch: unknown): Promise<CandidateProfile> => {
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

ipcMain.handle('workspace:settings:get', async () => workspace.getSettings(await ensureWorkspaceDb()));

ipcMain.handle('workspace:settings:update', async (_event, input: unknown) =>
  workspace.updateSettings(await ensureWorkspaceDb(), parseSettingsPatch(input)),
);

/** Badge counts for the sidebar: a dedicated read so the shell never has to fetch three lists. */
ipcMain.handle('workspace:counts:get', async () => workspace.getCounts(await ensureWorkspaceDb()));

ipcMain.handle('workspace:saved-jobs:list', async () => workspace.listSavedJobs(await ensureWorkspaceDb()));

ipcMain.handle('workspace:saved-jobs:create', async (_event, input: unknown) =>
  workspace.createSavedJob(await ensureWorkspaceDb(), parseSavedJobInput(input)),
);

ipcMain.handle('workspace:saved-jobs:update', async (_event, input: unknown) => {
  const { id, patch } = parseIdAndPatch(input);
  return workspace.updateSavedJob(await ensureWorkspaceDb(), id, parseSavedJobPatch(patch));
});

ipcMain.handle('workspace:saved-jobs:delete', async (_event, input: unknown) =>
  workspace.deleteSavedJob(await ensureWorkspaceDb(), parseIdEnvelope(input)),
);

ipcMain.handle('workspace:applications:list', async (_event, input: unknown) =>
  workspace.listApplications(await ensureWorkspaceDb(), parseApplicationFilter(input)),
);

ipcMain.handle('workspace:applications:create', async (_event, input: unknown) =>
  workspace.createApplication(await ensureWorkspaceDb(), parseApplicationInput(input)),
);

ipcMain.handle('workspace:applications:update', async (_event, input: unknown) => {
  const { id, patch } = parseIdAndPatch(input);
  return workspace.updateApplication(await ensureWorkspaceDb(), id, parseApplicationPatch(patch));
});

ipcMain.handle('workspace:applications:delete', async (_event, input: unknown) =>
  workspace.deleteApplication(await ensureWorkspaceDb(), parseIdEnvelope(input)),
);

ipcMain.handle('workspace:cv-documents:list', async () => workspace.listCvDocuments(await ensureWorkspaceDb()));

ipcMain.handle('workspace:cv-documents:create', async (_event, input: unknown) =>
  workspace.createCvDocument(await ensureWorkspaceDb(), parseCvDocumentInput(input)),
);

ipcMain.handle('workspace:cv-documents:update', async (_event, input: unknown) => {
  const { id, patch } = parseIdAndPatch(input);
  return workspace.updateCvDocument(await ensureWorkspaceDb(), id, parseCvDocumentPatch(patch));
});

ipcMain.handle('workspace:cv-documents:delete', async (_event, input: unknown) =>
  workspace.deleteCvDocument(await ensureWorkspaceDb(), parseIdEnvelope(input)),
);

ipcMain.handle('workspace:cv-documents:set-default', async (_event, input: unknown) =>
  workspace.setDefaultCvDocument(await ensureWorkspaceDb(), parseIdEnvelope(input)),
);

ipcMain.handle('workspace:letters:list', async () => workspace.listLetters(await ensureWorkspaceDb()));

ipcMain.handle('workspace:letters:create', async (_event, input: unknown) =>
  workspace.createLetter(await ensureWorkspaceDb(), parseLetterInput(input)),
);

ipcMain.handle('workspace:letters:update', async (_event, input: unknown) => {
  const { id, patch } = parseIdAndPatch(input);
  return workspace.updateLetter(await ensureWorkspaceDb(), id, parseLetterPatch(patch));
});

ipcMain.handle('workspace:letters:delete', async (_event, input: unknown) =>
  workspace.deleteLetter(await ensureWorkspaceDb(), parseIdEnvelope(input)),
);

ipcMain.handle('workspace:letters:duplicate', async (_event, input: unknown) =>
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
ipcMain.handle('system:set-login-item', (_event, input: unknown) => {
  if (typeof input !== 'boolean') throw new Error('"enabled" must be a boolean');
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: input });
});

/** Reads `package.json`'s `version` via Electron's own resolution: never a hand-maintained
 * string the Settings page's About section could drift from. */
ipcMain.handle('system:get-app-version', (): string => app.getVersion());

if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    spawnDaemon();
    createWindow();
    // Pre-warm only: any failure is reported to the renderer by `vacancy:get-status`, which awaits
    // this same initialization. Swallowed here so an engine problem never becomes an unhandled
    // rejection during startup.
    ensureVacancyEngine().catch(() => {});
    // Same deal for the workspace database: the first `workspace:*` call awaits this very
    // promise, so a failure here surfaces as that call rejecting with the real reason.
    ensureWorkspaceDb().catch(() => {});

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
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
