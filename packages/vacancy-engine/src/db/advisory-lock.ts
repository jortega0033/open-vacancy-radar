import SqliteDatabase from 'better-sqlite3';

export const SCAN_ADVISORY_LOCK = {
  name: 'vacancy-engine-scan',
} as const;

export type AdvisoryLockOutcome<T> =
  | { acquired: false }
  | { acquired: true; value: T };

/**
 * A best-effort, cross-process mutual exclusion primitive for scan-sensitive
 * commands. `tryAcquire` returns a release callback when the lock was taken,
 * or `null` when another process already holds it.
 */
export type ScanLock = {
  tryAcquire: () => (() => void) | null;
};

function isBusyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code: unknown = (error as { code?: unknown }).code;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || code === 'SQLITE_PROTOCOL';
}

function createInProcessScanLock(): ScanLock {
  let held = false;
  return {
    tryAcquire: () => {
      if (held) return null;
      held = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        held = false;
      };
    },
  };
}

/**
 * Replaces the former PostgreSQL session advisory lock.
 *
 * The embedded engine has no server session to hang a `pg_try_advisory_lock`
 * on, so exclusivity is taken on a dedicated sidecar SQLite file opened in
 * `locking_mode = exclusive`. The first writer holds an operating-system file
 * lock for the lifetime of its connection, a second process fails immediately
 * with `SQLITE_BUSY` (the lock connection uses a zero busy timeout), and the
 * operating system releases the lock even if the holder crashes. This matches the
 * failure semantics a dropped PostgreSQL session had.
 *
 * In-memory databases are per-process by definition, so they fall back to a
 * process-local lock.
 */
export function createScanLock(databasePath: string): ScanLock {
  if (databasePath === ':memory:' || databasePath.startsWith('file::memory:')) {
    return createInProcessScanLock();
  }

  const lockPath = `${databasePath}-${SCAN_ADVISORY_LOCK.name}.lock`;
  return {
    tryAcquire: () => {
      const handle = new SqliteDatabase(lockPath, { timeout: 0 });
      try {
        handle.pragma('locking_mode = exclusive');
        handle.exec(
          'create table if not exists scan_lock (id integer primary key, acquired_at integer not null)',
        );
        handle
          .prepare('insert or replace into scan_lock (id, acquired_at) values (1, ?)')
          .run(Date.now());
      } catch (error) {
        handle.close();
        if (isBusyError(error)) return null;
        throw error;
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        handle.close();
      };
    },
  };
}

/**
 * Runs an operation while holding the exclusive scan lock.
 *
 * The lock is always released once the operation settles, including when it
 * rejects, and a failure to release propagates so the caller never treats a
 * possibly still-locked engine as clean.
 */
export async function withScanAdvisoryTryLock<T>(
  lock: ScanLock,
  operation: () => Promise<T>,
): Promise<AdvisoryLockOutcome<T>> {
  const release = lock.tryAcquire();
  if (release === null) {
    return { acquired: false };
  }

  let operationOutcome:
    | { succeeded: true; value: T }
    | { succeeded: false; error: unknown };
  try {
    operationOutcome = { succeeded: true, value: await operation() };
  } catch (error) {
    operationOutcome = { succeeded: false, error };
  }

  release();

  if (!operationOutcome.succeeded) {
    throw operationOutcome.error;
  }
  return { acquired: true, value: operationOutcome.value };
}
