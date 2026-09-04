// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Migration 0005 flips `app_settings.sponsor_only_default` and `.ind_verification_enabled` from
 * `DEFAULT true` to `DEFAULT false`: two Netherlands-only toggles that shipped pre-enabled for
 * every new install, which is exactly the "no default country/role/salary bias" rule this app is
 * supposed to hold to (they were also otherwise-dead for `sponsorOnlyDefault`; see
 * `apps/desktop/src/components/settings/SearchProfileSection.tsx`'s doc history).
 *
 * SQLite has no `ALTER COLUMN ... SET DEFAULT`, so drizzle-kit generated a full
 * create-copy-drop-rename rebuild, the same shape 0002 used. That makes this migration's real risk
 * different from 0004's additive one: a rebuild COULD, if written wrong, re-apply the new default
 * to existing rows instead of copying their actual stored value across. `app_settings` is a
 * single fixed row (id=1), so there is exactly one row to get right, and this file proves both
 * halves: an existing installation's already-stored value survives untouched, and a genuinely new
 * install (no prior row) gets the new, bias-free default.
 */

const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'workspace', 'drizzle');

/** The tags this test pins the seeded database to: everything 0005 builds on top of. */
const PRE_0005_TAGS = [
  '0000_familiar_giant_man',
  '0001_misty_hobgoblin',
  '0002_brainy_morgan_stark',
  '0003_curved_shotgun',
  '0004_damp_dust',
];

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

/**
 * Copies the real 0000-0004 migrations into `<root>/drizzle-0004` with a journal that stops there.
 * Fails loudly if the real journal ever stops matching `PRE_0005_TAGS`, so a future 0006 (or a
 * squashed history) cannot quietly turn this into a test of the wrong prior version.
 */
