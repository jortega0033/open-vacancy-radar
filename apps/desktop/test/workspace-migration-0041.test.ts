// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';
import { listBlindApplyItems } from '../electron/workspace/blind-apply-store.js';

const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'workspace', 'drizzle');

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

/** Every migration before 0041: a database as an install from before #722 left it. */
function seedPre0041MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((entry) => entry.idx < 41);
  expect(journal.entries[41]?.tag).toMatch(/^0041_/);
  const folder = join(root, 'drizzle-0040');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  for (const entry of kept) cpSync(join(REAL_MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  return folder;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0041-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('migration 0041 adds the Blind Apply record (#722)', () => {
  it('leaves existing saved answers byte-identical and invents no authorization or item', () => {
    const answer = '  Remote, ideally  ';
    const seeded = new Database(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(seeded), { migrationsFolder: seedPre0041MigrationsFolder(dir) });
      seeded
        .prepare(
          `INSERT INTO application_answers (id, normalized_key, label, control_type, answer, origin_company, origin_role, created_at, updated_at, last_confirmed_at)
           VALUES ('ans-legacy', 'text::work style', 'Work style', 'text', ?, 'Fabrikam', 'Engineer', 1785000000000, 1785000000000, 1785000000000)`,
        )
        .run(answer);
      const tables = seeded.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>;
      expect(tables.map((table) => table.name)).not.toContain('blind_apply_items');
    } finally {
      seeded.close();
    }

    const { db, close } = createWorkspaceDb(dir);
    try {
      expect(workspace.listApplicationAnswers(db).find((row) => row.id === 'ans-legacy')).toMatchObject({ answer, label: 'Work style' });
      expect(listBlindApplyItems(db)).toEqual([]);
      const tables = db
        .all<{ name: string }>(sql.raw(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'blind_apply_%'`))
        .map((row) => row.name)
        .sort();
      expect(tables).toEqual(['blind_apply_answers', 'blind_apply_authorizations', 'blind_apply_events', 'blind_apply_items']);
      const [authorizations] = db.all<{ n: number }>(sql.raw('SELECT COUNT(*) AS n FROM blind_apply_authorizations'));
      expect(authorizations?.n).toBe(0);
    } finally {
      close();
    }
  });
});
