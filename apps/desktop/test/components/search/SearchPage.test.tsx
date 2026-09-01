import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DiscoveryVacancyAudit,
  GlobalRemoteReport,
  JobRadarReport,
  ReportVacancy,
} from '@open-vacancy-radar/vacancy-engine';
import { SearchPage } from '../../../src/components/search/index.js';
import type { SavedJobRecord, VacancyEngineStatus, VacancyRadarBridge } from '../../../src/window.js';
import { installBridges } from '../../cv-bridges.js';
import { DEFAULT_SETTINGS, installVacancyRadarBridge, installWorkspaceBridge } from '../../workspace-bridge.js';

function makeNetherlandsVacancy(overrides: Partial<ReportVacancy> = {}): ReportVacancy {
  return {
    id: 'nl-1',
    title: 'Senior Frontend Architect',
    description: 'Lead the frontend architecture for our flagship product.',
    company: 'Redwood Software',
    location: 'Amsterdam',
    remote: false,
    workplaceMode: 'hybrid',
    provider: 'greenhouse',
    url: 'https://example.invalid/jobs/nl-1',
    score: 99,
    technicalFit: 30,
    roleFit: 25,
    seniorityFit: 18,
    languageFit: 14,
    locationFit: 12,
    dutchRequired: false,
    dutchPreferred: false,
    languageEvidence: ['English-language posting'],
    primaryFit: 'frontend architect',
    matchingSkills: ['Angular', 'TypeScript'],
    gaps: ['No design-system experience stated'],
    reasons: ['Explicit frontend role'],
    sponsorLegalNames: ['Redwood Software Netherlands B.V.'],
    mappingConfidence: 'high',
    firstSeenAt: '2026-08-01T09:00:00.000Z',
    lastSeenAt: '2026-08-28T09:00:00.000Z',
    postedAt: '2026-08-20T09:00:00.000Z',
    verifiedInRun: true,
    sourceOutcomeStatus: 'succeeded',
    ...overrides,
  };
}

function makeNetherlandsReport(
  vacancies: ReportVacancy[],
  overrides: Partial<JobRadarReport> = {},
): JobRadarReport {
  return {
    runId: 'nl-run-1',
    scanStatus: 'succeeded',
    generatedAt: '2026-08-29T10:00:00.000Z',
    candidateProfileVersion: 'candidate-profile-v1',
    profileConfigured: true,
    indVerificationEnabled: true,
    deterministicScoringVersion: 'deterministic-relevance-v11',
    freshnessPolicy: { maximumPostingAgeDays: 30, cutoff: '2026-07-30T10:00:00.000Z' },
    officialSponsorSource: {
      url: 'https://ind.nl/public-register-recognised-sponsors',
      lastUpdated: '2026-08-25T00:00:00.000Z',
      retrievedAt: '2026-08-29T09:00:00.000Z',
    },
    statistics: {
      sponsorsLoaded: 12_933,
      activeSponsors: 12_933,
      companiesMapped: 799,
      careerSourcesDiscovered: 120,
      careerSourcesScanned: 118,
      incompleteSources: 0,
      blockedSources: 0,
      manualReviewSources: 0,
      unsupportedSources: 2,
      vacanciesDiscovered: vacancies.length,
      vacanciesNew: vacancies.length,
      vacanciesChanged: 0,
      vacanciesInactive: 0,
      staleVacanciesExcluded: 0,
      duplicateVacanciesCollapsed: 0,
      deterministicCandidates: vacancies.length,
      semanticScored: 0,
      relevantVacancies: vacancies.length,
      excellentMatches: vacancies.length,
      errorCount: 0,
      requestCount: 118,
      durationMs: 1234,
    },
    vacancies,
    ...overrides,
  };
}

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
 * reported ready. The interesting failure modes here are report-shaped, not engine-shaped.
 *
 * Most tests below exercise the Netherlands pipeline specifically and never touch the market
 * tabs, so the persisted setting here is pinned to 'netherlands' rather than left at
 * `installBridges()`'s own 'worldwide' default — a test-fixture choice, not a claim about what
 * the app should default to for a real user.
 */
function installAllBridges(overrides: Partial<VacancyRadarBridge> = {}): VacancyRadarBridge {
  installBridges();
  installWorkspaceBridge({ getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, defaultMarket: 'netherlands' }) });
  return installVacancyRadarBridge({
    getStatus: vi.fn().mockResolvedValue({ ready: true } satisfies VacancyEngineStatus),
    ...overrides,
  });
}

