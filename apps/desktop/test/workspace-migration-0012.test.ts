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
 * Migration 0012 adds #275's seven columns to `application_attempts` -- the derived requisition
 * identity, the completion-evidence type and the reapply record -- as plain
 * `ALTER TABLE ADD COLUMN`s, no rebuild.
 *
 * The behaviour worth pinning is what happens to an attempt that already existed: it keeps every
 * value it had, and gets an *empty* identity rather than a missing one. An empty identity matches
 * no posting, so a pre-#275 row can neither be mistaken for a completed application at some other
 * requisition nor lose the row it already was.
 */

const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'workspace', 'drizzle');

const PRE_0012_TAGS = [
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
];

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

function seedPre0012MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((entry) => PRE_0012_TAGS.includes(entry.tag));
  expect(kept.map((entry) => entry.tag)).toEqual(PRE_0012_TAGS);
  expect(journal.entries[PRE_0012_TAGS.length]?.tag).toBe('0012_petite_doctor_faustus');

  const folder = join(root, 'drizzle-0011');
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
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0012-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the seeded fixture really is a pre-0012 database', () => {
  it('has none of the #275 columns yet', () => {
    const folder = seedPre0012MigrationsFolder(dir);
    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(connection), { migrationsFolder: folder });
      const columns = attemptColumns(connection);
      for (const column of ADDED_COLUMNS) expect(columns).not.toContain(column);
    } finally {
      connection.close();
    }
  });
});

describe('migration 0012 adds the #275 identity, evidence and reapply columns', () => {
  it('is ALTER TABLE ADD COLUMN only, never a rebuild', () => {
    const sql = readFileSync(join(REAL_MIGRATIONS, '0012_petite_doctor_faustus.sql'), 'utf8');
    for (const column of ADDED_COLUMNS) {
      expect(sql).toContain(`ALTER TABLE \`application_attempts\` ADD \`${column}\``);
    }
    expect(sql).not.toMatch(/CREATE TABLE `__new_/);
  });

  it('carries an existing attempt row forward with an empty identity rather than a missing one', () => {
    const folder = seedPre0012MigrationsFolder(dir);
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
      // ...and the new columns read back as the empty/unrecorded state, not as undefined.
      expect(attempt.employerKey).toBe('');
      expect(attempt.requisitionId).toBeNull();
      expect(attempt.canonicalUrlKey).toBe('');
      expect(attempt.completionEvidence).toBeNull();
      expect(attempt.supersedesAttemptId).toBeNull();
      expect(attempt.reapplyReason).toBe('');
      expect(attempt.reapplyPreviousCvContentHash).toBeNull();

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
