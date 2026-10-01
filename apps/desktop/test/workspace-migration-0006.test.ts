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
 * Migration 0006 drops the curated Netherlands pipeline's last remaining trace from the workspace
 * database: `app_settings.default_market` / `.sponsor_only_default` / `.ind_verification_enabled`,
 * and `market` off both `saved_jobs` and `applications`. There is no data-preservation concern here
 * (confirmed with the user: no real installs to protect, drop entirely) -- this suite exists to
 * prove the migration applies cleanly to a populated database and leaves the right columns gone,
 * not to prove any value survives.
 *
 * SQLite in this app's runtime supports `ALTER TABLE ... DROP COLUMN` directly, so drizzle-kit
 * generated five plain drops rather than a create-copy-drop-rename rebuild.
 */

const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'workspace', 'drizzle');

/** The tags this test pins the seeded database to: everything 0006 builds on top of. */
const PRE_0006_TAGS = [
  '0000_familiar_giant_man',
  '0001_misty_hobgoblin',
  '0002_brainy_morgan_stark',
  '0003_curved_shotgun',
  '0004_damp_dust',
  '0005_lean_echo',
];

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

/**
 * Copies the real 0000-0005 migrations into `<root>/drizzle-0005` with a journal that stops there.
 * Fails loudly if the real journal ever stops matching `PRE_0006_TAGS`, so a future 0007 (or a
 * squashed history) cannot quietly turn this into a test of the wrong prior version.
 */
