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
import { installVacancyRadarBridge, installWorkspaceBridge } from '../../workspace-bridge.js';

function makeNetherlandsVacancy(overrides: Partial<ReportVacancy> = {}): ReportVacancy {
  return {
    id: 'nl-1',
    title: 'Senior Frontend Architect',
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

function makeNetherlandsReport(vacancies: ReportVacancy[]): JobRadarReport {
  return {
    runId: 'nl-run-1',
    scanStatus: 'succeeded',
    generatedAt: '2026-08-29T10:00:00.000Z',
    candidateProfileVersion: 'candidate-profile-v1',
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
 * reported ready — the interesting failure modes here are report-shaped, not engine-shaped.
 */
function installAllBridges(overrides: Partial<VacancyRadarBridge> = {}): VacancyRadarBridge {
  installBridges();
  return installVacancyRadarBridge({
    getStatus: vi.fn().mockResolvedValue({ ready: true } satisfies VacancyEngineStatus),
    ...overrides,
  });
}

function switchMarket(value: 'netherlands' | 'worldwide') {
  fireEvent.change(screen.getByLabelText('Market'), { target: { value } });
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

    fireEvent.click(screen.getByRole('button', { name: 'Run scan' }));

    await waitFor(() => expect(screen.getByText(/scanning live netherlands sources/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /run scan/i })).toBeDisabled();

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

    fireEvent.click(screen.getByRole('button', { name: 'Run scan' }));

    await waitFor(() => expect(screen.getByText(/scan failed: network unreachable/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Run scan' })).toBeEnabled();
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
    const workspace = installWorkspaceBridge({ createSavedJob: vi.fn().mockResolvedValue(created) });

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
    installWorkspaceBridge({ createSavedJob: vi.fn().mockRejectedValue(new Error('workspace database is locked')) });

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
    expect(screen.getByText(/freeday — amsterdam/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /hide ai assistant/i })).toBeInTheDocument();
  });
});