function seedPre0005MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const kept = journal.entries.filter((entry) => PRE_0005_TAGS.includes(entry.tag));
  expect(kept.map((entry) => entry.tag)).toEqual(PRE_0005_TAGS);
  expect(journal.entries[PRE_0005_TAGS.length]?.tag).toBe('0005_lean_echo');

  const folder = join(root, 'drizzle-0004');
  mkdirSync(join(folder, 'meta'), { recursive: true });
  for (const entry of kept) {
    cpSync(join(REAL_MIGRATIONS, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  return folder;
}

/**
 * Copies the real 0000-0005 migrations into `<root>/drizzle-0005` with a journal that stops there.
 *
 * Used instead of `createWorkspaceDb` (which always applies the app's full, current migration
 * chain) for the tests below that verify 0005's own behavior specifically: migration 0006 later
 * drops the very columns 0005 is about, so running the full chain would make this file's own
 * assertions about those columns fail for a reason that has nothing to do with 0005 itself.
 * Migration history is immutable -- an earlier migration's regression test must keep proving what
 * that migration did at the time, independent of what a later migration does to the same columns.
 */
function seedThrough0005MigrationsFolder(root: string): string {
  const journal = JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
  const tags = [...PRE_0005_TAGS, '0005_lean_echo'];
  const kept = journal.entries.filter((entry) => tags.includes(entry.tag));
  expect(kept.map((entry) => entry.tag)).toEqual(tags);

  const folder = join(root, 'drizzle-0005');
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

let dir: string;

/**
 * Builds a pre-0005 `workspace.db` with the settings row already created (as every real install
 * has: `main.ts` creates it on first launch) and both toggles explicitly set `true` -- either a
 * user who genuinely turned them on, or simply the pre-fix default nobody touched. Either way,
 * 0005 must not silently overwrite it.
 */
function seedPre0005Database(): void {
  const folder = seedPre0005MigrationsFolder(dir);
  const connection = openRaw(join(dir, 'workspace.db'));
  try {
    migrate(drizzle(connection), { migrationsFolder: folder });
    connection
      .prepare(
        `INSERT INTO app_settings (id, sponsor_only_default, ind_verification_enabled) VALUES (1, 1, 1)`,
      )
      .run();
  } finally {
    connection.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-workspace-migrate-0005-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the seeded fixture really is a pre-0005 database', () => {
  it('has both toggles true, from the pre-0005 default', () => {
    seedPre0005Database();
    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      const row = connection.prepare('SELECT sponsor_only_default, ind_verification_enabled FROM app_settings').get() as {
        sponsor_only_default: number;
        ind_verification_enabled: number;
      };
      expect(row.sponsor_only_default).toBe(1);
      expect(row.ind_verification_enabled).toBe(1);
      const applied = connection.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
      expect(applied.n).toBe(PRE_0005_TAGS.length);
    } finally {
      connection.close();
    }
  });
});

describe('migration 0005 changes the default without rewriting existing data', () => {
  it('is a table rebuild with no data-modifying statement of its own (INSERT ... SELECT only)', () => {
    // The rebuild's own INSERT is a copy by explicit, named column list on both sides (safer than
    // `SELECT *`, which could silently misalign if column order ever differed) -- asserted against
    // the shipped SQL text so a future edit that adds a real UPDATE/SET clause here (which would
    // silently rewrite every existing install's row) fails this test.
    const sql = readFileSync(join(REAL_MIGRATIONS, '0005_lean_echo.sql'), 'utf8');
    const insertMatch = sql.match(/INSERT INTO `__new_app_settings`\(([^)]+)\) SELECT ([^)]+?) FROM `app_settings`/s);
    expect(insertMatch, 'expected a column-list INSERT ... SELECT copy').not.toBeNull();
    // The two column lists must be identical, not merely both non-empty: a future regeneration that
    // silently reordered one side relative to the other would land a value in the wrong column.
    expect(insertMatch![1]).toBe(insertMatch![2]);
    // `/^UPDATE\s/m` (statement-initial), not `/\bUPDATE\b/`: the latter also matches the
    // `FOREIGN KEY ... ON UPDATE no action` clause the CREATE TABLE statement legitimately carries.
    expect(sql).not.toMatch(/^UPDATE\s/im);
    expect(sql).toMatch(/`sponsor_only_default` integer DEFAULT false NOT NULL/);
    expect(sql).toMatch(/`ind_verification_enabled` integer DEFAULT false NOT NULL/);
  });

  it("leaves an existing installation's already-true toggles unchanged", () => {
    seedPre0005Database();

    const through0005 = seedThrough0005MigrationsFolder(dir);
    const upgrade = openRaw(join(dir, 'workspace.db'));
    migrate(drizzle(upgrade), { migrationsFolder: through0005 });
    upgrade.close();

    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      const applied = connection.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
      expect(applied.n).toBe(PRE_0005_TAGS.length + 1);
      const row = connection.prepare('SELECT sponsor_only_default, ind_verification_enabled FROM app_settings').get() as {
        sponsor_only_default: number;
        ind_verification_enabled: number;
      };
      // Still 1: the rebuild copied the row's real stored value, not the new column default.
      expect(row.sponsor_only_default).toBe(1);
      expect(row.ind_verification_enabled).toBe(1);
    } finally {
      connection.close();
    }
  });

  it('gives a genuinely new install (no prior settings row) the new, bias-free default', () => {
    // No seedPre0005Database() here: a brand-new database has never had an app_settings row, so
    // this exercises the migration's DEFAULT clause itself, not a copied value. The row is
    // inserted with neither toggle specified, exactly like the app's own first-launch insert.
    const through0005 = seedThrough0005MigrationsFolder(dir);
    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      migrate(drizzle(connection), { migrationsFolder: through0005 });
      connection.prepare('INSERT INTO app_settings (id) VALUES (1)').run();
      const row = connection
        .prepare('SELECT sponsor_only_default, ind_verification_enabled FROM app_settings WHERE id = 1')
        .get() as { sponsor_only_default: number; ind_verification_enabled: number };
      expect(row.sponsor_only_default).toBe(0);
      expect(row.ind_verification_enabled).toBe(0);
    } finally {
      connection.close();
    }
  });

  it('is a no-op the second time: reopening an already-migrated database applies nothing more', () => {
    seedPre0005Database();

    const through0005 = seedThrough0005MigrationsFolder(dir);
    const first = openRaw(join(dir, 'workspace.db'));
    migrate(drizzle(first), { migrationsFolder: through0005 });
    first.close();
    const second = openRaw(join(dir, 'workspace.db'));
    migrate(drizzle(second), { migrationsFolder: through0005 });
    second.close();

    const connection = openRaw(join(dir, 'workspace.db'));
    try {
      const applied = connection.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
      expect(applied.n).toBe(PRE_0005_TAGS.length + 1);
    } finally {
      connection.close();
    }
  });
});
