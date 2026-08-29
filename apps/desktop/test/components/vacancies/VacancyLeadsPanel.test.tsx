import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveryVacancyAudit, GlobalRemoteReport } from '@open-vacancy-radar/vacancy-engine';
import { VacancyLeadsPanel } from '../../../src/components/vacancies/index.js';
import type { VacancyEngineStatus, VacancyRadarBridge } from '../../../src/window.js';

function makeVacancy(overrides: Partial<DiscoveryVacancyAudit> = {}): DiscoveryVacancyAudit {
  return {
    key: overrides.key ?? 'vac-1',
    provider: 'remotive',
    company: 'Acme Corp',
    title: 'Senior Frontend Engineer',
    url: 'https://example.com/jobs/1',
    location: 'Worldwide',
    employmentType: 'full_time',
    currency: 'USD',
    salaryPeriod: 'year',
    advertisedMinimum: 120_000,
    annualizedMinimumUsd: 120_000,
    decision: 'official_review_candidate',
    reasons: [],
    contentHash: 'hash-1',
    ...overrides,
  };
}

function makeReport(vacancies: DiscoveryVacancyAudit[]): GlobalRemoteReport {
  return {
    runId: 'run-123',
    generatedAt: '2026-08-29T10:00:00.000Z',
    profileVersion: 'v1',
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

function installBridge(overrides: Partial<VacancyRadarBridge> = {}): VacancyRadarBridge {
  const bridge: VacancyRadarBridge = {
    getStatus: vi.fn().mockResolvedValue({ ready: true } satisfies VacancyEngineStatus),
    getReport: vi.fn().mockResolvedValue(null),
    runScan: vi.fn(),
    ...overrides,
  };
  (window as unknown as { vacancyRadar: VacancyRadarBridge }).vacancyRadar = bridge;
  return bridge;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('VacancyLeadsPanel', () => {
  it('shows an empty state with a Run scan button when no report exists yet', async () => {
    installBridge();
    render(<VacancyLeadsPanel />);

    await waitFor(() => expect(screen.getByText(/no scan has been run yet/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /run scan/i })).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('renders the vacancy list immediately when a report is already hydrated', async () => {
    const report = makeReport([
      makeVacancy({ key: 'a', title: 'Senior Frontend Engineer' }),
      makeVacancy({ key: 'b', title: 'Backend Engineer', decision: 'role_mismatch' }),
    ]);
    installBridge({ getReport: vi.fn().mockResolvedValue(report) });

    render(<VacancyLeadsPanel />);

    await waitFor(() => expect(screen.getByText('Senior Frontend Engineer')).toBeInTheDocument());
    expect(screen.getByText('Backend Engineer')).toBeInTheDocument();
    // getReport hydrated the screen; runScan must not have been triggered just to view it.
    const bridge = window.vacancyRadar as VacancyRadarBridge;
    expect(bridge.runScan).not.toHaveBeenCalled();
  });

  it('shows a loading state while a scan is in progress and then renders results', async () => {
    let resolveScan: (report: GlobalRemoteReport) => void = () => {};
    const scanPromise = new Promise<GlobalRemoteReport>((resolve) => {
      resolveScan = resolve;
    });
    installBridge({ runScan: vi.fn().mockReturnValue(scanPromise) });

    render(<VacancyLeadsPanel />);
    await waitFor(() => expect(screen.getByRole('button', { name: /run scan/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /run scan/i }));

    await waitFor(() => expect(screen.getByText(/scanning live job sources/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /scanning/i })).toBeDisabled();

    resolveScan(makeReport([makeVacancy({ title: 'Staff Frontend Engineer' })]));

    await waitFor(() => expect(screen.getByText('Staff Frontend Engineer')).toBeInTheDocument());
    expect(screen.queryByText(/scanning live job sources/i)).not.toBeInTheDocument();
  });

  it('surfaces a scan error without crashing', async () => {
    installBridge({ runScan: vi.fn().mockRejectedValue(new Error('network unreachable')) });

    render(<VacancyLeadsPanel />);
    await waitFor(() => expect(screen.getByRole('button', { name: /run scan/i })).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /run scan/i }));

    await waitFor(() => expect(screen.getByText(/scan failed/i)).toBeInTheDocument());
    expect(screen.getByText(/network unreachable/i)).toBeInTheDocument();
    // still usable — the run button is back to its idle label and enabled again.
    expect(screen.getByRole('button', { name: 'Run scan' })).toBeEnabled();
  });

  it('filters the vacancy list by title as the user types, case-insensitively', async () => {
    const report = makeReport([
      makeVacancy({ key: 'a', title: 'Senior Frontend Engineer' }),
      makeVacancy({ key: 'b', title: 'Backend Platform Engineer' }),
      makeVacancy({ key: 'c', title: 'Staff FRONTEND Architect' }),
    ]);
    installBridge({ getReport: vi.fn().mockResolvedValue(report) });

    render(<VacancyLeadsPanel />);
    await waitFor(() => expect(screen.getByText('Senior Frontend Engineer')).toBeInTheDocument());

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'frontend' } });

    expect(screen.getByText('Senior Frontend Engineer')).toBeInTheDocument();
    expect(screen.getByText('Staff FRONTEND Architect')).toBeInTheDocument();
    expect(screen.queryByText('Backend Platform Engineer')).not.toBeInTheDocument();
  });

  it('shows a distinct "no matches" state when the filter excludes everything', async () => {
    const report = makeReport([makeVacancy({ key: 'a', title: 'Senior Frontend Engineer' })]);
    installBridge({ getReport: vi.fn().mockResolvedValue(report) });

    render(<VacancyLeadsPanel />);
    await waitFor(() => expect(screen.getByText('Senior Frontend Engineer')).toBeInTheDocument());

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nonexistent-role-xyz' } });

    await waitFor(() => expect(screen.getByText(/no vacancies match that search/i)).toBeInTheDocument());
    expect(screen.queryByText(/no scan has been run yet/i)).not.toBeInTheDocument();
  });
});
