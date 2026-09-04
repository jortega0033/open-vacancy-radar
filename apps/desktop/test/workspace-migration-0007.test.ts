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
 * Migration 0007 adds `app_settings.minimize_to_tray_on_close`, a plain additive boolean column
 * (see issue #194). Purely additive, so drizzle-kit generated a single `ALTER TABLE ... ADD`, no
 * table rebuild -- this suite mostly proves an existing row picks up the new column's default
 * without disturbing any of its other, already-stored values.
 */

const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'workspace', 'drizzle');

/** The tags this test pins the seeded database to: everything 0007 builds on top of. */
const PRE_0007_TAGS = [
  '0000_familiar_giant_man',
  '0001_misty_hobgoblin',
  '0002_brainy_morgan_stark',
  '0003_curved_shotgun',
  '0004_damp_dust',
  '0005_lean_echo',
  '0006_old_karen_page',
];

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

/**
 * Copies the real 0000-0006 migrations into `<root>/drizzle-0006` with a journal that stops there.
 * Fails loudly if the real journal ever stops matching `PRE_0007_TAGS`, so a future 0008 (or a
 * squashed history) cannot quietly turn this into a test of the wrong prior version.
 */
function seedPre0007MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((entry) => PRE_0007_TAGS.includes(entry.tag));
  expect(kept.map((entry) => entry.tag)).toEqual(PRE_0007_TAGS);
  expect(journal.entries[PRE_0007_TAGS.length]?.tag).toBe('0007_cheerful_talos');

  const folder = join(root, 'drizzle-0006');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  for (const entry of kept) {
    cpSync(join(REAL_MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  return folder;
}

/**
 * Copies the real 0000-0007 migrations into `<root>/drizzle-0007` with a journal that stops there.
 *
 * Used instead of `createWorkspaceDb` (which always applies the app's full, current migration
 * chain) for the tests below that verify 0007's own behavior specifically: migration 0008 later
 * adds an unrelated column on top, so running the full chain would make this file's own
 * migration-count assertions fail for a reason that has nothing to do with 0007 itself. Migration
 * history is immutable -- an earlier migration's regression test must keep proving what that
 * migration did at the time, independent of what a later migration adds on top.
 */
function seedThrough0007MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const tags = [...PRE_0007_TAGS, '0007_cheerful_talos'];
  const kept = journal.entries.filter((entry) => tags.includes(entry.tag));
  expect(kept.map((entry) => entry.tag)).toEqual(tags);

  const folder = join(root, 'drizzle-0007');
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

/** Builds a pre-0007 `workspace.db` with a settings row carrying real, non-default values on
 * several existing columns, so this migration proves it doesn't disturb any of them. */
function seedPre0007Database(): void {
  const folder = seedPre0007MigrationsFolder(dir);
  const connection = openRaw(join(dir, 'workspace.db'));
  try {
    migrate(drizzle(connection), { migrationsFolder: folder });
    connection
      .prepare(
        `INSERT INTO app_settings (id, launch_at_login, theme, default_location) VALUES (1, 1, 'dark', 'Germany')`,
      )
      .run();
  } finally {
    connection.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0007-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the seeded fixture really is a pre-0007 database', () => {
  it('has no minimize_to_tray_on_close column yet', () => {
    seedPre0007Database();
    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      const columns = connection.prepare('PRAGMA table_info(app_settings)').all() as { name: string }[];
      expect(columns.map((c) => c.name)).not.toContain('minimize_to_tray_on_close');
      const applied = connection.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
      expect(applied.n).toBe(PRE_0007_TAGS.length);
    } finally {
      connection.close();
    }
  });
});

describe('migration 0007 adds minimizeToTrayOnClose', () => {
  it('is a plain ADD COLUMN, no table rebuild', () => {
    const sql = readFileSync(join(REAL_MIGRATIONS, '0007_cheerful_talos.sql'), 'utf8');
    expect(sql).toMatch(/ALTER TABLE `app_settings` ADD `minimize_to_tray_on_close` integer DEFAULT false NOT NULL/);
    expect(sql).not.toMatch(/CREATE TABLE `__new_/);
  });

  it('applies cleanly to a populated database, adding the column without disturbing existing values', () => {
    seedPre0007Database();

    const through0007 = seedThrough0007MigrationsFolder(dir);
    const upgrade = openRaw(join(dir, 'workspace.db'));
    migrate(drizzle(upgrade), { migrationsFolder: through0007 });
    upgrade.close();

    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      const applied = connection.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
      expect(applied.n).toBe(PRE_0007_TAGS.length + 1);

      const columns = connection.prepare('PRAGMA table_info(app_settings)').all() as { name: string }[];
      expect(columns.map((c) => c.name)).toContain('minimize_to_tray_on_close');

      const row = connection
        .prepare('SELECT launch_at_login, theme, default_location, minimize_to_tray_on_close FROM app_settings WHERE id = 1')
        .get() as {
        launch_at_login: number;
        theme: string;
        default_location: string;
        minimize_to_tray_on_close: number;
      };
      // Existing values survive untouched.
      expect(row.launch_at_login).toBe(1);
      expect(row.theme).toBe('dark');
      expect(row.default_location).toBe('Germany');
      // New column reads its default.
      expect(row.minimize_to_tray_on_close).toBe(0);
    } finally {
      connection.close();
    }
  });

  it('gives a genuinely new install the bias-free default (off)', () => {
    const { db, close } = createWorkspaceDb(dir);
    try {
      const settings = workspace.getSettings(db);
      expect(settings.minimizeToTrayOnClose).toBe(false);
    } finally {
      close();
    }
  });

  it('is a no-op the second time: reopening an already-migrated database applies nothing more', () => {
    seedPre0007Database();

    const through0007 = seedThrough0007MigrationsFolder(dir);
    const firstOpen = openRaw(join(dir, 'workspace.db'));
    migrate(drizzle(firstOpen), { migrationsFolder: through0007 });
    firstOpen.close();
    const secondOpen = openRaw(join(dir, 'workspace.db'));
    migrate(drizzle(secondOpen), { migrationsFolder: through0007 });
    secondOpen.close();

    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      const applied = connection.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
      expect(applied.n).toBe(PRE_0007_TAGS.length + 1);
    } finally {
      connection.close();
    }
  });
});
