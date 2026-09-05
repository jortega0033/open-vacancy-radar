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
import type { CandidateProfile, GlobalRemoteReport } from '@open-vacancy-radar/vacancy-engine';
import type { CandidateProfilePatch } from './vacancy-profile-validate.js';
import type { WorkspaceBridge } from './workspace/types.js';
import type {
  ApplicationQueueBridge,
  ApplicationQueueEntry,
  ApplicationQueueEvent,
  ApplicationQueueEventType,
  ApplicationQueueStatus,
} from './application-queue-types.js';

/**
 * The only surface the renderer has onto Node/Electron. Every function here is a narrow,
 * single-purpose capability: never a generic "invoke this IPC channel with this payload" tunnel
 * and never the daemon's connection info (base URL + bearer token stay in the main process; see
 * electron/main.ts and SECURITY.md). The renderer cannot run a shell command, read/write an
 * arbitrary file, or reach any daemon route this bridge doesn't explicitly expose.
 */
export type DaemonStatus = { state: 'connecting' } | { state: 'ready' } | { state: 'unavailable'; error: string };

/**
 * `cwd` is deliberately absent (issue #175): `daemon:create-session`'s main-process handler pins
 * every v1 session to its own app-owned scratch directory and never reads a renderer-supplied one.
 */
export interface CreateSessionInput {
  provider: ProviderId;
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
  /** Whether a scan is currently running -- possibly one this window started before the user
   * navigated away from Search and back, since the scan itself outlives the page's own state. */
  getScanStatus(): Promise<{ scanning: boolean }>;
  /** The candidate profile deterministic scoring matches results against. */
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
  getScanStatus() {
    return ipcRenderer.invoke('vacancy:get-scan-status');
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

/**
 * A successful consumption now also carries an opaque **workspace session ref** (ADI-13): the handle
 * `startSession` below addresses a trusted workspace by. Optional, so a refusal's shape is unchanged
 * and a main process that did not mint one still produces a valid result.
 */
export type WorkspaceGrantConsumeResult =
  | { ok: true; workspaceSessionRef?: string }
  | { ok: false; reason: string };

export type WorkspaceGrantStatus =
  | { state: 'active'; expiresInMs: number }
  | { state: 'gone'; reason: string };

/**
 * What the renderer learns about a session it started (ADI-13).
 *
 * Note the absence of `cwd`. The daemon's own v2 session view has one, and main strips it before
 * this bridge ever sees a response -- so even a future daemon change that added more path-shaped
 * fields could not reach here, because this object is rebuilt field by field below.
 */
export interface WorkspaceSessionStarted {
  sessionId: string;
  provider: string;
  status: string;
  model?: string;
}

export type WorkspaceStartSessionResult =
  | { ok: true; session: WorkspaceSessionStarted }
  | { ok: false; reason: string };

/** What the renderer may ask for when starting a session. No path, no workspace id, no incarnation. */
export interface WorkspaceStartSessionInput {
  workspaceSessionRef: string;
  prompt: string;
  resumeProviderSessionId?: string;
  capabilities?: unknown;
}

export interface WorkspaceGrantBridge {
  /** Opens the native picker and confirmation dialog. Takes a provider id and nothing else. */
  requestGrant(provider: ProviderId): Promise<WorkspaceGrantOffer | null>;
  /** Spends a grant, once. Bound in main to the WebContents the grant was issued to. */
  consumeGrant(grantHandle: string): Promise<WorkspaceGrantConsumeResult>;
  /** Whether a handle is still usable, and if not, why. Reason strings only, never paths. */
  getGrantStatus(grantHandle: string): Promise<WorkspaceGrantStatus>;
  /**
   * Starts an agent session in a workspace the user already approved (ADI-13).
   *
   * Addressed by the opaque ref `consumeGrant` returned, never by a location: the signature has
   * nowhere to put a path, a `workspaceId`, or an `incarnation`, and the four fields it does forward
   * are copied out explicitly below so an object carrying extras cannot put them on the wire.
   */
  startSession(input: WorkspaceStartSessionInput): Promise<WorkspaceStartSessionResult>;
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
    if (result && typeof result === 'object' && (result as { ok?: unknown }).ok === true) {
      // Rebuilt, not spread: a success payload that grew a `canonicalPath` would otherwise cross.
      const ref = (result as { workspaceSessionRef?: unknown }).workspaceSessionRef;
      return { ok: true, ...(typeof ref === 'string' ? { workspaceSessionRef: ref } : {}) };
    }
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
  async startSession(input) {
    // Exactly four fields are read off the argument and put on the wire, each coerced here rather
    // than passed through. A caller that hands this `{ workspaceSessionRef, prompt, cwd, path }`
    // has the last two dropped at this boundary, not merely rejected after transmission -- the same
    // reasoning `requestGrant` above applies to its single field.
    const source = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const resume = source.resumeProviderSessionId;
    const result: unknown = await ipcRenderer.invoke('workspace:start-session', {
      workspaceSessionRef: typeof source.workspaceSessionRef === 'string' ? source.workspaceSessionRef : '',
      prompt: typeof source.prompt === 'string' ? source.prompt : '',
      ...(typeof resume === 'string' ? { resumeProviderSessionId: resume } : {}),
      ...(Array.isArray(source.capabilities) ? { capabilities: source.capabilities } : {}),
    });

    const payload = result && typeof result === 'object' ? (result as Record<string, unknown>) : undefined;
    const session = payload?.session as Record<string, unknown> | undefined;
    if (payload?.ok === true && session && typeof session.sessionId === 'string') {
      // Rebuilt field by field, like `toGrantOffer`: the daemon's own session view carries a `cwd`,
      // and main already strips it -- this is the second, independent place that cannot pass one on.
      return {
        ok: true,
        session: {
          sessionId: session.sessionId,
          provider: typeof session.provider === 'string' ? session.provider : '',
          status: typeof session.status === 'string' ? session.status : 'starting',
          ...(typeof session.model === 'string' ? { model: session.model } : {}),
        },
      };
    }
    const reason = payload?.reason;
    // Fail-closed: anything this build cannot interpret is a refusal, never a success.
    return { ok: false, reason: typeof reason === 'string' ? reason : 'refused' };
  },
};

contextBridge.exposeInMainWorld('workspaceGrant', workspaceGrantApi);

/**
 * A seventh namespace, for the AI Workspace (ADI-07).
 *
 * Its own namespace rather than four more methods on `workspaceGrant`, and that separation is the
 * security decision this ticket makes at this boundary. `workspaceGrant` is the app's filesystem
 * *trust* surface: four capabilities, each individually reviewed, whose key set `preload.test.ts`
 * pins exactly. Reading a session list is not a trust decision, and widening the trust namespace to
 * hold it would mean every future review of "what can the renderer do about folders?" has to first
 * separate the two concerns again. So `workspaceGrant` is left key-for-key unchanged, and this
 * sits beside it.
 *
 * Note the omissions, which are the design:
 *
 * - **no path argument, and no path in any response.** A v2 session's `cwd` has exactly one source
 *   in this system -- the canonical path behind a grant ref, held in main -- and it is not this.
 *   Every response is rebuilt field by field below, so a `cwd` main somehow forwarded still could
 *   not cross.
 * - **no provider session id and no native tool-call id.** Main drops the first and replaces the
 *   second with a local alias; this rebuild drops both again.
 * - **no generic invoke.** Every function names its own channel literally. There is no `channel`
 *   parameter, so a compromised renderer cannot reach an `agent-workspace:*` channel this list does
 *   not already grant, let alone a `workspace-grant:*` or `daemon:*` one.
 * - **no cancel.** Cancelling a session goes through v1's existing `agentDock.cancelSession`, which
 *   already works on a v2 session (both live in the same `SessionManager`). A second cancel verb
 *   would be a second thing to keep in agreement with it for no capability gained.
 */
export type {
  ActivityCloseReason,
  ActivityDigest,
  ActivityEntry,
  ActivityPush,
  AgentWorkspaceBridge,
  AttachResult,
  HistoryEntry,
  PageRequest,
  SessionCapacity,
  SessionEventsPage,
  SessionListPage,
  SessionSummary,
} from './agent-workspace-types.js';

import type {
  ActivityDigest as ActivityDigestType,
  ActivityEntry as ActivityEntryType,
  ActivityPush as ActivityPushType,
  AgentWorkspaceBridge as AgentWorkspaceBridgeType,
  AttachResult as AttachResultType,
  HistoryEntry as HistoryEntryType,
  PageRequest as PageRequestType,
  SessionCapacity as SessionCapacityType,
  SessionSummary as SessionSummaryType,
} from './agent-workspace-types.js';

/** Copies a string field only when it really is one. Every rebuild below goes through this. */
function optionalString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

function requiredString(source: Record<string, unknown>, key: string, fallback = ''): string {
  return optionalString(source, key) ?? fallback;
}

function optionalFiniteNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function toDigest(value: unknown): ActivityDigestType | undefined {
  const source = asRecord(value);
  if (!source) return undefined;
  const bytes = optionalFiniteNumber(source, 'bytes');
  const sha256 = optionalString(source, 'sha256');
  if (bytes === undefined || sha256 === undefined) return undefined;
  return { bytes, sha256 };
}

/**
 * The **second, independent** rebuild of a session summary.
 *
 * Main already built this object field by field in `agent-workspace-view.ts`. Doing it again here
 * is not redundancy: it is the same double-rebuild discipline ADI-13 established for
 * `startSession`, and it exists because preload should not trust main blindly. If a future change
 * to main leaks a `cwd` into this payload, the failure has to be in *two* files, in two different
 * processes, for it to reach the renderer.
 */
function toSessionSummary(value: unknown): SessionSummaryType | null {
  const source = asRecord(value);
  if (!source) return null;
  const id = optionalString(source, 'id');
  if (id === undefined || id.length === 0) return null;

  const scopeSource = asRecord(source.scope) ?? {};
  const providerVersion = optionalString(scopeSource, 'providerVersion');
  const model = optionalString(source, 'model');
  const terminalReason = optionalString(source, 'terminalReason');
  const parentSessionId = optionalString(source, 'parentSessionId');
  const completedAt = optionalString(source, 'completedAt');

  return {
    id,
    provider: requiredString(source, 'provider'),
    protocolVersion: nonNegativeInt(source.protocolVersion),
    transportId: requiredString(source, 'transportId', 'legacy-one-shot'),
    ...(model === undefined ? {} : { model }),
    status: requiredString(source, 'status', 'starting'),
    ...(terminalReason === undefined ? {} : { terminalReason }),
    acceptedWork: requiredString(source, 'acceptedWork', 'unknown'),
    rootSessionId: requiredString(source, 'rootSessionId', id),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    continuationKind: requiredString(source, 'continuationKind', 'fresh'),
    startedAt: requiredString(source, 'startedAt'),
    ...(completedAt === undefined ? {} : { completedAt }),
    earliestSequence: nonNegativeInt(source.earliestSequence),
    eventCount: nonNegativeInt(source.eventCount),
    eventsTruncated: source.eventsTruncated === true,
    scope: {
      ...(providerVersion === undefined ? {} : { providerVersion }),
      authenticated: requiredString(scopeSource, 'authenticated', 'unknown'),
      platform: requiredString(scopeSource, 'platform', 'unknown'),
      // Never echoed, for the reason `toGrantOffer` never echoes `effects`: this literal is a
      // documented limitation marker, and a stronger value main sent must not reach the UI.
      accountEvidence: 'cli_owned',
    },
    unknownFrameCount: nonNegativeInt(source.unknownFrameCount),
  };
}

/**
 * The second, independent rebuild of one activity entry.
 *
 * Rebuilt per `kind` rather than spread, so the fields main is required to have dropped
 * (`providerSessionId`, a native `toolCallId`, a `status` detail, an error `message`) have no
 * copier here even if they were present on the payload.
 */
function toActivityEntry(value: unknown): ActivityEntryType | null {
  const source = asRecord(value);
  if (!source) return null;
  const seq = source.seq;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return null;
  const origin = source.origin === 'history' ? 'history' : 'live';
  const base = { seq, at: requiredString(source, 'at'), origin } as const;

  switch (source.kind) {
    case 'session.started':
      return { ...base, kind: 'session.started', provider: requiredString(source, 'provider') };
    case 'status':
      return { ...base, kind: 'status', status: requiredString(source, 'status') };
    case 'assistant.message':
    case 'thinking.delta': {
      const text = optionalString(source, 'text');
      const digest = toDigest(source.digest);
      const body = {
        ...(text === undefined ? {} : { text }),
        ...(source.textTruncated === true ? { textTruncated: true } : {}),
        ...(source.textOmitted === true ? { textOmitted: true } : {}),
        ...(digest === undefined ? {} : { digest }),
      };
      return source.kind === 'assistant.message'
        ? { ...base, kind: 'assistant.message', ...body }
        : { ...base, kind: 'thinking.delta', ...body };
    }
    case 'tool.started': {
      const toolAlias = optionalString(source, 'toolAlias');
      const input = toDigest(source.input);
      return {
        ...base,
        kind: 'tool.started',
        toolName: requiredString(source, 'toolName'),
        ...(toolAlias === undefined ? {} : { toolAlias }),
        ...(input === undefined ? {} : { input }),
      };
    }
    case 'tool.completed': {
      const toolName = optionalString(source, 'toolName');
      const toolAlias = optionalString(source, 'toolAlias');
      const result = toDigest(source.result);
      return {
        ...base,
        kind: 'tool.completed',
        ...(toolName === undefined ? {} : { toolName }),
        ...(toolAlias === undefined ? {} : { toolAlias }),
        ...(typeof source.isError === 'boolean' ? { isError: source.isError } : {}),
        ...(result === undefined ? {} : { result }),
      };
    }
    case 'usage': {
      const inputTokens = optionalFiniteNumber(source, 'inputTokens');
      const outputTokens = optionalFiniteNumber(source, 'outputTokens');
      const cachedInputTokens = optionalFiniteNumber(source, 'cachedInputTokens');
      const cost = optionalFiniteNumber(source, 'cost');
      return {
        ...base,
        kind: 'usage',
        ...(inputTokens === undefined ? {} : { inputTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
        ...(cost === undefined ? {} : { cost }),
      };
    }
    case 'error': {
      const code = optionalString(source, 'code');
      return {
        ...base,
        kind: 'error',
        // Re-checked against the identifier charset here too: this value selects a row in a closed
        // renderer-side copy table, and a value that is not an identifier has no row to select.
        ...(code !== undefined && /^[A-Za-z0-9._-]{1,64}$/.test(code) ? { code } : {}),
        recoverable: source.recoverable === true,
      };
    }
    case 'session.completed':
      return { ...base, kind: 'session.completed' };
    case 'session.failed':
      return { ...base, kind: 'session.failed' };
    case 'session.cancelled':
      return { ...base, kind: 'session.cancelled' };
    case 'session.interrupted':
      return { ...base, kind: 'session.interrupted' };
    default:
      // Fail-closed: an entry kind this build cannot rebuild is dropped, never passed through.
      return null;
  }
}

function toCapacityBucket(value: unknown): { active: number; limit: number } {
  const source = asRecord(value) ?? {};
  return { active: nonNegativeInt(source.active), limit: nonNegativeInt(source.limit) };
}

function toCapacity(value: unknown): SessionCapacityType {
  const source = asRecord(value) ?? {};
  return { global: toCapacityBucket(source.global), provider: toCapacityBucket(source.provider) };
}

/** Copies exactly the two paging fields onto the wire, coerced, never the caller's whole object. */
function toPagePayload(page: PageRequestType | undefined): Record<string, unknown> {
  const source = asRecord(page) ?? {};
  const cursor = optionalString(source, 'cursor');
  const limit = optionalFiniteNumber(source, 'limit');
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

const agentWorkspaceApi: AgentWorkspaceBridgeType = {
  async listSessions(page) {
    const result: unknown = await ipcRenderer.invoke('agent-workspace:list', toPagePayload(page));
    const source = asRecord(result);
    const raw = Array.isArray(source?.sessions) ? source.sessions : [];
    const sessions: SessionSummaryType[] = [];
    for (const view of raw) {
      const summary = toSessionSummary(view);
      if (summary !== null) sessions.push(summary);
    }
    const nextCursor = source ? optionalString(source, 'nextCursor') : undefined;
    return {
      sessions,
      ...(nextCursor === undefined ? {} : { nextCursor }),
      capacity: toCapacity(source?.capacity),
    };
  },

  async getSession(sessionId) {
    const result: unknown = await ipcRenderer.invoke('agent-workspace:get', {
      sessionId: typeof sessionId === 'string' ? sessionId : '',
    });
    return toSessionSummary(result);
  },

  async getSessionEvents(sessionId, page) {
    const id = typeof sessionId === 'string' ? sessionId : '';
    const result: unknown = await ipcRenderer.invoke('agent-workspace:events', {
      sessionId: id,
      ...toPagePayload(page),
    });
    const source = asRecord(result);
    const raw = Array.isArray(source?.events) ? source.events : [];
    const events: HistoryEntryType[] = [];
    for (const record of raw) {
      const entry = toActivityEntry(record);
      // A history page's entries are history entries by definition: the origin is asserted here
      // rather than read from the payload, so a mislabelled `origin: 'live'` cannot make a
      // digest-only entry win the timeline merge against real prose.
      if (entry !== null) events.push({ ...entry, origin: 'history' });
    }
    const nextCursor = source ? optionalString(source, 'nextCursor') : undefined;
    return { sessionId: id, events, ...(nextCursor === undefined ? {} : { nextCursor }) };
  },

  async attachActivity(sessionId, lastSeq) {
    const result: unknown = await ipcRenderer.invoke('agent-workspace:attach', {
      sessionId: typeof sessionId === 'string' ? sessionId : '',
      ...(typeof lastSeq === 'number' && Number.isInteger(lastSeq) && lastSeq >= 0 ? { lastSeq } : {}),
    });
    const source = asRecord(result);
    if (source?.ok === true) return { ok: true };
    const reason = source ? optionalString(source, 'reason') : undefined;
    // Fail-closed: anything this build cannot interpret is a refusal, never a live attachment.
    const known: AttachResultType = {
      ok: false,
      reason:
        reason === 'attach_limit' || reason === 'daemon_unavailable' || reason === 'invalid_session_id'
          ? reason
          : 'daemon_unavailable',
    };
    return known;
  },

  async detachActivity(sessionId) {
    await ipcRenderer.invoke('agent-workspace:detach', {
      sessionId: typeof sessionId === 'string' ? sessionId : '',
    });
  },

  onActivity(callback) {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      const source = asRecord(payload);
      const sessionId = source ? optionalString(source, 'sessionId') : undefined;
      if (sessionId === undefined || sessionId.length === 0) return;

      const closed = asRecord(source?.closed);
      if (closed) {
        const reason = optionalString(closed, 'reason');
        callback({
          sessionId,
          closed: { reason: reason === 'stream_ended' ? 'stream_ended' : 'stream_unavailable' },
        });
        return;
      }

      const entry = toActivityEntry(source?.entry);
      if (entry !== null) callback({ sessionId, entry } satisfies ActivityPushType);
    };
    ipcRenderer.on('agent-workspace:activity', listener);
    return () => ipcRenderer.removeListener('agent-workspace:activity', listener);
  },
};

contextBridge.exposeInMainWorld('agentWorkspace', agentWorkspaceApi);

const APPLICATION_QUEUE_ENTRY_STATES = ['queued', 'active', 'paused', 'cancelled', 'done', 'failed'] as const;
const APPLICATION_QUEUE_EVENT_TYPES = [
  'enqueued',
  'lease_acquired',
  'paused',
  'resumed',
  'skipped',
  'cancelled',
  'released',
] as const;

/** Fail-closed the way every other bridge coercion here does: a response shape this build cannot
 * interpret produces `null`/is dropped, never a fabricated entry. */
function toApplicationQueueEntry(value: unknown): ApplicationQueueEntry | null {
  const source = asRecord(value);
  if (!source) return null;
  const attemptId = optionalString(source, 'attemptId');
  const state = optionalString(source, 'state');
  const queuedAt = optionalString(source, 'queuedAt');
  const updatedAt = optionalString(source, 'updatedAt');
  if (!attemptId || !state || !queuedAt || !updatedAt) return null;
  if (!(APPLICATION_QUEUE_ENTRY_STATES as readonly string[]).includes(state)) return null;
  return { attemptId, state: state as ApplicationQueueEntry['state'], queuedAt, updatedAt };
}

const applicationQueueApi: ApplicationQueueBridge = {
  async enqueue(attemptId) {
    const result = await ipcRenderer.invoke('application-queue:enqueue', attemptId);
    const entry = toApplicationQueueEntry(result);
    if (!entry) throw new Error('the application queue returned an unexpected response');
    return entry;
  },

  async pause(attemptId) {
    const result = await ipcRenderer.invoke('application-queue:pause', attemptId);
    const entry = toApplicationQueueEntry(result);
    if (!entry) throw new Error('the application queue returned an unexpected response');
    return entry;
  },

  async resume(attemptId) {
    const result = await ipcRenderer.invoke('application-queue:resume', attemptId);
    const entry = toApplicationQueueEntry(result);
    if (!entry) throw new Error('the application queue returned an unexpected response');
    return entry;
  },

  async skip(attemptId) {
    const result = await ipcRenderer.invoke('application-queue:skip', attemptId);
    const entry = toApplicationQueueEntry(result);
    if (!entry) throw new Error('the application queue returned an unexpected response');
    return entry;
  },

  async cancel(attemptId) {
    const result = await ipcRenderer.invoke('application-queue:cancel', attemptId);
    const entry = toApplicationQueueEntry(result);
    if (!entry) throw new Error('the application queue returned an unexpected response');
    return entry;
  },

  async getStatus(): Promise<ApplicationQueueStatus> {
    const result: unknown = await ipcRenderer.invoke('application-queue:get-status');
    const source = asRecord(result);
    const rawEntries = Array.isArray(source?.entries) ? source.entries : [];
    const entries: ApplicationQueueEntry[] = [];
    for (const raw of rawEntries) {
      const entry = toApplicationQueueEntry(raw);
      if (entry) entries.push(entry);
    }
    const leaseSource = asRecord(source?.lease);
    const leaseId = leaseSource ? optionalString(leaseSource, 'leaseId') : undefined;
    const leaseAttemptId = leaseSource ? optionalString(leaseSource, 'attemptId') : undefined;
    const acquiredAt = leaseSource ? optionalString(leaseSource, 'acquiredAt') : undefined;
    const lease = leaseId && leaseAttemptId && acquiredAt ? { leaseId, attemptId: leaseAttemptId, acquiredAt } : null;
    return { entries, lease };
  },

  onActivity(callback) {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => {
      const source = asRecord(payload);
      if (!source) return;
      const seq = source.seq;
      const at = optionalString(source, 'at');
      const type = optionalString(source, 'type');
      const attemptId = optionalString(source, 'attemptId');
      if (typeof seq !== 'number' || !at || !type || !attemptId) return;
      if (!(APPLICATION_QUEUE_EVENT_TYPES as readonly string[]).includes(type)) return;
      callback({ seq, at, type: type as ApplicationQueueEventType, attemptId } satisfies ApplicationQueueEvent);
    };
    ipcRenderer.on('application-queue:activity', listener);
    return () => ipcRenderer.removeListener('application-queue:activity', listener);
  },
};

contextBridge.exposeInMainWorld('applicationQueue', applicationQueueApi);
