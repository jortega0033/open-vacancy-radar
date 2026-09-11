import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCapabilities, ProviderStatus } from '@agent-dock/shared';
import type { DiscoveryVacancyAudit, GlobalRemoteReport } from '@open-vacancy-radar/vacancy-engine';
import { App } from '../src/App.js';
import type { AgentDockBridge, DaemonStatus, VacancyEngineStatus } from '../src/window.js';
import { installVacancyRadarBridge, installWorkspaceBridge } from './workspace-bridge.js';
import type { WorkspaceCounts } from '../src/window.js';

/**
 * One worldwide vacancy, enough to drive the "Generate Letter" handoff tests below. Matches
 * `test/components/search/SearchPage.test.tsx`'s own fixtures, trimmed to the one row these tests
 * need.
 */
function makeWorldwideVacancy(overrides: Partial<DiscoveryVacancyAudit> = {}): DiscoveryVacancyAudit {
  return {
    key: 'ww-1',
    provider: 'remotive',
    company: 'Acme Corp',
    title: 'Remote Frontend Engineer',
    url: 'https://example.invalid/jobs/ww-1',
    location: 'Worldwide',
    employmentType: 'full_time',
    currency: 'USD',
    salaryPeriod: 'year',
    advertisedMinimum: 120_000,
    annualizedMinimumUsd: 120_000,
    decision: 'official_review_candidate',
    reasons: ['Explicit frontend role'],
    contentHash: 'hash-ww-1',
    description: 'Join our fully-remote engineering team building the next generation of tooling.',
    postedAt: null,
    profileScore: 75,
    worldwideSponsorMatch: null,
    ...overrides,
  };
}

