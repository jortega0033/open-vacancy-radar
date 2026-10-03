import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderCapabilities, ProviderStatus } from '@agent-dock/shared';
import type { DiscoveryVacancyAudit, GlobalRemoteReport } from '@open-vacancy-radar/vacancy-engine';
import { App } from '../src/App.js';
import type { AgentDockBridge, DaemonStatus, VacancyEngineStatus } from '../src/window.js';
import { installVacancyRadarBridge, installWorkspaceBridge } from './workspace-bridge.js';
import type { WorkspaceCounts } from '../src/window.js';

/**
 * This file's own `waitFor`s mount the whole `App` shell and, for most of them, a worldwide report
 * of up to 30 vacancies through the real Search page -- no logic here is slow, but React committing
 * that tree competes with every other test file vitest is running in parallel, and the default
 * `asyncUtilTimeout` (1000ms) has been observed to run out under that contention alone, well before
 * the work itself has actually stalled. Scoped to this file's own module registry (vitest gives each
 * test file a fresh one), so it does not loosen the default anywhere else.
 *
 * Vitest's own per-test timeout (5000ms) has to widen to match, or a `waitFor` using the new budget
 * would just get cut off by the outer test instead.
 */
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 15_000 });

/**
 * One worldwide vacancy, enough to drive the "Generate letter" handoff tests below. Matches
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
    restartDaemon: vi.fn().mockResolvedValue({ state: 'ready' }),
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
  it('gives only Search an edge-to-edge, independently scrolling workspace', async () => {
    installVacancyRadarBridge({
      getStatus: vi.fn().mockResolvedValue({ ready: true } satisfies VacancyEngineStatus),
      getReport: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()])),
    });

    const { container } = render(<App />);
    await waitFor(() => expect(screen.getByLabelText('Vacancy details')).toBeInTheDocument());

    const main = container.querySelector('main');
    const resultsScroller = screen.getByLabelText('Vacancy results');
    const detailScroller = screen.getByLabelText('Vacancy details');
    const workspace = resultsScroller.parentElement?.parentElement;

    expect(main).toHaveClass('overflow-hidden');
    expect(main).not.toHaveClass('px-6');
    expect(workspace).toHaveClass('px-6', 'lg:px-0');
    expect(resultsScroller).toHaveClass('overflow-y-auto');
    expect(detailScroller).toHaveClass('overflow-y-auto');

    fireEvent.click(screen.getByRole('button', { name: 'Saved jobs' }));
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Saved jobs' })).toBeInTheDocument());
    expect(main).toHaveClass('overflow-y-auto', 'px-6');
    expect(main).not.toHaveClass('overflow-hidden');
  });

  describe('Fill search profile (issue #480)', () => {
    async function openSearchProfileFromSearch() {
      installVacancyRadarBridge({
        getStatus: vi.fn().mockResolvedValue({ ready: true } satisfies VacancyEngineStatus),
        getReport: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy({ profileScore: null })])),
      });
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: 'Fill search profile' }));
    }

    it('lands on Settings > Search with the first profile field focused', async () => {
      await openSearchProfileFromSearch();

      await waitFor(() => expect(screen.getByRole('tab', { name: 'Search' })).toHaveAttribute('aria-selected', 'true'));
      await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus());
    });

    it('a plain visit to Settings afterwards starts on General again', async () => {
      await openSearchProfileFromSearch();
      await waitFor(() => expect(screen.getByLabelText('Name')).toHaveFocus());

      fireEvent.click(screen.getByRole('button', { name: 'Search' })); // leave Settings
      fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));

      await waitFor(() => expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true'));
    });
  });

  describe('AI helper unavailable (issue #478)', () => {
    const RAW_ERROR =
      'process exited before starting (code 1, signal null): Error at C:\\Users\\someone\\app\\daemon.js token=abc123secret http://127.0.0.1:54321';

    function installUnavailableBridge(restartDaemon?: AgentDockBridge['restartDaemon']) {
      let statusCallback: ((status: DaemonStatus) => void) | undefined;
      const bridge = installBridge({
        getDaemonStatus: vi.fn().mockResolvedValue({ state: 'connecting' } satisfies DaemonStatus),
        onDaemonStatus: vi.fn((cb) => {
          statusCallback = cb;
          return () => {};
        }),
        ...(restartDaemon ? { restartDaemon } : {}),
      });
      return { bridge, emit: (status: DaemonStatus) => statusCallback?.(status) };
    }

    it('says AI features cannot start in plain language and hides the raw error behind Details', async () => {
      const { emit } = installUnavailableBridge();

      render(<App />);
      expect(screen.getByText('Starting the AI helper…')).toBeInTheDocument();

      emit({ state: 'unavailable', error: RAW_ERROR });

      await waitFor(() => expect(screen.getByText('AI features cannot start.')).toBeInTheDocument());
      expect(screen.getByText(/The AI part of the app did not start\. Your saved data is safe\./)).toBeInTheDocument();
      expect(screen.queryByText(/daemon/i)).not.toBeInTheDocument();

      // The raw text sits inside a closed <details>, so it is not visible, and it is redacted.
      const raw = screen.getByText(/process exited before starting/);
      expect(raw).not.toBeVisible();
      expect(raw.textContent).not.toMatch(/Users|token=abc123|127\.0\.0\.1/);
      fireEvent.click(screen.getByText('Details'));
      expect(raw).toBeVisible();
    });

    it('copies redacted diagnostics', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
      const { emit } = installUnavailableBridge();

      render(<App />);
      emit({ state: 'unavailable', error: RAW_ERROR });
      fireEvent.click(await screen.findByRole('button', { name: 'Copy report' }));

      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      const copied = writeText.mock.calls[0]![0] as string;
      expect(copied).toContain('process exited before starting');
      expect(copied).not.toMatch(/Users|token=abc123|127\.0\.0\.1/);
    });

    it('does not show the red notice on Applications or CV, and the sidebar still reports the problem', async () => {
      const { emit } = installUnavailableBridge();

      render(<App />);
      emit({ state: 'unavailable', error: RAW_ERROR });
      await screen.findByText('AI features cannot start.');

      fireEvent.click(screen.getByRole('button', { name: 'Applications' }));
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Applications' })).toBeInTheDocument());
      expect(screen.queryByText('AI features cannot start.')).not.toBeInTheDocument();
      expect(screen.getByText(/claude code unavailable/i)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'CV' }));
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'CV' })).toBeInTheDocument());
      expect(screen.queryByText('AI features cannot start.')).not.toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Letters' }));
      expect(await screen.findByText('AI features cannot start.')).toBeInTheDocument();
    });

    it('Try again restarts the helper, shows the pending state, and clears the notice on success', async () => {
      let finishRestart!: (status: DaemonStatus) => void;
      const restartDaemon = vi.fn(() => new Promise<DaemonStatus>((resolve) => (finishRestart = resolve)));
      const { emit } = installUnavailableBridge(restartDaemon);

      render(<App />);
      emit({ state: 'unavailable', error: RAW_ERROR });
      fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));

      expect(restartDaemon).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('button', { name: 'Trying again…' })).toBeDisabled();
      // A second click while pending cannot reach the bridge: the button is disabled.
      fireEvent.click(screen.getByRole('button', { name: 'Trying again…' }));
      expect(restartDaemon).toHaveBeenCalledTimes(1);

      finishRestart({ state: 'ready' });
      await waitFor(() => expect(screen.queryByText('AI features cannot start.')).not.toBeInTheDocument());
    });

    it('a failed Try again stays actionable and says so', async () => {
      const restartDaemon = vi
        .fn<AgentDockBridge['restartDaemon']>()
        .mockResolvedValue({ state: 'unavailable', error: 'still broken' });
      const { emit } = installUnavailableBridge(restartDaemon);

      render(<App />);
      emit({ state: 'unavailable', error: RAW_ERROR });
      fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));

      expect(await screen.findByTestId('ai-helper-retry-failed')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
      expect(screen.getByText('still broken')).toBeInTheDocument();
    });
  });

  it('renders the real AI runtime screen: provider cards, not the old session-runner form', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByText(/claude code ready/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'AI runtime' }));

    // "Claude Code" also appears in the sidebar footer and header, so assert on card-specific
    // content instead of the ambiguous name text.
    await waitFor(() => expect(screen.getByText('Sign-in')).toBeInTheDocument());
    expect(screen.getByRole('heading', { level: 1, name: 'AI runtime' })).toBeInTheDocument();
    // The old boilerplate's prompt-runner is gone: no cwd input, no free-text prompt box.
    expect(screen.queryByPlaceholderText('/path/to/project')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /prompt/i })).not.toBeInTheDocument();
  });

  it('hides AI Workspace from the sidebar: no nav entry and no route to AgentWorkspacePage', async () => {
    // Per `.claude/ticket-drafts/draft-agent-workspace-mvp-scope.md`, the product owner decided
    // Agent Workspace is not MVP surface and should be reachable in code but not in the UI ("flag
    // off, don't delete"). `nav.ts`'s `SECONDARY_NAV` is where that's enforced; this asserts the
    // shell actually reflects it, not just that the constant looks right in isolation.
    render(<App />);
    await waitFor(() => expect(screen.getByText(/claude code ready/i)).toBeInTheDocument());

    expect(screen.queryByRole('button', { name: 'AI Workspace' })).not.toBeInTheDocument();
    // The route itself is untouched -- `nav === 'agent-workspace'` in App.tsx still renders
    // `AgentWorkspacePage` -- so this only fails if that conditional or the component were removed,
    // never as a side effect of hiding the sidebar entry.
    expect(screen.queryByRole('heading', { level: 1, name: 'AI Workspace' })).not.toBeInTheDocument();
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
        // This test is about the sidebar's provider label, not first launch: without it the
        // welcome modal would open over the shell here purely because the literal omits the flag.
        welcomeSeen: true,
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

  describe('Search navigation session (issue #324)', () => {
    it('restores filters, page, selection, scroll and report without reloading it', async () => {
      const vacancies = Array.from({ length: 30 }, (_, index) =>
        makeWorldwideVacancy({
          key: `ww-${index}`,
          title: `Frontend Role ${String(index).padStart(2, '0')}`,
          company: index === 29 ? 'Selected Company' : `Company ${index}`,
        }),
      );
      const getReport = vi.fn().mockResolvedValue(makeWorldwideReport(vacancies));
      installVacancyRadarBridge({
        getStatus: vi.fn().mockResolvedValue({ ready: true } satisfies VacancyEngineStatus),
        getReport,
      });

      render(<App />);
      await waitFor(() => expect(screen.getByText('Page 1 of 2')).toBeInTheDocument());

      fireEvent.change(screen.getByRole('searchbox', { name: 'Role or keywords for next scan' }), {
        target: { value: 'Frontend' },
      });
      fireEvent.change(screen.getByRole('combobox', { name: 'Job source' }), {
        target: { value: 'remotive' },
      });
      fireEvent.change(screen.getByRole('combobox', { name: 'Employment type' }), {
        target: { value: 'full_time' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      await waitFor(() => expect(screen.getByText('Page 2 of 2')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: /Frontend Role 29/ }));
      fireEvent.click(screen.getByRole('button', { name: /compare with my cv/i }));
      await waitFor(() => expect(screen.getByText('CV assistant')).toBeInTheDocument());

      const resultsScroller = screen.getByLabelText('Vacancy results');
      Object.defineProperty(resultsScroller, 'scrollTop', { configurable: true, value: 84, writable: true });
      fireEvent.scroll(resultsScroller);
      const detailScroller = screen.getByLabelText('Vacancy details');
      Object.defineProperty(detailScroller, 'scrollTop', { configurable: true, value: 128, writable: true });
      fireEvent.scroll(detailScroller);

      fireEvent.click(screen.getByRole('button', { name: 'Saved jobs' }));
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Saved jobs' })).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));

      await waitFor(() => expect(screen.getByText('Page 2 of 2')).toBeInTheDocument());
      expect(screen.getByRole('searchbox', { name: 'Role or keywords for next scan' })).toHaveValue('Frontend');
      expect(screen.getByRole('combobox', { name: 'Job source' })).toHaveValue('remotive');
      expect(screen.getByRole('combobox', { name: 'Employment type' })).toHaveValue('full_time');
      expect(screen.getByRole('heading', { level: 2, name: 'Frontend Role 29' })).toBeInTheDocument();
      expect(screen.getByLabelText('Vacancy results').scrollTop).toBe(84);
      expect(screen.getByLabelText('Vacancy details').scrollTop).toBe(128);
      expect(screen.getByText('CV assistant')).toBeInTheDocument();
      expect(getReport).toHaveBeenCalledTimes(1);
    });

    it('returns from Letters to the originating vacancy and preserved Search view', async () => {
      const vacancies = Array.from({ length: 30 }, (_, index) =>
        makeWorldwideVacancy({
          key: `ww-${index}`,
          title: `Frontend Role ${String(index).padStart(2, '0')}`,
          company: `Company ${index}`,
        }),
      );
      installVacancyRadarBridge({
        getStatus: vi.fn().mockResolvedValue({ ready: true } satisfies VacancyEngineStatus),
        getReport: vi.fn().mockResolvedValue(makeWorldwideReport(vacancies)),
      });

      render(<App />);
      await waitFor(() => expect(screen.getByText('Page 1 of 2')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      await waitFor(() => expect(screen.getByText('Page 2 of 2')).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: /Frontend Role 29/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Letters' }));

      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Letters' })).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));

      await waitFor(() => expect(screen.getByText('Page 2 of 2')).toBeInTheDocument());
      expect(screen.getByRole('heading', { level: 2, name: 'Frontend Role 29' })).toBeInTheDocument();
    });

    it('starts a new transient session after the App root remounts', async () => {
      const getReport = vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()]));
      installVacancyRadarBridge({
        getStatus: vi.fn().mockResolvedValue({ ready: true } satisfies VacancyEngineStatus),
        getReport,
      });

      const first = render(<App />);
      await waitFor(() => expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0));
      fireEvent.change(screen.getByRole('searchbox', { name: 'Role or keywords for next scan' }), {
        target: { value: 'Remote' },
      });
      expect(screen.getByRole('searchbox', { name: 'Role or keywords for next scan' })).toHaveValue('Remote');
      first.unmount();

      render(<App />);
      await waitFor(() => expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0));
      expect(screen.getByRole('searchbox', { name: 'Role or keywords for next scan' })).toHaveValue('');
      expect(getReport).toHaveBeenCalledTimes(2);
    });

    it('installs a scan that finished while Search was unmounted', async () => {
      const previousReport = makeWorldwideReport([makeWorldwideVacancy({ title: 'Previous Role' })]);
      const nextReport = {
        ...makeWorldwideReport([makeWorldwideVacancy({ title: 'Role Finished While Away' })]),
        runId: 'ww-run-2',
        generatedAt: '2026-08-29T12:00:00.000Z',
      };
      let resolveScan: (report: GlobalRemoteReport) => void = () => {};
      const runScan = vi.fn().mockReturnValue(new Promise<GlobalRemoteReport>((resolve) => {
        resolveScan = resolve;
      }));
      installVacancyRadarBridge({
        getStatus: vi.fn().mockResolvedValue({ ready: true } satisfies VacancyEngineStatus),
        getScanStatus: vi.fn().mockResolvedValue({ scanning: false }),
        getReport: vi.fn().mockResolvedValueOnce(previousReport).mockResolvedValue(nextReport),
        runScan,
      });

      render(<App />);
      await waitFor(() => expect(screen.getAllByText('Previous Role').length).toBeGreaterThan(0));
      fireEvent.change(screen.getByRole('searchbox', { name: 'Role or keywords for next scan' }), {
        target: { value: 'Role' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Run new scan' }));
      await waitFor(() => expect(runScan).toHaveBeenCalledTimes(1));

      fireEvent.click(screen.getByRole('button', { name: 'Saved jobs' }));
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Saved jobs' })).toBeInTheDocument());
      resolveScan(nextReport);
      fireEvent.click(screen.getByRole('button', { name: 'Search' }));

      await waitFor(() => expect(screen.getAllByText('Role Finished While Away').length).toBeGreaterThan(0));
      expect(screen.queryByText('Previous Role')).not.toBeInTheDocument();
    });
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
      fireEvent.click(screen.getByRole('button', { name: 'Saved jobs' }));
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Saved jobs' })).toBeInTheDocument());

      // The subtitle never claims a count it does not have yet.
      expect(screen.getByText('Loading…')).toBeInTheDocument();
      expect(screen.queryByText(/\d+ saved/)).not.toBeInTheDocument();
      // No sidebar badge at all next to "Saved jobs" -- not "0", nothing.
      expect(screen.getByRole('button', { name: 'Saved jobs' }).textContent).toBe('Saved jobs');

      resolveCounts?.({ savedJobs: 3, activeApplications: 0, letters: 0, cvDocuments: 0 });
      await waitFor(() => expect(screen.getByText('3 saved')).toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Saved jobs' }).textContent).toBe('Saved jobs3');
    });

    it('keeps the last successfully loaded counts, rather than resetting to zero, when a later refresh fails', async () => {
      // `mockResolvedValue` (not `Once`): both the mount fetch and the "Saved jobs" click's own
      // re-sync (`handleNavigate` refreshes on every navigation) must see the real value.
      const getCounts = vi.fn().mockResolvedValue({ savedJobs: 5, activeApplications: 0, letters: 0, cvDocuments: 0 });
      installWorkspaceBridge({ getCounts });

      render(<App />);
      fireEvent.click(screen.getByRole('button', { name: 'Saved jobs' }));
      await waitFor(() => expect(screen.getByText('5 saved')).toBeInTheDocument());

      // Every subsequent call (the next navigation's re-sync) fails.
      getCounts.mockRejectedValue(new Error('workspace unavailable'));
      fireEvent.click(screen.getByRole('button', { name: 'Applications' }));
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Applications' })).toBeInTheDocument());
      fireEvent.click(screen.getByRole('button', { name: 'Saved jobs' }));

      // Still 5, not reset to 0 and not "Loading…" again -- the last real value survives a failed refresh.
      await waitFor(() => expect(screen.getByText('5 saved')).toBeInTheDocument());
    });

    it('QA regression: refreshes the "N active" header and sidebar badge right after creating an application, with no navigation', async () => {
      const getCounts = vi
        .fn()
        // Call 1: the initial mount fetch. Call 2: `handleNavigate`'s own re-sync fired by the
        // "Applications" click below -- both still see zero, since nothing has been created yet.
        .mockResolvedValueOnce({ savedJobs: 0, activeApplications: 0, letters: 0, cvDocuments: 0 })
        .mockResolvedValueOnce({ savedJobs: 0, activeApplications: 0, letters: 0, cvDocuments: 0 })
        // Call 3 onward: what the create's own refresh (the fix under test) should see.
        .mockResolvedValue({ savedJobs: 0, activeApplications: 1, letters: 0, cvDocuments: 0 });
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

      fireEvent.click(await screen.findByRole('button', { name: /^add your first application$/i }));
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
  describe('Letters page', () => {
    it('a visit to Letters through the sidebar opens on the Library', async () => {
      render(<App />);
      await waitFor(() => expect(screen.getByText(/find relevant roles/i)).toBeInTheDocument());

      fireEvent.click(screen.getByRole('button', { name: 'Letters' }));
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Letters' })).toBeInTheDocument());
      // Opens on the Library, exactly as an ordinary visit always has.
      expect(screen.getByRole('tab', { name: /library/i })).toHaveAttribute('aria-selected', 'true');

      fireEvent.click(screen.getByRole('tab', { name: /generator/i }));

      expect(await screen.findByRole('combobox', { name: 'Job' })).toHaveValue('manual');
    });
  });

  it('refreshes the saved jobs count after creating a saved job without navigating away', async () => {
    const getCounts = vi.fn().mockResolvedValue({ savedJobs: 0, activeApplications: 0, letters: 0, cvDocuments: 0 });
    const createSavedJob = vi.fn().mockResolvedValue({
      id: 'new-1',
      vacancyKey: null,
      role: 'New Role',
      company: 'New Co',
      location: 'Amsterdam',
      salary: 'EUR 5,000/month',
      arrangement: 'Remote',
      verification: 'Not checked',
      matchPercent: null,
      sourceUrl: null,
      notes: '',
      status: 'considering',
      savedAt: '2026-08-20T10:00:00.000Z',
      gapAnalysis: null,
      gapAnalysisAt: null,
    });
    installWorkspaceBridge({ getCounts, listSavedJobs: vi.fn().mockResolvedValue([]), createSavedJob });

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Saved jobs' }));
    await waitFor(() => expect(screen.getByText(/no saved jobs/i)).toBeInTheDocument());

    const callCountBeforeCreate = getCounts.mock.calls.length;

    // Create a saved job from the drawer.
    fireEvent.click(screen.getByRole('button', { name: /add job manually/i }));
    const dialog = await screen.findByRole('dialog', { name: /add saved job/i });
    fireEvent.change(within(dialog).getByLabelText(/^role$/i), { target: { value: 'New Role' } });
    fireEvent.change(within(dialog).getByLabelText(/^company$/i), { target: { value: 'New Co' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));

    // After creating, getCounts is called again (the onSavedJobsChanged callback fires).
    // This test verifies that creating a saved job triggers a count refresh without navigating.
    await waitFor(() => expect(getCounts.mock.calls.length).toBeGreaterThan(callCountBeforeCreate));
  });
});
