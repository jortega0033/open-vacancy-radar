// @vitest-environment node
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceDb, type WorkspaceDb } from '../electron/workspace/client.js';

/**
 * `workspace.db` is the single most sensitive store the app owns (CV text, contact info, cover
 * letters, job-posting text, all in plaintext SQLite), so it gets the same explicit 0700/0600
 * hardening the daemon's own stores already rely on -- see `discovery-file.test.ts`'s
 * "runtime directory permissions" describe block, which this mirrors. POSIX-only: Windows has no
 * equivalent of a POSIX file mode (NTFS ACL inheritance on a per-user directory is the real
 * protection there), so these assertions are skipped on win32 rather than asserted falsely.
 */
let dir: string;
let db: WorkspaceDb | undefined;
let close: (() => void) | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-perm-test-'));
});

afterEach(() => {
  close?.();
  close = undefined;
  db = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('createWorkspaceDb: filesystem permissions (POSIX)', () => {
  it('creates the workspace directory with mode 0700', () => {
    if (process.platform === 'win32') return;
    const userDataPath = join(dir, 'userData');
    ({ db, close } = createWorkspaceDb(userDataPath));
    expect(statSync(userDataPath).mode & 0o777).toBe(0o700);
  });

  it('creates workspace.db with mode 0600', () => {
    if (process.platform === 'win32') return;
    const userDataPath = join(dir, 'userData');
    ({ db, close } = createWorkspaceDb(userDataPath));
    const databasePath = join(userDataPath, 'workspace.db');
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
  });

  it('secures the -wal/-shm sidecar files too, when WAL mode creates them', () => {
    if (process.platform === 'win32') return;
    const userDataPath = join(dir, 'userData');
    ({ db, close } = createWorkspaceDb(userDataPath));
    const databasePath = join(userDataPath, 'workspace.db');
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${databasePath}${suffix}`;
      if (existsSync(sidecar)) {
        expect(statSync(sidecar).mode & 0o777).toBe(0o600);
      }
    }
  });
});
