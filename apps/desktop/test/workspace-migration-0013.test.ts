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
 * Migration 0013 adds one column, `prepared_fields`, to `application_attempts` (#272) -- a plain
 * `ALTER TABLE ADD COLUMN` with a `''` default, no rebuild.
 *
 * The half worth testing is what an existing attempt *means* afterwards. An attempt recorded before
 * this column existed was never prepared by the pipeline, and must come back saying exactly that:
 * `preparedFields: null`, so the review shows "this app has no record of filling this form" rather
 * than an empty answer list that reads like a form with nothing in it.
 */

const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'workspace', 'drizzle');

const PRE_0013_TAGS = [
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
  '0011_mixed_darkstar',
  '0012_nosy_veda',
];

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

function seedPre0013MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((entry) => PRE_0013_TAGS.includes(entry.tag));
  expect(kept.map((entry) => entry.tag)).toEqual(PRE_0013_TAGS);
  expect(journal.entries[PRE_0013_TAGS.length]?.tag).toBe('0013_last_komodo');

  const folder = join(root, 'drizzle-0012');
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

/** The row a pre-#272 install would hold: an attempt with no prepared-fields column at all. */
function insertLegacyAttempt(connection: Database.Database, id: string): void {
  const now = Date.now();
  connection
    .prepare(
      `INSERT INTO application_attempts
         (id, canonical_url, company, role, source_cv_content_hash, jd_snapshot, jd_snapshot_hash, jd_complete,
          workflow_version, checkpoint, checkpoint_detail, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, '', 'ready', '', ?, ?)`,
    )
    .run(id, 'https://jobs.example.invalid/apply/1', 'Northwind Freight', 'Logistics Platform Engineer', 'cv-hash', 'JD text', 'jd-hash', now, now);
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0013-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the seeded fixture really is a pre-0013 database', () => {
  it('has no prepared_fields column yet', () => {
    const folder = seedPre0013MigrationsFolder(dir);
    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(connection), { migrationsFolder: folder });
      const columns = connection.prepare('PRAGMA table_info(application_attempts)').all() as { name: string }[];
      expect(columns.map((column) => column.name)).not.toContain('prepared_fields');
    } finally {
      connection.close();
    }
  });
});

describe('migration 0013 adds prepared_fields to application_attempts', () => {
  it('is ALTER TABLE ADD COLUMN only, never a rebuild and never a drop', () => {
    const sql = readFileSync(join(REAL_MIGRATIONS, '0013_last_komodo.sql'), 'utf8');
    expect(sql).toMatch(/ALTER TABLE `application_attempts` ADD `prepared_fields`/);
    expect(sql).not.toMatch(/CREATE TABLE `__new_/);
    expect(sql).not.toMatch(/DROP/i);
  });

  it('leaves an existing attempt intact, reporting honestly that nothing prepared it', () => {
    const folder = seedPre0013MigrationsFolder(dir);
    const seeded = openRaw(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(seeded), { migrationsFolder: folder });
      insertLegacyAttempt(seeded, 'attempt-legacy');
    } finally {
      seeded.close();
    }

    const { db, close } = createWorkspaceDb(dir);
    try {
      const migrated = workspace.getApplicationAttempt(db, 'attempt-legacy');
      expect(migrated.company).toBe('Northwind Freight');
      expect(migrated.checkpoint).toBe('ready');
      expect(migrated.preparedFields).toBeNull();
    } finally {
      close();
    }
  });

  it('round-trips a prepared-fields record, and reads an unrecognisable one back as absent', () => {
    const { db, close } = createWorkspaceDb(dir);
    try {
      const attempt = workspace.createApplicationAttempt(db, {
        canonicalUrl: 'https://jobs.example.invalid/apply/2',
        company: 'Northwind Freight',
        role: 'Logistics Platform Engineer',
        sourceCvContentHash: 'cv-hash',
        jdSnapshotHash: 'jd-hash',
      });

      const stored = workspace.recordPreparedApplicationFields(db, attempt.id, {
        version: 1,
        preparedAt: '2026-09-11T12:00:00.000Z',
        company: 'Northwind Freight',
        role: 'Logistics Platform Engineer',
        verification: 'applied',
        fields: [{ label: 'fullName', controlType: 'text', required: true, status: 'committed', value: 'Jamie Rivera', provenance: 'cv' }],
      });
      expect(stored.preparedFields?.fields[0]).toMatchObject({ value: 'Jamie Rivera', provenance: 'cv' });
      expect(workspace.getApplicationAttempt(db, attempt.id).preparedFields?.fields).toHaveLength(1);

      // Fail closed, not half-parsed: a record this build cannot interpret is no record at all,
      // rather than a partially-read one presented as what the app committed. Written through a
      // second raw connection, because there is no repository call that could store one.
      const tamper = (value: string): void => {
        const raw = openRaw(join(dir, 'workspace.db'));
        try {
          raw.prepare('UPDATE application_attempts SET prepared_fields = ? WHERE id = ?').run(value, attempt.id);
        } finally {
          raw.close();
        }
      };

      tamper('{"version":99}');
      expect(workspace.getApplicationAttempt(db, attempt.id).preparedFields).toBeNull();

      tamper('not json at all');
      expect(workspace.getApplicationAttempt(db, attempt.id).preparedFields).toBeNull();

      expect(workspace.recordPreparedApplicationFields(db, attempt.id, null).preparedFields).toBeNull();
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
      const realMigrationCount = (JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal).entries.length;
      expect(applied.n).toBe(realMigrationCount);
    } finally {
      connection.close();
    }
  });
});
