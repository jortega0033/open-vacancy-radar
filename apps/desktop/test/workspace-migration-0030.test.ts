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

const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'workspace', 'drizzle');

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

/** Every migration before 0030, so a database can be seeded the way an install from before the
 * Support ask column left it. */
function seedPre0030MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((entry) => entry.idx < 30);
  expect(journal.entries[30]?.tag).toMatch(/^0030_/);
  const folder = join(root, 'drizzle-0029');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  for (const entry of kept) cpSync(join(REAL_MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  return folder;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0030-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('migration 0030 adds the Support ask state (#503)', () => {
  it('reads an older settings row as never asked, then stores and reads back a new state', () => {
    const seeded = new Database(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(seeded), { migrationsFolder: seedPre0030MigrationsFolder(dir) });
      seeded.prepare(`INSERT INTO app_settings (id, theme, welcome_seen) VALUES (1, 'dark', 1)`).run();
      const columns = seeded.prepare(`PRAGMA table_info(app_settings)`).all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toContain('support_prompt');
    } finally {
      seeded.close();
    }

    const { db, close } = createWorkspaceDb(dir);
    try {
      const older = workspace.getSettings(db);
      expect(older).toMatchObject({ theme: 'dark', welcomeSeen: true });
      expect(older.supportPrompt).toEqual({ answered: false, asks: 0, successesSinceDismissal: 0 });

      const updated = workspace.updateSettings(db, {
        supportPrompt: { answered: false, asks: 1, successesSinceDismissal: 2 },
      });
      expect(updated.supportPrompt).toEqual({ answered: false, asks: 1, successesSinceDismissal: 2 });
      expect(workspace.getSettings(db).supportPrompt).toEqual({ answered: false, asks: 1, successesSinceDismissal: 2 });
      // An unrelated update leaves the ask alone.
      expect(workspace.updateSettings(db, { theme: 'light' }).supportPrompt.asks).toBe(1);
    } finally {
      close();
    }
  });

  it('reads a malformed stored value as never asked rather than throwing', () => {
    const { db, close } = createWorkspaceDb(dir);
    try {
      workspace.getSettings(db);
    } finally {
      close();
    }
    const raw = new Database(join(dir, 'workspace.db'));
    try {
      raw.prepare(`UPDATE app_settings SET support_prompt = '{"answered":"maybe"}'`).run();
    } finally {
      raw.close();
    }
    const reopened = createWorkspaceDb(dir);
    try {
      expect(workspace.getSettings(reopened.db).supportPrompt).toEqual({
        answered: false,
        asks: 0,
        successesSinceDismissal: 0,
      });
    } finally {
      reopened.close();
    }
  });

  it('resets the ask with the rest of the data on "Delete my data"', () => {
    const { db, close } = createWorkspaceDb(dir);
    try {
      workspace.updateSettings(db, { supportPrompt: { answered: true, asks: 2, successesSinceDismissal: 0 } });
      const result = workspace.resetApplicationData(db);
      expect(result.settings.supportPrompt).toEqual({ answered: false, asks: 0, successesSinceDismissal: 0 });
    } finally {
      close();
    }
  });
});
