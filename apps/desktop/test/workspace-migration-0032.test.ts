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

/** Every migration before 0032, so a database can be seeded the way an install from before the
 * source scout setting left it. */
function seedPre0032MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((entry) => entry.idx < 32);
  expect(journal.entries[32]?.tag).toMatch(/^0032_/);
  const folder = join(root, 'drizzle-0031');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  for (const entry of kept) cpSync(join(REAL_MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  return folder;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0032-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('migration 0032 adds autoSourceScoutEnabled (#348)', () => {
  it('reads an older settings row as off, then stores and reads back an opt-in', () => {
    const seeded = new Database(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(seeded), { migrationsFolder: seedPre0032MigrationsFolder(dir) });
      seeded.prepare(`INSERT INTO app_settings (id, theme, auto_scan_enabled) VALUES (1, 'dark', 1)`).run();
      const columns = seeded.prepare(`PRAGMA table_info(app_settings)`).all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toContain('auto_source_scout_enabled');
    } finally {
      seeded.close();
    }

    const { db, close } = createWorkspaceDb(dir);
    try {
      const older = workspace.getSettings(db);
      expect(older).toMatchObject({ theme: 'dark', autoScanEnabled: true, autoSourceScoutEnabled: false });

      const updated = workspace.updateSettings(db, parseSettingsPatch({ autoSourceScoutEnabled: true }));
      expect(updated.autoSourceScoutEnabled).toBe(true);
      // Independent of automatic vacancy refresh in both directions.
      expect(updated.autoScanEnabled).toBe(true);
      expect(workspace.updateSettings(db, { autoScanEnabled: false }).autoSourceScoutEnabled).toBe(true);
    } finally {
      close();
    }
  });

  it('rejects a non-boolean value and is off after "Delete my data"', () => {
    expect(() => parseSettingsPatch({ autoSourceScoutEnabled: 'yes' })).toThrow();
    const { db, close } = createWorkspaceDb(dir);
    try {
      workspace.updateSettings(db, { autoSourceScoutEnabled: true });
      expect(workspace.resetApplicationData(db).settings.autoSourceScoutEnabled).toBe(false);
    } finally {
      close();
    }
  });
});
