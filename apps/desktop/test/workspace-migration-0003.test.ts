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
 * The **upgrade** path for ADI-07's migration 0003, which every other workspace test misses.
 *
 * `test/workspace-repository.test.ts` only ever calls `createWorkspaceDb` against an empty
 * directory, so it applies 0000 -> 0003 in one go against a database with no rows in it. That
 * proves the migration chain composes from nothing. It proves nothing at all about the case every
 * existing installation actually hits: a `workspace.db` that has been in daily use under the
 * pre-0003 schema, full of real rows, opened for the first time by a build that carries 0003.
 *
 * This file builds that database for real. There is no shortcut and no in-memory imitation:
 *
 *  1. A temp migrations folder is assembled from the *real* `electron/workspace/drizzle` files, but
 *     containing only 0000, 0001 and 0002 plus a `meta/_journal.json` truncated to those three
 *     entries. Drizzle's migrator has no "migrate to version N" API -- `migrate()` reads a folder
 *     and applies everything in it -- so a truncated copy of the folder is how you pin a database
 *     to a prior schema version without hand-writing SQL that could drift from the real thing.
 *     Copying (rather than retyping) the SQL is deliberate: if 0000-0002 were ever edited, this
 *     test would still be seeding the schema the app actually shipped.
 *  2. Realistic rows are written through raw SQL, because `repository.ts` cannot be used here --
 *     it is typed against the *post*-0003 schema and would immediately reference columns that do
 *     not exist yet. The values are the kind of thing a user's database really holds, not nulls
 *     and empty strings, so a migration that silently rewrote or dropped data would show up.
 *  3. The database is closed and reopened through the ordinary `createWorkspaceDb` path -- the
 *     exact call `main.ts` makes -- which finds 0000-0002 already recorded in
 *     `__drizzle_migrations` and applies only the pending 0003.
 *  4. Everything is then asserted through `repository.ts`'s normal readers, since "the migration
 *     ran" is not the claim worth making; "the app can still read the user's data afterwards" is.
 *
 * Note that the drizzle migrator decides what is pending by comparing each journal entry's `when`
 * timestamp against the newest `created_at` in `__drizzle_migrations`. The truncated journal keeps
 * the real `when` values untouched for exactly that reason: change them and the real migrator would
 * either re-run 0000-0002 or skip 0003, and this test would be measuring its own fixture.
 */

const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'workspace', 'drizzle');

/** The tags this test pins the seeded database to: everything ADI-07's 0003 builds on top of. */
const PRE_0003_TAGS = ['0000_familiar_giant_man', '0001_misty_hobgoblin', '0002_brainy_morgan_stark'];

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

/**
 * Copies the real 0000-0002 migrations into `<root>/drizzle-0002` with a journal that stops there.
 * Fails loudly if the real journal ever stops matching `PRE_0003_TAGS`, so a future 0004 (or a
 * squashed history) cannot quietly turn this into a test of the wrong prior version.
 */
function seedPre0003MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((entry) => PRE_0003_TAGS.includes(entry.tag));
  expect(kept.map((entry) => entry.tag)).toEqual(PRE_0003_TAGS);
  expect(journal.entries.at(-1)?.tag).toBe('0003_curved_shotgun');

  const folder = join(root, 'drizzle-0002');
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

const CV_ID = 'cv-4f2b0f7a-2c1d-4a9e-b0f1-6d5c8e3a7b11';
const JOB_ID = 'job-8a1c9e42-77b3-4d61-9f0a-1e2b3c4d5e6f';
const LETTER_ID = 'ltr-1d9f6b30-55aa-4c22-8e77-90ab12cd34ef';
const APPLICATION_ID = 'app-7c3e5d18-4b6f-49a0-bc12-3456789abcde';

const UPLOADED_AT = Date.UTC(2026, 5, 14, 9, 30, 0);
const CV_UPDATED_AT = Date.UTC(2026, 6, 2, 16, 45, 0);
const LETTER_UPDATED_AT = Date.UTC(2026, 6, 3, 11, 15, 0);
const SAVED_AT = Date.UTC(2026, 6, 1, 8, 5, 0);
const APPLIED_AT = Date.UTC(2026, 6, 4, 10, 0, 0);

const CV_PROFILE = {
  title: 'Senior Frontend Engineer',
  years: '9',
  location: 'Utrecht',
  languages: 'English, Dutch',
  skills: ['Angular', 'TypeScript', 'RxJS', 'Playwright'],
  summary: 'Nine years building component libraries and design systems for regulated products.',
  auth: 'EU citizen, no sponsorship required',
};

const CV_TEXT = 'Angular. TypeScript. RxJS. Nine years shipping accessible component libraries.';
const LETTER_BODY = 'Dear hiring team,\n\nRedwood’s platform work is the reason I applied.';

