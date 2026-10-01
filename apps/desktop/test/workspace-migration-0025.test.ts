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

function readJournal(): Journal {
  return JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
}

/** Every migration before 0025, so a database can be seeded the way an older install left it. */
function seedPre0025MigrationsFolder(root: string): string {
  const journal = readJournal();
  const kept = journal.entries.filter((entry) => entry.idx < 25);
  expect(kept).toHaveLength(25);
  expect(journal.entries[25]?.tag).toMatch(/^0025_/);

  const folder = join(root, 'drizzle-0024');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  for (const entry of kept) cpSync(join(REAL_MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  return folder;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0025-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function insertCv(connection: Database.Database, id: string, sourceCv: string | null): void {
  connection
    .prepare(
      `INSERT INTO cv_documents (id, name, kind, text, profile, source_cv, uploaded_at, updated_at)
       VALUES (?, 'Synthetic CV', 'manual', 'text', '{}', ?, 1788000000000, 1788000000000)`,
    )
    .run(id, sourceCv);
}

const entry = (company: string, title: string, id?: string) => ({
  ...(id === undefined ? {} : { id }),
  company,
  title,
  dates: '2020',
  engagement: 'employment',
  client: '',
  bullets: [`Worked at ${company}`],
});

describe('migration 0025 persists stable experience ids (#419)', () => {
  it('writes an id onto every stored experience entry that has none, keeping order and content', () => {
    const folder = seedPre0025MigrationsFolder(dir);
    const seeded = new Database(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(seeded), { migrationsFolder: folder });
      insertCv(
        seeded,
        'cv-legacy',
        JSON.stringify({ summary: 'Keep me', experience: [entry('Northwind Freight', 'Engineer'), entry('Northwind Freight', 'Engineer')], projects: [] }),
      );
      insertCv(seeded, 'cv-none', null);
      insertCv(seeded, 'cv-empty', JSON.stringify({ experience: [] }));
    } finally {
      seeded.close();
    }

    const { db, close } = createWorkspaceDb(dir);
    try {
      const legacy = workspace.getCvDocument(db, 'cv-legacy');
      expect(legacy.source?.summary).toBe('Keep me');
      expect(legacy.source?.experience.map((item) => item.id)).toEqual(['experience-1', 'experience-2']);
      expect(legacy.source?.experience.map((item) => item.bullets[0])).toEqual(['Worked at Northwind Freight', 'Worked at Northwind Freight']);
      expect(workspace.getCvDocument(db, 'cv-none').source).toBeNull();
      expect(workspace.getCvDocument(db, 'cv-empty').source?.experience).toEqual([]);
    } finally {
      close();
    }

    // The ids are in the stored JSON itself, not just filled in on read.
    const raw = new Database(join(dir, 'workspace.db'), { readonly: true });
    try {
      const stored = raw.prepare('SELECT source_cv FROM cv_documents WHERE id = ?').get('cv-legacy') as { source_cv: string };
      expect((JSON.parse(stored.source_cv) as { experience: { id: string }[] }).experience.map((item) => item.id)).toEqual([
        'experience-1',
        'experience-2',
      ]);
    } finally {
      raw.close();
    }
  });

  it('never rewrites an id that already exists', () => {
    const folder = seedPre0025MigrationsFolder(dir);
    const seeded = new Database(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(seeded), { migrationsFolder: folder });
      insertCv(seeded, 'cv-mixed', JSON.stringify({ experience: [entry('A', 'One', 'kept-id'), entry('B', 'Two')] }));
    } finally {
      seeded.close();
    }

    const { db, close } = createWorkspaceDb(dir);
    try {
      expect(workspace.getCvDocument(db, 'cv-mixed').source?.experience.map((item) => item.id)).toEqual(['kept-id', 'experience-2']);
    } finally {
      close();
    }
  });

  it('adds the JD completeness columns with defaults that claim nothing for an older overlay', () => {
    const folder = seedPre0025MigrationsFolder(dir);
    const seeded = new Database(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(seeded), { migrationsFolder: folder });
      insertCv(seeded, 'cv-1', null);
      seeded
        .prepare(
          `INSERT INTO cv_evidence_overlays (id, cv_id, vacancy_key, source_cv_content_hash, jd_snapshot, jd_snapshot_hash, captured_at, updated_at)
           VALUES ('overlay-old', 'cv-1', 'url:https://jobs.example.invalid/1', ?, 'Old JD text', ?, 1788000000000, 1788000000000)`,
        )
        .run('a'.repeat(64), 'b'.repeat(64));
    } finally {
      seeded.close();
    }

    const { db, close } = createWorkspaceDb(dir);
    try {
      const overlay = workspace.getCvEvidenceOverlayById(db, 'overlay-old');
      expect(overlay).toMatchObject({ jdIncompleteReasons: [], jdWarning: '', jdConfirmedComplete: false, jdComplete: true });
    } finally {
      close();
    }
  });
});
