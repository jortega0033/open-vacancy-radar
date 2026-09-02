import { contextBridge, ipcRenderer } from 'electron';
import {
  mcpConnectionStatusSchema,
  mcpVacancyResultSchema,
  type AgentEvent,
  type AgentSession,
  type McpConnectionStatus,
  type McpCredentialInput,
  type McpProviderId,
  type McpSearchRequest,
  type McpVacancyResult,
  type ProviderId,
  type ProviderStatus,
} from '@agent-dock/shared';
import type { CandidateProfile, GlobalRemoteReport, JobRadarReport } from '@open-vacancy-radar/vacancy-engine';
import type { CandidateProfilePatch } from './vacancy-profile-validate.js';
import type { WorkspaceBridge } from './workspace/types.js';

/**
 * The only surface the renderer has onto Node/Electron. Every function here is a narrow,
 * single-purpose capability: never a generic "invoke this IPC channel with this payload" tunnel
 * and never the daemon's connection info (base URL + bearer token stay in the main process; see
 * electron/main.ts and SECURITY.md). The renderer cannot run a shell command, read/write an
 * arbitrary file, or reach any daemon route this bridge doesn't explicitly expose.
 */
export type DaemonStatus = { state: 'connecting' } | { state: 'ready' } | { state: 'unavailable'; error: string };

export interface CreateSessionInput {
  provider: ProviderId;
  cwd: string;
  prompt: string;
  model?: string;
}

export interface AgentDockBridge {
  getDaemonStatus(): Promise<DaemonStatus>;
  onDaemonStatus(callback: (status: DaemonStatus) => void): () => void;
  listProviders(): Promise<ProviderStatus[]>;
  listMcpProviders(): Promise<McpConnectionStatus[]>;
  searchMcp(input: McpSearchRequest): Promise<McpVacancyResult[]>;
  setMcpCredential(input: McpCredentialInput): Promise<void>;
  removeMcpProvider(providerId: McpProviderId): Promise<void>;
  createSession(input: CreateSessionInput): Promise<AgentSession>;
  cancelSession(sessionId: string): Promise<void>;
  onSessionEvent(callback: (sessionId: string, event: AgentEvent) => void): () => void;
  selectDirectory(): Promise<string | null>;
}

export type VacancyEngineStatus = { ready: boolean; error?: string };

/**
 * A second, independent bridge namespace (rather than folding these onto `AgentDockBridge`)
 * because it talks to the embedded vacancy-discovery engine in the main process directly: no
 * daemon, no bearer token, nothing shared with the AgentDock session machinery above. Keeping it
 * separate means a fork that drops the vacancy-lead feature can delete this namespace without
 * touching the AgentDock bridge at all, and vice versa.
 */
export interface VacancyRadarBridge {
  getStatus(): Promise<VacancyEngineStatus>;
  /** Global-remote (worldwide) pipeline. */
  getReport(): Promise<GlobalRemoteReport | null>;
  /**
   * `query` scopes each source's own server-side search parameter for this run (see
   * `GlobalRemoteScanOptions.query` in the engine) instead of always harvesting the same static
   * default and filtering everything client-side afterward. Omitted or blank keeps that default.
   */
  runScan(query?: string): Promise<GlobalRemoteReport>;
  /**
   * Netherlands pipeline: the IND recognised-sponsor scan. A separate pair of methods rather
   * than a `market` argument on the two above, because the two pipelines return genuinely
   * different report shapes (`GlobalRemoteReport` vs `JobRadarReport`) and a union-typed return
   * would push a discriminator check into every caller for no gain.
   */
  getNetherlandsReport(): Promise<JobRadarReport | null>;
  runNetherlandsScan(): Promise<JobRadarReport>;
  /** The Netherlands pipeline's candidate profile: what deterministic scoring matches against. */
  getSearchProfile(): Promise<CandidateProfile>;
  saveSearchProfile(patch: CandidateProfilePatch): Promise<CandidateProfile>;
}