/** Writes the rows a real pre-0003 workspace holds, through SQL that only names pre-0003 columns. */
function seedPre0003Rows(connection: Database.Database): void {
  connection
    .prepare(
      `INSERT INTO cv_documents (id, name, kind, target_role, text, profile, is_default, uploaded_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(CV_ID, 'Jake Ortega: frontend', 'uploaded', 'Senior Frontend Engineer', CV_TEXT, JSON.stringify(CV_PROFILE), 1, UPLOADED_AT, CV_UPDATED_AT);

  connection
    .prepare(
      `INSERT INTO saved_jobs (id, vacancy_key, role, company, market, location, salary, arrangement, verification, match_percent, source_url, notes, status, saved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      JOB_ID,
      'nl:redwood-software:senior-frontend-engineer',
      'Senior Frontend Engineer',
      'Redwood Software',
      'netherlands',
      'Amsterdam',
      '€72.000 - €86.000',
      'hybrid',
      'ind_recognised_sponsor',
      91,
      'https://example.invalid/vacancies/redwood-senior-frontend',
      'Recruiter replied within a day. Ask about the platform team split.',
      'preparing',
      SAVED_AT,
    );

  connection
    .prepare(
      `INSERT INTO letters (id, title, company, role, type, tone, length, status, vacancy_key, cv_id, body, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      LETTER_ID,
      'Redwood motivation',
      'Redwood Software',
      'Senior Frontend Engineer',
      'motivation_letter',
      'natural',
      'standard',
      'final',
      'nl:redwood-software:senior-frontend-engineer',
      CV_ID,
      LETTER_BODY,
      LETTER_UPDATED_AT,
    );

  connection
    .prepare(
      `INSERT INTO applications (id, saved_job_id, role, company, location, market, verification, status, applied_at, next_step, contact, cv_id, letter_id, notes, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      APPLICATION_ID,
      JOB_ID,
      'Senior Frontend Engineer',
      'Redwood Software',
      'Amsterdam',
      'netherlands',
      'ind_recognised_sponsor',
      'interview',
      APPLIED_AT,
      'Second interview with the platform team',
      'Marieke (talent partner)',
      CV_ID,
      LETTER_ID,
      'Prepared the design-system walkthrough.',
      0,
    );

  // A settings row deliberately full of NON-default values: a migration that rebuilt this table
  // (as 0002 genuinely does) and lost the user's preferences would otherwise read as a pass,
  // because every column would still hold something legal.
  connection
    .prepare(
      `INSERT INTO app_settings (id, launch_at_login, start_page, theme, density, sidebar_start, sidebar_collapsed, last_opened_page, default_market, default_location, sponsor_only_default, ind_verification_enabled, default_cv_id, default_letter_type, default_letter_tone, default_letter_length, default_application_status, confirm_application_delete, auto_archive_rejected, default_provider)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      1,
      'saved',
      'dark',
      'compact',
      'collapsed',
      1,
      'applications',
      'netherlands',
      'Amsterdam',
      0,
      0,
      CV_ID,
      'cover_letter',
      'confident',
      'detailed',
      'recruiter_screen',
      0,
      1,
      'codex',
    );
}

let dir: string;

/** Builds a pre-0003 `workspace.db` in `dir`, seeded with real rows, and closes it. */
function seedPre0003Database(): void {
  const folder = seedPre0003MigrationsFolder(dir);
  const connection = openRaw(join(dir, 'workspace.db'));
  try {
    migrate(drizzle(connection), { migrationsFolder: folder });
    seedPre0003Rows(connection);
  } finally {
    connection.close();
  }
}

function columnNames(connection: Database.Database, table: string): string[] {
  return (connection.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => column.name);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the seeded fixture really is a pre-0003 database', () => {
  it('has none of the three ADI-07 columns before the upgrade', () => {
    seedPre0003Database();
    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      const columns = columnNames(connection, 'app_settings');
      expect(columns).toContain('default_provider'); // 0001 applied
      expect(columns).not.toContain('agent_selected_session_id');
      expect(columns).not.toContain('agent_archived_session_ids');
      expect(columns).not.toContain('agent_unread_counts');
      // Only three migrations are on record, so 0003 is genuinely pending rather than skipped.
      const applied = connection.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
      expect(applied.n).toBe(PRE_0003_TAGS.length);
    } finally {
      connection.close();
    }
  });
});

describe('migration 0003 applied to a database that already has real data', () => {
  it('opens without throwing and applies exactly the one pending migration', () => {
    seedPre0003Database();

    const opened = createWorkspaceDb(dir);
    opened.close();

    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      const applied = connection.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
      expect(applied.n).toBe(PRE_0003_TAGS.length + 1);
      expect(columnNames(connection, 'app_settings')).toEqual(
        expect.arrayContaining(['agent_selected_session_id', 'agent_archived_session_ids', 'agent_unread_counts']),
      );
    } finally {
      connection.close();
    }
  });

  it('gives the pre-existing settings row the new columns’ defaults, and leaves every old column alone', () => {
    seedPre0003Database();

    const { db, close } = createWorkspaceDb(dir);
    try {
      const settings = workspace.getSettings(db);

      // The user's preferences, exactly as they were written under the pre-0003 schema.
      expect(settings).toMatchObject({
        launchAtLogin: true,
        startPage: 'saved',
        theme: 'dark',
        density: 'compact',
        sidebarStart: 'collapsed',
        sidebarCollapsed: true,
        lastOpenedPage: 'applications',
        defaultMarket: 'netherlands',
        defaultLocation: 'Amsterdam',
        sponsorOnlyDefault: false,
        indVerificationEnabled: false,
        defaultCvId: CV_ID,
        defaultLetterType: 'cover_letter',
        defaultLetterTone: 'confident',
        defaultLetterLength: 'detailed',
        defaultApplicationStatus: 'recruiter_screen',
        confirmApplicationDelete: false,
        autoArchiveRejected: true,
        defaultProvider: 'codex',
      });

      // And the three ADI-07 fields read back as their empty-but-valid defaults rather than as
      // null, undefined, or a JSON parse failure. This is the case `toSettings` defends against.
      expect(settings.agentSelectedSessionId).toBeNull();
      expect(settings.agentArchivedSessionIds).toEqual([]);
      expect(settings.agentUnreadCounts).toEqual({});
    } finally {
      close();
    }
  });

  it('still returns every pre-existing row through the normal repository readers', () => {
    seedPre0003Database();

    const { db, close } = createWorkspaceDb(dir);
    try {
      const [job] = workspace.listSavedJobs(db);
      expect(job).toMatchObject({
        id: JOB_ID,
        role: 'Senior Frontend Engineer',
        company: 'Redwood Software',
        market: 'netherlands',
        location: 'Amsterdam',
        salary: '€72.000 - €86.000',
        arrangement: 'hybrid',
        verification: 'ind_recognised_sponsor',
        matchPercent: 91,
        status: 'preparing',
        vacancyKey: 'nl:redwood-software:senior-frontend-engineer',
      });
      expect(job?.savedAt).toBe(new Date(SAVED_AT).toISOString());

      const [cv] = workspace.listCvDocuments(db);
      expect(cv).toMatchObject({ id: CV_ID, name: 'Jake Ortega: frontend', kind: 'uploaded', isDefault: true, text: CV_TEXT });
      // The pre-existing JSON column survives the migration as an object, not as a raw string.
      expect(cv?.profile).toEqual(CV_PROFILE);

      const [letter] = workspace.listLetters(db);
      expect(letter).toMatchObject({ id: LETTER_ID, status: 'final', cvId: CV_ID, body: LETTER_BODY });

      const [application] = workspace.listApplications(db);
      expect(application).toMatchObject({
        id: APPLICATION_ID,
        savedJobId: JOB_ID,
        status: 'interview',
        cvId: CV_ID,
        letterId: LETTER_ID,
        nextStep: 'Second interview with the platform team',
      });
      expect(application?.appliedAt).toBe(new Date(APPLIED_AT).toISOString());

      expect(workspace.getCounts(db)).toEqual({ savedJobs: 1, activeApplications: 1, letters: 1 });
    } finally {
      close();
    }
  });

  it('lets the AI Workspace write its new state onto the migrated row, and read it back', () => {
    seedPre0003Database();

    const first = createWorkspaceDb(dir);
    try {
      const updated = workspace.updateSettings(first.db, {
        agentSelectedSessionId: '00000000-0000-4000-8000-000000000000',
        agentArchivedSessionIds: ['11111111-1111-4111-8111-111111111111'],
        agentUnreadCounts: { '00000000-0000-4000-8000-000000000000': 3 },
      });
      expect(updated.agentSelectedSessionId).toBe('00000000-0000-4000-8000-000000000000');
      // Unrelated preferences on the same row are untouched by the ADI-07 write.
      expect(updated.theme).toBe('dark');
      expect(updated.defaultProvider).toBe('codex');
    } finally {
      first.close();
    }

    // Reopening runs the migrator again against a now-current database: it must be a no-op.
    const second = createWorkspaceDb(dir);
    try {
      const settings = workspace.getSettings(second.db);
      expect(settings.agentArchivedSessionIds).toEqual(['11111111-1111-4111-8111-111111111111']);
      expect(settings.agentUnreadCounts).toEqual({ '00000000-0000-4000-8000-000000000000': 3 });
      expect(workspace.listSavedJobs(second.db)).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  it('is a no-op the second time: reopening an already-migrated database applies nothing more', () => {
    seedPre0003Database();

    createWorkspaceDb(dir).close();
    createWorkspaceDb(dir).close();

    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      const applied = connection.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
      expect(applied.n).toBe(PRE_0003_TAGS.length + 1);
    } finally {
      connection.close();
    }
  });

  it('keeps the foreign-key detachment behavior working on rows that predate 0003', () => {
    seedPre0003Database();

    const { db, close } = createWorkspaceDb(dir);
    try {
      // Exercises `onDelete: set null` against rows written before the migration ran, which is the
      // one behavior a table rebuild (0002's shape) can silently drop by omitting the constraints.
      expect(workspace.deleteCvDocument(db, CV_ID)).toEqual({ deleted: true });
      expect(workspace.listLetters(db)[0]?.cvId).toBeNull();
      expect(workspace.listApplications(db)[0]?.cvId).toBeNull();
      expect(workspace.getSettings(db).defaultCvId).toBeNull();
    } finally {
      close();
    }
  });
});
