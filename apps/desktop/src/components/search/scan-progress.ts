import type { VacancyScanStatus } from '../../window.js';

/**
 * What the scan progress panel says, derived from the engine's own events and the clock (#459).
 *
 * The bar is determinate only while the main process can name a denominator and has counted
 * completed sources against it. Before the first event, or once every group has reported and the
 * run is matching sponsors and scoring rows, there is no honest fraction to draw, so those stages
 * are indeterminate. Elapsed time is wall-clock from the run's own start stamp and is the only
 * number here that is not an engine count.
 */
export interface ScanProgressView {
  /** 0..1 when a real fraction exists, otherwise null for an indeterminate bar. */
  fraction: number | null;
  headline: string;
  elapsed: string;
  vacancies: string | null;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function describeScanProgress(status: VacancyScanStatus | undefined, now: number): ScanProgressView {
  const startedAt = status?.startedAt;
  const elapsed = startedAt === undefined ? '0:00' : formatElapsed(now - startedAt);
  const done = status?.sourcesDone;
  const total = status?.sourcesTotal;
  const vacancies =
    status?.vacanciesSoFar === undefined
      ? null
      : `${status.vacanciesSoFar.toLocaleString()} ${status.vacanciesSoFar === 1 ? 'listing' : 'listings'} checked`;

  if (status?.stopping) {
    return { fraction: null, headline: 'Stopping the scan…', elapsed, vacancies };
  }
  if (done === undefined || total === undefined || total <= 0) {
    return { fraction: null, headline: 'Starting the scan…', elapsed, vacancies };
  }
  if (done >= total) {
    // The AI web search runs alongside the source groups (#685) and the run only scores results once
    // it has finished, so while it is still going that is what the run is waiting for.
    const waitingForAi = status?.aiWebSearch === 'waiting' || status?.aiWebSearch === 'running';
    return {
      fraction: null,
      headline: waitingForAi
        ? `All ${total} source groups checked. Waiting for the AI web search to finish…`
        : `All ${total} source groups checked. Matching sponsors and scoring results…`,
      elapsed,
      vacancies,
    };
  }
  return {
    fraction: done / total,
    headline: `Checked ${done} of ${total} source groups`,
    elapsed,
    vacancies,
  };
}
