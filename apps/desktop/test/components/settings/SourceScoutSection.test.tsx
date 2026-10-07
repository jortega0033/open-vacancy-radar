import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SourceScoutStatus } from '../../../electron/source-scout-types.js';
import { SourceScoutSection } from '../../../src/components/settings/SourceScoutSection.js';
import { installVacancyRadarBridge } from '../../workspace-bridge.js';

function status(overrides: Partial<SourceScoutStatus> = {}): SourceScoutStatus {
  return {
    enabled: true,
    paused: false,
    running: false,
    hasProfile: true,
    lastRunAt: null,
    nextRunAt: null,
    lastOutcome: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SourceScoutSection', () => {
  it('says it only runs while the app is open or in the tray and saves the toggle', () => {
    installVacancyRadarBridge();
    const onEnabledChange = vi.fn();
    render(<SourceScoutSection enabled={false} onEnabledChange={onEnabledChange} />);

    expect(screen.getByText('Runs only while Open Vacancy Radar is open or in the tray.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run now' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Look for new companies in the background' }));
    expect(onEnabledChange).toHaveBeenCalledWith(true);
  });

  it('shows a plain message and blocks Run now when no role or keyword is saved', async () => {
    installVacancyRadarBridge({ getSourceScoutStatus: vi.fn().mockResolvedValue(status({ hasProfile: false })) });
    render(<SourceScoutSection enabled onEnabledChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByText(/Add a role or keyword under What you are looking for/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Run now' })).toBeDisabled();
  });

  it('shows the last outcome with its counters', async () => {
    installVacancyRadarBridge({
      getSourceScoutStatus: vi.fn().mockResolvedValue(
        status({
          lastRunAt: '2026-10-05T10:00:00.000Z',
          lastOutcome: {
            kind: 'completed',
            at: '2026-10-05T10:00:00.000Z',
            counters: { attempted: 10, refreshed: 6, explored: 4, newlyVerified: 2, empty: 3, skipped: 0, blocked: 1, failed: 1 },
          },
        }),
      ),
    });
    render(<SourceScoutSection enabled onEnabledChange={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByText('Finished. 10 companies checked, 2 new, 3 empty, 1 blocked, 1 failed.')).toBeInTheDocument(),
    );
  });

  it('starts a run now and refreshes the status', async () => {
    const runSourceScoutNow = vi.fn().mockResolvedValue({ started: true });
    const getSourceScoutStatus = vi.fn().mockResolvedValue(status());
    installVacancyRadarBridge({ getSourceScoutStatus, runSourceScoutNow });
    render(<SourceScoutSection enabled onEnabledChange={vi.fn()} />);

    const button = await screen.findByRole('button', { name: 'Run now' });
    await waitFor(() => expect(button).toBeEnabled());
    const callsBefore = getSourceScoutStatus.mock.calls.length;
    fireEvent.click(button);
    await waitFor(() => expect(runSourceScoutNow).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getSourceScoutStatus.mock.calls.length).toBeGreaterThan(callsBefore));
  });

  it('pauses and resumes', async () => {
    const setSourceScoutPaused = vi
      .fn()
      .mockResolvedValueOnce(status({ paused: true }))
      .mockResolvedValueOnce(status({ paused: false }));
    installVacancyRadarBridge({ getSourceScoutStatus: vi.fn().mockResolvedValue(status()), setSourceScoutPaused });
    render(<SourceScoutSection enabled onEnabledChange={vi.fn()} />);

    const pause = await screen.findByRole('button', { name: 'Pause' });
    await waitFor(() => expect(pause).toBeEnabled());
    fireEvent.click(pause);
    expect(await screen.findByRole('button', { name: 'Resume' })).toBeInTheDocument();
    expect(setSourceScoutPaused).toHaveBeenLastCalledWith(true);
    expect(screen.getByText(/Next run: Paused/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(setSourceScoutPaused).toHaveBeenLastCalledWith(false));
  });
});
