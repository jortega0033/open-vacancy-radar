import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCapabilities, ProviderStatus } from '@agent-dock/shared';
import { App } from '../../../src/App.js';
import { AppSidebar } from '../../../src/components/shell/AppSidebar.js';
import { WorkspaceHeader } from '../../../src/components/shell/WorkspaceHeader.js';
import { EmptyState } from '../../../src/components/shell/EmptyState.js';
import { OpenVacancyRadarMark } from '../../../src/components/brand/OpenVacancyRadarMark.js';
import { headerCopy, isNavPage, NAV_PAGES } from '../../../src/components/shell/nav.js';
import type { AgentDockBridge, DaemonStatus, WorkspaceBridge } from '../../../src/window.js';
import {
  DEFAULT_SETTINGS,
  installVacancyRadarBridge,
  installWorkspaceBridge,
} from '../../workspace-bridge.js';

const CAPABILITIES: ProviderCapabilities = {
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
  capabilities: CAPABILITIES,
};

function installAgentDock(overrides: Partial<AgentDockBridge> = {}): AgentDockBridge {
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

const NOOP = () => {};

beforeEach(() => {
  installAgentDock();
  installVacancyRadarBridge();
  installWorkspaceBridge();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-density');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AppSidebar', () => {
  const BASE = {
    active: 'search' as const,
    onNavigate: NOOP,
    collapsed: false,
    onToggleCollapsed: NOOP,
    counts: { savedJobs: 3, activeApplications: 2, letters: 5 },
    runtimeLabel: 'Claude Code',
    runtimeState: 'ready' as const,
  };

  it('renders all seven destinations as buttons', () => {
    render(<AppSidebar {...BASE} />);
    for (const label of ['Search', 'Saved Jobs', 'Applications', 'CV', 'Letters', 'AI Runtime', 'Settings']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('shows badge counts next to Saved Jobs, Applications and Letters, and only those', () => {
    render(<AppSidebar {...BASE} />);
    expect(screen.getByRole('button', { name: 'Saved Jobs' })).toHaveTextContent('3');
    expect(screen.getByRole('button', { name: 'Applications' })).toHaveTextContent('2');
    expect(screen.getByRole('button', { name: 'Letters' })).toHaveTextContent('5');
    expect(screen.getByRole('button', { name: 'CV' })).toHaveTextContent(/^CV$/);
    expect(screen.getByRole('button', { name: 'Search' })).toHaveTextContent(/^Search$/);
  });

  it('marks the active destination with aria-current, and only that one', () => {
    render(<AppSidebar {...BASE} active="applications" />);
    expect(screen.getByRole('button', { name: 'Applications' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Search' })).not.toHaveAttribute('aria-current');
  });

  it('keeps every destination reachable and named when collapsed, dropping only the visible label', () => {
    render(<AppSidebar {...BASE} collapsed />);
    // The accessible name survives via aria-label, so a collapsed rail is not a screen-reader
    // dead end, but the text (and the badge) is genuinely gone, not just visually hidden.
    expect(screen.getByRole('button', { name: 'Saved Jobs' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Saved Jobs' })).not.toHaveTextContent('3');
    expect(screen.queryByText('Open Vacancy Radar')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Open Vacancy Radar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Saved Jobs' })).toHaveClass('ovr-nav-icon');
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveClass('ovr-nav-icon');
  });

  it('labels the toggle for the action it performs, in both states', () => {
    const { rerender } = render(<AppSidebar {...BASE} />);
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toHaveAttribute('aria-expanded', 'true');

    rerender(<AppSidebar {...BASE} collapsed />);
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('calls onNavigate with the clicked destination id', () => {
    const onNavigate = vi.fn();
    render(<AppSidebar {...BASE} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Letters' }));
    expect(onNavigate).toHaveBeenCalledWith('letters');
  });

  it('shows each runtime state in words, not only in color, and never claims "ready" without one', () => {
    const { rerender } = render(<AppSidebar {...BASE} runtimeState="ready" />);
    expect(screen.getByText(/Claude Code/)).toHaveTextContent('Claude Code ready');

    rerender(<AppSidebar {...BASE} runtimeState="not-installed" />);
    expect(screen.getByText(/Claude Code/)).toHaveTextContent('Claude Code not installed');

    rerender(<AppSidebar {...BASE} runtimeState="not-authenticated" />);
    expect(screen.getByText(/Claude Code/)).toHaveTextContent('Claude Code not authenticated');

    rerender(<AppSidebar {...BASE} runtimeState="unavailable" />);
    expect(screen.getByText(/Claude Code/)).toHaveTextContent('Claude Code unavailable');

    rerender(<AppSidebar {...BASE} runtimeState="connecting" />);
    expect(screen.getByText(/Claude Code/)).toHaveTextContent('Claude Code starting');
  });
});

describe('OpenVacancyRadarMark', () => {
  it('uses currentColor and is decorative unless the caller supplies a label', () => {
    const { rerender } = render(<OpenVacancyRadarMark label="Open Vacancy Radar" />);

    const meaningful = screen.getByRole('img', { name: 'Open Vacancy Radar' });
    expect(meaningful.querySelectorAll('[stroke="currentColor"], [fill="currentColor"]')).toHaveLength(3);
    expect(meaningful).not.toHaveAttribute('aria-hidden');

    rerender(<OpenVacancyRadarMark />);
    expect(screen.queryByRole('img', { name: 'Open Vacancy Radar' })).not.toBeInTheDocument();
    expect(screen.getByTestId('open-vacancy-radar-mark')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('WorkspaceHeader', () => {
  it('shows the page title and contextual subtitle', () => {
    render(<WorkspaceHeader title="Saved Jobs" subtitle="3 saved" />);
    expect(screen.getByRole('heading', { name: 'Saved Jobs' })).toBeInTheDocument();
    expect(screen.getByText('3 saved')).toBeInTheDocument();
  });

  // Runtime status is no longer shown here: it moved entirely to AppSidebar's footer (see below),
  // both to stop duplicating the same fact in two places and because AppSidebar's version can
  // actually distinguish "no CLI installed" from "daemon down", which this component never could.
});

describe('headerCopy', () => {
  it('has copy for every destination', () => {
    for (const page of NAV_PAGES) {
      const copy = headerCopy(page, { savedJobs: 0, activeApplications: 0, letters: 0 });
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.subtitle.length).toBeGreaterThan(0);
    }
  });

  it('folds live counts into the subtitle', () => {
    const counts = { savedJobs: 7, activeApplications: 4, letters: 2 };
    expect(headerCopy('saved', counts).subtitle).toBe('7 saved');
    expect(headerCopy('applications', counts).subtitle).toBe('4 active');
    expect(headerCopy('letters', counts).subtitle).toBe('2 documents');
  });

  it('never names a market the app cannot actually search', () => {
    // The prototype invented seven countries; this app has two real pipelines. Header copy is the
    // most visible surface, so it is the one asserted against that regression.
    const joined = NAV_PAGES.map((page) => {
      const copy = headerCopy(page, { savedJobs: 0, activeApplications: 0, letters: 0 });
      return `${copy.title} ${copy.subtitle}`;
    })
      .join(' ')
      .toLowerCase();
    for (const invented of ['germany', 'belgium', 'france', 'united kingdom']) {
      expect(joined).not.toContain(invented);
    }
  });
});

describe('isNavPage', () => {
  it('accepts the seven destinations and rejects the startPage-only instruction', () => {
    for (const page of NAV_PAGES) expect(isNavPage(page)).toBe(true);
    expect(isNavPage('last_opened')).toBe(false);
    expect(isNavPage('')).toBe(false);
    expect(isNavPage(undefined)).toBe(false);
  });
});

describe('EmptyState', () => {
  it('renders its title and description', () => {
    render(<EmptyState title="Applications: coming next" description="Your pipeline." />);
    expect(screen.getByRole('heading', { name: 'Applications: coming next' })).toBeInTheDocument();
    expect(screen.getByText('Your pipeline.')).toBeInTheDocument();
  });

  it('renders local artwork as a decorative current-color mask', () => {
    render(
      <EmptyState
        illustration="/assets/illustrations/empty-applications.svg"
        title="No applications yet"
      />,
    );

    const illustration = screen.getByTestId('empty-state-illustration');
    expect(illustration).toHaveAttribute('aria-hidden', 'true');
    expect(illustration.getAttribute('style')).toContain('empty-applications.svg');
    expect(illustration.getAttribute('style')).toContain('currentcolor');
  });
});

describe('App shell routing', () => {
  it('opens on Search by default and shows the matching header', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Search Jobs' })).toBeInTheDocument());
    // The sidebar nav button, not SearchFilterBar's own "Search" button (same accessible name).
    expect(screen.getByRole('button', { name: 'Search', current: 'page' })).toHaveAttribute('aria-current', 'page');
  });

  it('switches page and header when a nav item is clicked', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Search Jobs' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Applications' }));

    // The real ApplicationsPage now renders here instead of a placeholder. Its own test suite
    // (test/components/applications/ApplicationsPage.test.tsx) covers its content in depth; this
    // level only needs to prove routing actually switched. Both the WorkspaceHeader's <h1> page
    // title and ApplicationsPage's own <h2> section heading say "Applications", so disambiguate
    // by level rather than asserting on whichever one happens to render first.
    expect(screen.getByRole('heading', { level: 1, name: 'Applications' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Applications' })).toHaveAttribute('aria-current', 'page');
  });

  it('persists the page it navigated to, so a restart can restore it', async () => {
    const bridge = installWorkspaceBridge();
    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Search Jobs' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Letters' }));

    await waitFor(() => expect(bridge.updateSettings).toHaveBeenCalledWith({ lastOpenedPage: 'letters' }));
  });

  it('restores the remembered page on start when startPage is last_opened', async () => {
    installWorkspaceBridge({
      getSettings: vi
        .fn()
        .mockResolvedValue({ ...DEFAULT_SETTINGS, startPage: 'last_opened', lastOpenedPage: 'letters' }),
    });

    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Letters' })).toBeInTheDocument());
  });

  it('honours an explicit start page over the remembered one', async () => {
    installWorkspaceBridge({
      getSettings: vi
        .fn()
        .mockResolvedValue({ ...DEFAULT_SETTINGS, startPage: 'saved', lastOpenedPage: 'letters' }),
    });

    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Saved Jobs' })).toBeInTheDocument());
  });

  it('still opens on a usable page when the workspace database is unavailable', async () => {
    // Losing the remembered sidebar state is an acceptable cost of a broken database. Losing the
    // whole app is not.
    installWorkspaceBridge({
      getSettings: vi.fn().mockRejectedValue(new Error('workspace.db is locked')),
      getCounts: vi.fn().mockRejectedValue(new Error('workspace.db is locked')),
    });

    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Search Jobs' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Saved Jobs' })).toBeInTheDocument();
  });

  it('shows live badge counts from the workspace database', async () => {
    installWorkspaceBridge({
      getCounts: vi.fn().mockResolvedValue({ savedJobs: 12, activeApplications: 4, letters: 9 }),
    });

    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saved Jobs' })).toHaveTextContent('12'));
    expect(screen.getByRole('button', { name: 'Applications' })).toHaveTextContent('4');
    expect(screen.getByRole('button', { name: 'Letters' })).toHaveTextContent('9');
  });
});

describe('App shell sidebar collapse', () => {
  it('collapses and expands, and persists the choice', async () => {
    const bridge: WorkspaceBridge = installWorkspaceBridge();
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));

    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument();
    await waitFor(() => expect(bridge.updateSettings).toHaveBeenCalledWith({ sidebarCollapsed: true }));

    fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    await waitFor(() => expect(bridge.updateSettings).toHaveBeenCalledWith({ sidebarCollapsed: false }));
  });

  it('starts collapsed when the remembered state was collapsed', async () => {
    installWorkspaceBridge({
      getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, sidebarCollapsed: true }),
    });
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument());
  });

  it('lets an explicit sidebarStart preference override the remembered state', async () => {
    installWorkspaceBridge({
      getSettings: vi
        .fn()
        .mockResolvedValue({ ...DEFAULT_SETTINGS, sidebarStart: 'collapsed', sidebarCollapsed: false }),
    });
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument());
  });
});

describe('App shell theme and density', () => {
  it('applies the persisted theme to the document element', async () => {
    installWorkspaceBridge({ getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, theme: 'dark' }) });
    render(<App />);
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'openvacancyradar-dark'));
  });

  it('leaves the attribute off for "system", so prefers-color-scheme decides', async () => {
    installWorkspaceBridge({ getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, theme: 'system' }) });
    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Search Jobs' })).toBeInTheDocument());
    expect(document.documentElement).not.toHaveAttribute('data-theme');
  });

  it('applies compact density as an attribute, and comfortable as its absence', async () => {
    installWorkspaceBridge({ getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, density: 'compact' }) });
    const { unmount } = render(<App />);
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-density', 'compact'));
    unmount();

    installWorkspaceBridge({ getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, density: 'comfortable' }) });
    render(<App />);
    await waitFor(() => expect(document.documentElement).not.toHaveAttribute('data-density'));
  });
});
