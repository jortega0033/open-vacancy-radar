import { useEffect, useRef, useState } from 'react';
import type { VacancyScanStatus } from '../../window.js';
import { describeScanProgress } from './scan-progress.js';

/** How often the main process is asked for the run's counts. The count only changes when a source
 * group finishes, so this is frequent enough for "at least every 5 seconds" without being busy. */
const STATUS_POLL_MS = 2000;

/** The latest scan status while `active`, re-read every two seconds, plus a one-second clock so the
 * elapsed time moves between reads. */
export function useScanStatus(active: boolean): { status: VacancyScanStatus | undefined; now: number } {
  const [status, setStatus] = useState<VacancyScanStatus>();
  const [now, setNow] = useState(() => Date.now());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active) {
      setStatus(undefined);
      return;
    }
    let cancelled = false;
    const read = async () => {
      try {
        const next = await window.vacancyRadar.getScanProgress();
        if (!cancelled && alive.current) setStatus(next);
      } catch {
        // Keep the last reading; the scan itself reports its own failure.
      }
    };
    void read();
    const poll = window.setInterval(() => void read(), STATUS_POLL_MS);
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
      window.clearInterval(clock);
    };
  }, [active]);

  return { status, now };
}

export interface ScanProgressPanelProps {
  status: VacancyScanStatus | undefined;
  now: number;
  /** A stop was requested here and the run has not wound down yet. */
  stopping: boolean;
  onStop: () => void;
}

/**
 * Real progress for a scan that takes minutes (#459): source groups finished out of the total the
 * engine reports, elapsed time, vacancies found so far, an honest time range, and Stop. Stopping
 * keeps the previous report, which the copy says outright.
 */
export function ScanProgressPanel({ status, now, stopping, onStop }: ScanProgressPanelProps) {
  const view = describeScanProgress(stopping && status ? { ...status, stopping: true } : status, now);
  const canStop = status?.scanId !== undefined && !stopping && status.stopping !== true;
  const valueText = view.fraction === null ? view.headline : `${view.headline}, ${view.elapsed} elapsed`;
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{view.headline}</span>
        <span className="text-xs text-base-content/70">{view.elapsed} elapsed</span>
        {view.vacancies && <span className="text-xs text-base-content/70">{view.vacancies}</span>}
      </div>
      <progress
        className="progress progress-info w-full"
        {...(view.fraction === null ? {} : { value: Math.round(view.fraction * 100), max: 100 })}
        aria-label="Scan progress"
        aria-valuetext={valueText}
      />
      <span className="text-xs text-base-content/70">
        Usually takes 2 to 5 minutes. You can keep browsing while it runs. Stopping keeps your previous report.
      </span>
      <div>
        <button type="button" className="btn btn-outline btn-xs" disabled={!canStop} onClick={onStop}>
          {stopping || status?.stopping ? 'Stopping…' : 'Stop scan'}
        </button>
      </div>
    </div>
  );
}
