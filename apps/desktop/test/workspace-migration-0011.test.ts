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

/** Migration 0011 adds one nullable column, `submission_mode`, to `application_attempts` (#203) --
 * a plain `ALTER TABLE ADD COLUMN`, no rebuild, existing rows survive with it null. */

const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'workspace', 'drizzle');

const PRE_0011_TAGS = [
  '0000_familiar_giant_man',
  '0001_misty_hobgoblin',
  '0002_brainy_morgan_stark',
  '0003_curved_shotgun',
  '0004_damp_dust',
  '0005_lean_echo',
  '0006_old_karen_page',
  '0007_cheerful_talos',
  '0008_young_zemo',
  '0009_aspiring_rick_jones',
  '0010_smart_wolfsbane',
];

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

function seedPre0011MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((entry) => PRE_0011_TAGS.includes(entry.tag));
  expect(kept.map((entry) => entry.tag)).toEqual(PRE_0011_TAGS);
  expect(journal.entries[PRE_0011_TAGS.length]?.tag).toBe('0011_mixed_darkstar');

  const folder = join(root, 'drizzle-0010');
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0011-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the seeded fixture really is a pre-0011 database', () => {
  it('has no submission_mode column yet', () => {
    const folder = seedPre0011MigrationsFolder(dir);
    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(connection), { migrationsFolder: folder });
      const attemptColumns = connection.prepare('PRAGMA table_info(application_attempts)').all() as { name: string }[];
      expect(attemptColumns.map((c) => c.name)).not.toContain('submission_mode');
    } finally {
      connection.close();
    }
  });
});

describe('migration 0011 adds submission_mode', () => {
  it('is ALTER TABLE ADD COLUMN only, never a rebuild', () => {
    const sql = readFileSync(join(REAL_MIGRATIONS, '0011_mixed_darkstar.sql'), 'utf8');
    expect(sql).toMatch(/ALTER TABLE `application_attempts` ADD `submission_mode`/);
    expect(sql).not.toMatch(/CREATE TABLE `__new_/);
  });

  it('leaves an existing attempt row intact, with submission_mode null, on a genuinely new install', () => {
    const { close } = createWorkspaceDb(dir);
    try {
      const connection = openRaw(join(dir, 'workspace.db'));
      try {
        const attemptColumns = connection.prepare('PRAGMA table_info(application_attempts)').all() as { name: string }[];
        expect(attemptColumns.map((c) => c.name)).toContain('submission_mode');
      } finally {
        connection.close();
      }
    } finally {
      close();
    }
  });

  it('is a no-op the second time: reopening an already-migrated database applies nothing more', () => {
    createWorkspaceDb(dir).close();
    createWorkspaceDb(dir).close();

    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      const applied = connection.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
      const realMigrationCount = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')).entries.length as number;
      expect(applied.n).toBe(realMigrationCount);
    } finally {
      connection.close();
    }
  });
});
