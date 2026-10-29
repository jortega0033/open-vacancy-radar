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
import { getInterviewContextView } from '../electron/interview-context-service.js';
import { applicationInterviewRounds, applicationSubmissionPackages } from '../electron/workspace/schema.js';

const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'workspace', 'drizzle');

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

/** Every migration before 0039: a database as an install from before #691 left it. */
function seedPre0039MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((entry) => entry.idx < 39);
  expect(journal.entries[39]?.tag).toMatch(/^0039_/);
  const folder = join(root, 'drizzle-0038');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  for (const entry of kept) cpSync(join(REAL_MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  return folder;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0039-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('migration 0039 adds submitted-document manifests and interview rounds (#691)', () => {
  it('keeps free notes as they were and invents no round, date, type or document record', async () => {
    const seeded = new Database(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(seeded), { migrationsFolder: seedPre0039MigrationsFolder(dir) });
      seeded
        .prepare(
          `INSERT INTO applications (id, role, company, location, status, applied_at, next_step, contact, notes, archived)
           VALUES ('app-legacy', 'Data Engineer', 'Fabrikam', '', 'interview', 1785000000000, 'Second interview Tuesday', '',
                   'Round 1 on 2026-07-02 went well, they asked about Spark. Next: system design.', 0)`,
        )
        .run();
      const tables = seeded.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>;
      expect(tables.map((table) => table.name)).not.toContain('application_interview_rounds');
    } finally {
      seeded.close();
    }

    const { db, close } = createWorkspaceDb(dir);
    try {
      const row = workspace.listApplications(db).find((app) => app.id === 'app-legacy')!;
      expect(row).toMatchObject({
        status: 'interview',
        nextStep: 'Second interview Tuesday',
        notes: 'Round 1 on 2026-07-02 went well, they asked about Spark. Next: system design.',
      });
      expect(db.select().from(applicationInterviewRounds).all()).toEqual([]);
      expect(db.select().from(applicationSubmissionPackages).all()).toEqual([]);

      const view = await getInterviewContextView({ db }, 'app-legacy');
      expect(view.rounds).toEqual([]);
      expect(view).toMatchObject({ selection: 'none' });
      expect(view.packages.every((pkg) => pkg.documents.length === 0 && pkg.version === null)).toBe(true);
    } finally {
      close();
    }
  });
});
