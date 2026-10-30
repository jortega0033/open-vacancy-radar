// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getActionsView } from '../electron/application-actions-service.js';
import { createWorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';
import { applicationActionPrefs, applicationActions, applicationFollowUpDrafts } from '../electron/workspace/schema.js';

const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'workspace', 'drizzle');

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

/** Every migration before 0040: a database as an install from before #692 left it. */
function seedPre0040MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((entry) => entry.idx < 40);
  expect(journal.entries[40]?.tag).toMatch(/^0040_/);
  const folder = join(root, 'drizzle-0039');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  for (const entry of kept) cpSync(join(REAL_MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  return folder;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0040-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('migration 0040 adds local due actions and follow-up drafts (#692)', () => {
  it('leaves free-text next steps and notes byte-identical and invents no action, switch or draft', () => {
    const nextStep = '  Call Priya on Tuesday – bring the Q3 numbers\n(and the café receipt)  ';
    const notes = 'Round 1 on 2026-07-02 went well.\r\nNext: system design.   \n';
    const seeded = new Database(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(seeded), { migrationsFolder: seedPre0040MigrationsFolder(dir) });
      seeded
        .prepare(
          `INSERT INTO applications (id, role, company, location, status, applied_at, next_step, contact, notes, archived)
           VALUES ('app-legacy', 'Data Engineer', 'Fabrikam', '', 'applied', 1785000000000, ?, 'Priya', ?, 0)`,
        )
        .run(nextStep, notes);
      const tables = seeded.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>;
      expect(tables.map((table) => table.name)).not.toContain('application_actions');
    } finally {
      seeded.close();
    }

    const { db, close } = createWorkspaceDb(dir);
    try {
      const row = workspace.listApplications(db).find((app) => app.id === 'app-legacy')!;
      expect(row).toMatchObject({ status: 'applied', nextStep, notes, contact: 'Priya' });
      expect(db.select().from(applicationActions).all()).toEqual([]);
      expect(db.select().from(applicationActionPrefs).all()).toEqual([]);
      expect(db.select().from(applicationFollowUpDrafts).all()).toEqual([]);
      const view = getActionsView({ db, now: () => new Date('2026-11-02T10:00:00Z') }, 'app-legacy');
      expect(view.actions).toEqual([]);
      expect(view.suppressed).toBe(false);
      expect(view.application.submissionClass).toBe('user_stated');
    } finally {
      close();
    }
  });
});
