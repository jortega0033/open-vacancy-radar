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

/**
 * Migration 0010 adds `automation_grants` (a brand-new table, issue #203) and two nullable
 * columns on the existing `application_attempts` (`form_structure_hash`,
 * `scheduled_automatic_submit_at`). A plain `ALTER TABLE ADD COLUMN` for both -- no rebuild, no
 * `__new_application_attempts` -- so an existing row survives untouched with the new columns null.
 */

const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'workspace', 'drizzle');

const PRE_0010_TAGS = [
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
];

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

function seedPre0010MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((entry) => PRE_0010_TAGS.includes(entry.tag));
  expect(kept.map((entry) => entry.tag)).toEqual(PRE_0010_TAGS);
  expect(journal.entries[PRE_0010_TAGS.length]?.tag).toBe('0010_smart_wolfsbane');

  const folder = join(root, 'drizzle-0009');
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
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0010-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the seeded fixture really is a pre-0010 database', () => {
  it('has no automation_grants table and no new attempt columns yet', () => {
    const folder = seedPre0010MigrationsFolder(dir);
    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(connection), { migrationsFolder: folder });
      const tables = connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
      expect(tables.map((t) => t.name)).not.toContain('automation_grants');

      const attemptColumns = connection.prepare('PRAGMA table_info(application_attempts)').all() as { name: string }[];
      expect(attemptColumns.map((c) => c.name)).not.toContain('form_structure_hash');
      expect(attemptColumns.map((c) => c.name)).not.toContain('scheduled_automatic_submit_at');
    } finally {
      connection.close();
    }
  });
});

describe('migration 0010 adds automation_grants and two application_attempts columns', () => {
  it('is CREATE TABLE + ALTER TABLE ADD COLUMN only, never a rebuild of application_attempts', () => {
    const sql = readFileSync(join(REAL_MIGRATIONS, '0010_smart_wolfsbane.sql'), 'utf8');
    expect(sql).toMatch(/CREATE TABLE `automation_grants`/);
    expect(sql).toMatch(/ALTER TABLE `application_attempts` ADD `form_structure_hash`/);
    expect(sql).toMatch(/ALTER TABLE `application_attempts` ADD `scheduled_automatic_submit_at`/);
    expect(sql).not.toMatch(/CREATE TABLE `__new_/);
  });

  it('creates automation_grants with the right shape, on a genuinely new install', () => {
    const { close } = createWorkspaceDb(dir);
    try {
      const connection = openRaw(join(dir, 'workspace.db'));
      try {
        const tables = connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
        expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['automation_grants']));

        const grantColumns = connection.prepare('PRAGMA table_info(automation_grants)').all() as { name: string }[];
        expect(grantColumns.map((c) => c.name)).toEqual(
          expect.arrayContaining(['id', 'policy_id', 'created_at', 'expires_at', 'revoked_at']),
        );

        const attemptColumns = connection.prepare('PRAGMA table_info(application_attempts)').all() as { name: string }[];
        expect(attemptColumns.map((c) => c.name)).toEqual(
          expect.arrayContaining(['form_structure_hash', 'scheduled_automatic_submit_at']),
        );
      } finally {
        connection.close();
      }
    } finally {
      close();
    }
  });

  it('leaves an existing attempt row intact, with both new columns null', () => {
    const folder = seedPre0010MigrationsFolder(dir);
    const connection = openRaw(join(dir, 'workspace.db'));
    const now = Date.now();
    try {
      migrate(drizzle(connection), { migrationsFolder: folder });
      connection
        .prepare(
          `INSERT INTO application_attempts (id, company, role, source_cv_content_hash, jd_snapshot_hash, created_at, updated_at)
           VALUES ('attempt-1', 'Acme', 'Engineer', ?, ?, ?, ?)`,
        )
        .run('a'.repeat(64), 'b'.repeat(64), now, now);
    } finally {
      connection.close();
    }

    const { close } = createWorkspaceDb(dir);
    try {
      const reconnection = openRaw(join(dir, 'workspace.db'));
      try {
        const row = reconnection.prepare('SELECT * FROM application_attempts WHERE id = ?').get('attempt-1') as Record<string, unknown>;
        expect(row.company).toBe('Acme');
        expect(row.form_structure_hash).toBeNull();
        expect(row.scheduled_automatic_submit_at).toBeNull();
      } finally {
        reconnection.close();
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
      expect(applied.n).toBe(PRE_0010_TAGS.length + 1);
    } finally {
      connection.close();
    }
  });
});
