// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';
import { parseSettingsPatch } from '../electron/workspace/validate.js';

const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'workspace', 'drizzle');

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

/** Every migration before 0033, so a database can be seeded the way an install from before the
 * automatic company list setting left it. */
function seedPre0033MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((entry) => entry.idx < 33);
  expect(journal.entries[33]?.tag).toMatch(/^0033_/);
  const folder = join(root, 'drizzle-0032');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  for (const entry of kept) cpSync(join(REAL_MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  return folder;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0033-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('migration 0033 adds autoRosterDownloadEnabled (#637)', () => {
  it('reads an older settings row as on, then stores and reads back an opt-out', () => {
    const seeded = new Database(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(seeded), { migrationsFolder: seedPre0033MigrationsFolder(dir) });
      seeded.prepare(`INSERT INTO app_settings (id, theme, auto_scan_enabled) VALUES (1, 'dark', 1)`).run();
      const columns = seeded.prepare(`PRAGMA table_info(app_settings)`).all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toContain('auto_roster_download_enabled');
    } finally {
      seeded.close();
    }

    const { db, close } = createWorkspaceDb(dir);
    try {
      const older = workspace.getSettings(db);
      expect(older).toMatchObject({ theme: 'dark', autoScanEnabled: true, autoRosterDownloadEnabled: true });

      const updated = workspace.updateSettings(db, parseSettingsPatch({ autoRosterDownloadEnabled: false }));
      expect(updated.autoRosterDownloadEnabled).toBe(false);
      expect(workspace.getSettings(db).autoRosterDownloadEnabled).toBe(false);
    } finally {
      close();
    }
  });

  it('rejects a non-boolean value and is on again after "Delete my data"', () => {
    expect(() => parseSettingsPatch({ autoRosterDownloadEnabled: 'yes' })).toThrow();
    const { db, close } = createWorkspaceDb(dir);
    try {
      workspace.updateSettings(db, { autoRosterDownloadEnabled: false });
      expect(workspace.resetApplicationData(db).settings.autoRosterDownloadEnabled).toBe(true);
    } finally {
      close();
    }
  });
});