/**
 * A fourth namespace, for the user's own workspace data (saved jobs, applications, CV library,
 * letters, settings) in a local SQLite database the main process owns. The capability list lives
 * in `workspace/types.ts` so `src/window.d.ts` can name it without a type reference into this
 * (Electron-importing) module; see the comment on `WorkspaceBridge` there.
 */
export type { WorkspaceBridge } from './workspace/types.js';

export interface CvFile {
  fileName: string;
  text: string;
}

/**
 * A third independent namespace, for the same reason `vacancyRadar` is separate from `agentDock`:
 * it is the only part of the bridge that touches the user's own documents, so it stays isolated
 * and auditable on its own terms. Note what is deliberately *not* here: no `readFile(path)`, no
 * path argument of any kind. `selectAndRead()` returns already-extracted text for a file **the
 * user picked in a native dialog**; the renderer never names a file and never receives a filesystem
 * path, so a compromised renderer cannot turn this into an arbitrary-file-read primitive.
 * `getWorkspaceDir()` returns one app-owned scratch directory (main.ts creates it) purely so the
 * AI features have a valid `cwd` for `createSession`. It grants no access to that directory.
 */
export interface CvBridge {
  selectAndRead(): Promise<CvFile | null>;
  getWorkspaceDir(): Promise<string>;
}

/**
 * Reconstructs a clean `DaemonStatus` from whatever main sent, rather than validating its shape
 * and then passing the original object through unchanged (AD-07). The difference matters: the
 * previous `isDaemonStatus` type guard only checked that `state` was one of the three known
 * values and then returned the raw object as-is. So an extra field on that object (a token, a
 * base URL, anything) would have crossed into the renderer completely untouched. Building a fresh
 * object with only the fields each variant is actually supposed to carry means an accidental
 * extra property on the main-process side can never reach here, structurally, regardless of what
 * main.ts's `daemon:get-status`/`daemon:status` handlers ever get changed to send.
 */
function toDaemonStatus(value: unknown): DaemonStatus {
  const state = value && typeof value === 'object' ? (value as { state?: unknown }).state : undefined;
  if (state === 'ready') return { state: 'ready' };
  if (state === 'unavailable') {
    const error = (value as { error?: unknown }).error;
    return { state: 'unavailable', error: typeof error === 'string' ? error : 'unknown error' };
  }
  return { state: 'connecting' };
}

const api: AgentDockBridge = {
  async getDaemonStatus() {
    return toDaemonStatus(await ipcRenderer.invoke('daemon:get-status'));
  },
  onDaemonStatus(callback) {
    const listener = (_event: Electron.IpcRendererEvent, status: unknown) => {
      callback(toDaemonStatus(status));
    };
    ipcRenderer.on('daemon:status', listener);
    return () => ipcRenderer.removeListener('daemon:status', listener);
  },
  listProviders() {
    return ipcRenderer.invoke('daemon:list-providers');
  },
  async listMcpProviders() {
    const value: unknown = await ipcRenderer.invoke('daemon:mcp-statuses');
    return Array.isArray(value) ? value.map((item) => mcpConnectionStatusSchema.parse(item)) : [];
  },
  async searchMcp(input) {
    const value: unknown = await ipcRenderer.invoke('daemon:mcp-search', input);
    return Array.isArray(value) ? value.map((item) => mcpVacancyResultSchema.parse(item)) : [];
  },
  setMcpCredential(input) {
    return ipcRenderer.invoke('daemon:mcp-set-credential', input);
  },
  removeMcpProvider(providerId) {
    return ipcRenderer.invoke('daemon:mcp-remove', providerId);
  },
  createSession(input) {
    return ipcRenderer.invoke('daemon:create-session', input);
  },
  cancelSession(sessionId) {
    return ipcRenderer.invoke('daemon:cancel-session', sessionId);
  },
  onSessionEvent(callback) {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      const p = payload as { sessionId?: unknown; event?: unknown } | null;
      if (p && typeof p.sessionId === 'string' && p.event && typeof p.event === 'object') {
        callback(p.sessionId, p.event as AgentEvent);
      }
    };
    ipcRenderer.on('daemon:session-event', listener);
    return () => ipcRenderer.removeListener('daemon:session-event', listener);
  },
  async selectDirectory() {
    const result: unknown = await ipcRenderer.invoke('dialog:select-directory');
    return typeof result === 'string' ? result : null;
  },
};

