import { StrictMode, useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveryVacancyAudit, GlobalRemoteReport, ScanProgressEvent } from '@open-vacancy-radar/vacancy-engine';
import {
  SearchPage,
  createSearchSessionState,
  type SearchSessionState,
} from '../../../src/components/search/index.js';
import type { SavedJobRecord, VacancyEngineStatus, VacancyRadarBridge } from '../../../src/window.js';
import type { ApplicationPipelineBridge } from '../../../electron/application-pipeline-types.js';
import { installBridges } from '../../cv-bridges.js';
import {
  DEFAULT_CANDIDATE_PROFILE,
  DEFAULT_SETTINGS,
  installVacancyRadarBridge,
  installWorkspaceBridge,
} from '../../workspace-bridge.js';

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

function makeWorldwideReport(
  vacancies: DiscoveryVacancyAudit[],
  discoverySources: GlobalRemoteReport['discoverySources'] = [],
): GlobalRemoteReport {
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
    discoverySources,
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

/**
 * Every bridge the page (and the CV assistant it can open) touches, with the vacancy engine
 * reported ready.
 */
function installAllBridges(overrides: Partial<VacancyRadarBridge> = {}): VacancyRadarBridge {
  installBridges();
  installWorkspaceBridge();
  (window as unknown as { applicationPipeline: ApplicationPipelineBridge }).applicationPipeline = {
    start: vi.fn(),
    startFromVacancy: vi.fn().mockResolvedValue({
      ok: true,
      attemptId: 'attempt-search-1',
      savedJobId: 'saved-search-1',
      created: true,
    }),
    retryTailoring: vi.fn(),
    useOriginalCv: vi.fn(),
    resume: vi.fn(),
  };
  return installVacancyRadarBridge({
    getStatus: vi.fn().mockResolvedValue({ ready: true } satisfies VacancyEngineStatus),
    ...overrides,
  });
}

function enterSearchQuery(value = 'frontend engineer') {
  fireEvent.change(screen.getByRole('searchbox', { name: 'Role or keywords' }), {
    target: { value },
  });
}

function SearchSessionHarness({ initialSession }: { initialSession: SearchSessionState }) {
  const [session, setSession] = useState(initialSession);
  return <SearchPage session={session} onSessionChange={setSession} />;
}

/**
 * A `vacancyRadar` bridge whose `onScanProgress` is a real, minimal pub/sub instead of the default
 * no-op stub: `emit(event)` delivers to every currently-subscribed `SearchPage`, and
 * `listenerCount()`/`unsubscribeFns` let a test assert exactly one live subscription per mount
 * (issue #252's "does not break or duplicate the progress subscription" acceptance criterion).
 */
function installProgressCapturingBridge(overrides: Partial<VacancyRadarBridge> = {}): {
  bridge: VacancyRadarBridge;
  emit: (event: ScanProgressEvent) => void;
  listenerCount: () => number;
  unsubscribeFns: ReturnType<typeof vi.fn>[];
} {
  const listeners: Array<(event: ScanProgressEvent) => void> = [];
  const unsubscribeFns: ReturnType<typeof vi.fn>[] = [];
  const onScanProgress = vi.fn((callback: (event: ScanProgressEvent) => void) => {
    listeners.push(callback);
    const unsubscribe = vi.fn(() => {
      const index = listeners.indexOf(callback);
      if (index >= 0) listeners.splice(index, 1);
    });
    unsubscribeFns.push(unsubscribe);
    return unsubscribe;
  });
  const bridge = installAllBridges({ onScanProgress, ...overrides });
  return {
    bridge,
    emit: (event) => listeners.forEach((listener) => listener(event)),
    listenerCount: () => listeners.length,
    unsubscribeFns,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SearchPage', () => {
  it('restores salary criteria from the shared session and submits them with a scan', async () => {
    const bridge = installAllBridges({
      getReport: vi.fn().mockResolvedValue(null),
      runScan: vi.fn().mockResolvedValue(makeWorldwideReport([])),
    });
    const initialSession = createSearchSessionState();
    initialSession.filters = {
      ...initialSession.filters,
      query: 'frontend engineer',
      salaryMinimum: '60 000',
      salaryCurrency: 'EUR',
      includeUnknownSalary: false,
    };
    initialSession.appliedFilters = { ...initialSession.filters };

    render(<SearchSessionHarness initialSession={initialSession} />);

    expect(screen.getByLabelText('Minimum annual salary')).toHaveValue('60 000');
    expect(screen.getByLabelText('Include vacancies without comparable salary')).not.toBeChecked();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Run scan' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Run scan' }));

    await waitFor(() =>
      expect(bridge.runScan).toHaveBeenCalledWith({
        mode: 'query',
        query: 'frontend engineer',
        salary: { minimumAnnual: '60 000', currency: 'EUR', includeUnknown: false },
      }),
    );
  });

  it('blocks a blank or whitespace-only query before any scan request', async () => {
    const bridge = installAllBridges({ runScan: vi.fn() });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getByText(/no search yet/i)).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'Run scan' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Run the first scan' })).toBeDisabled();
    expect(screen.getByText(/existing reports remain available to browse and filter/i)).toBeInTheDocument();

    enterSearchQuery('   ');
    expect(screen.getByRole('button', { name: 'Run scan' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Run the first scan' })).toBeDisabled();
    expect(bridge.runScan).not.toHaveBeenCalled();
  });

  it('keeps an existing report browseable when the query is cleared', async () => {
    const bridge = installAllBridges({
      getReport: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()])),
      runScan: vi.fn(),
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0));

    enterSearchQuery('   ');
    expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Run new scan' })).toBeDisabled();
    expect(bridge.runScan).not.toHaveBeenCalled();
  });

  it('hydrates the report on mount without starting a scan', async () => {
    const bridge = installAllBridges({
      getReport: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()])),
    });

    render(<SearchPage />);

    await waitFor(() => expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0));
    expect(bridge.getReport).toHaveBeenCalledTimes(1);
    // Viewing a stored report must never cost a live scan.
    expect(bridge.runScan).not.toHaveBeenCalled();
  });

  it('reattaches to a scan already running on mount, instead of looking idle', async () => {
    // Real regression: the Search page's own `scanning` state is component-local, so it used to
    // reset to false every time this page (re)mounted -- including after the user navigated away
    // from Search mid-scan and back. The scan itself runs entirely in the main process and knows
    // nothing about the renderer's page lifecycle, so it kept running regardless; the page just
    // stopped knowing about it, looked idle, and then failed outright with "a vacancy scan is
    // already running" the moment the user clicked Search again.
    const getScanStatus = vi
      .fn()
      .mockResolvedValueOnce({ scanning: true })
      .mockResolvedValueOnce({ scanning: true })
      .mockResolvedValue({ scanning: false });
    const bridge = installAllBridges({
      getReport: vi.fn().mockResolvedValue(null),
      getScanStatus,
    });

    render(<SearchPage />);

    await waitFor(() => expect(screen.getByText(/scanning live sources/i)).toBeInTheDocument());
    // Search itself is blocked while reattached to that scan -- no way to double-trigger it.
    expect(screen.getByRole('button', { name: 'Run scan' })).toBeDisabled();
    expect(bridge.runScan).not.toHaveBeenCalled();

    vi.mocked(bridge.getReport).mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()]));

    await waitFor(() => expect(getScanStatus).toHaveBeenCalledTimes(3), { timeout: 10_000 });
    await waitFor(() => expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0), {
      timeout: 10_000,
    });
    expect(screen.queryByText(/scanning live sources/i)).not.toBeInTheDocument();
  }, 15_000);

  it('a scan-already-running rejection stays in the scanning state instead of reporting itself as a failure', async () => {
    // The narrow race this is a safety net for: the reattachment check above found no scan in
    // flight, the user clicked Search, and it lost a race to a scan that started in between.
    const getScanStatus = vi
      .fn()
      .mockResolvedValueOnce({ scanning: false }) // the mount-time reattachment check
      .mockResolvedValueOnce({ scanning: true }) // still going, once runScan's own poll starts
      .mockResolvedValue({ scanning: false });
    const bridge = installAllBridges({
      getReport: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()])),
      runScan: vi.fn().mockRejectedValue(new Error('a vacancy scan is already running')),
      getScanStatus,
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0));

    enterSearchQuery('Role');
    fireEvent.click(screen.getByRole('button', { name: 'Run new scan' }));

    await waitFor(() => expect(screen.getByText(/scanning live sources/i)).toBeInTheDocument());
    expect(screen.queryByText(/scan failed/i)).not.toBeInTheDocument();

    let resolveFinalReport: (report: GlobalRemoteReport) => void = () => {};
    vi.mocked(bridge.getReport).mockReturnValue(new Promise((resolve) => {
      resolveFinalReport = resolve;
    }));

    await waitFor(() => expect(bridge.getReport).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    expect(screen.getByRole('button', { name: 'Run new scan' })).toBeDisabled();

    resolveFinalReport({
      ...makeWorldwideReport([makeWorldwideVacancy({ title: 'Rescanned Role' })]),
      runId: 'ww-run-2',
      generatedAt: '2026-08-29T12:00:00.000Z',
    });

    await waitFor(() => expect(screen.getAllByText('Rescanned Role').length).toBeGreaterThan(0), { timeout: 10_000 });
    expect(screen.queryByText(/scanning live sources/i)).not.toBeInTheDocument();
  }, 15_000);

  it('reflects a background scan that finished while the window was hidden, once it becomes visible again', async () => {
    // #195: a scan can run and finish entirely while the window is hidden (minimized to tray).
    // The mount-time reattachment effect only reattaches to a scan that is *still* running, so it
    // does nothing here -- this is a genuinely separate code path (a `visibilitychange` listener)
    // that must unconditionally re-fetch the report, not just re-check whether a scan is ongoing.
    const getScanStatus = vi.fn().mockResolvedValue({ scanning: false });
    const bridge = installAllBridges({
      getReport: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()])),
      getReportSummary: vi.fn().mockResolvedValue({ runId: 'ww-run-1', generatedAt: '2026-08-29T11:00:00.000Z', vacancyCount: 1 }),
      getScanStatus,
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0));

    // A background scan completed while hidden: the stored report now has a different result.
    vi.mocked(bridge.getReport).mockResolvedValue(
      makeWorldwideReport([makeWorldwideVacancy({ title: 'Freshly Scanned Role' })]),
    );
    vi.mocked(bridge.getReportSummary).mockResolvedValue({
      runId: 'ww-run-2',
      generatedAt: '2026-08-29T12:00:00.000Z',
      vacancyCount: 1,
    });

    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => expect(screen.getAllByText('Freshly Scanned Role').length).toBeGreaterThan(0));
    // No scan was triggered to get here -- purely a re-fetch of the already-finished report.
    expect(bridge.runScan).not.toHaveBeenCalled();
  });

  it('requires confirmation before a browse-all scan starts', async () => {
    const bridge = installAllBridges({
      runScan: vi.fn().mockResolvedValue(
        makeWorldwideReport([makeWorldwideVacancy()], []),
      ),
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getByText(/no search yet/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Browse all vacancies' }));
    const dialog = screen.getByRole('dialog', { name: /browse all vacancies/i });
    expect(within(dialog).getByText(/capped at 5,000 rows/i)).toBeInTheDocument();
    expect(bridge.runScan).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: /browse all vacancies/i })).not.toBeInTheDocument();
    expect(bridge.runScan).not.toHaveBeenCalled();
  });

  it('runs an explicitly confirmed browse-all scan and renders incomplete cap state', async () => {
    const cappedReport = makeWorldwideReport([makeWorldwideVacancy()], []);
    cappedReport.scanBounds = {
      mode: 'browse_all',
      resultCap: 5_000,
      resultCountBeforeCap: 5_001,
      complete: false,
      completenessReason: 'Browse-all result cap kept 5,000 of 5,001 discovered vacancies.',
    };
    const bridge = installAllBridges({
      runScan: vi.fn().mockResolvedValue(cappedReport),
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getByText(/no search yet/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Browse all vacancies' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Browse all vacancies' }));

    await waitFor(() => expect(bridge.runScan).toHaveBeenCalledWith({ mode: 'browse_all' }));
    expect(await screen.findByText(/kept 5,000 of 5,001/i)).toBeInTheDocument();
    expect(screen.getByText(/browse-all cap 5,000 .* incomplete/i)).toBeInTheDocument();
  });

  it('routes selected country and employment through a focused scan request', async () => {
    const bridge = installAllBridges({
      getReport: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()])),
      runScan: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()])),
    });
    render(<SearchPage />);
    await screen.findByText('Remote Frontend Engineer');

    enterSearchQuery('frontend');
    fireEvent.change(screen.getByRole('combobox', { name: 'Country' }), { target: { value: 'Germany' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Employment type' }), { target: { value: 'full_time' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run new scan' }));

    await waitFor(() => expect(bridge.runScan).toHaveBeenCalledWith({
      mode: 'query', query: 'frontend', country: 'Germany', employment: 'full_time',
    }));
  });

  it('only labels an engine-reported count as matching the focused scan', async () => {
    const legacyReport = makeWorldwideReport([makeWorldwideVacancy()]);
    installAllBridges({ getReport: vi.fn().mockResolvedValue(legacyReport) });

    render(<SearchPage />);
    await screen.findByText('Remote Frontend Engineer');
    expect(screen.queryByText(/matching the focused scan/i)).not.toBeInTheDocument();
  });

  it('does not show a focused count for a browse-all report even when legacy data contains one', async () => {
    const report = makeWorldwideReport([makeWorldwideVacancy()]);
    report.scanBounds = { mode: 'browse_all', resultCap: 5_000, resultCountBeforeCap: 1, complete: true, completenessReason: null };
    report.statistics.focusedMatches = 1;
    installAllBridges({ getReport: vi.fn().mockResolvedValue(report) });

    render(<SearchPage />);
    await screen.findByText('Remote Frontend Engineer');
    expect(screen.queryByText(/matching the focused scan/i)).not.toBeInTheDocument();
  });

  it('renders raw and focused counts supplied by the engine', async () => {
    const report = makeWorldwideReport([makeWorldwideVacancy()]);
    report.statistics.rawRowsFetched = 12;
    report.statistics.focusedMatches = 3;
    installAllBridges({ getReport: vi.fn().mockResolvedValue(report) });

    render(<SearchPage />);
    expect(await screen.findByText(/12 raw rows fetched, 1 deduplicated vacancies, 3 matching the focused scan/i)).toBeInTheDocument();
  });

  it('does not re-fetch a large report when the window returns visible and no new report exists', async () => {
    const report = makeWorldwideReport([makeWorldwideVacancy()]);
    const getReport = vi.fn().mockResolvedValue(report);
    installAllBridges({
      getReport,
      getReportSummary: vi.fn().mockResolvedValue({ runId: report.runId, generatedAt: report.generatedAt, vacancyCount: 1 }),
      getScanStatus: vi.fn().mockResolvedValue({ scanning: false }),
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0));

    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => expect(getReport).toHaveBeenCalledTimes(1));
  });

  it('keeps showing vacancies when the candidate profile has no targets configured', async () => {
    const onOpenSearchProfile = vi.fn();
    installAllBridges({
      getReport: vi
        .fn()
        .mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy({ profileScore: null })])),
    });

    render(<SearchPage onOpenSearchProfile={onOpenSearchProfile} />);

    await waitFor(() => expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0));
    expect(screen.getByText(/vacancies were found, but none were scored/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fill search profile' }));
    expect(onOpenSearchProfile).toHaveBeenCalledTimes(1);
  });

  it('explains when a saved profile exists but the loaded report is still unscored', async () => {
    const rescored = makeWorldwideReport([makeWorldwideVacancy({ profileScore: 82 })]);
    const bridge = installAllBridges({
      getReport: vi
        .fn()
        .mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy({ profileScore: null })])),
      getSearchProfile: vi.fn().mockResolvedValue({
        ...DEFAULT_CANDIDATE_PROFILE,
        targetRoles: ['Frontend Engineer'],
      }),
      runScan: vi.fn().mockResolvedValue(rescored),
    });

    render(<SearchPage />);

    await waitFor(() => expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByText(/search profile is saved, but this report was generated before it could be scored/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Fill search profile' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Rescan and score' }));

    await waitFor(() => expect(bridge.runScan).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(/generated before it could be scored/i)).not.toBeInTheDocument());
    expect(screen.getAllByText('82').length).toBeGreaterThan(0);
  });

  it('keeps unscored-report guidance when the current search profile cannot be loaded', async () => {
    installAllBridges({
      getReport: vi
        .fn()
        .mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy({ profileScore: null })])),
      getSearchProfile: vi.fn().mockRejectedValue(new Error('profile read failed')),
    });

    render(<SearchPage />);

    await waitFor(() => expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0));
    await waitFor(() =>
      expect(screen.getByText(/could not check whether the current search profile can score this report/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/profile read failed/i)).toBeInTheDocument();
  });

  it('seeds the country filter from the persisted default search location on first load', async () => {
    installBridges();
    installWorkspaceBridge({
      getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, defaultLocation: 'Germany' }),
    });
    installVacancyRadarBridge({
      getStatus: vi.fn().mockResolvedValue({ ready: true } satisfies VacancyEngineStatus),
      getReport: vi.fn().mockResolvedValue(
        makeWorldwideReport([
          makeWorldwideVacancy({ key: 'de-1', title: 'Backend Engineer', location: 'Munich, Germany', profileScore: 80 }),
          makeWorldwideVacancy({ key: 'us-1', title: 'Frontend Engineer', location: 'Austin, United States', profileScore: 80 }),
        ]),
      ),
    });

    render(<SearchPage />);

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Country' })).toHaveValue('Germany'));
    await waitFor(() => expect(screen.getAllByText('Backend Engineer').length).toBeGreaterThan(0));
    expect(screen.queryByText('Frontend Engineer')).not.toBeInTheDocument();
  });

  it('merges delayed default-location hydration without clobbering edits already made', async () => {
    let resolveSettings: (settings: typeof DEFAULT_SETTINGS) => void = () => {};
    installBridges();
    installWorkspaceBridge({
      getSettings: vi.fn().mockReturnValue(new Promise((resolve) => {
        resolveSettings = resolve;
      })),
    });
    installVacancyRadarBridge({
      getStatus: vi.fn().mockResolvedValue({ ready: true } satisfies VacancyEngineStatus),
      getReport: vi.fn().mockResolvedValue(
        makeWorldwideReport([
          makeWorldwideVacancy({ title: 'Remote Engineer', location: 'Berlin, Germany' }),
        ]),
      ),
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getAllByText('Remote Engineer').length).toBeGreaterThan(0));
    enterSearchQuery('Remote');
    resolveSettings({ ...DEFAULT_SETTINGS, defaultLocation: 'Germany' });

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Country' })).toHaveValue('Germany'));
    expect(screen.getByRole('searchbox', { name: 'Role or keywords' })).toHaveValue('Remote');
    expect(screen.getAllByText('Remote Engineer').length).toBeGreaterThan(0);
  });

  it('still completes a scan after React StrictMode replays effect cleanup', async () => {
    installAllBridges({
      runScan: vi.fn().mockResolvedValue(
        makeWorldwideReport([makeWorldwideVacancy({ title: 'Strict Mode Role' })]),
      ),
    });

    render(
      <StrictMode>
        <SearchPage />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByText(/no search yet/i)).toBeInTheDocument());
    enterSearchQuery('Strict');
    fireEvent.click(screen.getByRole('button', { name: 'Run the first scan' }));

    await waitFor(() => expect(screen.getAllByText('Strict Mode Role').length).toBeGreaterThan(0));
  });

  it('clicking Run new scan refreshes external sources while a report is already loaded', async () => {
    const bridge = installAllBridges({
      getReport: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()])),
      runScan: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy({ title: 'Rescanned Role' })])),
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0));

    enterSearchQuery('Role');
    fireEvent.click(screen.getByRole('button', { name: 'Run new scan' }));

    await waitFor(() => expect(bridge.runScan).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByText('Rescanned Role').length).toBeGreaterThan(0));
  });

  it('does not start a fresh scan when Enter is pressed against an already-loaded report', async () => {
    const bridge = installAllBridges({
      getReport: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()])),
      runScan: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()])),
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0));

    enterSearchQuery('Remote');
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Role or keywords' }), {
      key: 'Enter',
      code: 'Enter',
    });
    expect(bridge.runScan).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Run new scan' }));
    await waitFor(() => expect(bridge.runScan).toHaveBeenCalledTimes(1));
  });

  it('keeps the applied report stable while editing a draft query', async () => {
    const bothVacancies = makeWorldwideReport([
      makeWorldwideVacancy(),
      makeWorldwideVacancy({ key: 'ww-2', provider: 'dice', title: 'Frontend Developer', company: 'Freeday' }),
    ]);
    const bridge = installAllBridges({
      getReport: vi.fn().mockResolvedValue(bothVacancies),
      runScan: vi.fn().mockResolvedValue(bothVacancies),
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Frontend Developer').length).toBeGreaterThan(0);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Role or keywords' }), {
      target: { value: 'Remote' },
    });

    expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Frontend Developer').length).toBeGreaterThan(0);
    expect(bridge.runScan).not.toHaveBeenCalled();
  });

  it('applies secondary filters locally without starting a fresh scan', async () => {
    const bothVacancies = makeWorldwideReport([
      makeWorldwideVacancy(),
      makeWorldwideVacancy({ key: 'ww-2', provider: 'dice', title: 'Dice Frontend Role' }),
    ]);
    const bridge = installAllBridges({
      getReport: vi.fn().mockResolvedValue(bothVacancies),
      runScan: vi.fn().mockResolvedValue(bothVacancies),
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Dice Frontend Role').length).toBeGreaterThan(0);

    const resultsScroller = screen.getByLabelText('Vacancy results');
    Object.defineProperty(resultsScroller, 'scrollTop', { configurable: true, value: 84, writable: true });
    fireEvent.scroll(resultsScroller);

    fireEvent.change(screen.getByRole('combobox', { name: 'Job source' }), {
      target: { value: 'dice' },
    });

    await waitFor(() => expect(screen.queryByText('Remote Frontend Engineer')).not.toBeInTheDocument());
    expect(screen.getAllByText('Dice Frontend Role').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Vacancy results').scrollTop).toBe(0);
    expect(bridge.runScan).not.toHaveBeenCalled();
  });

  it('forwards the typed role/keyword to the scan itself, not just the local filter', async () => {
    const bridge = installAllBridges({
      getReport: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()])),
      runScan: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()])),
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0));

    fireEvent.change(screen.getByRole('searchbox', { name: 'Role or keywords' }), {
      target: { value: 'backend engineer' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run new scan' }));

    await waitFor(() => expect(bridge.runScan).toHaveBeenCalledWith({ mode: 'query', query: 'backend engineer' }));
  });

  it('Clear filters applies immediately, with no separate Search click needed', async () => {
    const bothVacancies = makeWorldwideReport([
      makeWorldwideVacancy(),
      makeWorldwideVacancy({ key: 'ww-2', provider: 'dice', title: 'Frontend Developer', company: 'Freeday' }),
    ]);
    installAllBridges({
      getReport: vi.fn().mockResolvedValue(bothVacancies),
      runScan: vi.fn().mockResolvedValue(bothVacancies),
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0));

    fireEvent.change(screen.getByRole('combobox', { name: 'Job source' }), {
      target: { value: 'remotive' },
    });
    await waitFor(() => expect(screen.queryByText('Frontend Developer')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(screen.getAllByText('Frontend Developer').length).toBeGreaterThan(0);
    expect(screen.getByRole('searchbox', { name: 'Role or keywords' })).toHaveValue('');
  });

  it('paginates the results list instead of rendering every row at once', async () => {
    const manyVacancies = Array.from({ length: 20_000 }, (_, index) =>
      makeWorldwideVacancy({ key: `ww-${index}`, title: `Frontend Role ${index}` }),
    );
    installAllBridges({
      getReport: vi.fn().mockResolvedValue(makeWorldwideReport(manyVacancies)),
    });

    render(<SearchPage />);

    await waitFor(() => expect(screen.getByText(/^20000 vacancies/)).toBeInTheDocument(), { timeout: 5_000 });
    expect(screen.getByText('Page 1 of 800')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Frontend Role \d+/ })).toHaveLength(25);
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => expect(screen.getByText('Page 2 of 800')).toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: /Frontend Role \d+/ })).toHaveLength(25);
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it('opens on the page containing a preferred selected vacancy', async () => {
    const manyVacancies = Array.from({ length: 30 }, (_, index) =>
      makeWorldwideVacancy({
        key: `ww-${index}`,
        title: index === 29 ? 'Z Frontend Role 29' : `A Frontend Role ${String(index).padStart(2, '0')}`,
      }),
    );
    installAllBridges({
      getReport: vi.fn().mockResolvedValue(makeWorldwideReport(manyVacancies)),
    });

    render(<SearchPage preferredSelectedKey="ww-29" />);

    await waitFor(() => expect(screen.getByText('Page 2 of 2')).toBeInTheDocument());
    expect(screen.getAllByText('Z Frontend Role 29').length).toBeGreaterThan(0);
  });

  it('clamps a stale page and selects the first vacancy on the surviving page', async () => {
    const vacancies = Array.from({ length: 30 }, (_, index) =>
      makeWorldwideVacancy({
        key: `ww-${index}`,
        title: `Frontend Role ${String(index).padStart(2, '0')}`,
      }),
    );
    const getReport = vi.fn();
    installAllBridges({ getReport });
    const initialSession: SearchSessionState = {
      ...createSearchSessionState(),
      report: makeWorldwideReport(vacancies),
      reportHydrated: true,
      settingsHydrated: true,
      selectedKey: 'removed-vacancy',
      page: 99,
      listScrollTop: 88,
      detailScrollTop: 144,
    };

    render(<SearchSessionHarness initialSession={initialSession} />);

    await waitFor(() => expect(screen.getByText('Page 2 of 2')).toBeInTheDocument());
    expect(screen.getByRole('heading', { level: 2, name: 'Frontend Role 25' })).toBeInTheDocument();
    expect(screen.getByLabelText('Vacancy results').scrollTop).toBe(0);
    expect(screen.getByLabelText('Vacancy details').scrollTop).toBe(0);
    expect(getReport).not.toHaveBeenCalled();
  });

  it('surfaces partial worldwide source health and snapshot age', async () => {
    const warning =
      'stale parsed snapshot reused from 2026-08-30T10:00:00.000Z after rate_limited_status';
    installAllBridges({
      getReport: vi.fn().mockResolvedValue(
        makeWorldwideReport([makeWorldwideVacancy()], [
          {
            id: 'workable_global:all-customers',
            provider: 'workable_global',
            url: 'https://www.workable.com/boards/workable.xml',
            requests: 1,
            listings: 1,
            status: 'partial',
            error: warning,
            networkAttempts: 1,
            retries: 0,
            complete: false,
            completenessReason: warning,
            continuationCursor: null,
          },
        ]),
      ),
    });

    render(<SearchPage />);

    await waitFor(() => expect(screen.getByText(/source coverage warning/i)).toBeInTheDocument());
    // Collapsed by default; the detail line only appears once the toggle is opened. The provider id
    // renders through `discoveryProviderLabel` ("Workable"), not the raw "workable_global" id.
    expect(screen.queryByText(`Workable: ${warning}`)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /source coverage warning/i }));
    expect(screen.getByText(`Workable: ${warning}`)).toBeInTheDocument();
  });

  it('reports the missing verification as absent for a vacancy with no sponsor match', async () => {
    installAllBridges({
      getReport: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()])),
    });

    render(<SearchPage />);

    await waitFor(() => expect(screen.getAllByText('Not available for this vacancy').length).toBeGreaterThan(0));
    expect(screen.getByText(/employer verification is not available for this vacancy/i)).toBeInTheDocument();

    expect(screen.queryByText(/recognised sponsor/i)).not.toBeInTheDocument();
  });

  it('shows a best-effort possible sponsor match for a matched vacancy', async () => {
    installAllBridges({
      getReport: vi.fn().mockResolvedValue(
        makeWorldwideReport([
          makeWorldwideVacancy({
            location: 'Amsterdam, Netherlands',
            worldwideSponsorMatch: { legalName: 'Acme Technologies B.V.', kvkNumber: '01234567' },
          }),
        ]),
      ),
    });

    render(<SearchPage />);

    await waitFor(() => expect(screen.getAllByText(/possible sponsor match/i).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/Acme Technologies B\.V\./).length).toBeGreaterThan(0);
  });

  it('runs the scan from the empty state and shows a real loading state', async () => {
    let resolveScan: (report: GlobalRemoteReport) => void = () => {};
    const scanPromise = new Promise<GlobalRemoteReport>((resolve) => {
      resolveScan = resolve;
    });
    const bridge = installAllBridges({ runScan: vi.fn().mockReturnValue(scanPromise) });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getByText(/no search yet/i)).toBeInTheDocument());

    enterSearchQuery('Frontend');
    fireEvent.click(screen.getByRole('button', { name: 'Run the first scan' }));

    await waitFor(() => expect(screen.getByText(/scanning live sources/i)).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /run the first scan/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/no search yet/i)).not.toBeInTheDocument();

    resolveScan(makeWorldwideReport([makeWorldwideVacancy({ title: 'Frontend Developer' })]));

    await waitFor(() => expect(screen.getAllByText('Frontend Developer').length).toBeGreaterThan(0));
    expect(screen.queryByText(/scanning live sources/i)).not.toBeInTheDocument();
    expect(bridge.runScan).toHaveBeenCalledTimes(1);
  });

  describe('progressive search results (issue #252)', () => {
    it('shows a vacancy pushed via vacancy:scan-progress before the scan promise resolves, and the final report replaces it exactly', async () => {
      let resolveScan: (report: GlobalRemoteReport) => void = () => {};
      const scanPromise = new Promise<GlobalRemoteReport>((resolve) => {
        resolveScan = resolve;
      });
      const { emit } = installProgressCapturingBridge({ runScan: vi.fn().mockReturnValue(scanPromise) });

      render(<SearchPage />);
      await waitFor(() => expect(screen.getByText(/no search yet/i)).toBeInTheDocument());

      enterSearchQuery('Frontend');
      fireEvent.click(screen.getByRole('button', { name: 'Run the first scan' }));
      await waitFor(() => expect(screen.getByText(/scanning live sources/i)).toBeInTheDocument());

      // Provably before `runScan`'s own promise resolves: nothing has resolved it yet.
      emit({
        sourceId: 'himalayas',
        vacancies: [makeWorldwideVacancy({ key: 'streamed-1', title: 'Streamed Frontend Role', profileScore: null })],
      });

      await waitFor(() => expect(screen.getAllByText('Streamed Frontend Role').length).toBeGreaterThan(0));
      // Honest "not yet scored" state, not a real-looking match percentage.
      expect(screen.getByText(/showing vacancies as each source finishes/i)).toBeInTheDocument();

      resolveScan(makeWorldwideReport([makeWorldwideVacancy({ title: 'Frontend Developer' })]));

      await waitFor(() => expect(screen.getAllByText('Frontend Developer').length).toBeGreaterThan(0));
      // The final, non-streaming list is exactly what loaded -- no partial-only row survives.
      expect(screen.queryByText('Streamed Frontend Role')).not.toBeInTheDocument();
      expect(screen.queryByText(/showing vacancies as each source finishes/i)).not.toBeInTheDocument();
    });

    it('subscribes exactly once per mount and unsubscribes on unmount, so navigating away and back never duplicates the listener', async () => {
      const { bridge, listenerCount, unsubscribeFns } = installProgressCapturingBridge();

      const { unmount } = render(<SearchPage />);
      await waitFor(() => expect(bridge.onScanProgress).toHaveBeenCalledTimes(1));
      expect(listenerCount()).toBe(1);

      unmount();
      expect(unsubscribeFns[0]).toHaveBeenCalledTimes(1);
      expect(listenerCount()).toBe(0);

      // Navigate back: a second mount subscribes its own listener, never stacking onto the first.
      render(<SearchPage />);
      await waitFor(() => expect(bridge.onScanProgress).toHaveBeenCalledTimes(2));
      expect(listenerCount()).toBe(1);
    });

    it('reattaching to a scan already in flight also picks up its next progress event, not just its eventual completion', async () => {
      const getScanStatus = vi.fn().mockResolvedValue({ scanning: true });
      const { emit } = installProgressCapturingBridge({ getReport: vi.fn().mockResolvedValue(null), getScanStatus });

      render(<SearchPage />);
      await waitFor(() => expect(screen.getByText(/scanning live sources/i)).toBeInTheDocument());

      emit({
        sourceId: 'jobicy',
        vacancies: [makeWorldwideVacancy({ key: 'reattached-1', title: 'Reattached Streamed Role' })],
      });

      await waitFor(() => expect(screen.getAllByText('Reattached Streamed Role').length).toBeGreaterThan(0));
    });

    it('keeps the saved report visible during a rescan and reports incoming live progress separately', async () => {
      const scanPromise = new Promise<GlobalRemoteReport>(() => {}); // never resolves in this test
      const { emit } = installProgressCapturingBridge({
        getReport: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy({ title: 'Existing Role' })])),
        runScan: vi.fn().mockReturnValue(scanPromise),
      });

      render(<SearchPage />);
      await waitFor(() => expect(screen.getAllByText('Existing Role').length).toBeGreaterThan(0));

      enterSearchQuery('Role');
      fireEvent.click(screen.getByRole('button', { name: 'Run new scan' }));
      await waitFor(() => expect(screen.getByText(/scanning live sources/i)).toBeInTheDocument());

      emit({
        sourceId: 'himalayas',
        vacancies: [makeWorldwideVacancy({ key: 'mid-rescan-1', title: 'Mid Rescan Streamed Role' })],
      });

      // The existing (real, already-scored) report keeps showing rather than being pre-empted by an
      // honest-but-unscored partial row -- streaming only fills the "nothing loaded at all yet" gap.
      await waitFor(() => expect(screen.getAllByText('Existing Role').length).toBeGreaterThan(0));
      expect(screen.getByText(/1 live vacancy has arrived so far/i)).toBeInTheDocument();
      expect(screen.queryByText('Mid Rescan Streamed Role')).not.toBeInTheDocument();
    });
  });

  it('surfaces a scan failure without losing the page', async () => {
    installAllBridges({ runScan: vi.fn().mockRejectedValue(new Error('network unreachable')) });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getByText(/no search yet/i)).toBeInTheDocument());

    enterSearchQuery();
    fireEvent.click(screen.getByRole('button', { name: 'Run the first scan' }));

    await waitFor(() => expect(screen.getByText(/scan failed: network unreachable/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Run the first scan' })).toBeEnabled();
  });

  it('keeps the existing report, selection, page and scroll after a rescan fails', async () => {
    const vacancies = Array.from({ length: 30 }, (_, index) =>
      makeWorldwideVacancy({
        key: `ww-${index}`,
        title: `Frontend Role ${String(index).padStart(2, '0')}`,
      }),
    );
    installAllBridges({
      getReport: vi.fn().mockResolvedValue(makeWorldwideReport(vacancies)),
      runScan: vi.fn().mockRejectedValue(new Error('network unreachable')),
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getByText('Page 1 of 2')).toBeInTheDocument());
    enterSearchQuery('Frontend');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByText('Page 2 of 2')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Frontend Role 29/ }));

    const listScroller = screen.getByLabelText('Vacancy results');
    Object.defineProperty(listScroller, 'scrollTop', { configurable: true, value: 84, writable: true });
    fireEvent.scroll(listScroller);
    const detailScroller = screen.getByLabelText('Vacancy details');
    Object.defineProperty(detailScroller, 'scrollTop', { configurable: true, value: 128, writable: true });
    fireEvent.scroll(detailScroller);

    fireEvent.click(screen.getByRole('button', { name: 'Run new scan' }));

    await waitFor(() => expect(screen.getByText(/scan failed: network unreachable/i)).toBeInTheDocument());
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Frontend Role 29' })).toBeInTheDocument();
    expect(screen.getByLabelText('Vacancy results').scrollTop).toBe(84);
    expect(screen.getByLabelText('Vacancy details').scrollTop).toBe(128);
  });

  it('does not resurrect scan-start filters when Clear filters is clicked during the scan', async () => {
    let resolveScan: (report: GlobalRemoteReport) => void = () => {};
    const scanPromise = new Promise<GlobalRemoteReport>((resolve) => {
      resolveScan = resolve;
    });
    installAllBridges({
      getReport: vi.fn().mockResolvedValue(
        makeWorldwideReport([makeWorldwideVacancy({ title: 'Previous Frontend Role' })]),
      ),
      runScan: vi.fn().mockReturnValue(scanPromise),
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getAllByText('Previous Frontend Role').length).toBeGreaterThan(0));
    enterSearchQuery('Frontend');
    fireEvent.click(screen.getByRole('button', { name: 'Run new scan' }));
    await waitFor(() => expect(screen.getByText(/scanning live sources/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    resolveScan({
      ...makeWorldwideReport([makeWorldwideVacancy({ title: 'Backend Role' })]),
      runId: 'ww-run-2',
      generatedAt: '2026-08-29T12:00:00.000Z',
    });

    await waitFor(() => expect(screen.getAllByText('Backend Role').length).toBeGreaterThan(0));
    expect(screen.getByRole('searchbox', { name: 'Role or keywords' })).toHaveValue('');
  });

  it('a scan-failure Retry button re-runs the scan and clears the error on success', async () => {
    const runScan = vi
      .fn()
      .mockRejectedValueOnce(new Error('network unreachable'))
      .mockResolvedValueOnce(makeWorldwideReport([makeWorldwideVacancy()]));
    installAllBridges({ runScan });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getByText(/no search yet/i)).toBeInTheDocument());
    enterSearchQuery();
    fireEvent.click(screen.getByRole('button', { name: 'Run the first scan' }));
    await waitFor(() => expect(screen.getByText(/scan failed: network unreachable/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(runScan).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/scan failed/i)).not.toBeInTheDocument());
    expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0);
  });

  it('a report-load-failure Retry button re-attempts hydration', async () => {
    const getReport = vi
      .fn()
      .mockRejectedValueOnce(new Error('workspace database is locked'))
      .mockResolvedValueOnce(makeWorldwideReport([makeWorldwideVacancy()]));
    installAllBridges({ getReport });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getByText('workspace database is locked')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(getReport).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0));
    expect(screen.queryByText('workspace database is locked')).not.toBeInTheDocument();
  });

  it('an engine-unavailable Retry button rechecks status and recovers once the engine reports ready', async () => {
    const getStatus = vi
      .fn()
      .mockResolvedValueOnce({ ready: false, error: 'engine binary missing' } satisfies VacancyEngineStatus)
      .mockResolvedValueOnce({ ready: true } satisfies VacancyEngineStatus);
    installAllBridges({ getStatus });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getByText(/vacancy engine unavailable: engine binary missing/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText(/vacancy engine unavailable/i)).not.toBeInTheDocument(),
    );
  });

  it('saves the selected vacancy through the workspace IPC', async () => {
    installAllBridges({
      getReport: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()])),
    });
    const created: SavedJobRecord = {
      id: 'saved-1',
      vacancyKey: 'ww-1',
      role: 'Remote Frontend Engineer',
      company: 'Acme Corp',
      location: 'Worldwide',
      salary: 'from USD 120,000/yr',
      arrangement: null,
      verification: 'Not available for this vacancy',
      matchPercent: null,
      sourceUrl: 'https://example.invalid/jobs/ww-1',
      notes: '',
      status: 'considering',
      savedAt: '2026-08-29T12:00:00.000Z',
      gapAnalysis: null,
      gapAnalysisAt: null,
    };
    const workspace = installWorkspaceBridge({ createSavedJob: vi.fn().mockResolvedValue(created) });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save job' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Saved' })).toBeInTheDocument());
    expect(workspace.createSavedJob).toHaveBeenCalledWith({
      role: 'Remote Frontend Engineer',
      company: 'Acme Corp',
      location: 'Worldwide',
      vacancyKey: 'ww-1',
      salary: 'from USD 120,000/yr',
      verification: 'Not available for this vacancy',
      matchPercent: 75,
      sourceUrl: 'https://example.invalid/jobs/ww-1',
      status: 'considering',
    });
  });

  it('starts preparation directly from Search and opens the resolved attempt', async () => {
    installAllBridges({
      getReport: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()])),
    });
    const pipeline = window.applicationPipeline;
    const onViewApplicationAttempt = vi.fn();

    render(<SearchPage onViewApplicationAttempt={onViewApplicationAttempt} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare application' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Prepare application' }));

    await waitFor(() => expect(pipeline.startFromVacancy).toHaveBeenCalledWith('ww-1'));
    await waitFor(() => expect(onViewApplicationAttempt).toHaveBeenCalledWith('attempt-search-1'));
    expect(screen.getByRole('button', { name: 'Saved' })).toBeInTheDocument();
  });

  it('reports a failed save on the vacancy rather than silently doing nothing', async () => {
    installAllBridges({
      getReport: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()])),
    });
    installWorkspaceBridge({ createSavedJob: vi.fn().mockRejectedValue(new Error('workspace database is locked')) });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save job' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));

    await waitFor(() => expect(screen.getByText(/workspace database is locked/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Save job' })).toBeEnabled();
  });

  it('clicking "Generate Letter" hands the selected vacancy off as a SelectedVacancy, unchanged by any AI logic', async () => {
    const onGenerateLetter = vi.fn();
    installAllBridges({
      getReport: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()])),
    });

    render(<SearchPage onGenerateLetter={onGenerateLetter} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate Letter' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Generate Letter' }));

    expect(onGenerateLetter).toHaveBeenCalledTimes(1);
    expect(onGenerateLetter).toHaveBeenCalledWith({
      title: 'Remote Frontend Engineer',
      company: 'Acme Corp',
      location: 'Worldwide',
      url: 'https://example.invalid/jobs/ww-1',
      employmentType: 'full_time',
      currency: 'USD',
      salaryPeriod: 'year',
      advertisedMinimum: 120_000,
      key: 'ww-1',
    });
  });

  it('shows the salary evidence provider and source key separately from the result provider', async () => {
    installAllBridges({
      getReport: vi.fn().mockResolvedValue(
        makeWorldwideReport([
          makeWorldwideVacancy({
            provider: 'workable_global',
            salaryProvider: 'himalayas',
            salarySourceKey: 'himalayas:salary-copy',
            salarySourceUrl: 'https://example.invalid/himalayas/salary-copy',
            salaryProvenance: 'reviewed_structured',
            normalizedAnnualMinimum: 120_000,
            normalizedCurrency: 'USD',
            normalizationMethod: 'advertised_annual',
          }),
        ]),
      ),
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Remote Frontend Engineer' })).toBeInTheDocument());
    expect(screen.getByText('Himalayas (himalayas:salary-copy)')).toBeInTheDocument();
  });

  it('"Generate Letter" is a harmless no-op when the page is used standalone, with no handler wired', async () => {
    installAllBridges({
      getReport: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()])),
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Generate Letter' })).toBeInTheDocument());

    expect(() => fireEvent.click(screen.getByRole('button', { name: 'Generate Letter' }))).not.toThrow();
  });

  it('opens the CV assistant on demand for the selected vacancy', async () => {
    installAllBridges({
      getReport: vi.fn().mockResolvedValue(
        makeWorldwideReport([
          makeWorldwideVacancy(),
          makeWorldwideVacancy({ key: 'ww-2', title: 'Frontend Developer', company: 'Freeday', profileScore: 40 }),
        ]),
      ),
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: /analyse against my cv/i })).toBeInTheDocument());

    // The assistant is an affordance, not something mounted for every row up front.
    expect(screen.queryByText('CV assistant')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Frontend Developer'));
    fireEvent.click(screen.getByRole('button', { name: /analyse against my cv/i }));

    await waitFor(() => expect(screen.getByText('CV assistant')).toBeInTheDocument());
    // It receives the row the user picked, not the first one in the report.
    expect(screen.getByText(/freeday, worldwide/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /hide ai assistant/i })).toBeInTheDocument();
  });
});