// The Market selector was folded into the Country dropdown: picking "Netherlands" switches to
// that pipeline, anything else (here, "All countries") switches to (or stays on) worldwide.
function switchMarket(value: 'netherlands' | 'worldwide') {
  fireEvent.change(screen.getByLabelText('Country'), {
    target: { value: value === 'netherlands' ? 'Netherlands' : 'all' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SearchPage', () => {
  it('hydrates the Netherlands report on mount without starting a scan', async () => {
    const bridge = installAllBridges({
      getNetherlandsReport: vi.fn().mockResolvedValue(makeNetherlandsReport([makeNetherlandsVacancy()])),
    });

    render(<SearchPage />);

    await waitFor(() => expect(screen.getAllByText('Senior Frontend Architect').length).toBeGreaterThan(0));
    expect(bridge.getNetherlandsReport).toHaveBeenCalledTimes(1);
    // Viewing a stored report must never cost a live scan of either pipeline.
    expect(bridge.runNetherlandsScan).not.toHaveBeenCalled();
    expect(bridge.runScan).not.toHaveBeenCalled();
    expect(bridge.getReport).not.toHaveBeenCalled();
  });

  it('shows a distinct empty state when the candidate profile has no targets configured', async () => {
    installAllBridges({
      getNetherlandsReport: vi.fn().mockResolvedValue(
        makeNetherlandsReport([makeNetherlandsVacancy()], { profileConfigured: false }),
      ),
    });

    render(<SearchPage />);

    await waitFor(() => expect(screen.getByText("Your search profile isn't set up yet")).toBeInTheDocument());
    expect(screen.queryByText('Senior Frontend Architect')).not.toBeInTheDocument();
  });

  it('switches to the worldwide pipeline report when the market changes', async () => {
    const bridge = installAllBridges({
      getNetherlandsReport: vi.fn().mockResolvedValue(makeNetherlandsReport([makeNetherlandsVacancy()])),
      getReport: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()])),
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getAllByText('Senior Frontend Architect').length).toBeGreaterThan(0));

    switchMarket('worldwide');

    await waitFor(() => expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0));
    expect(bridge.getReport).toHaveBeenCalledTimes(1);
    expect(bridge.runScan).not.toHaveBeenCalled();
    expect(screen.queryByText('Senior Frontend Architect')).not.toBeInTheDocument();
  });

  it('shows the free-text City or region box only for Netherlands; the unified Country dropdown handles worldwide instead', async () => {
    installAllBridges({
      getNetherlandsReport: vi.fn().mockResolvedValue(makeNetherlandsReport([makeNetherlandsVacancy()])),
      getReport: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()])),
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getAllByText('Senior Frontend Architect').length).toBeGreaterThan(0));
    expect(screen.getByRole('textbox', { name: 'City or region' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Country' })).toHaveValue('Netherlands');

    switchMarket('worldwide');

    await waitFor(() => expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0));
    // Worldwide's own structured Country filter replaces it -- two controls for the same job
    // (a free-text box and a full country list) was the actual complaint.
    expect(screen.queryByRole('textbox', { name: 'City or region' })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Country' })).toHaveValue('all');
  });

  it('there is no separate Market selector any more: picking a specific country while on Netherlands switches straight to worldwide filtered to it', async () => {
    const bridge = installAllBridges({
      getNetherlandsReport: vi.fn().mockResolvedValue(makeNetherlandsReport([makeNetherlandsVacancy()])),
      getReport: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy({ location: 'Berlin, Germany' })])),
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getAllByText('Senior Frontend Architect').length).toBeGreaterThan(0));
    expect(screen.queryByRole('combobox', { name: 'Market' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Country' }), { target: { value: 'Germany' } });

    await waitFor(() => expect(bridge.getReport).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('combobox', { name: 'Country' })).toHaveValue('Germany');
    await waitFor(() => expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0));
  });

  it('seeds the country filter from the persisted default search location on first load', async () => {
    installBridges();
    installWorkspaceBridge({
      getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, defaultMarket: 'worldwide', defaultLocation: 'Germany' }),
    });
    installVacancyRadarBridge({
      getStatus: vi.fn().mockResolvedValue({ ready: true } satisfies VacancyEngineStatus),
      getReport: vi.fn().mockResolvedValue(
        makeWorldwideReport([
          makeWorldwideVacancy({ key: 'de-1', title: 'Backend Engineer', location: 'Munich, Germany' }),
          makeWorldwideVacancy({ key: 'us-1', title: 'Frontend Engineer', location: 'Austin, United States' }),
        ]),
      ),
    });

    render(<SearchPage />);

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Country' })).toHaveValue('Germany'));
    await waitFor(() => expect(screen.getAllByText('Backend Engineer').length).toBeGreaterThan(0));
    expect(screen.queryByText('Frontend Engineer')).not.toBeInTheDocument();
  });

  it('clicking Search always runs a fresh scan, even with a report already loaded (no separate dead "Search" vs. "Rescan" split)', async () => {
    const bridge = installAllBridges({
      getNetherlandsReport: vi.fn().mockResolvedValue(makeNetherlandsReport([makeNetherlandsVacancy()])),
      runNetherlandsScan: vi.fn().mockResolvedValue(
        makeNetherlandsReport([makeNetherlandsVacancy({ title: 'Rescanned Role' })]),
      ),
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getAllByText('Senior Frontend Architect').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => expect(bridge.runNetherlandsScan).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByText('Rescanned Role').length).toBeGreaterThan(0));
  });

  it('does not filter the list while typing; only applies once Search is clicked', async () => {
    const bothVacancies = makeNetherlandsReport([
      makeNetherlandsVacancy(),
      makeNetherlandsVacancy({ id: 'nl-2', title: 'Frontend Developer', company: 'Freeday' }),
    ]);
    installAllBridges({
      getNetherlandsReport: vi.fn().mockResolvedValue(bothVacancies),
      runNetherlandsScan: vi.fn().mockResolvedValue(bothVacancies),
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getAllByText('Senior Frontend Architect').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Frontend Developer').length).toBeGreaterThan(0);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Role or keywords' }), {
      target: { value: 'Architect' },
    });

    // Still both rows: typing alone must not narrow the list.
    expect(screen.getAllByText('Senior Frontend Architect').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Frontend Developer').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => expect(screen.queryByText('Frontend Developer')).not.toBeInTheDocument());
    expect(screen.getAllByText('Senior Frontend Architect').length).toBeGreaterThan(0);
  });

  it('forwards the typed role/keyword to the worldwide scan itself, not just the local filter', async () => {
    const bridge = installAllBridges({
      getNetherlandsReport: vi.fn().mockResolvedValue(makeNetherlandsReport([makeNetherlandsVacancy()])),
      getReport: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()])),
      runScan: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()])),
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getAllByText('Senior Frontend Architect').length).toBeGreaterThan(0));
    switchMarket('worldwide');
    await waitFor(() => expect(screen.getAllByText('Remote Frontend Engineer').length).toBeGreaterThan(0));

    fireEvent.change(screen.getByRole('searchbox', { name: 'Role or keywords' }), {
      target: { value: 'backend engineer' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => expect(bridge.runScan).toHaveBeenCalledWith('backend engineer'));
  });

  it('Clear filters applies immediately, with no separate Search click needed', async () => {
    const bothVacancies = makeNetherlandsReport([
      makeNetherlandsVacancy(),
      makeNetherlandsVacancy({ id: 'nl-2', title: 'Frontend Developer', company: 'Freeday' }),
    ]);
    installAllBridges({
      getNetherlandsReport: vi.fn().mockResolvedValue(bothVacancies),
      runNetherlandsScan: vi.fn().mockResolvedValue(bothVacancies),
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getAllByText('Senior Frontend Architect').length).toBeGreaterThan(0));

    fireEvent.change(screen.getByRole('searchbox', { name: 'Role or keywords' }), {
      target: { value: 'Architect' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(screen.queryByText('Frontend Developer')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(screen.getAllByText('Frontend Developer').length).toBeGreaterThan(0);
    expect(screen.getByRole('searchbox', { name: 'Role or keywords' })).toHaveValue('');
  });

  it('paginates the results list instead of rendering every row at once', async () => {
    const manyVacancies = Array.from({ length: 30 }, (_, index) =>
      makeNetherlandsVacancy({ id: `nl-${index}`, title: `Frontend Role ${index}` }),
    );
    installAllBridges({
      getNetherlandsReport: vi.fn().mockResolvedValue(makeNetherlandsReport(manyVacancies)),
    });

    render(<SearchPage />);

    // Scoped to `getAllByRole('button', ...)`, not `getAllByText`: the detail pane's own <h2>
    // repeats whichever row is selected, which would otherwise double-count that one row.
    await waitFor(() => expect(screen.getByText(/^30 vacancies/)).toBeInTheDocument());
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Frontend Role \d+/ })).toHaveLength(25);
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => expect(screen.getByText('Page 2 of 2')).toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: /Frontend Role \d+/ })).toHaveLength(5);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
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
          },
        ]),
      ),
    });

    render(<SearchPage />);
    switchMarket('worldwide');

    await waitFor(() => expect(screen.getByText(/source coverage warning/i)).toBeInTheDocument());
    // Collapsed by default; the detail line only appears once the toggle is opened.
    expect(screen.queryByText(`workable_global: ${warning}`)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /source coverage warning/i }));
    expect(screen.getByText(`workable_global: ${warning}`)).toBeInTheDocument();
  });

  it('shows the real IND sponsor verification for a Netherlands vacancy', async () => {
    installAllBridges({
      getNetherlandsReport: vi.fn().mockResolvedValue(makeNetherlandsReport([makeNetherlandsVacancy()])),
    });

    render(<SearchPage />);

    await waitFor(() => expect(screen.getAllByText('Recognised sponsor').length).toBeGreaterThan(0));
    expect(screen.getAllByText(/Redwood Software Netherlands B\.V\./).length).toBeGreaterThan(0);
    expect(screen.getByText(/matched with high confidence/i)).toBeInTheDocument();
  });

  it('shows verification as turned off, not as an unresolved sponsor match, when IND verification is disabled', async () => {
    installAllBridges({
      getNetherlandsReport: vi.fn().mockResolvedValue(
        makeNetherlandsReport([makeNetherlandsVacancy()], { indVerificationEnabled: false }),
      ),
    });

    render(<SearchPage />);

    await waitFor(() => expect(screen.getAllByText('Verification turned off').length).toBeGreaterThan(0));
    // The honest "we did not check" copy, never the "we checked and found nothing" wording that a
    // genuinely unresolved sponsor match gets.
    expect(screen.queryByText('Sponsor entity not resolved')).not.toBeInTheDocument();
    expect(screen.getAllByText(/turned off in Settings/i).length).toBeGreaterThan(0);
  });

  it('reports the missing worldwide verification as absent, never as an IND-style outcome', async () => {
    installAllBridges({
      getReport: vi.fn().mockResolvedValue(makeWorldwideReport([makeWorldwideVacancy()])),
    });

    render(<SearchPage />);
    switchMarket('worldwide');

    await waitFor(() => expect(screen.getAllByText('Not available for this market').length).toBeGreaterThan(0));
    expect(
      screen.getByText(/employer verification is not available for worldwide \/ remote/i),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/nothing was verified about this employer/i).length).toBeGreaterThan(0);

    // None of the Netherlands verification vocabulary may leak into a market that runs no check.
    expect(screen.queryByText(/recognised sponsor/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/possible sponsor match/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sponsor entity not resolved/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not a recognised sponsor/i)).not.toBeInTheDocument();
  });

  it('runs the market scan from the empty state and shows a real loading state', async () => {
    let resolveScan: (report: JobRadarReport) => void = () => {};
    const scanPromise = new Promise<JobRadarReport>((resolve) => {
      resolveScan = resolve;
    });
    const bridge = installAllBridges({ runNetherlandsScan: vi.fn().mockReturnValue(scanPromise) });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getByText(/no search yet/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Run the first scan' }));

    await waitFor(() => expect(screen.getByText(/scanning live netherlands sources/i)).toBeInTheDocument());
    // The "No search yet" empty state (with its now-stale CTA) is replaced by a loading skeleton
    // while the scan is in flight, not left frozen underneath the scanning banner.
    expect(screen.queryByRole('button', { name: /run the first scan/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/no search yet/i)).not.toBeInTheDocument();

    resolveScan(makeNetherlandsReport([makeNetherlandsVacancy({ title: 'Frontend Developer' })]));

    await waitFor(() => expect(screen.getAllByText('Frontend Developer').length).toBeGreaterThan(0));
    expect(screen.queryByText(/scanning live netherlands sources/i)).not.toBeInTheDocument();
    expect(bridge.runNetherlandsScan).toHaveBeenCalledTimes(1);
    // The worldwide pipeline must not be touched by a Netherlands scan.
    expect(bridge.runScan).not.toHaveBeenCalled();
  });

  it('surfaces a scan failure without losing the page', async () => {
    installAllBridges({ runNetherlandsScan: vi.fn().mockRejectedValue(new Error('network unreachable')) });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getByText(/no search yet/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Run the first scan' }));

    await waitFor(() => expect(screen.getByText(/scan failed: network unreachable/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Run the first scan' })).toBeEnabled();
  });

  it('a scan-failure Retry button re-runs the scan and clears the error on success', async () => {
    const runNetherlandsScan = vi
      .fn()
      .mockRejectedValueOnce(new Error('network unreachable'))
      .mockResolvedValueOnce(makeNetherlandsReport([makeNetherlandsVacancy()]));
    installAllBridges({ runNetherlandsScan });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getByText(/no search yet/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Run the first scan' }));
    await waitFor(() => expect(screen.getByText(/scan failed: network unreachable/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(runNetherlandsScan).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/scan failed/i)).not.toBeInTheDocument());
    expect(screen.getAllByText('Senior Frontend Architect').length).toBeGreaterThan(0);
  });

  it('a report-load-failure Retry button re-attempts hydration for the current market', async () => {
    const getNetherlandsReport = vi
      .fn()
      .mockRejectedValueOnce(new Error('workspace database is locked'))
      .mockResolvedValueOnce(makeNetherlandsReport([makeNetherlandsVacancy()]));
    installAllBridges({ getNetherlandsReport });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getByText('workspace database is locked')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(getNetherlandsReport).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getAllByText('Senior Frontend Architect').length).toBeGreaterThan(0));
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
      getNetherlandsReport: vi.fn().mockResolvedValue(makeNetherlandsReport([makeNetherlandsVacancy()])),
    });
    const created: SavedJobRecord = {
      id: 'saved-1',
      vacancyKey: 'nl-1',
      role: 'Senior Frontend Architect',
      company: 'Redwood Software',
      market: 'netherlands',
      location: 'Amsterdam',
      salary: null,
      arrangement: 'Hybrid',
      verification: 'Recognised sponsor',
      matchPercent: 99,
      sourceUrl: 'https://example.invalid/jobs/nl-1',
      notes: '',
      status: 'considering',
      savedAt: '2026-08-29T12:00:00.000Z',
    };
    const workspace = installWorkspaceBridge({
      getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, defaultMarket: 'netherlands' }),
      createSavedJob: vi.fn().mockResolvedValue(created),
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save job' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Saved' })).toBeInTheDocument());
    expect(workspace.createSavedJob).toHaveBeenCalledWith({
      role: 'Senior Frontend Architect',
      company: 'Redwood Software',
      market: 'netherlands',
      location: 'Amsterdam',
      vacancyKey: 'nl-1',
      salary: null,
      arrangement: 'Hybrid',
      verification: 'Recognised sponsor',
      matchPercent: 99,
      sourceUrl: 'https://example.invalid/jobs/nl-1',
      status: 'considering',
    });
  });

  it('reports a failed save on the vacancy rather than silently doing nothing', async () => {
    installAllBridges({
      getNetherlandsReport: vi.fn().mockResolvedValue(makeNetherlandsReport([makeNetherlandsVacancy()])),
    });
    installWorkspaceBridge({
      getSettings: vi.fn().mockResolvedValue({ ...DEFAULT_SETTINGS, defaultMarket: 'netherlands' }),
      createSavedJob: vi.fn().mockRejectedValue(new Error('workspace database is locked')),
    });

    render(<SearchPage />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save job' })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Save job' }));

    await waitFor(() => expect(screen.getByText(/workspace database is locked/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Save job' })).toBeEnabled();
  });

  it('opens the CV assistant on demand for the selected vacancy', async () => {
    installAllBridges({
      getNetherlandsReport: vi.fn().mockResolvedValue(
        makeNetherlandsReport([
          makeNetherlandsVacancy(),
          makeNetherlandsVacancy({ id: 'nl-2', title: 'Frontend Developer', company: 'Freeday', score: 90 }),
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
    expect(screen.getByText(/freeday, amsterdam/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /hide ai assistant/i })).toBeInTheDocument();
  });
});
