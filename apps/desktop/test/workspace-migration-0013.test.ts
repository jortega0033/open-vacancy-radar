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
 * Migration 0013 is the reconciliation of #271 and #275, which were built independently against
 * the same master and each generated a migration numbered 0012. Neither number survived: #294
 * landed the real 0012 (`cv_documents.source_cv`) first, so both were regenerated as this single
 * migration rather than being applied as two competing ones.
 *
 * It does exactly what the two separate migrations did between them, and nothing else:
 *
 *  - `CREATE TABLE application_submission_receipts` (#271), the durable evidence behind every claim
 *    this app makes about an application having been delivered;
 *  - seven `ALTER TABLE ... ADD COLUMN`s on `application_attempts` (#275), the derived requisition
 *    identity, the completion evidence type, and the explicit reapply record.
 *
 * No table is rebuilt, so no existing row is touched -- asserted below against a real pre-0013
 * database rather than by reading the schema module.
 *
 * The `user_reported` checkpoint value (#271) needs no schema change at all: the checkpoint
 * column's `enum` is a Drizzle type-level constraint, never a SQL `CHECK`, so widening it is a
 * TypeScript change and nothing more. This file proves that too, since a rebuild would show here.
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

/** The #275 columns, in the order migration 0013 adds them. */
const ADDED_COLUMNS = [
  'employer_key',
  'requisition_id',
  'canonical_url_key',
  'completion_evidence',
  'supersedes_attempt_id',
  'reapply_reason',
  'reapply_previous_cv_content_hash',
];

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

function readJournal(): Journal {
  return JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
}

/** The single migration this file is about, resolved from the journal rather than hardcoded, so a
 * regenerated migration with a different drizzle-kit name does not silently stop being tested. */
function migration0013Tag(): string {
  const entry = readJournal().entries[PRE_0013_TAGS.length];
  expect(entry?.tag).toMatch(/^0013_/);
  return entry!.tag;
}

function seedPre0013MigrationsFolder(root: string): string {
  const journal = readJournal();
  const kept = journal.entries.filter((entry) => PRE_0013_TAGS.includes(entry.tag));
  expect(kept.map((entry) => entry.tag)).toEqual(PRE_0013_TAGS);
  expect(journal.entries[PRE_0013_TAGS.length]?.tag).toMatch(/^0013_/);

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

function attemptColumns(connection: Database.Database): string[] {
  return (connection.prepare('PRAGMA table_info(application_attempts)').all() as { name: string }[]).map((c) => c.name);
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0013-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the seeded fixture really is a pre-0013 database', () => {
  it('has no application_submission_receipts table yet (#271)', () => {
    const folder = seedPre0013MigrationsFolder(dir);
    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(connection), { migrationsFolder: folder });
      const tables = connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
      expect(tables.map((t) => t.name)).not.toContain('application_submission_receipts');
    } finally {
      connection.close();
    }
  });

  it('has none of the #275 columns yet', () => {
    const folder = seedPre0013MigrationsFolder(dir);
    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(connection), { migrationsFolder: folder });
      const columns = attemptColumns(connection);
      for (const column of ADDED_COLUMNS) expect(columns).not.toContain(column);
    } finally {
      connection.close();
    }
  });

  it('already has #294\'s 0012 applied, so 0013 really is the next number', () => {
    const folder = seedPre0013MigrationsFolder(dir);
    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(connection), { migrationsFolder: folder });
      const columns = (connection.prepare('PRAGMA table_info(cv_documents)').all() as { name: string }[]).map((c) => c.name);
      expect(columns).toContain('source_cv');
    } finally {
      connection.close();
    }
  });
});

