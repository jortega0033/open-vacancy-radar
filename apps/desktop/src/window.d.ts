import type { AgentEvent, AgentSession, ProviderId, ProviderStatus } from '@agent-dock/shared';
import type { CandidateProfile, GlobalRemoteReport } from '@open-vacancy-radar/vacancy-engine';
import type { CandidateProfilePatch } from '../electron/vacancy-profile-validate.js';

export type DaemonStatus = { state: 'connecting' } | { state: 'ready' } | { state: 'unavailable'; error: string };

/**
 * `cwd` is deliberately absent (issue #175): the main process always pins every v1 session to its
 * own app-owned scratch directory and never reads a renderer-supplied one, the same "the renderer
 * never names a folder" rule the workspace-grant types already enforce.
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
  createSession(input: CreateSessionInput): Promise<AgentSession>;
  cancelSession(sessionId: string): Promise<void>;
  onSessionEvent(callback: (sessionId: string, event: AgentEvent) => void): () => void;
  selectDirectory(): Promise<string | null>;
}

export type VacancyEngineStatus = { ready: boolean; error?: string };

export interface VacancyRadarBridge {
  getStatus(): Promise<VacancyEngineStatus>;
  /** Global-remote (worldwide) pipeline. */
  getReport(): Promise<GlobalRemoteReport | null>;
  /** `query` scopes each source's own server-side search parameter for this run; omitted or blank
   * keeps the checked-in profile's static default. */
  runScan(query?: string): Promise<GlobalRemoteReport>;
  /** Whether a scan is currently running -- possibly one this window started before the user
   * navigated away from Search and back, since the scan itself outlives the page's own state. */
  getScanStatus(): Promise<{ scanning: boolean }>;
  /** The candidate profile deterministic scoring matches results against. */
  getSearchProfile(): Promise<CandidateProfile>;
  saveSearchProfile(patch: CandidateProfilePatch): Promise<CandidateProfile>;
}

export interface CvFile {
  fileName: string;
  text: string;
}

/** Mirror of `CvBridge` in electron/preload.ts. See the rationale for the narrow shape there. */
export interface CvBridge {
  selectAndRead(): Promise<CvFile | null>;
  getWorkspaceDir(): Promise<string>;
}

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

/** Mirror of `SystemBridge` in electron/preload.ts. OS-level integration: login item, app
 * version, and the native save-file dialog used for real document export. */
export interface SystemBridge {
  setLaunchAtLogin(enabled: boolean): Promise<void>;
  /** `app.getVersion()`: reads `package.json`'s `version`, so the About section can never drift
   * from what actually shipped. */
  getAppVersion(): Promise<string>;
  saveFile(input: SaveFileInput): Promise<SaveFileResult>;
}

/**
 * Mirror of `WorkspaceGrantBridge` in electron/preload.ts (ADI-06, extended by ADI-13).
 *
 * This declaration was missing entirely until ADI-07: `workspaceGrant` shipped with no renderer
 * consumer, so nothing needed to name it, and `window.workspaceGrant` was simply not on the
 * `Window` interface. The AI Workspace is its first consumer, which is what makes the declaration
 * necessary now.
 *
 * Hand-mirrored rather than imported, like `CvBridge` and `SystemBridge` above and unlike the
 * workspace record types below: `preload.ts` imports `electron`, so a type reference into it from
 * the renderer's own declaration file would drag Electron's types into the renderer's graph for no
 * benefit. The surface is four functions, so drift would be immediately obvious, and
 * `preload.test.ts` pins the real key set independently.
 *
 * Note what these types cannot express, which is the point: no argument names a path, and no
 * return value carries one.
 */
export interface WorkspaceGrantDisplay {
  name: string;
  branch?: string;
  dirty: boolean;
  /** Always the literal. See ADI-06's D4: a narrowed claim here would be a false one. */
  effects: 'unbounded_cli';
}

export interface WorkspaceGrantOffer {
  grantHandle: string;
  display: WorkspaceGrantDisplay;
}

export type WorkspaceGrantConsumeResult =
  | { ok: true; workspaceSessionRef?: string }
  | { ok: false; reason: string };

export type WorkspaceGrantStatus =
  | { state: 'active'; expiresInMs: number }
  | { state: 'gone'; reason: string };