contextBridge.exposeInMainWorld('agentDock', api);

const vacancyApi: VacancyRadarBridge = {
  getStatus() {
    return ipcRenderer.invoke('vacancy:get-status');
  },
  getReport() {
    return ipcRenderer.invoke('vacancy:get-report');
  },
  runScan(query) {
    return ipcRenderer.invoke('vacancy:run-scan', query);
  },
  getNetherlandsReport() {
    return ipcRenderer.invoke('vacancy:get-nl-report');
  },
  runNetherlandsScan() {
    return ipcRenderer.invoke('vacancy:run-nl-scan');
  },
  getSearchProfile() {
    return ipcRenderer.invoke('vacancy:get-search-profile');
  },
  saveSearchProfile(patch) {
    return ipcRenderer.invoke('vacancy:save-search-profile', patch);
  },
};

contextBridge.exposeInMainWorld('vacancyRadar', vacancyApi);

/**
 * Each function names its own channel literally and forwards only the arguments that channel is
 * documented to take: there is no `channel` parameter anywhere, so a compromised renderer cannot
 * reach a `workspace:*` channel this list does not already grant, let alone a `daemon:*` one.
 * Main validates every payload again on arrival (electron/workspace/validate.ts); this side is
 * about the shape of the capability, not about trusting the renderer.
 */
const workspaceApi: WorkspaceBridge = {
  getSettings() {
    return ipcRenderer.invoke('workspace:settings:get');
  },
  updateSettings(patch) {
    return ipcRenderer.invoke('workspace:settings:update', patch);
  },
  getCounts() {
    return ipcRenderer.invoke('workspace:counts:get');
  },

  listSavedJobs() {
    return ipcRenderer.invoke('workspace:saved-jobs:list');
  },
  createSavedJob(input) {
    return ipcRenderer.invoke('workspace:saved-jobs:create', input);
  },
  updateSavedJob(id, patch) {
    return ipcRenderer.invoke('workspace:saved-jobs:update', { id, patch });
  },
  deleteSavedJob(id) {
    return ipcRenderer.invoke('workspace:saved-jobs:delete', { id });
  },

  listApplications(filter) {
    return ipcRenderer.invoke('workspace:applications:list', { filter: filter ?? 'all' });
  },
  createApplication(input) {
    return ipcRenderer.invoke('workspace:applications:create', input);
  },
  updateApplication(id, patch) {
    return ipcRenderer.invoke('workspace:applications:update', { id, patch });
  },
  deleteApplication(id) {
    return ipcRenderer.invoke('workspace:applications:delete', { id });
  },

  listCvDocuments() {
    return ipcRenderer.invoke('workspace:cv-documents:list');
  },
  createCvDocument(input) {
    return ipcRenderer.invoke('workspace:cv-documents:create', input);
  },
  updateCvDocument(id, patch) {
    return ipcRenderer.invoke('workspace:cv-documents:update', { id, patch });
  },
  deleteCvDocument(id) {
    return ipcRenderer.invoke('workspace:cv-documents:delete', { id });
  },
  setDefaultCvDocument(id) {
    return ipcRenderer.invoke('workspace:cv-documents:set-default', { id });
  },

  listLetters() {
    return ipcRenderer.invoke('workspace:letters:list');
  },
  createLetter(input) {
    return ipcRenderer.invoke('workspace:letters:create', input);
  },
  updateLetter(id, patch) {
    return ipcRenderer.invoke('workspace:letters:update', { id, patch });
  },
  deleteLetter(id) {
    return ipcRenderer.invoke('workspace:letters:delete', { id });
  },
  duplicateLetter(id) {
    return ipcRenderer.invoke('workspace:letters:duplicate', { id });
  },
};

