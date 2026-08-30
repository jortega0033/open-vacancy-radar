import { withScanAdvisoryTryLock, type ScanLock } from '@open-vacancy-radar/vacancy-engine';

export const SCAN_BUSY_IN_PROCESS = 'a vacancy scan is already running';
export const SCAN_BUSY_OTHER_PROCESS = 'a vacancy scan is already running in another process';

export interface ExclusiveScanOptions {
  /**
   * Whether this guard should take the engine's cross-process advisory lock itself.
   *
   * `false` for `runEndToEndScan`, which takes that lock as part of its own contract and reports
   * `{ status: 'skipped' }` rather than throwing when it cannot get it. Taking it here as well
   * would deadlock against that acquisition on a platform where the lock is per-handle.
   */
  takeAdvisoryLock: boolean;
}

/**
 * Mutual exclusion for vacancy scans, in two layers.
 *
 * **In-process (always).** One flag shared by *every* scan kind, not one per kind: the
 * global-remote and Netherlands pipelines write the same engine database and the same
 * scan-run/content-hash tables, so running them together is exactly as damaging as running two of
 * either. This layer is also the only one that works reliably inside a single process — POSIX
 * `fcntl` locks (what SQLite uses on Linux/macOS) are per-process, so a second connection opened
 * by *this* process is not blocked by the first. The advisory lock alone would therefore be a
 * no-op for precisely the case the renderer can cause: two IPC calls in flight at once.
 *
 * **Cross-process (opt-in).** The engine's `createScanLock` sidecar file lock, which is the only
 * thing that stops a scan started by another process — `pnpm vacancies:scan` pointed at the same
 * userData database, say. This closes the gap flagged in the earlier review, where the desktop
 * app's global-remote handler guarded with an in-process boolean alone.
 *
 * The lock is read through a getter rather than passed in, because it is created lazily alongside
 * the engine database and a handler can be invoked before that finishes.
 */
export function createScanGuard(getLock: () => ScanLock | undefined) {
  let inFlight = false;

  return async function runExclusiveScan<T>(
    run: () => Promise<T>,
    options: ExclusiveScanOptions,
  ): Promise<T> {
    if (inFlight) throw new Error(SCAN_BUSY_IN_PROCESS);
    inFlight = true;
    try {
      if (!options.takeAdvisoryLock) return await run();

      const lock = getLock();
      if (!lock) throw new Error('vacancy engine is not initialized');
      const outcome = await withScanAdvisoryTryLock(lock, run);
      if (!outcome.acquired) throw new Error(SCAN_BUSY_OTHER_PROCESS);
      return outcome.value;
    } finally {
      // Cleared however the scan ended — a failed scan must not wedge the app into a state where
      // every later scan is refused as "already running".
      inFlight = false;
    }
  };
}
