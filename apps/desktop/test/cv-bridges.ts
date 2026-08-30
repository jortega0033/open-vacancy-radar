import { vi } from 'vitest';
import type { AgentEvent, ProviderCapabilities, ProviderStatus } from '@agent-dock/shared';
import type { AgentDockBridge, CvBridge } from '../src/window.js';
import type { VacancyLead } from '../src/components/cv/types.js';
import { installWorkspaceBridge } from './workspace-bridge.js';

/**
 * Shared bridge stubs for the CV-assistant tests, following the same approach as App.test.tsx:
 * `window.agentDock` (and now `window.cv`) are replaced with vi.fn()s that resolve, reject, or
 * hand back the session-event callback so a test can drive the stream itself.
 */
const CAPABILITIES: ProviderCapabilities = {
  resume: true,
  cancellation: true,
  tools: true,
  usage: true,
  thinking: true,
};

export const CLAUDE_INSTALLED: ProviderStatus = {
  id: 'claude',
  name: 'Claude Code',
  installed: true,
  authenticated: 'authenticated',
  capabilities: CAPABILITIES,
  availableModels: ['sonnet', 'opus'],
};

export type EmitEvent = (sessionId: string, event: AgentEvent) => void;

export interface InstalledBridges {
  agentDock: AgentDockBridge;
  cv: CvBridge;
  /** Pushes an event into whatever `onSessionEvent` callback the component registered. */
  emit: EmitEvent;
}

export function installBridges(
  overrides: { agentDock?: Partial<AgentDockBridge>; cv?: Partial<CvBridge> } = {},
): InstalledBridges {
  const listeners: ((sessionId: string, event: AgentEvent) => void)[] = [];

  const agentDock: AgentDockBridge = {
    getDaemonStatus: vi.fn().mockResolvedValue({ state: 'ready' }),
    onDaemonStatus: vi.fn().mockReturnValue(() => {}),
    listProviders: vi.fn().mockResolvedValue([CLAUDE_INSTALLED]),
    createSession: vi.fn().mockResolvedValue({
      id: 'sess-cv-1',
      provider: 'claude',
      cwd: '/userData/ai-workspace',
      prompt: 'ignored',
      status: 'starting',
      startedAt: new Date().toISOString(),
    }),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    onSessionEvent: vi.fn((cb: (sessionId: string, event: AgentEvent) => void) => {
      listeners.push(cb);
      return () => {
        const index = listeners.indexOf(cb);
        if (index >= 0) listeners.splice(index, 1);
      };
    }),
    selectDirectory: vi.fn().mockResolvedValue('/chosen/dir'),
    ...overrides.agentDock,
  };

  const cv: CvBridge = {
    selectAndRead: vi.fn().mockResolvedValue({ fileName: 'cv.pdf', text: 'Angular. TypeScript. 8 years.' }),
    getWorkspaceDir: vi.fn().mockResolvedValue('/userData/ai-workspace'),
    ...overrides.cv,
  };

  const target = window as unknown as { agentDock: AgentDockBridge; cv: CvBridge };
  target.agentDock = agentDock;
  target.cv = cv;
  // The CV assistant now also offers "save to CV library", which goes through `window.workspace`.
  // Installed here so every CV test renders against a complete set of bridges rather than
  // depending on which of them a given component happens to touch on mount.
  installWorkspaceBridge();

  return {
    agentDock,
    cv,
    emit: (sessionId, event) => {
      for (const listener of [...listeners]) listener(sessionId, event);
    },
  };
}

export const TEST_VACANCY: VacancyLead = {
  title: 'Senior Frontend Engineer',
  company: 'Redwood Software',
  location: 'Amsterdam, Netherlands',
  url: 'https://example.invalid/jobs/senior-frontend-engineer',
  employmentType: 'full_time',
  currency: 'EUR',
  salaryPeriod: 'month',
  advertisedMinimum: 6500,
  description: 'Build Angular applications. Five years of frontend experience required.',
  requirements: ['Angular', 'TypeScript', 'Design systems'],
};
