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
 * Migration 0012 adds one new table, `application_submission_receipts` (#271) -- the durable
 * evidence behind every claim this app makes about an application having been delivered. A pure
 * `CREATE TABLE`: `application_attempts` is not rebuilt, and no existing row is touched.
 *
 * The new `user_reported` checkpoint value needs no schema change at all: the checkpoint column's
 * `enum` is a Drizzle type-level constraint, never a SQL `CHECK`, so widening it is a TypeScript
 * change and nothing more. This file proves that too, since a rebuild would show up here.
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

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

function seedPre0012MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((entry) => PRE_0012_TAGS.includes(entry.tag));
  expect(kept.map((entry) => entry.tag)).toEqual(PRE_0012_TAGS);
  expect(journal.entries[PRE_0012_TAGS.length]?.tag).toBe('0012_many_jetstream');

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

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0012-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the seeded fixture really is a pre-0012 database', () => {
  it('has no application_submission_receipts table yet', () => {
    const folder = seedPre0012MigrationsFolder(dir);
    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(connection), { migrationsFolder: folder });
      const tables = connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
      expect(tables.map((t) => t.name)).not.toContain('application_submission_receipts');
    } finally {
      connection.close();
    }
  });
});

describe('migration 0012 adds the submission receipts table', () => {
  it('is CREATE TABLE only, never a rebuild of an existing table', () => {
    const sql = readFileSync(join(REAL_MIGRATIONS, '0012_many_jetstream.sql'), 'utf8');
    expect(sql).toMatch(/CREATE TABLE `application_submission_receipts`/);
    expect(sql).not.toMatch(/CREATE TABLE `__new_/);
    expect(sql).not.toMatch(/ALTER TABLE `application_attempts`/);
  });

  it('applies onto a real pre-0012 database, leaving existing attempt rows untouched', () => {
    const folder = seedPre0012MigrationsFolder(dir);
    const databasePath = join(dir, 'workspace.db');

    const before = openRaw(databasePath);
    try {
      migrate(drizzle(before), { migrationsFolder: folder });
      before
        .prepare(
          'INSERT INTO application_attempts (id, company, role, source_cv_content_hash, jd_snapshot_hash, checkpoint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run('attempt-1', 'Fixture Employer', 'Staff Engineer', 'a'.repeat(64), 'b'.repeat(64), 'submitting', Date.now(), Date.now());
    } finally {
      before.close();
    }

    const { db, close } = createWorkspaceDb(dir);
    try {
      const attempt = workspace.getApplicationAttempt(db, 'attempt-1');
      expect(attempt.checkpoint).toBe('submitting');
      expect(workspace.listApplicationSubmissionReceipts(db, 'attempt-1')).toEqual([]);
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
      const updated = workspace.updateApplicationAttempt(db, attempt.id, { checkpoint: 'user_reported' });
      expect(updated.checkpoint).toBe('user_reported');
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
