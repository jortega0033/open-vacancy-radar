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

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

/** Every migration before 0029, so a database can be seeded the way an install from before the
 * case role and company columns left it. */
function seedPre0029MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((entry) => entry.idx < 29);
  expect(journal.entries[29]?.tag).toMatch(/^0029_/);
  const folder = join(root, 'drizzle-0028');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  for (const entry of kept) cpSync(join(REAL_MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  return folder;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0029-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('migration 0029 adds the case role and company without disturbing an existing case (#419)', () => {
  it('reads an older case with an empty role and company, and stores them for a new one', () => {
    const seeded = new Database(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(seeded), { migrationsFolder: seedPre0029MigrationsFolder(dir) });
      seeded
        .prepare(
          `INSERT INTO cv_documents (id, name, kind, text, profile, source_cv, uploaded_at, updated_at)
           VALUES ('cv-1', 'Synthetic CV', 'manual', 'text', '{}', NULL, 1788000000000, 1788000000000)`,
        )
        .run();
      seeded
        .prepare(
          `INSERT INTO cv_evidence_overlays
             (id, cv_id, vacancy_key, source_cv_content_hash, jd_snapshot, jd_snapshot_hash, state, captured_at, updated_at)
           VALUES ('overlay-1', 'cv-1', 'manual:synthetic-key', ?, 'Experience with React is required.', ?, 'draft', 1788000000000, 1788000000000)`,
        )
        .run('a'.repeat(64), 'b'.repeat(64));
    } finally {
      seeded.close();
    }

    const { db, close } = createWorkspaceDb(dir);
    try {
      const older = workspace.getCvEvidenceOverlayById(db, 'overlay-1');
      expect(older).toMatchObject({ caseTitle: '', caseCompany: '', vacancyKey: 'manual:synthetic-key' });
      const created = workspace.createCvEvidenceOverlay(db, {
        cvId: 'cv-1',
        vacancyKey: 'manual:another-key',
        caseTitle: 'Platform Engineer',
        caseCompany: 'Northwind Freight',
        sourceCvContentHash: 'a'.repeat(64),
        jdSnapshotHash: 'b'.repeat(64),
        origin: 'manual',
      });
      expect(workspace.getCvEvidenceOverlayById(db, created.id)).toMatchObject({
        caseTitle: 'Platform Engineer',
        caseCompany: 'Northwind Freight',
      });
    } finally {
      close();
    }
  });
});
