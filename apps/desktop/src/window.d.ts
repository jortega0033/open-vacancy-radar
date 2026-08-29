import type { AgentEvent, AgentSession, ProviderId, ProviderStatus } from '@agent-dock/shared';
import type { GlobalRemoteReport } from '@open-vacancy-radar/vacancy-engine';

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
  getReport(): Promise<GlobalRemoteReport | null>;
  runScan(): Promise<GlobalRemoteReport>;
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

declare global {
  interface Window {
    agentDock: AgentDockBridge;
    vacancyRadar: VacancyRadarBridge;
    cv: CvBridge;
  }
}

export {};