contextBridge.exposeInMainWorld('workspace', workspaceApi);

/**
 * Rebuilt field by field rather than passed through, on the same principle as `toDaemonStatus`:
 * whatever `cv:select-and-read` sends, only `fileName` and `text` can ever reach the renderer. An
 * absolute path accidentally added to that payload later could not cross this boundary.
 */
function toCvFile(value: unknown): CvFile | null {
  if (!value || typeof value !== 'object') return null;
  const { fileName, text } = value as { fileName?: unknown; text?: unknown };
  if (typeof fileName !== 'string' || typeof text !== 'string') return null;
  return { fileName, text };
}

const cvApi: CvBridge = {
  async selectAndRead() {
    return toCvFile(await ipcRenderer.invoke('cv:select-and-read'));
  },
  async getWorkspaceDir() {
    const result: unknown = await ipcRenderer.invoke('cv:get-workspace-dir');
    if (typeof result !== 'string' || result.length === 0) {
      throw new Error('main process did not return a workspace directory');
    }
    return result;
  },
};

contextBridge.exposeInMainWorld('cv', cvApi);

/**
 * A fifth, single-capability namespace for the Settings page's "launch at login" toggle. Kept off
 * `WorkspaceBridge` on purpose: that bridge is the SQLite workspace contract (asserted
 * exhaustively in tests as "exactly these functions"), while this one call is OS integration with
 * no database involvement. The boolean is coerced with `=== true` so nothing but a literal
 * boolean ever reaches the channel, and the promise resolves to void. Main returns nothing worth
 * forwarding.
 */
export interface SaveFileFilter {
  name: string;
  extensions: string[];
}

export interface SaveFileInput {
  suggestedName: string;
  data: string;
  encoding: 'utf8' | 'base64';
  filters: SaveFileFilter[];
}

export interface SaveFileResult {
  saved: boolean;
  path?: string;
}

export interface SystemBridge {
  setLaunchAtLogin(enabled: boolean): Promise<void>;
  getAppVersion(): Promise<string>;
  /** Writes renderer-built file bytes (a real export, not a stub) to a user-chosen path via the
   * native save dialog. `{ saved: false }` means the user cancelled the dialog, not a failure. */
  saveFile(input: SaveFileInput): Promise<SaveFileResult>;
}

const systemApi: SystemBridge = {
  async setLaunchAtLogin(enabled) {
    await ipcRenderer.invoke('system:set-login-item', enabled === true);
  },
  async getAppVersion() {
    return (await ipcRenderer.invoke('system:get-app-version')) as string;
  },
  async saveFile(input) {
    return (await ipcRenderer.invoke('system:save-file', input)) as SaveFileResult;
  },
};

contextBridge.exposeInMainWorld('system', systemApi);

/**
 * A sixth namespace, for workspace grants (ADI-06).
 *
 * Its own namespace rather than three more methods on `agentDock`, for the reason the other
 * separations exist: this is the app's filesystem-trust boundary, and keeping it isolated means it
 * can be reviewed, tested, and (in a fork that does not want agent workspaces) deleted on its own
 * terms. The five pre-existing namespaces (`agentDock`, `vacancyRadar`, `workspace`, `cv`, and
 * `system`) are untouched by this ticket, and `preload.test.ts`
 * asserts that key-for-key.
 *
 * Note what is missing, because the omissions are the design:
 *
 * - **no path argument anywhere.** `requestGrant` takes a provider id. The folder is chosen by the
 *   user in a native picker that main opens; the renderer never names it and never learns it.
 * - **no path in any response.** A grant offer carries an opaque handle and a `display` object
 *   rebuilt field by field below, so a path accidentally added to the IPC payload later still could
 *   not cross this boundary.
 * - **no `workspaceId` or `incarnation`.** Those are the daemon's trust keys. A renderer holding
 *   them could describe a workspace it was never granted, so they stay in the main process.
 * - **no way to set trust.** There is no `trust()` here, and no daemon route that would accept one
 *   (see apps/daemon/src/routes/v2-workspaces.ts).
 */
