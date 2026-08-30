import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCapabilities, ProviderStatus } from '@agent-dock/shared';
import { RuntimePage } from '../../../src/components/runtime/index.js';
import type { AgentDockBridge } from '../../../src/window.js';
import { DEFAULT_SETTINGS, installWorkspaceBridge } from '../../workspace-bridge.js';

const CLAUDE: ProviderStatus = {
  id: 'claude',
  name: 'Claude Code',
  installed: true,
  authenticated: 'authenticated',
  capabilities: { resume: true, cancellation: true, tools: true, usage: false, thinking: false },
  executablePath: '/usr/local/bin/claude',
  version: '2.4.1',
};
const NO_CAPABILITIES: ProviderCapabilities = {};
const CODEX_NOT_INSTALLED: ProviderStatus = {
  id: 'codex',
  name: 'Codex',
  installed: false,
  authenticated: 'unknown',
  capabilities: NO_CAPABILITIES,
};

function installAgentDockBridge(overrides: Partial<AgentDockBridge> = {}): AgentDockBridge {
  const bridge: AgentDockBridge = {
    getDaemonStatus: vi.fn().mockResolvedValue({ state: 'ready' }),
    onDaemonStatus: vi.fn().mockReturnValue(() => {}),
    listProviders: vi.fn().mockResolvedValue([CLAUDE, CODEX_NOT_INSTALLED]),
    createSession: vi.fn(),
    cancelSession: vi.fn(),
    onSessionEvent: vi.fn().mockReturnValue(() => {}),
    selectDirectory: vi.fn(),
    ...overrides,
  };
  (window as unknown as { agentDock: AgentDockBridge }).agentDock = bridge;
  return bridge;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RuntimePage', () => {
  it('shows the daemon-unavailable empty state instead of any provider content', () => {
    installAgentDockBridge();
    installWorkspaceBridge();
    render(<RuntimePage daemonState="unavailable" daemonError="daemon exited" />);

    expect(screen.getByRole('heading', { name: 'AI runtime unavailable' })).toBeInTheDocument();
    expect(screen.getByText(/daemon exited/)).toBeInTheDocument();
    expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();
  });

  it('renders real provider cards — installed/auth/version/capabilities — not the old prompt runner', async () => {
    installAgentDockBridge();
    installWorkspaceBridge();
    render(<RuntimePage daemonState="ready" />);

    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument());
    expect(screen.getByText('2.4.1')).toBeInTheDocument();
    expect(screen.getByText('Authenticated')).toBeInTheDocument();
    expect(screen.getByText('Resume')).toBeInTheDocument();
    expect(screen.getByText('Tools')).toBeInTheDocument();
    expect(screen.queryByText('Usage')).not.toBeInTheDocument(); // capabilities.usage is false

    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not installed' })).toBeDisabled();

    // The old boilerplate's session runner is gone.
    expect(screen.queryByPlaceholderText('/path/to/project')).not.toBeInTheDocument();
  });

  it('sets a provider as default, persists it, and reports the change upward', async () => {
    installAgentDockBridge({
      listProviders: vi.fn().mockResolvedValue([
        CLAUDE,
        { ...CODEX_NOT_INSTALLED, installed: true, authenticated: 'authenticated', version: '1.0.0' },
      ]),
    });
    const updateSettings = vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, defaultProvider: 'codex' });
    installWorkspaceBridge({
      getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, defaultProvider: 'claude' }),
      updateSettings,
    });
    const onDefaultProviderChanged = vi.fn();

    render(<RuntimePage daemonState="ready" onDefaultProviderChanged={onDefaultProviderChanged} />);
    await waitFor(() => expect(screen.getByText('Default ✓')).toBeInTheDocument()); // Claude starts as default

    fireEvent.click(screen.getByRole('button', { name: 'Use as default' })); // Codex's button

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ defaultProvider: 'codex' }));
    await waitFor(() => expect(onDefaultProviderChanged).toHaveBeenCalledWith('codex'));
  });

  it('verify shows a real success checklist for the current default provider', async () => {
    installAgentDockBridge();
    installWorkspaceBridge({ getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, defaultProvider: 'claude' }) });

    render(<RuntimePage daemonState="ready" />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(screen.getByText(/executable detected/i)).toBeInTheDocument());
    expect(screen.getByText('/usr/local/bin/claude')).toBeInTheDocument();
    expect(screen.getByText(/version check passed — 2\.4\.1/i)).toBeInTheDocument();
  });

  it('verify reports a real failure when the default provider is not authenticated', async () => {
    installAgentDockBridge({
      listProviders: vi.fn().mockResolvedValue([{ ...CLAUDE, authenticated: 'unauthenticated' }, CODEX_NOT_INSTALLED]),
    });
    installWorkspaceBridge({ getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, defaultProvider: 'claude' }) });

    render(<RuntimePage daemonState="ready" />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByText(/is installed but not authenticated/i)).toBeInTheDocument();
    expect(screen.queryByText(/executable detected/i)).not.toBeInTheDocument();
  });

  it('surfaces a provider-listing failure without crashing', async () => {
    installAgentDockBridge({ listProviders: vi.fn().mockRejectedValue(new Error('daemon unreachable')) });
    installWorkspaceBridge();

    render(<RuntimePage daemonState="ready" />);

    await waitFor(() => expect(screen.getByText(/daemon unreachable/i)).toBeInTheDocument());
  });
});
