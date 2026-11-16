// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

// Running every migration twice (seed, then open) is slow on a loaded machine; the FollowUps suite
// sets the same allowance for the same reason.
vi.setConfig({ testTimeout: 60_000 });
import { createWorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';

const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'workspace', 'drizzle');

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

/** Every migration before 0043: a database as an install from before #708 left it. */
function seedPre0043MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  expect(journal.entries[43]?.tag).toBe('0043_application_status_events');
  const kept = journal.entries.filter((entry) => entry.idx < 43);
  const folder = join(root, 'drizzle-0042');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  for (const entry of kept) cpSync(join(REAL_MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  return folder;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0043-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('migration 0043 adds the status history (#708)', () => {
  it('loads a pre-#708 application unchanged, with no backfilled history, and records only later changes', () => {
    const seeded = new Database(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(seeded), { migrationsFolder: seedPre0043MigrationsFolder(dir) });
      seeded
        .prepare(
          `INSERT INTO applications (id, role, company, location, status, applied_at, next_step, contact, notes, archived)
           VALUES ('app-legacy', 'Platform Engineer', 'Northwind', 'Remote', 'interview', 1785000000000, '', '', '', 0)`,
        )
        .run();
    } finally {
      seeded.close();
    }

    const { db, close } = createWorkspaceDb(dir);
    try {
      expect(workspace.listApplications(db)).toEqual([
        expect.objectContaining({ id: 'app-legacy', status: 'interview', appliedAt: new Date(1785000000000).toISOString() }),
      ]);
      // "Current value only": no event is invented for the row's existing status or its applied date.
      expect(workspace.listApplicationStatusEvents(db, 'app-legacy')).toEqual([]);

      workspace.updateApplication(db, 'app-legacy', { status: 'offer' });
      expect(workspace.listApplicationStatusEvents(db, 'app-legacy')).toEqual([
        expect.objectContaining({ fromStatus: 'interview', toStatus: 'offer', source: 'user_set', occurredOn: null }),
      ]);
    } finally {
      close();
    }
  });
});
