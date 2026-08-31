import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCapabilities, ProviderStatus } from '@agent-dock/shared';
import { App } from '../src/App.js';
import type { AgentDockBridge, DaemonStatus } from '../src/window.js';
import { installVacancyRadarBridge, installWorkspaceBridge } from './workspace-bridge.js';

const TEST_CAPABILITIES: ProviderCapabilities = {
  resume: true,
  cancellation: true,
  tools: true,
  usage: true,
  thinking: true,
};

const CLAUDE_INSTALLED: ProviderStatus = {
  id: 'claude',
  name: 'Claude Code',
  installed: true,
  authenticated: 'authenticated',
  capabilities: TEST_CAPABILITIES,
  availableModels: ['sonnet', 'opus'],
};

function installBridge(overrides: Partial<AgentDockBridge> = {}): AgentDockBridge {
  const bridge: AgentDockBridge = {
    getDaemonStatus: vi.fn().mockResolvedValue({ state: 'ready' } satisfies DaemonStatus),
    onDaemonStatus: vi.fn().mockReturnValue(() => {}),
    listProviders: vi.fn().mockResolvedValue([CLAUDE_INSTALLED]),
    createSession: vi.fn(),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    onSessionEvent: vi.fn().mockReturnValue(() => {}),
    selectDirectory: vi.fn().mockResolvedValue('/chosen/dir'),
    ...overrides,
  };
  (window as unknown as { agentDock: AgentDockBridge }).agentDock = bridge;
  return bridge;
}

beforeEach(() => {
  installBridge();
  installWorkspaceBridge();
  installVacancyRadarBridge();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * App.tsx itself now owns only shell-level concerns: which page is active, the app-wide daemon
 * banner, and the persisted default-provider label shown in the sidebar/header. The actual AI
 * Runtime screen (provider cards, verify) is `RuntimePage`, covered in
 * `test/components/runtime/RuntimePage.test.tsx`; this file no longer needs to drive it to test
 * App.tsx's own behavior.
 */
describe('App', () => {
  it('shows the daemon-unavailable banner when the daemon reports an error', async () => {
    let statusCallback: ((status: DaemonStatus) => void) | undefined;
    installBridge({
      getDaemonStatus: vi.fn().mockResolvedValue({ state: 'connecting' } satisfies DaemonStatus),
      onDaemonStatus: vi.fn((cb) => {
        statusCallback = cb;
        return () => {};
      }),
    });

    render(<App />);
    expect(screen.getByText(/connecting to local daemon/i)).toBeInTheDocument();

    statusCallback?.({ state: 'unavailable', error: 'daemon process exited unexpectedly (code 1, signal null)' });

    await waitFor(() => expect(screen.getByText(/daemon unavailable/i)).toBeInTheDocument());
    expect(screen.getByText(/exited unexpectedly/)).toBeInTheDocument();
  });

  it('renders the real AI Runtime screen: provider cards, not the old session-runner form', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/claude code ready/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'AI Runtime' }));

    // "Claude Code" also appears in the sidebar footer and header, so assert on card-specific
    // content instead of the ambiguous name text.
    await waitFor(() => expect(screen.getByText('Installed')).toBeInTheDocument());
    expect(screen.getByRole('heading', { level: 1, name: 'AI Runtime' })).toBeInTheDocument();
    // The old boilerplate's prompt-runner is gone: no cwd input, no free-text prompt box.
    expect(screen.queryByPlaceholderText('/path/to/project')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /prompt/i })).not.toBeInTheDocument();
  });

  it("reflects the persisted default provider in the sidebar's runtime label", async () => {
    installBridge({
      listProviders: vi.fn().mockResolvedValue([
        CLAUDE_INSTALLED,
        { ...CLAUDE_INSTALLED, id: 'codex', name: 'Codex' } satisfies ProviderStatus,
      ]),
    });
    installWorkspaceBridge({
      getSettings: vi.fn().mockResolvedValue({
        launchAtLogin: false,
        startPage: 'search',
        theme: 'system',
        density: 'comfortable',
        sidebarStart: 'remember_last',
        sidebarCollapsed: false,
        lastOpenedPage: 'search',
        defaultMarket: 'netherlands',
        defaultLocation: '',
        sponsorOnlyDefault: true,
        indVerificationEnabled: true,
        defaultCvId: null,
        defaultLetterType: 'motivation_letter',
        defaultLetterTone: 'natural',
        defaultLetterLength: 'standard',
        defaultApplicationStatus: 'preparing',
        confirmApplicationDelete: true,
        autoArchiveRejected: false,
        defaultProvider: 'codex',
      }),
    });

    render(<App />);

    await waitFor(() => expect(screen.getByText(/codex ready/i)).toBeInTheDocument());
  });
});
