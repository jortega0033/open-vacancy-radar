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

/**
 * Migration 0008 adds `app_settings.auto_scan_enabled`, a plain additive boolean column (see issue
 * #195). Purely additive, so drizzle-kit generated a single `ALTER TABLE ... ADD`, no table
 * rebuild -- this suite mostly proves an existing row picks up the new column's default without
 * disturbing any of its other, already-stored values.
 */

const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'workspace', 'drizzle');

/** The tags this test pins the seeded database to: everything 0008 builds on top of. */
const PRE_0008_TAGS = [
  '0000_familiar_giant_man',
  '0001_misty_hobgoblin',
  '0002_brainy_morgan_stark',
  '0003_curved_shotgun',
  '0004_damp_dust',
  '0005_lean_echo',
  '0006_old_karen_page',
  '0007_cheerful_talos',
];

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

/**
 * Copies the real 0000-0007 migrations into `<root>/drizzle-0007` with a journal that stops there.
 * Fails loudly if the real journal ever stops matching `PRE_0008_TAGS`, so a future 0009 (or a
 * squashed history) cannot quietly turn this into a test of the wrong prior version.
 */
function seedPre0008MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((entry) => PRE_0008_TAGS.includes(entry.tag));
  expect(kept.map((entry) => entry.tag)).toEqual(PRE_0008_TAGS);
  expect(journal.entries[PRE_0008_TAGS.length]?.tag).toBe('0008_young_zemo');

  const folder = join(root, 'drizzle-0007');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  for (const entry of kept) {
    cpSync(join(REAL_MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  return folder;
}

/**
 * Copies the real 0000-0008 migrations into `<root>/drizzle-0008` with a journal that stops there.
 *
 * Used instead of `createWorkspaceDb` (which always applies the app's full, current migration
 * chain) for the tests below that verify 0008's own behavior specifically: migration 0009 later
 * adds unrelated tables on top, so running the full chain would make this file's own
 * migration-count assertions fail for a reason that has nothing to do with 0008 itself. Migration
 * history is immutable -- an earlier migration's regression test must keep proving what that
 * migration did at the time, independent of what a later migration adds on top.
 */
function seedThrough0008MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const tags = [...PRE_0008_TAGS, '0008_young_zemo'];
  const kept = journal.entries.filter((entry) => tags.includes(entry.tag));
  expect(kept.map((entry) => entry.tag)).toEqual(tags);

  const folder = join(root, 'drizzle-0008');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  for (const entry of kept) {
    cpSync(join(REAL_MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  return folder;
}

function openRaw(databasePath: string): Database.Database {
  const connection = new Database(databasePath);
  connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');
  return connection;
}

let dir: string;

/** Builds a pre-0008 `workspace.db` with a settings row carrying real, non-default values on
 * several existing columns, so this migration proves it doesn't disturb any of them. */
function seedPre0008Database(): void {
  const folder = seedPre0008MigrationsFolder(dir);
  const connection = openRaw(join(dir, 'workspace.db'));
  try {
    migrate(drizzle(connection), { migrationsFolder: folder });
    connection
      .prepare(
        `INSERT INTO app_settings (id, launch_at_login, theme, default_location, minimize_to_tray_on_close) VALUES (1, 1, 'dark', 'Germany', 1)`,
      )
      .run();
  } finally {
    connection.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0008-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the seeded fixture really is a pre-0008 database', () => {
  it('has no auto_scan_enabled column yet', () => {
    seedPre0008Database();
    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      const columns = connection.prepare('PRAGMA table_info(app_settings)').all() as { name: string }[];
      expect(columns.map((c) => c.name)).not.toContain('auto_scan_enabled');
      const applied = connection.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
      expect(applied.n).toBe(PRE_0008_TAGS.length);
    } finally {
      connection.close();
    }
  });
});

describe('migration 0008 adds autoScanEnabled', () => {
  it('is a plain ADD COLUMN, no table rebuild', () => {
    const sql = readFileSync(join(REAL_MIGRATIONS, '0008_young_zemo.sql'), 'utf8');
    expect(sql).toMatch(/ALTER TABLE `app_settings` ADD `auto_scan_enabled` integer DEFAULT false NOT NULL/);
    expect(sql).not.toMatch(/CREATE TABLE `__new_/);
  });

  it('applies cleanly to a populated database, adding the column without disturbing existing values', () => {
    seedPre0008Database();

    const through0008 = seedThrough0008MigrationsFolder(dir);
    const upgrade = openRaw(join(dir, 'workspace.db'));
    migrate(drizzle(upgrade), { migrationsFolder: through0008 });
    upgrade.close();

    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      const applied = connection.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
      expect(applied.n).toBe(PRE_0008_TAGS.length + 1);

      const columns = connection.prepare('PRAGMA table_info(app_settings)').all() as { name: string }[];
      expect(columns.map((c) => c.name)).toContain('auto_scan_enabled');

      const row = connection
        .prepare(
          'SELECT launch_at_login, theme, default_location, minimize_to_tray_on_close, auto_scan_enabled FROM app_settings WHERE id = 1',
        )
        .get() as {
        launch_at_login: number;
        theme: string;
        default_location: string;
        minimize_to_tray_on_close: number;
        auto_scan_enabled: number;
      };
      // Existing values survive untouched.
      expect(row.launch_at_login).toBe(1);
      expect(row.theme).toBe('dark');
      expect(row.default_location).toBe('Germany');
      expect(row.minimize_to_tray_on_close).toBe(1);
      // New column reads its default.
      expect(row.auto_scan_enabled).toBe(0);
    } finally {
      connection.close();
    }
  });

  it('gives a genuinely new install the bias-free default (off)', () => {
    const { db, close } = createWorkspaceDb(dir);
    try {
      const settings = workspace.getSettings(db);
      expect(settings.autoScanEnabled).toBe(false);
    } finally {
      close();
    }
  });

  it('is a no-op the second time: reopening an already-migrated database applies nothing more', () => {
    seedPre0008Database();

    const through0008 = seedThrough0008MigrationsFolder(dir);
    const firstOpen = openRaw(join(dir, 'workspace.db'));
    migrate(drizzle(firstOpen), { migrationsFolder: through0008 });
    firstOpen.close();
    const secondOpen = openRaw(join(dir, 'workspace.db'));
    migrate(drizzle(secondOpen), { migrationsFolder: through0008 });
    secondOpen.close();

    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      const applied = connection.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
      expect(applied.n).toBe(PRE_0008_TAGS.length + 1);
    } finally {
      connection.close();
    }
  });
});
