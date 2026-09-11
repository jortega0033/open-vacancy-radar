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

const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'workspace', 'drizzle');

const PRE_0014_TAGS = [
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
  '0013_soft_obadiah_stane',
];

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

function readJournal(): Journal {
  return JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
}

function migration0014Tag(): string {
  const entry = readJournal().entries[PRE_0014_TAGS.length];
  expect(entry?.tag).toMatch(/^0014_/);
  return entry!.tag;
}

function seedPre0014MigrationsFolder(root: string): string {
  const journal = readJournal();
  const kept = journal.entries.filter((entry) => PRE_0014_TAGS.includes(entry.tag));
  expect(kept.map((entry) => entry.tag)).toEqual(PRE_0014_TAGS);

  const folder = join(root, 'drizzle-0013');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  for (const entry of kept) cpSync(join(REAL_MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
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
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0014-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('migration 0014 adds prepared_fields to application_attempts', () => {
  it('is ALTER TABLE ADD COLUMN only', () => {
    const sql = readFileSync(join(REAL_MIGRATIONS, `${migration0014Tag()}.sql`), 'utf8');
    expect(sql).toMatch(/ALTER TABLE `application_attempts` ADD `prepared_fields` text DEFAULT '' NOT NULL/);
    expect(sql).not.toMatch(/CREATE TABLE `__new_/);
    expect(sql).not.toMatch(/DROP TABLE/i);
  });

  it('leaves legacy attempts intact and reports no prepared fields', () => {
    const folder = seedPre0014MigrationsFolder(dir);
    const seeded = openRaw(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(seeded), { migrationsFolder: folder });
      seeded
        .prepare(
          `INSERT INTO application_attempts
             (id, vacancy_key, canonical_url, company, role, source_cv_content_hash, jd_snapshot_hash, checkpoint, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', 1788000000000, 1788000000000)`,
        )
        .run('legacy-attempt', 'scan-legacy', 'https://jobs.example.invalid/apply/1', 'Northwind Freight', 'Logistics Platform Engineer', 'a'.repeat(64), 'b'.repeat(64));
    } finally {
      seeded.close();
    }

    const { db, close } = createWorkspaceDb(dir);
    try {
      const migrated = workspace.getApplicationAttempt(db, 'legacy-attempt');
      expect(migrated.checkpoint).toBe('ready');
      expect(migrated.preparedFields).toBeNull();
      expect(migrated.completionEvidence).toBeNull();
      expect(migrated.reapplyReason).toBe('');
    } finally {
      close();
    }
  });

  it('round-trips prepared fields and fails closed on unknown JSON', () => {
    const { db, close } = createWorkspaceDb(dir);
    try {
      const attempt = workspace.createApplicationAttempt(db, {
        canonicalUrl: 'https://jobs.example.invalid/apply/2',
        company: 'Northwind Freight',
        role: 'Logistics Platform Engineer',
        sourceCvContentHash: 'a'.repeat(64),
        jdSnapshotHash: 'b'.repeat(64),
      });

      workspace.recordPreparedApplicationFields(db, attempt.id, {
        version: 1,
        preparedAt: '2026-09-11T12:00:00.000Z',
        company: 'Northwind Freight',
        role: 'Logistics Platform Engineer',
        verification: 'applied',
        fields: [{ label: 'fullName', controlType: 'text', required: true, status: 'committed', value: 'Jamie Rivera', provenance: 'cv' }],
      });
      expect(workspace.getApplicationAttempt(db, attempt.id).preparedFields?.fields[0]).toMatchObject({
        value: 'Jamie Rivera',
        provenance: 'cv',
      });

      const raw = openRaw(join(dir, 'workspace.db'));
      try {
        raw.prepare('UPDATE application_attempts SET prepared_fields = ? WHERE id = ?').run('{"version":99}', attempt.id);
      } finally {
        raw.close();
      }
      expect(workspace.getApplicationAttempt(db, attempt.id).preparedFields).toBeNull();
    } finally {
      close();
    }
  });
});