export type WorkspaceGrantEffects = 'unbounded_cli';

export interface WorkspaceGrantDisplay {
  name: string;
  branch?: string;
  dirty: boolean;
  effects: WorkspaceGrantEffects;
}

export interface WorkspaceGrantOffer {
  grantHandle: string;
  display: WorkspaceGrantDisplay;
}

export type WorkspaceGrantConsumeResult = { ok: true } | { ok: false; reason: string };

export type WorkspaceGrantStatus =
  | { state: 'active'; expiresInMs: number }
  | { state: 'gone'; reason: string };

export interface WorkspaceGrantBridge {
  /** Opens the native picker and confirmation dialog. Takes a provider id and nothing else. */
  requestGrant(provider: ProviderId): Promise<WorkspaceGrantOffer | null>;
  /** Spends a grant, once. Bound in main to the WebContents the grant was issued to. */
  consumeGrant(grantHandle: string): Promise<WorkspaceGrantConsumeResult>;
  /** Whether a handle is still usable, and if not, why. Reason strings only, never paths. */
  getGrantStatus(grantHandle: string): Promise<WorkspaceGrantStatus>;
}

/** Rebuilds the offer field by field, on the same principle as `toDaemonStatus` and `toCvFile`. */
function toGrantOffer(value: unknown): WorkspaceGrantOffer | null {
  if (!value || typeof value !== 'object') return null;
  const { grantHandle, display } = value as { grantHandle?: unknown; display?: unknown };
  if (typeof grantHandle !== 'string' || !display || typeof display !== 'object') return null;
  const { name, branch, dirty } = display as { name?: unknown; branch?: unknown; dirty?: unknown };
  if (typeof name !== 'string') return null;
  return {
    grantHandle,
    display: {
      name,
      ...(typeof branch === 'string' ? { branch } : {}),
      dirty: dirty === true,
      // Never read from the payload: the literal is what this build knows how to describe, and
      // echoing back an effects value main sent would let a future widening reach the UI silently.
      effects: 'unbounded_cli',
    },
  };
}

const workspaceGrantApi: WorkspaceGrantBridge = {
  async requestGrant(provider) {
    // Exactly one field is forwarded, and it is coerced to a string here rather than passed
    // through: a caller that hands this an OBJECT carrying `{ provider, path }` would otherwise
    // put that whole object (path included) on the wire, and rely on main's schema parse to reject
    // it. Rejection after transmission is not the same as never transmitting, so the coercion is
    // done at the boundary. Main validates the value against `providerIdSchema` regardless.
    return toGrantOffer(
      await ipcRenderer.invoke('workspace-grant:request', {
        provider: typeof provider === 'string' ? provider : '',
      }),
    );
  },
  async consumeGrant(grantHandle) {
    const result: unknown = await ipcRenderer.invoke('workspace-grant:consume', {
      grantHandle: typeof grantHandle === 'string' ? grantHandle : '',
    });
    if (result && typeof result === 'object' && (result as { ok?: unknown }).ok === true) return { ok: true };
    const reason = result && typeof result === 'object' ? (result as { reason?: unknown }).reason : undefined;
    return { ok: false, reason: typeof reason === 'string' ? reason : 'unknown_handle' };
  },
  async getGrantStatus(grantHandle) {
    const result: unknown = await ipcRenderer.invoke('workspace-grant:status', {
      grantHandle: typeof grantHandle === 'string' ? grantHandle : '',
    });
    const state = result && typeof result === 'object' ? (result as { state?: unknown }).state : undefined;
    if (state === 'active') {
      const expiresInMs = (result as { expiresInMs?: unknown }).expiresInMs;
      return { state: 'active', expiresInMs: typeof expiresInMs === 'number' ? expiresInMs : 0 };
    }
    const reason = result && typeof result === 'object' ? (result as { reason?: unknown }).reason : undefined;
    return { state: 'gone', reason: typeof reason === 'string' ? reason : 'unknown_handle' };
  },
};

contextBridge.exposeInMainWorld('workspaceGrant', workspaceGrantApi);
