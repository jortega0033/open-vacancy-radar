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
 * The **upgrade** path for issue #138's migration 0004, which adds `saved_jobs.gap_analysis` and
 * `saved_jobs.gap_analysis_at`.
 *
 * Built on exactly the pattern `test/workspace-migration-0003.test.ts` established, for the same
 * reason it exists: `test/workspace-repository.test.ts` only ever opens an empty directory, so it
 * applies 0000 -> 0004 in one go against a database with no rows in it. That proves the chain
 * composes from nothing. It proves nothing about the case every existing installation hits: a
 * `workspace.db` full of real rows, opened for the first time by a build carrying 0004.
 *
 * The claim under test is narrow and worth stating plainly, because it is the whole risk of a
 * schema change to a table holding a user's own data: **0004 is additive**. A saved job that
 * existed before it must come back afterwards with every field it had, byte for byte, plus two new
 * columns reading null. Nothing is rebuilt, nothing is defaulted over, nothing is dropped.
 *
 * As in the 0003 test, the pre-migration rows are written through raw SQL naming only pre-0004
 * columns (`repository.ts` is typed against the post-0004 schema and could not write them), and the
 * database is then reopened through the ordinary `createWorkspaceDb` path -- the exact call
 * `main.ts` makes -- so the migrator itself decides what is pending.
 */

const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'workspace', 'drizzle');

/** The tags this test pins the seeded database to: everything 0004 builds on top of. */
const PRE_0004_TAGS = [
  '0000_familiar_giant_man',
  '0001_misty_hobgoblin',
  '0002_brainy_morgan_stark',
  '0003_curved_shotgun',
];

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

function readJournal(): Journal {
  return JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
}

/**
 * How many migrations `createWorkspaceDb` records once it has finished with a database. Read from
 * the real journal rather than written down as a number, because this test seeds a *prefix* of the
 * history and then opens the database with the shipped migrations folder: everything after the
 * prefix is pending, which is 0004 today and 0004 plus whatever follows it later (0005 onwards).
 */
function migrationCount(): number {
  return readJournal().entries.length;
}

/**
 * Copies the real 0000-0003 migrations into `<root>/drizzle-0003` with a journal that stops there.
 * Fails loudly if the real journal's first four entries ever stop being `PRE_0004_TAGS`, or if
 * 0004 stops being the entry that immediately follows them, so a rewritten or squashed history
 * cannot quietly turn this into a test of the wrong prior version.
 */
