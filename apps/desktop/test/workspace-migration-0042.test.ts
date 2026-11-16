// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getBrief } from '../electron/application-brief-service.js';
import { createWorkspaceDb } from '../electron/workspace/client.js';
import * as briefStore from '../electron/workspace/application-brief-store.js';
import { ATS_URL, makeDeps, makeWorld, scanRow, setScan } from './application-brief-fixtures.js';

const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'workspace', 'drizzle');

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

function readJournal(): Journal {
  return JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
}

/** Every migration before 0042: a database as an install from before #709 left it. */
function seedPre0042MigrationsFolder(root: string): string {
  const journal = readJournal();
  const kept = journal.entries.filter((entry) => entry.idx < 42);
  expect(journal.entries[42]?.tag).toBe('0042_brief_query_provenance');
  const folder = join(root, 'drizzle-0041');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  for (const entry of kept) cpSync(join(REAL_MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  return folder;
}

const PLAN = {
  planRevision: 3,
  fetchedBy: [{ variantId: 'literal', query: 'platform engineer', language: null, provider: 'ats_roster_greenhouse' }],
  matchedLocally: [{ variantId: 'literal', query: 'platform engineer', language: null, field: 'title' }],
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0042-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('migration 0042 adds per-copy search provenance (#709)', () => {
  it('keeps a pre-#709 brief and its saved copy as they were, and that copy reads "not recorded" forever', async () => {
    // A workspace from before #709: one saved job whose brief and `saved:` reference already exist.
    const seeded = new Database(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(seeded), { migrationsFolder: seedPre0042MigrationsFolder(dir) });
      const columns = seeded.prepare(`PRAGMA table_info(application_brief_aliases)`).all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toContain('query_provenance');
      seeded
        .prepare(
          `INSERT INTO saved_jobs (id, vacancy_key, role, company, location, source_url, notes, status, saved_at)
           VALUES ('job-legacy', 'gh:1001', 'Platform Engineer', 'Northwind Freight', 'Remote - Europe', ?, '', 'considering', 1785000000000)`,
        )
        .run(ATS_URL);
      seeded
        .prepare(
          `INSERT INTO application_briefs (id, identity_key, identity_kind, employer_key, requisition_id, company, role, location, notices, facts_version, created_at, updated_at)
           VALUES ('brief-legacy', 'req:greenhouse:northwind:1001', 'requisition', 'greenhouse:northwind', '1001', 'Northwind Freight', 'Platform Engineer', 'Remote - Europe', '[]', 1, 1785000000000, 1785000000000)`,
        )
        .run();
      seeded
        .prepare(
          `INSERT INTO application_brief_aliases (alias_key, brief_id, kind, label, provider, url, first_seen_at, last_seen_at)
           VALUES ('saved:job-legacy', 'brief-legacy', 'saved_job', '', NULL, NULL, 1785000000000, 1785000000000)`,
        )
        .run();
    } finally {
      seeded.close();
    }

    // Opening it runs 0042: the column is added and the existing row keeps NULL, which means "not recorded".
    const { db, close } = createWorkspaceDb(dir);
    try {
      expect(briefStore.listAliases(db, 'brief-legacy')).toEqual([
        expect.objectContaining({ aliasKey: 'saved:job-legacy', kind: 'saved_job', queryProvenance: null }),
      ]);

      // Even with a scan row carrying variants in hand, and one that ran before the save time, the
      // copy is never filled in: only a placeholder written by #709 itself can be completed.
      const world = makeWorld();
      setScan(world, [scanRow({ key: 'gh:1001', url: ATS_URL, queryProvenance: PLAN })], '2026-01-01T00:00:00.000Z', undefined, '2025-12-31T23:00:00.000Z');
      const view = await getBrief(makeDeps(db, world), { savedJobId: 'job-legacy' });
      expect(view.briefId).toBe('brief-legacy');
      expect(view.searchProvenance).toEqual([expect.objectContaining({ aliasKey: 'saved:job-legacy', provenance: null })]);
      expect(briefStore.listAliases(db, 'brief-legacy').find((alias) => alias.aliasKey === 'saved:job-legacy')?.queryProvenance).toBeNull();
    } finally {
      close();
    }
  });

  it('keeps the migration journal strictly ordered, so a database never silently skips a migration', () => {
    // drizzle applies a migration only when its `when` is later than the newest one the database has
    // recorded. Two branches that both add "the next" migration (#747 also adds a 0042) must not land
    // with the later file carrying the earlier timestamp: regenerate it with drizzle-kit instead.
    const entries = readJournal().entries;
    entries.forEach((entry, index) => {
      expect(entry.idx).toBe(index);
      expect(entry.tag.startsWith(String(index).padStart(4, '0') + '_')).toBe(true);
      if (index > 0) expect(entry.when).toBeGreaterThan(entries[index - 1]!.when);
    });
  });
});
