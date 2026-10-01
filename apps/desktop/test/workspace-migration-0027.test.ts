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

/** Every migration before 0027, so a database can be seeded the way an install from before the
 * project selection and source baseline columns left it. */
function seedPre0027MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((entry) => entry.idx < 27);
  expect(journal.entries[27]?.tag).toMatch(/^0027_/);
  const folder = join(root, 'drizzle-0026');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  for (const entry of kept) cpSync(join(REAL_MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  return folder;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0027-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const JD = 'Experience with React is required.';
const HASH = 'a'.repeat(64);
const RESUME = {
  contact: { name: 'Sam', title: '', location: '', email: '', phone: '', links: [] },
  summary: 'Approved summary.',
  experience: [],
  projects: [],
  skills: [],
  education: [],
};

describe('migration 0027 adds project selection and source baseline without touching approved cases (#419)', () => {
  it('keeps an approved case approved, with its snapshot readable as render contract version 0', () => {
    const seeded = new Database(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(seeded), { migrationsFolder: seedPre0027MigrationsFolder(dir) });
      seeded
        .prepare(
          `INSERT INTO cv_documents (id, name, kind, text, profile, source_cv, uploaded_at, updated_at)
           VALUES ('cv-1', 'Synthetic CV', 'manual', 'text', '{}', NULL, 1788000000000, 1788000000000)`,
        )
        .run();
      seeded
        .prepare(
          `INSERT INTO cv_evidence_overlays
             (id, cv_id, vacancy_key, source_cv_content_hash, jd_snapshot, jd_snapshot_hash, state, approved_resume_snapshot, captured_at, updated_at)
           VALUES ('overlay-1', 'cv-1', 'url:https://jobs.example.invalid/1', ?, ?, ?, 'candidate_approved', ?, 1788000000000, 1788000000000)`,
        )
        .run(HASH, JD, 'b'.repeat(64), JSON.stringify({ resume: RESUME, digest: 'c'.repeat(64), approvedAt: '2026-09-02T00:00:00.000Z', caseRevision: '2' }));
    } finally {
      seeded.close();
    }

    const { db, close } = createWorkspaceDb(dir);
    try {
      const overlay = workspace.getCvEvidenceOverlayById(db, 'overlay-1');
      expect(overlay.state).toBe('candidate_approved');
      expect(overlay.projectSelection).toBeNull();
      expect(overlay.sourceBaseline).toBeNull();
      expect(overlay.approvedResumeSnapshot).toMatchObject({ renderContractVersion: 0, digest: 'c'.repeat(64) });
      expect(overlay.approvedResumeSnapshot?.resume.summary).toBe('Approved summary.');
    } finally {
      close();
    }
  });
});
