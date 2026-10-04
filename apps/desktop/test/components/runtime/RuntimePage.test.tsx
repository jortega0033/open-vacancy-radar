import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    restartDaemon: vi.fn().mockResolvedValue({ state: 'ready' }),
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
  it('shows a status while the AI tools load, then the cards', async () => {
    let resolveProviders: (list: ProviderStatus[]) => void = () => {};
    installAgentDockBridge({
      listProviders: vi.fn().mockReturnValue(new Promise<ProviderStatus[]>((resolve) => (resolveProviders = resolve))),
    });
    installWorkspaceBridge();
    render(<RuntimePage daemonState="ready" />);

    expect(screen.getByRole('status')).toHaveTextContent('Checking your AI tools');
    resolveProviders([CLAUDE, CODEX_NOT_INSTALLED]);
    await waitFor(() => expect(screen.queryByText(/checking your ai tools/i)).not.toBeInTheDocument());
    expect((await screen.findAllByText('Claude Code')).length).toBeGreaterThan(0);
  });

  it('shows the plain-language helper notice instead of any provider content, with the raw error only under Details', () => {
    installAgentDockBridge();
    installWorkspaceBridge();
    const onRetryHelper = vi.fn();
    render(<RuntimePage daemonState="unavailable" daemonError="helper exited" onRetryHelper={onRetryHelper} />);

    expect(screen.getByText('AI features cannot start.')).toBeInTheDocument();
    expect(screen.getByText(/did not start\. Your saved data is safe\./)).toBeInTheDocument();
    expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();
    expect(screen.getByText('helper exited')).not.toBeVisible();
    fireEvent.click(screen.getByText('Details'));
    expect(screen.getByText('helper exited')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetryHelper).toHaveBeenCalledTimes(1);
  });

  it('keeps the notice up and disables Try again while a restart is running', () => {
    installAgentDockBridge();
    installWorkspaceBridge();
    render(<RuntimePage daemonState="connecting" helperRetrying onRetryHelper={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Trying again…' })).toBeDisabled();
  });

  it('says plainly which features always use Claude Code (#546)', async () => {
    installAgentDockBridge();
    installWorkspaceBridge();
    render(<RuntimePage daemonState="ready" />);

    const note = screen.getByTestId('claude-only-features');
    expect(note).toHaveTextContent('Preparing an application and AI web search always use Claude Code.');
    expect(note).toHaveTextContent('Everything else uses the tool you pick here.');
    expect(note.textContent).not.toContain('—');
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument());
  });

  it('renders real provider cards (sign-in, version under Details), not the old prompt runner', async () => {
    installAgentDockBridge();
    installWorkspaceBridge();
    render(<RuntimePage daemonState="ready" />);

    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument());
    // The version sits behind a "Details" disclosure, and the capability chips are gone.
    expect(screen.getByText('2.4.1')).not.toBeVisible();
    expect(screen.getByText('Signed in')).toBeInTheDocument();
    expect(screen.queryByText('Capabilities')).not.toBeInTheDocument();
    expect(screen.queryByText('Resume')).not.toBeInTheDocument();
    expect(screen.queryByText('Tools')).not.toBeInTheDocument();
    expect(screen.queryByText('Installed')).not.toBeInTheDocument();

    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByText('Install Codex, then check again.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Not installed' })).not.toBeInTheDocument();

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
    await waitFor(() => expect(screen.getByRole('button', { name: 'Default' })).toBeInTheDocument()); // Claude starts as default

    fireEvent.click(screen.getByRole('button', { name: 'Use this one' })); // Codex's button

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ defaultProvider: 'codex' }));
    await waitFor(() => expect(onDefaultProviderChanged).toHaveBeenCalledWith('codex'));
  });

  it('hides the picker when only one tool is installed and it is already in use', async () => {
    installAgentDockBridge();
    installWorkspaceBridge({ getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, defaultProvider: 'claude' }) });
    render(<RuntimePage daemonState="ready" />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: 'Use this one' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Default' })).not.toBeInTheDocument();
  });

  it('keeps the advanced check collapsed and plain: no path, version query or model line', async () => {
    installAgentDockBridge();
    installWorkspaceBridge({ getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, defaultProvider: 'claude' }) });
    render(<RuntimePage daemonState="ready" />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument());

    expect(screen.getByText('This check does not use your AI quota.')).not.toBeVisible();
    fireEvent.click(screen.getByText('Advanced check'));
    expect(screen.getByRole('button', { name: 'Check' })).toBeVisible();
    expect(screen.getByText('This check does not use your AI quota.')).toBeVisible();
    expect(screen.queryByText(/CLI default/)).not.toBeInTheDocument();
    expect(screen.queryByText(/AgentDock/)).not.toBeInTheDocument();
  });

  it('verify says the tool is working for the current default provider', async () => {
    installAgentDockBridge();
    installWorkspaceBridge({ getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, defaultProvider: 'claude' }) });

    render(<RuntimePage daemonState="ready" />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Advanced check'));
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));

    expect(await screen.findByText('Claude Code is working.')).toBeInTheDocument();
    expect(screen.queryByText('/usr/local/bin/claude')).not.toBeInTheDocument();
  });

  it('verify reports a real failure when the default provider is not authenticated', async () => {
    installAgentDockBridge({
      listProviders: vi.fn().mockResolvedValue([{ ...CLAUDE, authenticated: 'unauthenticated' }, CODEX_NOT_INSTALLED]),
    });
    installWorkspaceBridge({ getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, defaultProvider: 'claude' }) });

    render(<RuntimePage daemonState="ready" />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Advanced check'));
    fireEvent.click(screen.getByRole('button', { name: 'Check' }));

    expect(await screen.findByText('Claude Code is installed but not signed in. Sign in, then check again.')).toBeInTheDocument();
    expect(screen.queryByText(/is working/i)).not.toBeInTheDocument();
  });

  it('never claims "Default" readiness for a configured default that is not installed', async () => {
    // The persisted default (schema default: 'claude') can point at a CLI that was never
    // installed on this machine, e.g. a fresh Windows Sandbox run. The card must say so plainly
    // instead of the button reading "Default" with a check mark as if the CLI were ready to use.
    installAgentDockBridge({
      listProviders: vi.fn().mockResolvedValue([{ ...CLAUDE, installed: false, authenticated: 'unknown' }, CODEX_NOT_INSTALLED]),
    });
    installWorkspaceBridge({ getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, defaultProvider: 'claude' }) });

    render(<RuntimePage daemonState="ready" />);
    await waitFor(() => expect(screen.getByText('Claude Code')).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: 'Default' })).not.toBeInTheDocument();
    // Still surfaced as the configured default, just not via a button implying it is ready.
    expect(screen.getByText('Default')).toBeInTheDocument();
    // "Claude Code" also appears in the advanced check below the card grid, so scope to the card
    // specifically (the first occurrence, per that DOM order) rather than the ambiguous name text.
    const claudeCard = screen.getAllByText('Claude Code')[0]!.closest('.card');
    expect(claudeCard).not.toBeNull();
    expect(within(claudeCard as HTMLElement).getByText('Install Claude Code, then check again.')).toBeInTheDocument();
    // Nothing is installed, so there is nothing to choose between and no picker.
    expect(within(claudeCard as HTMLElement).queryByRole('button', { name: 'Use this one' })).not.toBeInTheDocument();
  });

  it('names a concrete next step for a CLI that is not installed: official guide link and a copyable command', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    installAgentDockBridge();
    installWorkspaceBridge();
    render(<RuntimePage daemonState="ready" />);

    const panel = await screen.findByTestId('provider-fix-codex');
    const guide = within(panel).getByRole('link', { name: 'Installation guide' });
    expect(guide).toHaveAttribute('href', expect.stringMatching(/^https:\/\//));
    expect(guide).toHaveAttribute('target', '_blank');
    expect(guide).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(panel).getByText('curl -fsSL https://chatgpt.com/codex/install.sh | sh')).not.toBeVisible();
    fireEvent.click(within(panel).getByText('Show install command'));
    expect(within(panel).getByText('curl -fsSL https://chatgpt.com/codex/install.sh | sh')).toBeVisible();

    fireEvent.click(within(panel).getByRole('button', { name: 'Copy install command' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('curl -fsSL https://chatgpt.com/codex/install.sh | sh'));
    expect(await within(panel).findByText('Copied')).toBeInTheDocument();
  });

  it('shows the guide and no guessed command on a platform without a verified one', async () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    installAgentDockBridge(); // Codex is the uninstalled provider and has no verified Windows command
    installWorkspaceBridge();
    render(<RuntimePage daemonState="ready" />);

    const panel = await screen.findByTestId('provider-fix-codex');
    expect(within(panel).getByRole('link', { name: 'Installation guide' })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Copy install command' })).not.toBeInTheDocument();
    expect(within(panel).getByText('Install Codex, then check again.')).toBeInTheDocument();
    expect(within(panel).queryByText('Show install command')).not.toBeInTheDocument();
  });

  it('tells a signed-out CLI to run its login command and offers Copy', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    installAgentDockBridge({
      listProviders: vi.fn().mockResolvedValue([
        { ...CLAUDE, authenticated: 'unauthenticated' },
        { ...CODEX_NOT_INSTALLED, installed: true, authenticated: 'unauthenticated' },
      ]),
    });
    installWorkspaceBridge();
    render(<RuntimePage daemonState="ready" />);

    const claudePanel = await screen.findByTestId('provider-fix-claude');
    expect(claudePanel).toHaveTextContent('Sign in by running claude in a terminal, then check again.');
    expect(screen.getByTestId('provider-fix-codex')).toHaveTextContent('Sign in by running codex login in a terminal, then check again.');

    fireEvent.click(within(claudePanel).getByRole('button', { name: 'Copy sign-in command' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('claude'));
  });

  it('Check again re-reads provider status and reports checking, then still-blocked, then ready', async () => {
    let resolveSecond!: (list: ProviderStatus[]) => void;
    const listProviders = vi
      .fn()
      .mockResolvedValueOnce([CLAUDE, CODEX_NOT_INSTALLED]) // initial load
      .mockResolvedValueOnce([CLAUDE, CODEX_NOT_INSTALLED]) // first check: still missing
      .mockImplementationOnce(() => new Promise<ProviderStatus[]>((resolve) => (resolveSecond = resolve)));
    installAgentDockBridge({ listProviders });
    installWorkspaceBridge();
    render(<RuntimePage daemonState="ready" />);

    const panel = await screen.findByTestId('provider-fix-codex');
    fireEvent.click(within(panel).getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Still not installed.')).toBeInTheDocument();
    expect(listProviders).toHaveBeenCalledTimes(2);

    fireEvent.click(within(screen.getByTestId('provider-fix-codex')).getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Checking…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeDisabled();
    resolveSecond([CLAUDE, { ...CODEX_NOT_INSTALLED, installed: true, authenticated: 'authenticated', version: '1.0.0' }]);
    expect(await screen.findByText('Codex is ready.')).toBeInTheDocument();
    expect(screen.queryByTestId('provider-fix-codex')).not.toBeInTheDocument();
  });

  it('shows a provider error as one plain sentence with the raw text under Details', async () => {
    installAgentDockBridge({
      listProviders: vi.fn().mockResolvedValue([{ ...CLAUDE, error: 'spawn EACCES' }, CODEX_NOT_INSTALLED]),
    });
    installWorkspaceBridge();
    render(<RuntimePage daemonState="ready" />);

    expect(await screen.findByText('Something went wrong checking this tool.')).toBeInTheDocument();
    expect(screen.getByText('spawn EACCES')).not.toBeVisible();
  });

  it('surfaces a provider-listing failure without crashing', async () => {
    installAgentDockBridge({ listProviders: vi.fn().mockRejectedValue(new Error('daemon unreachable')) });
    installWorkspaceBridge();

    render(<RuntimePage daemonState="ready" />);

    expect(await screen.findByText('The AI helper is not responding. Try again in a moment.')).toBeInTheDocument();
    expect(screen.getByText('daemon unreachable')).not.toBeVisible(); // raw text stays under Details
  });
});
