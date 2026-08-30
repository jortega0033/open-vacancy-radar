import type { AgentEvent, AgentSession, ProviderId, ProviderStatus } from '@agent-dock/shared';
import type { GlobalRemoteReport, JobRadarReport } from '@open-vacancy-radar/vacancy-engine';

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
  runScan(): Promise<GlobalRemoteReport>;
  /** Netherlands pipeline — the IND recognised-sponsor scan. */
  getNetherlandsReport(): Promise<JobRadarReport | null>;
  runNetherlandsScan(): Promise<JobRadarReport>;
}

export interface CvFile {
  fileName: string;
  text: string;
}

/** Mirror of `CvBridge` in electron/preload.ts — see the rationale for the narrow shape there. */
export interface CvBridge {
  selectAndRead(): Promise<CvFile | null>;
  getWorkspaceDir(): Promise<string>;
}

/** Mirror of `SystemBridge` in electron/preload.ts — OS login-item integration for Settings. */
export interface SystemBridge {
  setLaunchAtLogin(enabled: boolean): Promise<void>;
}

/**
 * The workspace record/input types are *imported* from the Electron side rather than re-declared
 * here, unlike the three bridges above. Those are short enough that a hand-written mirror is
 * cheap and its drift would be obvious; the workspace contract is five entities × three shapes,
 * where a silent divergence between main and renderer is a real risk and re-typing it would be
 * pure duplication. The import is type-only, so nothing from `electron/` is ever pulled into the
 * renderer bundle — it is erased at compile time.
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
  Market,
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
  }
}

export {};