function seedPre0004MigrationsFolder(root: string): string {
  const journal = readJournal();
  const kept = journal.entries.filter((entry) => PRE_0004_TAGS.includes(entry.tag));
  expect(kept.map((entry) => entry.tag)).toEqual(PRE_0004_TAGS);
  expect(journal.entries.slice(0, kept.length).map((entry) => entry.tag)).toEqual(PRE_0004_TAGS);
  // The migration under test is the next one after the seeded prefix. It is deliberately not
  // required to be the *last* entry in the journal: migrations added after it (0005 onwards) are
  // applied by the same reopen below, and that is the real upgrade an existing install gets.
  expect(journal.entries[kept.length]?.tag).toBe('0004_damp_dust');

  const folder = join(root, 'drizzle-0003');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  for (const entry of kept) {
    cpSync(join(REAL_MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  return folder;
}

/** Opens a raw connection with the same pragmas `createWorkspaceDb` uses. */
function openRaw(databasePath: string): Database.Database {
  const connection = new Database(databasePath);
  connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');
  return connection;
}

const JOB_ID = 'job-8a1c9e42-77b3-4d61-9f0a-1e2b3c4d5e6f';
const SECOND_JOB_ID = 'job-2b7d0c15-3ef4-4a88-91bc-77aa11223344';
const SAVED_AT = Date.UTC(2026, 6, 1, 8, 5, 0);
const SECOND_SAVED_AT = Date.UTC(2026, 6, 9, 13, 40, 0);

/**
 * The full field set of one realistic pre-0004 saved job. Every optional column carries a real
 * value rather than a null: a migration that rebuilt the table and defaulted a column over would
 * otherwise still read as a pass, because null is a legal value everywhere it appears.
 */
const EXISTING_JOB = {
  vacancyKey: 'nl:redwood-software:senior-frontend-engineer',
  role: 'Senior Frontend Engineer',
  company: 'Redwood Software',
  market: 'netherlands',
  location: 'Amsterdam',
  salary: '€72.000 - €86.000',
  arrangement: 'hybrid',
  verification: 'ind_recognised_sponsor',
  matchPercent: 91,
  sourceUrl: 'https://example.invalid/vacancies/redwood-senior-frontend',
  notes: 'Recruiter replied within a day. Ask about the platform team split.',
  status: 'preparing',
} as const;

function seedPre0004Rows(connection: Database.Database): void {
  const insert = connection.prepare(
    `INSERT INTO saved_jobs (id, vacancy_key, role, company, market, location, salary, arrangement, verification, match_percent, source_url, notes, status, saved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    JOB_ID,
    EXISTING_JOB.vacancyKey,
    EXISTING_JOB.role,
    EXISTING_JOB.company,
    EXISTING_JOB.market,
    EXISTING_JOB.location,
    EXISTING_JOB.salary,
    EXISTING_JOB.arrangement,
    EXISTING_JOB.verification,
    EXISTING_JOB.matchPercent,
    EXISTING_JOB.sourceUrl,
    EXISTING_JOB.notes,
    EXISTING_JOB.status,
    SAVED_AT,
  );
  // A second, sparser row: the manually-added shape, where the nullable columns really are null.
  insert.run(
    SECOND_JOB_ID,
    null,
    'Staff Engineer',
    'Blue Harbor',
    'worldwide',
    'Remote',
    null,
    null,
    null,
    null,
    null,
    '',
    'considering',
    SECOND_SAVED_AT,
  );
}

let dir: string;

/** Builds a pre-0004 `workspace.db` in `dir`, seeded with real saved jobs, and closes it. */
function seedPre0004Database(): void {
  const folder = seedPre0004MigrationsFolder(dir);
  const connection = openRaw(join(dir, 'workspace.db'));
  try {
    migrate(drizzle(connection), { migrationsFolder: folder });
    seedPre0004Rows(connection);
  } finally {
    connection.close();
  }
}

function columnNames(connection: Database.Database, table: string): string[] {
  return (connection.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0004-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the seeded fixture really is a pre-0004 database', () => {
  it('has neither gap-analysis column before the upgrade', () => {
    seedPre0004Database();
    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      const columns = columnNames(connection, 'saved_jobs');
      expect(columns).toContain('match_percent'); // the table really is the shipped saved_jobs
      expect(columns).not.toContain('gap_analysis');
      expect(columns).not.toContain('gap_analysis_at');
      const applied = connection.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
      expect(applied.n).toBe(PRE_0004_TAGS.length);
    } finally {
      connection.close();
    }
  });
});

describe('migration 0004 is additive', () => {
  it('is written as ADD COLUMN only: no DROP, no table rebuild, no data statement', () => {
    // Asserted against the shipped SQL text, not the resulting schema, because the two ways to add
    // a column to SQLite are not equivalent here. `ALTER TABLE ... ADD COLUMN` cannot touch an
    // existing row; the create-copy-drop-rename rebuild drizzle emits for other kinds of change
    // rewrites every row in the table, and would leave this file's other assertions passing while
    // the user's data had in fact been through a full copy.
    const sql = readFileSync(join(REAL_MIGRATIONS, '0004_damp_dust.sql'), 'utf8');
    const statements = sql
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter((statement) => statement !== '');

    expect(statements).toEqual([
      'ALTER TABLE `saved_jobs` ADD `gap_analysis` text;',
      'ALTER TABLE `saved_jobs` ADD `gap_analysis_at` integer;',
    ]);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bCREATE TABLE\b/i);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });

  it('opens an existing database without throwing and applies every pending migration', () => {
    seedPre0004Database();

    createWorkspaceDb(dir).close();

    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      const applied = connection.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
      expect(applied.n).toBe(migrationCount());
      expect(columnNames(connection, 'saved_jobs')).toEqual(
        expect.arrayContaining(['gap_analysis', 'gap_analysis_at']),
      );
    } finally {
      connection.close();
    }
  });

  it('leaves a pre-existing populated saved job unchanged, with the new columns reading null', () => {
    seedPre0004Database();

    const { db, close } = createWorkspaceDb(dir);
    try {
      const jobs = workspace.listSavedJobs(db);
      expect(jobs).toHaveLength(2);

      const job = jobs.find((row) => row.id === JOB_ID);
      // Every field the row was written with, still exactly as written.
      expect(job).toEqual({
        id: JOB_ID,
        ...EXISTING_JOB,
        savedAt: new Date(SAVED_AT).toISOString(),
        gapAnalysis: null,
        gapAnalysisAt: null,
      });

      // The sparse row's nulls are still nulls, not defaults invented by the migration.
      const second = jobs.find((row) => row.id === SECOND_JOB_ID);
      expect(second).toMatchObject({
        vacancyKey: null,
        salary: null,
        arrangement: null,
        verification: null,
        matchPercent: null,
        sourceUrl: null,
        notes: '',
        gapAnalysis: null,
        gapAnalysisAt: null,
      });

      expect(workspace.getCounts(db).savedJobs).toBe(2);
    } finally {
      close();
    }
  });

  it('lets a migrated row take an analysis, and keeps it across a reopen', () => {
    seedPre0004Database();

    const analysis = '## Strengths\nNine years of Angular.\n\n## Gaps\nNo Kubernetes exposure.';

    const first = createWorkspaceDb(dir);
    try {
      const updated = workspace.updateSavedJob(first.db, JOB_ID, { gapAnalysis: analysis });
      expect(updated.gapAnalysis).toBe(analysis);
      expect(updated.gapAnalysisAt).not.toBeNull();
      // Writing the analysis touches nothing else on the row.
      expect(updated).toMatchObject({ ...EXISTING_JOB, savedAt: new Date(SAVED_AT).toISOString() });
    } finally {
      first.close();
    }

    // Reopening runs the migrator again against a now-current database: it must be a no-op, and
    // the analysis must still be there. This is the ticket's "reopen the drawer tomorrow" claim.
    const second = createWorkspaceDb(dir);
    try {
      const jobs = workspace.listSavedJobs(second.db);
      const job = jobs.find((row) => row.id === JOB_ID);
      expect(job?.gapAnalysis).toBe(analysis);
      // Stored as a timestamp, and it round-trips as one rather than as an opaque string.
      expect(job?.gapAnalysisAt).toBe(new Date(job?.gapAnalysisAt ?? '').toISOString());
      // The other saved job is unaffected: this is a per-row field, not app state.
      expect(jobs.find((row) => row.id === SECOND_JOB_ID)?.gapAnalysis).toBeNull();
    } finally {
      second.close();
    }
  });

  it('is a no-op the second time: reopening an already-migrated database applies nothing more', () => {
    seedPre0004Database();

    createWorkspaceDb(dir).close();
    createWorkspaceDb(dir).close();

    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      const applied = connection.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
      expect(applied.n).toBe(migrationCount()); // every pending migration, applied by the first open
    } finally {
      connection.close();
    }
  });
});