function seedPre0006MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((entry) => PRE_0006_TAGS.includes(entry.tag));
  expect(kept.map((entry) => entry.tag)).toEqual(PRE_0006_TAGS);
  expect(journal.entries[PRE_0006_TAGS.length]?.tag).toBe('0006_old_karen_page');

  const folder = join(root, 'drizzle-0005');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  for (const entry of kept) {
    cpSync(join(REAL_MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  return folder;
}

/**
 * Copies the real 0000-0006 migrations into `<root>/drizzle-0006` with a journal that stops there.
 *
 * Used instead of `createWorkspaceDb` (which always applies the app's full, current migration
 * chain) for the tests below that verify 0006's own behavior specifically: migration 0007 later
 * adds an unrelated column on top, so running the full chain would make this file's own
 * migration-count assertions fail for a reason that has nothing to do with 0006 itself. Migration
 * history is immutable -- an earlier migration's regression test must keep proving what that
 * migration did at the time, independent of what a later migration adds on top.
 */
function seedThrough0006MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const tags = [...PRE_0006_TAGS, '0006_old_karen_page'];
  const kept = journal.entries.filter((entry) => tags.includes(entry.tag));
  expect(kept.map((entry) => entry.tag)).toEqual(tags);

  const folder = join(root, 'drizzle-0006');
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

/**
 * Builds a pre-0006 `workspace.db` with a settings row and one saved job / one application, each
 * carrying a real `market` value -- exactly the shape a real install would have accumulated before
 * this migration.
 */
function seedPre0006Database(): void {
  const folder = seedPre0006MigrationsFolder(dir);
  const connection = openRaw(join(dir, 'workspace.db'));
  try {
    migrate(drizzle(connection), { migrationsFolder: folder });
    connection
      .prepare(
        `INSERT INTO app_settings (id, default_market, default_location, sponsor_only_default, ind_verification_enabled) VALUES (1, 'netherlands', 'Netherlands', 1, 1)`,
      )
      .run();
    connection
      .prepare(
        `INSERT INTO saved_jobs (id, role, company, market, location, saved_at) VALUES ('job-1', 'Engineer', 'Acme', 'netherlands', 'Amsterdam', ?)`,
      )
      .run(Date.now());
    connection
      .prepare(
        `INSERT INTO applications (id, role, company, market, location) VALUES ('app-1', 'Engineer', 'Acme', 'netherlands', 'Amsterdam')`,
      )
      .run();
  } finally {
    connection.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0006-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the seeded fixture really is a pre-0006 database', () => {
  it('has the market columns, from the pre-0006 schema', () => {
    seedPre0006Database();
    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      const savedJob = connection.prepare('SELECT market FROM saved_jobs WHERE id = ?').get('job-1') as {
        market: string;
      };
      expect(savedJob.market).toBe('netherlands');
      const applied = connection.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
      expect(applied.n).toBe(PRE_0006_TAGS.length);
    } finally {
      connection.close();
    }
  });
});

describe('migration 0006 drops the curated-pipeline columns', () => {
  it('is DROP COLUMN only, no table rebuild', () => {
    const sql = readFileSync(join(REAL_MIGRATIONS, '0006_old_karen_page.sql'), 'utf8');
    expect(sql).toMatch(/ALTER TABLE `app_settings` DROP COLUMN `default_market`/);
    expect(sql).toMatch(/ALTER TABLE `app_settings` DROP COLUMN `sponsor_only_default`/);
    expect(sql).toMatch(/ALTER TABLE `app_settings` DROP COLUMN `ind_verification_enabled`/);
    expect(sql).toMatch(/ALTER TABLE `applications` DROP COLUMN `market`/);
    expect(sql).toMatch(/ALTER TABLE `saved_jobs` DROP COLUMN `market`/);
    expect(sql).not.toMatch(/CREATE TABLE `__new_/);
  });

  it('applies cleanly to a populated database and removes the columns', () => {
    seedPre0006Database();

    const through0006 = seedThrough0006MigrationsFolder(dir);
    const upgrade = openRaw(join(dir, 'workspace.db'));
    migrate(drizzle(upgrade), { migrationsFolder: through0006 });
    upgrade.close();

    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      const applied = connection.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
      expect(applied.n).toBe(PRE_0006_TAGS.length + 1);

      const settingsColumns = connection.prepare('PRAGMA table_info(app_settings)').all() as { name: string }[];
      const settingsNames = settingsColumns.map((c) => c.name);
      expect(settingsNames).not.toContain('default_market');
      expect(settingsNames).not.toContain('sponsor_only_default');
      expect(settingsNames).not.toContain('ind_verification_enabled');
      expect(settingsNames).toContain('default_location');

      const savedJobColumns = connection.prepare('PRAGMA table_info(saved_jobs)').all() as { name: string }[];
      expect(savedJobColumns.map((c) => c.name)).not.toContain('market');

      const applicationColumns = connection.prepare('PRAGMA table_info(applications)').all() as { name: string }[];
      expect(applicationColumns.map((c) => c.name)).not.toContain('market');

      // The rows themselves survive the drop: only the one column is gone.
      const savedJob = connection.prepare('SELECT role, location FROM saved_jobs WHERE id = ?').get('job-1') as {
        role: string;
        location: string;
      };
      expect(savedJob).toEqual({ role: 'Engineer', location: 'Amsterdam' });

      const settingsRow = connection.prepare('SELECT default_location FROM app_settings WHERE id = 1').get() as {
        default_location: string;
      };
      expect(settingsRow.default_location).toBe('Netherlands');
    } finally {
      connection.close();
    }
  });

  it('gives a genuinely new install the expected settings shape', () => {
    const { db, close } = createWorkspaceDb(dir);
    try {
      const settings = workspace.getSettings(db);
      expect(settings).not.toHaveProperty('defaultMarket');
      expect(settings).not.toHaveProperty('sponsorOnlyDefault');
      expect(settings).not.toHaveProperty('indVerificationEnabled');
      expect(settings.defaultLocation).toBe('');
    } finally {
      close();
    }
  });

  it('is a no-op the second time: reopening an already-migrated database applies nothing more', () => {
    seedPre0006Database();

    const through0006 = seedThrough0006MigrationsFolder(dir);
    const firstOpen = openRaw(join(dir, 'workspace.db'));
    migrate(drizzle(firstOpen), { migrationsFolder: through0006 });
    firstOpen.close();
    const secondOpen = openRaw(join(dir, 'workspace.db'));
    migrate(drizzle(secondOpen), { migrationsFolder: through0006 });
    secondOpen.close();

    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      const applied = connection.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
      expect(applied.n).toBe(PRE_0006_TAGS.length + 1);
    } finally {
      connection.close();
    }
  });
});
