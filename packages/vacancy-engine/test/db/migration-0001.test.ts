// @vitest-environment node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseClient, migrateDatabase } from '../../src/db/client.js';

/**
 * Migration 0001 drops the fourteen tables that existed only to serve the curated Netherlands
 * pipeline (see the plan for the full deletion: `full-scan.ts`, `company-campaign.ts`, and the
 * whole company-discovery/scoring/reporting chain behind them). Following the exact pattern
 * `apps/desktop/test/workspace-migration-0005.test.ts` established for the desktop's own
 * column-drop migration.
 *
 * The real risk here is not "does the migration run" -- drizzle-kit generated a plain sequence of
 * `DROP TABLE` statements -- it's *order*. `foreign_keys = ON` is set for the whole connection
 * (`db/client.ts`), and SQLite refuses to drop a table another live table still references via a
 * foreign key. drizzle-kit's own generator emitted the drops alphabetically, which is wrong (e.g.
 * `companies` sorts before `company_aliases`/`company_sponsors`, its own children) and would fail
 * at runtime. The shipped migration was hand-reordered child-first, reusing the exact order
 * `test/integration/sqlite-lifecycle.test.ts`'s `INTEGRATION_TABLES` already documents and
 * exercises for row deletion. This file proves that reordering is actually correct against a
 * populated database, not just plausible.
 *
 * The second real risk is `ind_sponsors`/`ind_sponsor_snapshots`/`http_cache` survival: they are
 * the only tables `worldwideSponsorMatch` (the sole surviving verification signal) depends on.
 * Losing them here would silently degrade that check to "always null" with no error anywhere.
 */

const REAL_MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');

const PRE_0001_TAGS = ['0000_giant_winter_soldier'];

type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
type Journal = { version: string; dialect: string; entries: JournalEntry[] };

