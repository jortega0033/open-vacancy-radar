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
import { cvDocumentToTailoredResume, describeCvExportBlockers } from '../electron/cv-export.js';

/**
 * Migration 0012 adds one nullable column, `source_cv`, to `cv_documents` (#274) -- a plain
 * `ALTER TABLE ADD COLUMN`, no rebuild, existing rows survive with it null.
 *
 * The interesting half of this suite is not the DDL but what a pre-#274 row *means* afterwards.
 * #274's own migration criterion is that existing small-profile records must migrate "without
 * fabricated sections": a row that has only the seven flat `CvProfile` fields must come back with
 * `source: null` and export exactly as thinly as it did before, never as a reviewed-looking source
 * with empty employment and education it was never asked about.
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
  expect(journal.entries[PRE_0012_TAGS.length]?.tag).toBe('0012_nosy_veda');

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

/** Writes the row a pre-#274 install would hold: name, kind, the flat profile JSON, nothing else. */
function insertSmallProfileRow(connection: Database.Database, id: string): void {
  const now = Date.now();
  connection
    .prepare(
      `INSERT INTO cv_documents (id, name, kind, target_role, text, profile, is_default, uploaded_at, updated_at)
       VALUES (?, ?, 'manual', '', '', ?, 1, ?, ?)`,
    )
    .run(
      id,
      'Frontend CV: Netherlands',
      JSON.stringify({
        title: 'Senior Frontend Engineer',
        years: '8',
        location: 'Amsterdam, Netherlands',
        languages: 'Dutch (B2), English (native)',
        skills: ['TypeScript', 'React'],
        summary: 'Frontend engineer with eight years building design systems.',
        auth: 'EU citizen, no sponsorship needed',
      }),
      now,
      now,
    );
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0012-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the seeded fixture really is a pre-0012 database', () => {
  it('has no source_cv column yet', () => {
    const folder = seedPre0012MigrationsFolder(dir);
    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(connection), { migrationsFolder: folder });
      const columns = connection.prepare('PRAGMA table_info(cv_documents)').all() as { name: string }[];
      expect(columns.map((c) => c.name)).not.toContain('source_cv');
    } finally {
      connection.close();
    }
  });
});

describe('migration 0012 adds source_cv to cv_documents', () => {
  it('is ALTER TABLE ADD COLUMN only, never a rebuild and never a drop', () => {
    const sql = readFileSync(join(REAL_MIGRATIONS, '0012_nosy_veda.sql'), 'utf8');
    expect(sql).toMatch(/ALTER TABLE `cv_documents` ADD `source_cv`/);
    expect(sql).not.toMatch(/CREATE TABLE `__new_/);
    expect(sql).not.toMatch(/DROP/i);
  });

  it('leaves an existing small-profile row intact, with source_cv null', () => {
    const folder = seedPre0012MigrationsFolder(dir);
    const seeded = openRaw(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(seeded), { migrationsFolder: folder });
      insertSmallProfileRow(seeded, 'cv-legacy');
    } finally {
      seeded.close();
    }

    // Reopening through the real client applies 0012 on top of that existing row.
    const { db, close } = createWorkspaceDb(dir);
    try {
      const migrated = workspace.getCvDocument(db, 'cv-legacy');
      expect(migrated.name).toBe('Frontend CV: Netherlands');
      expect(migrated.profile.skills).toEqual(['TypeScript', 'React']);
      expect(migrated.source).toBeNull();
    } finally {
      close();
    }
  });

  it('does not fabricate sections for a migrated row, and does not block its export', () => {
    const folder = seedPre0012MigrationsFolder(dir);
    const seeded = openRaw(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(seeded), { migrationsFolder: folder });
      insertSmallProfileRow(seeded, 'cv-legacy');
    } finally {
      seeded.close();
    }

    const { db, close } = createWorkspaceDb(dir);
    try {
      const migrated = workspace.getCvDocument(db, 'cv-legacy');
      const resume = cvDocumentToTailoredResume(migrated, null);

      expect(resume.experience).toEqual([]);
      expect(resume.education).toEqual([]);
      expect(resume.projects).toEqual([]);
      expect(resume.contact.email).toBe('');
      expect(resume.summary).toBe('Frontend engineer with eight years building design systems.');
      expect(describeCvExportBlockers(migrated)).toEqual([]);
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
      const realMigrationCount = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')).entries
        .length as number;
      expect(applied.n).toBe(realMigrationCount);
    } finally {
      connection.close();
    }
  });
});