describe('migration 0013 combines the #271 receipts table and the #275 attempt columns', () => {
  it('creates the receipts table and adds the attempt columns, without rebuilding anything', () => {
    const sql = readFileSync(join(REAL_MIGRATIONS, `${migration0013Tag()}.sql`), 'utf8');

    // #271: a plain CREATE TABLE.
    expect(sql).toMatch(/CREATE TABLE `application_submission_receipts`/);
    // #275: ADD COLUMN only, every one of them.
    for (const column of ADDED_COLUMNS) {
      expect(sql).toContain(`ALTER TABLE \`application_attempts\` ADD \`${column}\``);
    }
    // Neither ticket's migration rebuilt a table, and the combined one must not either: a rebuild
    // is how an ALTER-only migration quietly turns into data loss on an existing workspace.
    expect(sql).not.toMatch(/CREATE TABLE `__new_/);
    expect(sql).not.toMatch(/DROP TABLE/);
  });

  it('is the only 0013, and nothing re-numbered an already-released migration', () => {
    const entries = readJournal().entries;
    const tags = entries.map((entry) => entry.tag);
    expect(tags.filter((tag) => tag.startsWith('0013_'))).toHaveLength(1);
    // The two superseded 0012s from the original branches must be gone, and #294's must stand.
    expect(tags).toContain('0012_nosy_veda');
    expect(tags).not.toContain('0012_many_jetstream');
    expect(tags).not.toContain('0012_petite_doctor_faustus');
    expect(entries.map((entry) => entry.idx)).toEqual(entries.map((_, index) => index));
  });

  it('applies onto a real pre-0013 database, leaving an existing attempt row untouched', () => {
    const folder = seedPre0013MigrationsFolder(dir);
    const seeded = openRaw(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(seeded), { migrationsFolder: folder });
      seeded
        .prepare(
          `INSERT INTO application_attempts
             (id, vacancy_key, canonical_url, company, role, source_cv_content_hash, jd_snapshot_hash, checkpoint, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', 1788000000000, 1788000000000)`,
        )
        .run(
          'legacy-attempt',
          'scan-legacy',
          'https://boards.greenhouse.io/northwindlabs/jobs/4012345',
          'Northwind Labs',
          'Platform Engineer',
          'a'.repeat(64),
          'b'.repeat(64),
        );
    } finally {
      seeded.close();
    }

    const { db, close } = createWorkspaceDb(dir);
    try {
      const attempt = workspace.getApplicationAttempt(db, 'legacy-attempt');
      // Everything it already had survives...
      expect(attempt.checkpoint).toBe('submitted');
      expect(attempt.company).toBe('Northwind Labs');
      expect(attempt.canonicalUrl).toBe('https://boards.greenhouse.io/northwindlabs/jobs/4012345');
      // ...the new #275 columns read back as the empty/unrecorded state, not as undefined...
      expect(attempt.employerKey).toBe('');
      expect(attempt.requisitionId).toBeNull();
      expect(attempt.canonicalUrlKey).toBe('');
      expect(attempt.completionEvidence).toBeNull();
      expect(attempt.supersedesAttemptId).toBeNull();
      expect(attempt.reapplyReason).toBe('');
      expect(attempt.reapplyPreviousCvContentHash).toBeNull();
      // ...and #271's receipts table exists and is empty for it.
      expect(workspace.listApplicationSubmissionReceipts(db, 'legacy-attempt')).toEqual([]);

      // An empty identity matches nothing: a different posting stays eligible...
      expect(
        workspace.findCompletedApplication(db, {
          company: 'Someone Else',
          canonicalUrl: 'https://boards.greenhouse.io/otherboard/jobs/999',
        }),
      ).toBeUndefined();
      // ...while the row's own vacancy key still protects the posting it really was.
      expect(
        workspace.findCompletedApplication(db, {
          company: 'Northwind Labs',
          vacancyKey: 'scan-legacy',
        }),
      ).toMatchObject({ attemptId: 'legacy-attempt', matchedOn: 'vacancy_key' });
    } finally {
      close();
    }
  });

  it('cascades a receipt away with its attempt, the way an artifact already does', () => {
    const { db, close } = createWorkspaceDb(dir);
    try {
      const attempt = workspace.createApplicationAttempt(db, {
        company: 'Fixture Employer',
        role: 'Staff Engineer',
        sourceCvContentHash: 'a'.repeat(64),
        jdSnapshotHash: 'b'.repeat(64),
      });
      workspace.createApplicationSubmissionReceipt(db, {
        attemptId: attempt.id,
        outcome: 'unknown',
        source: 'page_observation',
        evidenceKind: 'none',
        detail: 'nothing conclusive was observed',
      });
      expect(workspace.listApplicationSubmissionReceipts(db, attempt.id)).toHaveLength(1);

      workspace.deleteApplicationAttempt(db, attempt.id);
      expect(workspace.listApplicationSubmissionReceipts(db, attempt.id)).toEqual([]);
    } finally {
      close();
    }
  });

  it('accepts the new user_reported checkpoint without any SQL constraint standing in the way', () => {
    const { db, close } = createWorkspaceDb(dir);
    try {
      const attempt = workspace.createApplicationAttempt(db, {
        company: 'Fixture Employer',
        role: 'Staff Engineer',
        sourceCvContentHash: 'a'.repeat(64),
        jdSnapshotHash: 'b'.repeat(64),
      });
      const updated = workspace.updateApplicationAttempt(db, attempt.id, {
        checkpoint: 'user_reported',
        completionEvidence: 'user_reported',
      });
      expect(updated.checkpoint).toBe('user_reported');
      expect(updated.completionEvidence).toBe('user_reported');
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
      expect(applied.n).toBe(readJournal().entries.length);
    } finally {
      connection.close();
    }
  });
});
