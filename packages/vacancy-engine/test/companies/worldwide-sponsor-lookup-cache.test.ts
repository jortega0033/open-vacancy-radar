import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  readWorldwideSponsorLookups,
  writeWorldwideSponsorLookup,
  WORLDWIDE_SPONSOR_LOOKUP_MAX_AGE_DAYS,
} from '../../src/companies/worldwide-sponsor-lookup-cache.js';
import {
  createDatabaseClient,
  migrateDatabase,
  type Database,
  type DatabaseClient,
} from '../../src/db/client.js';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'vacancy-engine-sponsor-lookups-'));

let client: DatabaseClient | undefined;

function db(): Database {
  if (client === undefined) throw new Error('test database is not initialized');
  return client.db;
}

const NOW = new Date('2026-06-01T12:00:00.000Z');
const MILLISECONDS_PER_DAY = 86_400_000;

describe('worldwide sponsor lookup cache', () => {
  beforeAll(async () => {
    client = createDatabaseClient(path.join(temporaryDirectory, 'lookups.db'));
    await migrateDatabase(client.db, migrationsFolder);
  }, 30_000);

  beforeEach(() => {
    client?.connection.exec('delete from "worldwide_sponsor_lookups";');
  });

  afterAll(() => {
    client?.close();
    client = undefined;
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('returns nothing at all, and runs no query, for an empty key list', async () => {
    expect(await readWorldwideSponsorLookups(db(), [])).toEqual(new Map());
  });

  it('round-trips a resolved KVK and a resolved "nothing found", keeping them distinguishable from absent', async () => {
    await writeWorldwideSponsorLookup(
      db(),
      { companyKey: 'acme bv', companyName: 'Acme BV', kvkNumber: '12345678' },
      NOW,
    );
    // A `null` KVK is a real answer -- Wikidata was asked and had nothing unambiguous -- and must
    // come back as a cache *hit*, or every scan would keep re-paying for the same dead end.
    await writeWorldwideSponsorLookup(
      db(),
      { companyKey: 'beta bv', companyName: 'Beta BV', kvkNumber: null },
      NOW,
    );

    const known = await readWorldwideSponsorLookups(db(), ['acme bv', 'beta bv', 'never seen'], NOW);

    expect(known.get('acme bv')).toEqual({ kvkNumber: '12345678' });
    expect(known.has('beta bv')).toBe(true);
    expect(known.get('beta bv')).toEqual({ kvkNumber: null });
    expect(known.has('never seen')).toBe(false);
  });

  it('treats an entry past the freshness window as absent, so it is resolved again', async () => {
    const stale = new Date(
      NOW.getTime() - (WORLDWIDE_SPONSOR_LOOKUP_MAX_AGE_DAYS + 1) * MILLISECONDS_PER_DAY,
    );
    const fresh = new Date(
      NOW.getTime() - (WORLDWIDE_SPONSOR_LOOKUP_MAX_AGE_DAYS - 1) * MILLISECONDS_PER_DAY,
    );
    await writeWorldwideSponsorLookup(
      db(),
      { companyKey: 'stale bv', companyName: 'Stale BV', kvkNumber: '11111111' },
      stale,
    );
    await writeWorldwideSponsorLookup(
      db(),
      { companyKey: 'fresh bv', companyName: 'Fresh BV', kvkNumber: '22222222' },
      fresh,
    );

    const known = await readWorldwideSponsorLookups(db(), ['stale bv', 'fresh bv'], NOW);

    expect(known.has('stale bv')).toBe(false);
    expect(known.get('fresh bv')).toEqual({ kvkNumber: '22222222' });
  });

  it('replaces an earlier answer for the same employer rather than accumulating rows', async () => {
    await writeWorldwideSponsorLookup(
      db(),
      { companyKey: 'acme bv', companyName: 'ACME  BV', kvkNumber: null },
      new Date(NOW.getTime() - MILLISECONDS_PER_DAY),
    );
    await writeWorldwideSponsorLookup(
      db(),
      { companyKey: 'acme bv', companyName: 'Acme BV', kvkNumber: '87654321' },
      NOW,
    );

    const rows = client?.connection
      .prepare('SELECT company_name, kvk_number FROM worldwide_sponsor_lookups')
      .all() as { company_name: string; kvk_number: string | null }[];

    expect(rows).toEqual([{ company_name: 'Acme BV', kvk_number: '87654321' }]);
  });

  it('reads more keys than SQLite allows bound parameters in one statement', async () => {
    const keys = Array.from({ length: 1_200 }, (_unused, index) => `company ${index}`);
    for (const key of keys) {
      await writeWorldwideSponsorLookup(
        db(),
        { companyKey: key, companyName: key, kvkNumber: null },
        NOW,
      );
    }

    const known = await readWorldwideSponsorLookups(db(), keys, NOW);

    expect(known.size).toBe(1_200);
  });
});