function makeWorldwideReport(vacancies: DiscoveryVacancyAudit[]): GlobalRemoteReport {
  return {
    runId: 'ww-run-1',
    generatedAt: '2026-08-29T11:00:00.000Z',
    profileVersion: 'global-remote-profile-v1',
    criteria: {
      role: 'frontend',
      fullyRemote: true,
      applicantLocation: 'anywhere-outside-us-nl',
      usCitizenshipRequired: false,
      minimumAnnualBaseUsd: 100_000,
      currency: 'USD',
    },
    statistics: {
      discoveryRequests: 1,
      discoveryListings: vacancies.length,
      discoveryUniqueListings: vacancies.length,
      discoveryOfficialReviewCandidates: vacancies.length,
      officialBoardsOrPagesAttempted: 0,
      officialRequests: 0,
      strictMatches: 0,
      manualReview: 0,
      nearMisses: 0,
      excludedOrInactive: 0,
      blockedOrErrored: 0,
      registrySources: 0,
      activeRegistrySources: 0,
      gatedRegistrySources: 0,
      manualOrProhibitedRegistrySources: 0,
    },
    sourceRegistry: [],
    discoverySources: [],
    strictMatches: [],
    manualReview: [],
    nearMisses: [],
    excludedOrInactive: [],
    blockedOrErrored: [],
    officialAudit: [],
    discoveryAudit: vacancies,
    methodology: [],
    attribution: [],
  };
}

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
        defaultLocation: '',
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

  /**
   * Issue #178: before this fix, `counts` defaulted to a zeroed `WorkspaceCounts`, so "not loaded
   * yet" and "genuinely zero" rendered identically -- a "0" badge, a "0 saved" subtitle. Neither
   * test below waits for the badge/subtitle to *appear*; that would trivially pass against the old
   * behavior too. They assert on the state *before* the count is known, and after a load that fails.
   */
  describe('sidebar badge counts (issue #178)', () => {
    it('shows no numeric badge and a loading subtitle before the first getCounts() resolves', async () => {
      let resolveCounts: ((counts: WorkspaceCounts) => void) | undefined;
      installWorkspaceBridge({
        getCounts: vi.fn(
          () =>
            new Promise<WorkspaceCounts>((resolve) => {
              resolveCounts = resolve;
            }),
        ),
      });

      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: 'Saved Jobs' }));
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Saved Jobs' })).toBeInTheDocument());

      // The subtitle never claims a count it does not have yet.
      expect(screen.getByText('Loading…')).toBeInTheDocument();
      expect(screen.queryByText(/\d+ saved/)).not.toBeInTheDocument();
      // No sidebar badge at all next to "Saved Jobs" -- not "0", nothing.
      expect(screen.getByRole('button', { name: 'Saved Jobs' }).textContent).toBe('Saved Jobs');

      resolveCounts?.({ savedJobs: 3, activeApplications: 0, letters: 0 });
      await waitFor(() => expect(screen.getByText('3 saved')).toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Saved Jobs' }).textContent).toBe('Saved Jobs3');
    });

    it('keeps the last successfully loaded counts, rather than resetting to zero, when a later refresh fails', async () => {
      // `mockResolvedValue` (not `Once`): both the mount fetch and the "Saved Jobs" click's own
      // re-sync (`handleNavigate` refreshes on every navigation) must see the real value.
      const getCounts = vi.fn().mockResolvedValue({ savedJobs: 5, activeApplications: 0, letters: 0 });
      installWorkspaceBridge({ getCounts });

      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: 'Saved Jobs' }));
      await waitFor(() => expect(screen.getByText('5 saved')).toBeInTheDocument());

      // Every subsequent call (the next navigation's re-sync) fails.
      getCounts.mockRejectedValue(new Error('workspace unavailable'));
      fireEvent.click(screen.getByRole('button', { name: 'Applications' }));
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Applications' })).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Saved Jobs' }));

      // Still 5, not reset to 0 and not "Loading…" again -- the last real value survives a failed refresh.
      await waitFor(() => expect(screen.getByText('5 saved')).toBeInTheDocument());
    });

    it('QA regression: refreshes the "N active" header and sidebar badge right after creating an application, with no navigation', async () => {
      const getCounts = vi
        .fn()
        // Call 1: the initial mount fetch. Call 2: `handleNavigate`'s own re-sync fired by the
        // "Applications" click below -- both still see zero, since nothing has been created yet.
        .mockResolvedValueOnce({ savedJobs: 0, activeApplications: 0, letters: 0 })
        .mockResolvedValueOnce({ savedJobs: 0, activeApplications: 0, letters: 0 })
        // Call 3 onward: what the create's own refresh (the fix under test) should see.
        .mockResolvedValue({ savedJobs: 0, activeApplications: 1, letters: 0 });
      const createApplication = vi.fn().mockResolvedValue({
        id: 'app-1',
        savedJobId: null,
        role: 'New Role',
        company: 'New Co',
        location: null,
        verification: null,
        status: 'applied',
        appliedAt: null,
        nextStep: null,
        contact: null,
        cvId: null,
        letterId: null,
        notes: '',
        archived: false,
      });
      installWorkspaceBridge({ getCounts, listApplications: vi.fn().mockResolvedValue([]), createApplication });

      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: 'Applications' }));
      await waitFor(() => expect(screen.getByText('0 active')).toBeInTheDocument());
      // `handleNavigate`'s own re-sync already called `getCounts` once more on the way in; let that
      // settle on the stale "0 active" value before the create below, so the assertion further down
      // is actually exercising the create's own refresh rather than riding that earlier call.
      await waitFor(() => expect(getCounts).toHaveBeenCalledTimes(2));

      fireEvent.click(screen.getByRole('button', { name: /^add application$/i }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText('Role *'), { target: { value: 'New Role' } });
      fireEvent.change(within(dialog).getByLabelText('Company *'), { target: { value: 'New Co' } });
      fireEvent.click(within(dialog).getByRole('button', { name: /create application/i }));

      await waitFor(() => expect(createApplication).toHaveBeenCalledTimes(1));
      // The fix: this refresh happens from the create itself, with no click on the sidebar and no
      // leaving the Applications page in between.
      await waitFor(() => expect(screen.getByText('1 active')).toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Applications' }).textContent).toBe('Applications1');
    });
  });

  /**
   * ADI-06 wired the shell itself; these cover the Search -> Letters live-vacancy handoff (the one
   * piece of cross-page state App.tsx now carries -- see `pendingVacancy`).
   */
  describe('Search -> Letters vacancy handoff', () => {
    it('clicking "Generate Letter" on the vacancy detail navigates to Letters with that vacancy pre-selected, no manual retyping', async () => {
      installVacancyRadarBridge({
        getStatus: vi.fn().mockResolvedValue({ ready: true } satisfies VacancyEngineStatus),
        getReport: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()])),
      });

      render(<App />);
      await waitFor(() => expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0));

      fireEvent.click(screen.getByRole('button', { name: 'Generate Letter' }));

      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Letters' })).toBeInTheDocument());
      expect(screen.getByRole('tab', { name: /generator/i })).toHaveAttribute('aria-selected', 'true');
      // "Live" job source, pre-selected on the handed-off vacancy -- LetterGenerator received it.
      expect(await screen.findByRole('combobox', { name: 'Job' })).toHaveValue('live');
      expect(screen.getByText('Remote Frontend Engineer')).toBeInTheDocument();
    });

    it('a manual visit to Letters through the sidebar shows no vacancy pre-selected', async () => {
      render(<App />);
      await waitFor(() => expect(screen.getByText(/find relevant roles/i)).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Letters' }));
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Letters' })).toBeInTheDocument());
      // Opens on the Library, exactly as an ordinary visit always has.
      expect(screen.getByRole('tab', { name: /library/i })).toHaveAttribute('aria-selected', 'true');

      fireEvent.click(screen.getByRole('tab', { name: /generator/i }));

      expect(await screen.findByRole('combobox', { name: 'Job' })).toHaveValue('manual');
    });

    it('the handoff does not persist: leaving Letters and returning through the sidebar no longer replays the handed-off vacancy', async () => {
      installVacancyRadarBridge({
        getStatus: vi.fn().mockResolvedValue({ ready: true } satisfies VacancyEngineStatus),
        getReport: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()])),
      });

      render(<App />);
      await waitFor(() => expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0));
      fireEvent.click(screen.getByRole('button', { name: 'Generate Letter' }));
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Letters' })).toBeInTheDocument());
      expect(await screen.findByRole('combobox', { name: 'Job' })).toHaveValue('live');

      // Leave Letters for an unrelated page, then come back through the sidebar -- an ordinary,
      // non-handoff visit.
      fireEvent.click(screen.getByRole('button', { name: 'Saved Jobs' }));
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Saved Jobs' })).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Letters' }));
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Letters' })).toBeInTheDocument());
      expect(screen.getByRole('tab', { name: /library/i })).toHaveAttribute('aria-selected', 'true');

      fireEvent.click(screen.getByRole('tab', { name: /generator/i }));

      expect(await screen.findByRole('combobox', { name: 'Job' })).toHaveValue('manual');
    });
  });
});
