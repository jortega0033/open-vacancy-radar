import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AtsRosterImportResult } from '@open-vacancy-radar/vacancy-engine';
import {
  AtsRosterSection,
  type AtsRosterSectionProps,
} from '../../../src/components/settings/AtsRosterSection.js';
import { installVacancyRadarBridge } from '../../workspace-bridge.js';

function baseProps(overrides: Partial<AtsRosterSectionProps> = {}): AtsRosterSectionProps {
  return {
    onRefreshed: vi.fn(),
    onRefreshError: vi.fn(),
    ...overrides,
  };
}

function importResult(overrides: Partial<AtsRosterImportResult> = {}): AtsRosterImportResult {
  return {
    file: 'ats-roster-v1.json',
    importedAt: '2026-09-11T00:00:00.000Z',
    totalEntries: 42,
    providers: [
      {
        provider: 'greenhouse',
        status: 'success',
        rawRowCount: 42,
        importedCount: 42,
        invalidRowCount: 0,
        duplicateRowCount: 0,
        error: null,
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AtsRosterSection', () => {
  it('shows "not yet imported" when the roster has never been imported', async () => {
    installVacancyRadarBridge({
      getAtsRosterStatus: vi.fn().mockResolvedValue(null),
    });

    render(<AtsRosterSection {...baseProps()} />);

    await waitFor(() => expect(screen.getByText(/Not yet imported/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Refresh company roster' })).toBeInTheDocument();
  });

  it('shows the last-refreshed date and total entries when a roster already exists', async () => {
    installVacancyRadarBridge({
      getAtsRosterStatus: vi.fn().mockResolvedValue({
        importedAt: '2026-09-11T00:00:00.000Z',
        totalEntries: 1234,
        sourceCounts: { greenhouse: 1234 },
      }),
    });

    render(<AtsRosterSection {...baseProps()} />);

    await waitFor(() => expect(screen.getByText(/Last refreshed/)).toBeInTheDocument());
    expect(screen.getByText(/1,234 companies/)).toBeInTheDocument();
  });

  it('shows a load error instead of the default status when the status fails to load', async () => {
    installVacancyRadarBridge({
      getAtsRosterStatus: vi.fn().mockRejectedValue(new Error('disk read failed')),
    });

    render(<AtsRosterSection {...baseProps()} />);

    await waitFor(() => expect(screen.getByText('disk read failed')).toBeInTheDocument());
    expect(screen.queryByText(/Not yet imported/)).not.toBeInTheDocument();
  });

  it('runs the refresh on click, reports success upward, and shows the refreshed status', async () => {
    const refreshAtsRoster = vi.fn().mockResolvedValue(importResult());
    const onRefreshed = vi.fn();
    installVacancyRadarBridge({
      getAtsRosterStatus: vi.fn().mockResolvedValue(null),
      refreshAtsRoster,
    });

    render(<AtsRosterSection {...baseProps({ onRefreshed })} />);

    await waitFor(() => expect(screen.getByText(/Not yet imported/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Refresh company roster' }));

    await waitFor(() => expect(refreshAtsRoster).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onRefreshed).toHaveBeenCalledWith(importResult()));
    expect(screen.getByText(/42 companies/)).toBeInTheDocument();
  });

  it('reports a refresh failure upward through onRefreshError instead of throwing', async () => {
    const refreshAtsRoster = vi.fn().mockRejectedValue(new Error('a vacancy scan is already running'));
    const onRefreshError = vi.fn();
    installVacancyRadarBridge({
      getAtsRosterStatus: vi.fn().mockResolvedValue(null),
      refreshAtsRoster,
    });

    render(<AtsRosterSection {...baseProps({ onRefreshError })} />);

    await waitFor(() => expect(screen.getByText(/Not yet imported/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Refresh company roster' }));

    await waitFor(() =>
      expect(onRefreshError).toHaveBeenCalledWith('a vacancy scan is already running'),
    );
  });

  it('disables the refresh button while a refresh is in flight', async () => {
    let resolveRefresh: (value: AtsRosterImportResult) => void = () => {};
    const refreshAtsRoster = vi.fn(
      () => new Promise<AtsRosterImportResult>((resolve) => { resolveRefresh = resolve; }),
    );
    installVacancyRadarBridge({
      getAtsRosterStatus: vi.fn().mockResolvedValue(null),
      refreshAtsRoster,
    });

    render(<AtsRosterSection {...baseProps()} />);

    await waitFor(() => expect(screen.getByText(/Not yet imported/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Refresh company roster' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled());
    resolveRefresh(importResult());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh company roster' })).not.toBeDisabled());
  });
});
