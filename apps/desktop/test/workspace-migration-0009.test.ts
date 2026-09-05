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
 * Migration 0009 adds `application_attempts` and `application_artifacts` (#198): two brand-new
 * tables, no existing column touched. Purely additive `CREATE TABLE` statements, so this suite is
 * mostly about proving the tables exist with the right shape and foreign keys, rather than proving
 * an existing row survives (there is no existing row of this shape to survive).
 */

const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'workspace', 'drizzle');

const PRE_0009_TAGS = [
  '0000_familiar_giant_man',
  '0001_misty_hobgoblin',
  '0002_brainy_morgan_stark',
  '0003_curved_shotgun',
  '0004_damp_dust',
  '0005_lean_echo',
  '0006_old_karen_page',
  '0007_cheerful_talos',
  '0008_young_zemo',
];

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

function seedPre0009MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((entry) => PRE_0009_TAGS.includes(entry.tag));
  expect(kept.map((entry) => entry.tag)).toEqual(PRE_0009_TAGS);
  expect(journal.entries[PRE_0009_TAGS.length]?.tag).toBe('0009_aspiring_rick_jones');

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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0009-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the seeded fixture really is a pre-0009 database', () => {
  it('has neither new table yet', () => {
    const folder = seedPre0009MigrationsFolder(dir);
    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(connection), { migrationsFolder: folder });
      const tables = connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[];
      expect(tables.map((t) => t.name)).not.toContain('application_attempts');
      expect(tables.map((t) => t.name)).not.toContain('application_artifacts');
    } finally {
      connection.close();
    }
  });
});

describe('migration 0009 adds application_attempts and application_artifacts', () => {
  it('is CREATE TABLE only, no rebuild of any existing table', () => {
    const sql = readFileSync(join(REAL_MIGRATIONS, '0009_aspiring_rick_jones.sql'), 'utf8');
    expect(sql).toMatch(/CREATE TABLE `application_attempts`/);
    expect(sql).toMatch(/CREATE TABLE `application_artifacts`/);
    expect(sql).not.toMatch(/CREATE TABLE `__new_/);
    expect(sql).not.toMatch(/ALTER TABLE `(applications|cv_documents|saved_jobs|letters|app_settings)`/);
  });

  it('creates both tables with working foreign keys, on a genuinely new install', () => {
    const { close } = createWorkspaceDb(dir);
    try {
      const connection = openRaw(join(dir, 'workspace.db'));
      try {
        const tables = connection
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[];
        expect(tables.map((t) => t.name)).toEqual(
          expect.arrayContaining(['application_attempts', 'application_artifacts']),
        );

        const attemptColumns = connection.prepare('PRAGMA table_info(application_attempts)').all() as {
          name: string;
        }[];
        expect(attemptColumns.map((c) => c.name)).toEqual(
          expect.arrayContaining([
            'id',
            'application_id',
            'vacancy_key',
            'canonical_url',
            'company',
            'role',
            'source_cv_id',
            'source_cv_content_hash',
            'jd_snapshot',
            'jd_snapshot_hash',
            'jd_complete',
            'workflow_version',
            'checkpoint',
            'checkpoint_detail',
            'created_at',
            'updated_at',
            'submitted_at',
          ]),
        );

        const artifactColumns = connection.prepare('PRAGMA table_info(application_artifacts)').all() as {
          name: string;
        }[];
        expect(artifactColumns.map((c) => c.name)).toEqual(
          expect.arrayContaining([
            'id',
            'attempt_id',
            'kind',
            'file_name',
            'mime_type',
            'byte_size',
            'content_hash',
            'storage_path',
            'created_at',
          ]),
        );
      } finally {
        connection.close();
      }
    } finally {
      close();
    }
  });

  it('cascades: deleting an attempt deletes its artifacts', () => {
    createWorkspaceDb(dir).close();

    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      const now = Date.now();
      connection
        .prepare(
          `INSERT INTO application_attempts (id, company, role, source_cv_content_hash, jd_snapshot_hash, created_at, updated_at)
           VALUES ('attempt-1', 'Acme', 'Engineer', ?, ?, ?, ?)`,
        )
        .run('a'.repeat(64), 'b'.repeat(64), now, now);
      connection
        .prepare(
          `INSERT INTO application_artifacts (id, attempt_id, kind, mime_type, byte_size, content_hash, created_at)
           VALUES ('artifact-1', 'attempt-1', 'cv_pdf', 'application/pdf', 1024, ?, ?)`,
        )
        .run('c'.repeat(64), now);

      connection.prepare(`DELETE FROM application_attempts WHERE id = 'attempt-1'`).run();

      const remaining = connection
        .prepare(`SELECT id FROM application_artifacts WHERE id = 'artifact-1'`)
        .all();
      expect(remaining).toHaveLength(0);
    } finally {
      connection.close();
    }
  });

  it('is a no-op the second time: reopening an already-migrated database applies nothing more', () => {
    createWorkspaceDb(dir).close();
    createWorkspaceDb(dir).close();

    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      const applied = connection.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
      expect(applied.n).toBe(PRE_0009_TAGS.length + 1);
    } finally {
      connection.close();
    }
  });
});
