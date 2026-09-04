import { withScanAdvisoryTryLock, type ScanLock } from '@open-vacancy-radar/vacancy-engine';

export const SCAN_BUSY_IN_PROCESS = 'a vacancy scan is already running';
export const SCAN_BUSY_OTHER_PROCESS = 'a vacancy scan is already running in another process';

export interface ExclusiveScanOptions {
  /** Whether this guard should take the engine's cross-process advisory lock itself. */
  takeAdvisoryLock: boolean;
}

/**
 * Mutual exclusion for vacancy scans, in two layers.
 *
 * **In-process (always).** One flag shared across every scan: POSIX `fcntl` locks (what SQLite
 * uses on Linux/macOS) are per-process, so a second connection opened by *this* process is not
 * blocked by the first. The advisory lock alone would therefore be a no-op for precisely the case
 * the renderer can cause: two IPC calls in flight at once.
 *
 * **Cross-process (opt-in).** The engine's `createScanLock` sidecar file lock, which is the only
 * thing that stops a scan started by another process (`pnpm vacancies:scan` pointed at the same
 * userData database, say). This closes the gap flagged in the earlier review, where the desktop
 * app's global-remote handler guarded with an in-process boolean alone.
 *
 * The lock is read through a getter rather than passed in, because it is created lazily alongside
 * the engine database and a handler can be invoked before that finishes.
 */
export interface ScanGuard {
  runExclusiveScan<T>(run: () => Promise<T>, options: ExclusiveScanOptions): Promise<T>;
  /**
   * Whether a scan started through this guard is still running. The renderer's own `scanning`
   * state is just a piece of component state, gone the moment the Search page unmounts (the user
   * navigates away); the scan itself runs entirely in this process and keeps going regardless.
   * This lets a remounted Search page notice that a scan is already in flight -- one it may have
   * started itself before navigating away -- and reflect that instead of looking idle and then
   * failing with `SCAN_BUSY_IN_PROCESS` the moment the user clicks Search again.
   */
  isScanInFlight(): boolean;
}

export function createScanGuard(getLock: () => ScanLock | undefined): ScanGuard {
  let inFlight = false;

  async function runExclusiveScan<T>(run: () => Promise<T>, options: ExclusiveScanOptions): Promise<T> {
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
      // Cleared however the scan ended. A failed scan must not wedge the app into a state where
      // every later scan is refused as "already running".
      inFlight = false;
    }
  }

  return { runExclusiveScan, isScanInFlight: () => inFlight };
}