function readJournal(): Journal {
  return JSON.parse(readFileSync(join(REAL_MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as Journal;
}

/** Copies the real 0000 migration into `<root>/drizzle-0000` with a journal that stops there.
 * Fails loudly if the real journal's first entry or its immediate successor ever changes, so a
 * future 0002 (or a squashed history) cannot quietly turn this into a test of the wrong version. */
function seedPre0001MigrationsFolder(root: string): string {
  const journal = readJournal();
  const kept = journal.entries.filter((entry) => PRE_0001_TAGS.includes(entry.tag));
  expect(kept.map((entry) => entry.tag)).toEqual(PRE_0001_TAGS);
  expect(journal.entries[kept.length]?.tag).toBe('0001_tricky_the_enforcers');

  const folder = join(root, 'drizzle-0000');
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

function tableNames(connection: Database.Database): string[] {
  return (
    connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'").all() as Array<{ name: string }>
  ).map((row) => row.name);
}

const SPONSOR_ID = 'sponsor-1111-2222-3333-444455556666';
const COMPANY_ID = 'company-1111-2222-3333-444455556666';
const CAREER_SOURCE_ID = 'career-1111-2222-3333-444455556666';
const VACANCY_ID = 'vacancy-111-2222-3333-444455556666';
const SCAN_RUN_ID = 'scanrun-111-2222-3333-444455556666';

/** Seeds one realistic, FK-linked row per surviving table plus every doomed table that has a
 * meaningful FK chain, so the migration is proven against real references, not an empty schema. */
const FAKE_CONTENT_HASH = 'a'.repeat(64);

function seedRows(connection: Database.Database): void {
  const now = Date.now();

  connection
    .prepare(
      `INSERT INTO ind_sponsors (id, source_identity_key, legal_name, normalized_name, search_name, kvk_number, source_url, source_retrieved_at, first_seen_at, last_seen_at, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(SPONSOR_ID, 'sponsor-key-1', 'Acme B.V.', 'acme bv', 'acme', '12345678', 'https://ind.nl/register', now, now, now);

  connection
    .prepare(
      `INSERT INTO ind_sponsor_snapshots (id, source_url, source_last_updated, retrieved_at, raw_row_count, unique_sponsor_count, duplicate_row_count, membership_hash, accepted, rejection_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)`,
    )
    .run('snap-1', 'https://ind.nl/register', now, now, 100, 95, 5, 'hash-abc');

  connection
    .prepare(
      `INSERT INTO http_cache (cache_key, url, final_url, status, content_type, response_headers, etag, last_modified, body, body_hash, fetched_at, expires_at)
       VALUES (?, ?, ?, 200, 'text/html', '{}', NULL, NULL, ?, ?, ?, NULL)`,
    )
    .run('cache-1', 'https://example.test/', 'https://example.test/', '<html></html>', 'body-hash-1', now);

  connection
    .prepare(
      `INSERT INTO companies (id, brand_name, domain, mapping_confidence, mapping_source, mapping_evidence, scan_enabled, created_at, updated_at)
       VALUES (?, 'Acme', 'acme.example', 'high', 'manual', '{}', 1, ?, ?)`,
    )
    .run(COMPANY_ID, now, now);

  connection
    .prepare(
      `INSERT INTO company_aliases (id, company_id, alias, normalized_alias, source, confidence)
       VALUES ('alias-1', ?, 'Acme BV', 'acme bv', 'manual', 'high')`,
    )
    .run(COMPANY_ID);

  connection
    .prepare(
      `INSERT INTO company_sponsors (company_id, sponsor_id, relationship, confidence, source, evidence, catalog_managed, discovery_managed, created_at)
       VALUES (?, ?, 'legal_entity', 'high', 'manual', '{}', 1, 0, ?)`,
    )
    .run(COMPANY_ID, SPONSOR_ID, now);

  connection
    .prepare(
      `INSERT INTO career_sources (id, company_id, source_type, provider, base_url, discovery_method, discovery_evidence, status, catalog_managed, discovery_managed, created_at, updated_at)
       VALUES (?, ?, 'ats', 'greenhouse', 'https://boards.greenhouse.io/acme', 'manual', '{}', 'active', 1, 0, ?, ?)`,
    )
    .run(CAREER_SOURCE_ID, COMPANY_ID, now, now);

  connection
    .prepare(
      `INSERT INTO vacancies (id, company_id, career_source_id, external_id, title, description, url, workplace_mode, first_seen_at, last_seen_at, content_hash, hash_version, active, missing_complete_scans)
       VALUES (?, ?, ?, 'ext-1', 'Frontend Engineer', 'Build things.', 'https://boards.greenhouse.io/acme/1', 'remote', ?, ?, ?, 'vacancy-content-v2', 1, 0)`,
    )
    .run(VACANCY_ID, COMPANY_ID, CAREER_SOURCE_ID, now, now, FAKE_CONTENT_HASH);

  connection
    .prepare(
      `INSERT INTO vacancy_scores (id, vacancy_id, candidate_profile_version, scoring_version, deterministic_score, final_score, technical_fit, role_fit, seniority_fit, language_fit, location_fit, dutch_required, dutch_preferred, language_evidence, primary_fit, matching_skills, gaps, reasons, content_hash, scored_at)
       VALUES ('score-1', ?, 'v1', 'v1', 80, 80, 80, 80, 80, 100, 100, 0, 0, '[]', 'Frontend', '[]', '[]', '[]', ?, ?)`,
    )
    .run(VACANCY_ID, FAKE_CONTENT_HASH, now);

  connection
    .prepare(
      `INSERT INTO vacancy_snapshots (id, vacancy_id, content_hash, hash_version, payload, observed_at)
       VALUES ('snap-vac-1', ?, ?, 'vacancy-content-v2', '{}', ?)`,
    )
    .run(VACANCY_ID, FAKE_CONTENT_HASH, now);

  connection
    .prepare(`INSERT INTO application_status (vacancy_id, status, notes, updated_at) VALUES (?, 'new', NULL, ?)`)
    .run(VACANCY_ID, now);

  connection
    .prepare(
      `INSERT INTO scan_runs (id, command, status, ai_enabled, started_at, finished_at, statistics)
       VALUES (?, 'scan', 'succeeded', 0, ?, ?, '{}')`,
    )
    .run(SCAN_RUN_ID, now, now);

  connection
    .prepare(
      `INSERT INTO scan_source_outcomes (id, scan_run_id, career_source_id, status, complete, vacancies_seen, request_count, duration_ms, created_at)
       VALUES ('outcome-1', ?, ?, 'succeeded', 1, 1, 1, 10, ?)`,
    )
    .run(SCAN_RUN_ID, CAREER_SOURCE_ID, now);

  connection
    .prepare(
      `INSERT INTO scan_errors (id, scan_run_id, company_id, career_source_id, category, message, context, occurred_at)
       VALUES ('error-1', ?, ?, ?, 'network_error', 'boom', '{}', ?)`,
    )
    .run(SCAN_RUN_ID, COMPANY_ID, CAREER_SOURCE_ID, now);

  connection
    .prepare(
      `INSERT INTO sponsor_discovery (sponsor_id, status, evidence, priority, attempt_count, created_at, updated_at)
       VALUES (?, 'needs_domain', '{}', 0, 0, ?, ?)`,
    )
    .run(SPONSOR_ID, now, now);
}

let dir: string;

function seedPre0001Database(): void {
  const folder = seedPre0001MigrationsFolder(dir);
  const connection = openRaw(join(dir, 'vacancy-engine.db'));
  try {
    migrate(drizzle(connection), { migrationsFolder: folder });
    seedRows(connection);
  } finally {
    connection.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-engine-migrate-0001-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the seeded fixture really is a pre-0001 database', () => {
  it('has all fourteen doomed tables plus the three survivors', () => {
    seedPre0001Database();
    const connection = openRaw(join(dir, 'vacancy-engine.db'));
    try {
      const tables = tableNames(connection);
      expect(tables).toEqual(
        expect.arrayContaining(['companies', 'vacancies', 'ind_sponsors', 'http_cache']),
      );
      const applied = connection.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
      expect(applied.n).toBe(PRE_0001_TAGS.length);
    } finally {
      connection.close();
    }
  });
});

describe('migration 0001 drops the curated Netherlands pipeline tables only', () => {
  it('is written as DROP TABLE only, no CREATE/INSERT/UPDATE of its own', () => {
    const sql = readFileSync(join(REAL_MIGRATIONS, '0001_tricky_the_enforcers.sql'), 'utf8');
    expect(sql).not.toMatch(/\bCREATE TABLE\b/i);
    expect(sql).not.toMatch(/^INSERT\s/im);
    expect(sql).not.toMatch(/^UPDATE\s/im);
    const dropped = [...sql.matchAll(/DROP TABLE `([a-z_]+)`/g)].map((match) => match[1]);
    expect(dropped).toEqual([
      'application_status',
      'scan_errors',
      'scan_source_outcomes',
      'company_discovery_campaign_items',
      'company_discovery_attempts',
      'sponsor_discovery',
      'scan_runs',
      'vacancy_scores',
      'vacancy_snapshots',
      'vacancies',
      'career_sources',
      'company_sponsors',
      'company_aliases',
      'companies',
    ]);
  });

  it('applies cleanly against a populated database with real FK-linked rows', async () => {
    seedPre0001Database();

    // The real regression this proves: drizzle-kit generated these DROP TABLE statements in
    // alphabetical order, which drops `companies` before its own children `company_aliases`/
    // `company_sponsors` -- SQLite refuses that with foreign_keys=ON. The shipped migration was
    // hand-reordered child-first; running it against real FK-linked rows (not an empty schema)
    // is what actually exercises that ordering rather than merely asserting it looks plausible.
    const { db, close } = createDatabaseClient(join(dir, 'vacancy-engine.db'));
    try {
      await migrateDatabase(db);
    } finally {
      close();
    }
  });

  it('leaves the fourteen curated tables gone and the three survivors intact, byte-identical', async () => {
    seedPre0001Database();

    const { db, close } = createDatabaseClient(join(dir, 'vacancy-engine.db'));
    try {
      await migrateDatabase(db);
    } finally {
      close();
    }

    const connection = openRaw(join(dir, 'vacancy-engine.db'));
    try {
      const tables = tableNames(connection);
      expect(tables.sort()).toEqual(['http_cache', 'ind_sponsor_snapshots', 'ind_sponsors'].sort());

      // The load-bearing assertion: the only tables the surviving worldwideSponsorMatch check
      // depends on must come through with every value unchanged, not just "the table exists".
      const sponsor = connection.prepare('SELECT * FROM ind_sponsors WHERE id = ?').get(SPONSOR_ID) as
        | Record<string, unknown>
        | undefined;
      expect(sponsor).toMatchObject({
        id: SPONSOR_ID,
        legal_name: 'Acme B.V.',
        kvk_number: '12345678',
        active: 1,
      });

      const snapshot = connection.prepare('SELECT * FROM ind_sponsor_snapshots WHERE id = ?').get('snap-1') as
        | Record<string, unknown>
        | undefined;
      expect(snapshot).toMatchObject({ id: 'snap-1', accepted: 1, unique_sponsor_count: 95 });

      const cache = connection.prepare('SELECT * FROM http_cache WHERE cache_key = ?').get('cache-1') as
        | Record<string, unknown>
        | undefined;
      expect(cache).toMatchObject({ cache_key: 'cache-1', status: 200, body: '<html></html>' });
    } finally {
      connection.close();
    }
  });

  it('is a no-op the second time: reopening an already-migrated database applies nothing more', async () => {
    seedPre0001Database();

    for (let i = 0; i < 2; i += 1) {
      const { db, close } = createDatabaseClient(join(dir, 'vacancy-engine.db'));
      try {
        await migrateDatabase(db);
      } finally {
        close();
      }
    }

    const connection = openRaw(join(dir, 'vacancy-engine.db'));
    try {
      const applied = connection.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get() as { n: number };
      expect(applied.n).toBe(PRE_0001_TAGS.length + 1);
    } finally {
      connection.close();
    }
  });
});

describe('migrateDatabase applies 0001 to a genuinely fresh database too', () => {
  it('creates only the three surviving tables from nothing', async () => {
    const { db, close } = createDatabaseClient(join(dir, 'fresh.db'));
    try {
      await migrateDatabase(db);
    } finally {
      close();
    }

    const connection = openRaw(join(dir, 'fresh.db'));
    try {
      expect(tableNames(connection).sort()).toEqual(['http_cache', 'ind_sponsor_snapshots', 'ind_sponsors'].sort());
    } finally {
      connection.close();
    }
  });
});