export interface WorkspaceSessionStarted {
  sessionId: string;
  provider: string;
  status: string;
  model?: string;
}

export type WorkspaceStartSessionResult =
  | { ok: true; session: WorkspaceSessionStarted }
  | { ok: false; reason: string };

export interface WorkspaceStartSessionInput {
  workspaceSessionRef: string;
  prompt: string;
  resumeProviderSessionId?: string;
  capabilities?: unknown;
}

export interface WorkspaceGrantBridge {
  requestGrant(provider: ProviderId): Promise<WorkspaceGrantOffer | null>;
  consumeGrant(grantHandle: string): Promise<WorkspaceGrantConsumeResult>;
  getGrantStatus(grantHandle: string): Promise<WorkspaceGrantStatus>;
  startSession(input: WorkspaceStartSessionInput): Promise<WorkspaceStartSessionResult>;
}

/**
 * The AI Workspace types (ADI-07) *are* imported, for the same reason the workspace record types
 * below are: `electron/agent-workspace-types.ts` is a pure type module that imports nothing from
 * Electron or Node, and the surface is large enough (a dozen shapes, one of them an eleven-member
 * discriminated union) that a hand-written mirror would be pure duplication with a real chance of
 * silent divergence. The import is type-only and erased at compile time.
 */
export type {
  ActivityCloseReason,
  ActivityDigest,
  ActivityEntry,
  ActivityPush,
  AgentWorkspaceBridge,
  AttachRefusal,
  AttachResult,
  HistoryEntry,
  PageRequest,
  SessionCapacity,
  SessionEventsPage,
  SessionListPage,
  SessionScopeSummary,
  SessionSummary,
  StartSessionDenialReason,
} from '../electron/agent-workspace-types.js';

/** #200. Short and content-free enough that a hand-written mirror is cheap, same reasoning as the
 * three bridges above -- the import is type-only and erased at compile time. */
export type {
  ApplicationQueueBridge,
  ApplicationQueueEntry,
  ApplicationQueueEntryState,
  ApplicationQueueEvent,
  ApplicationQueueEventType,
  ApplicationQueueLease,
  ApplicationQueueStatus,
} from '../electron/application-queue-types.js';

/**
 * The workspace record/input types are *imported* from the Electron side rather than re-declared
 * here, unlike the three bridges above. Those are short enough that a hand-written mirror is
 * cheap and its drift would be obvious; the workspace contract is five entities × three shapes,
 * where a silent divergence between main and renderer is a real risk and re-typing it would be
 * pure duplication. The import is type-only, so nothing from `electron/` is ever pulled into the
 * renderer bundle. It is erased at compile time.
 */
export type {
  ApplicationFilter,
  ApplicationInput,
  ApplicationPatch,
  ApplicationRecord,
  ApplicationStatus,
  AppSettingsPatch,
  AppSettingsRecord,
  CvDocumentInput,
  CvDocumentPatch,
  CvDocumentRecord,
  CvKind,
  CvProfile,
  DeleteResult,
  DensityPreference,
  LetterInput,
  LetterLength,
  LetterPatch,
  LetterRecord,
  LetterStatus,
  LetterTone,
  LetterType,
  SavedJobInput,
  SavedJobPatch,
  SavedJobRecord,
  SavedJobStatus,
  SidebarStartPreference,
  StartPage,
  ThemePreference,
  WorkspaceBridge,
  WorkspaceCounts,
} from '../electron/workspace/types.js';

declare global {
  interface Window {
    agentDock: AgentDockBridge;
    vacancyRadar: VacancyRadarBridge;
    cv: CvBridge;
    system: SystemBridge;
    workspace: import('../electron/workspace/types.js').WorkspaceBridge;
    /** ADI-06/ADI-13. Declared here for the first time by ADI-07, its first renderer consumer. */
    workspaceGrant: WorkspaceGrantBridge;
    /** ADI-07. The seventh namespace: read v2 sessions, and stream sanitized live activity. */
    agentWorkspace: import('../electron/agent-workspace-types.js').AgentWorkspaceBridge;
    /** #200. The eighth namespace: the daemon-owned application queue -- enqueue/pause/resume/
     * skip/cancel an attempt by opaque id, and stream its (content-free) live activity. */
    applicationQueue: import('../electron/application-queue-types.js').ApplicationQueueBridge;
  }
}

export {};
