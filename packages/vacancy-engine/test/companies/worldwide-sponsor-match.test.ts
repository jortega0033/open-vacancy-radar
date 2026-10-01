import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { WIKIDATA_API_ENDPOINT } from '../../src/companies/wikidata-name-source.js';
import { resolveWorldwideSponsorMatch } from '../../src/companies/worldwide-sponsor-match.js';
import { createDatabaseClient, migrateDatabase, type Database, type DatabaseClient } from '../../src/db/client.js';
import { indSponsors } from '../../src/db/schema.js';
import { FixtureHttpClient } from '../ats/helpers.js';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'vacancy-engine-worldwide-sponsor-'));
const testDatabasePath = path.join(temporaryDirectory, 'worldwide-sponsor-test.db');

let client: DatabaseClient | undefined;

function database(): Database {
  if (client === undefined) throw new Error('test database is not initialized');
  return client.db;
}

async function seedSponsor(overrides: { kvkNumber: string; legalName: string; active?: boolean }): Promise<void> {
  await database()
    .insert(indSponsors)
    .values({
      sourceIdentityKey: `test:${overrides.kvkNumber}`,
      legalName: overrides.legalName,
      normalizedName: overrides.legalName.toLowerCase(),
      searchName: overrides.legalName.toLowerCase(),
      kvkNumber: overrides.kvkNumber,
      sourceUrl: 'https://ind.example.test/register',
      sourceRetrievedAt: new Date('2026-01-01T00:00:00.000Z'),
      active: overrides.active ?? true,
    });
}

function searchUrl(companyName: string): string {
  const url = new URL(WIKIDATA_API_ENDPOINT);
  url.searchParams.set('action', 'wbsearchentities');
  url.searchParams.set('search', companyName);
  url.searchParams.set('language', 'en');
  url.searchParams.set('type', 'item');
  url.searchParams.set('limit', '10');
  url.searchParams.set('format', 'json');
  return url.toString();
}

function claimsUrl(itemId: string): string {
  const url = new URL(WIKIDATA_API_ENDPOINT);
  url.searchParams.set('action', 'wbgetentities');
  url.searchParams.set('ids', itemId);
  url.searchParams.set('props', 'claims');
  url.searchParams.set('format', 'json');
  return url.toString();
}

function cleanSearchAndClaimsFixture(companyName: string, itemId: string, kvkNumber: string) {
  return new Map<string, string>([
    [
      searchUrl(companyName),
      JSON.stringify({ search: [{ id: itemId, label: companyName, match: { type: 'label', language: 'en', text: companyName } }] }),
    ],
    [
      claimsUrl(itemId),
      JSON.stringify({
        entities: {
          [itemId]: {
            id: itemId,
            claims: {
              P3220: [{ mainsnak: { snaktype: 'value', datavalue: { value: kvkNumber, type: 'string' } }, rank: 'normal' }],
              P856: [
                {
                  mainsnak: { snaktype: 'value', datavalue: { value: 'https://acme.test/', type: 'string' } },
                  rank: 'normal',
                },
              ],
            },
          },
        },
      }),
    ],
  ]);
}

describe('resolveWorldwideSponsorMatch', () => {
  beforeAll(async () => {
    client = createDatabaseClient(testDatabasePath);
    await migrateDatabase(client.db, migrationsFolder);
  }, 30_000);

  beforeEach(() => {
    client?.connection.exec('delete from "ind_sponsors";');
  });

  afterAll(() => {
    client?.close();
    client = undefined;
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it('never attempts the Wikidata lookup, or touches the database, for a non-Netherlands location', async () => {
    const http = new FixtureHttpClient(new Map());

    const result = await resolveWorldwideSponsorMatch({
      http,
      // A poisoned database stand-in: if the gate below ever failed to short-circuit before a
      // database read, this throws instead of silently returning a false negative that would
      // pass anyway.
      database: undefined as unknown as Database,
      companyName: 'Acme Corp',
      location: 'Remote (United States)',
    });

    expect(result).toBeNull();
    expect(http.requestedUrls).toEqual([]);
  });

  it('resolves a match for a clean, unambiguous Wikidata hit whose KVK is an active IND sponsor', async () => {
    await seedSponsor({ kvkNumber: '01234567', legalName: 'Acme Technologies B.V.' });
    const http = new FixtureHttpClient(cleanSearchAndClaimsFixture('Acme Corp', 'Q1', '01234567'));

    const result = await resolveWorldwideSponsorMatch({
      http,
      database: database(),
      companyName: 'Acme Corp',
      location: 'Amsterdam, Netherlands',
    });

    expect(result).toEqual({ legalName: 'Acme Technologies B.V.', kvkNumber: '01234567' });
  });

  it('reports absence, not a negative finding, when the resolved KVK matches no active IND sponsor', async () => {
    // No sponsor seeded at all -- and separately, an inactive sponsor with the exact same KVK
    // must not count either, matching the Netherlands pipeline's own `active` discipline.
    await seedSponsor({ kvkNumber: '01234567', legalName: 'Formerly Registered B.V.', active: false });
    const http = new FixtureHttpClient(cleanSearchAndClaimsFixture('Acme Corp', 'Q1', '01234567'));

    const result = await resolveWorldwideSponsorMatch({
      http,
      database: database(),
      companyName: 'Acme Corp',
      location: 'Amsterdam, Netherlands',
    });

    expect(result).toBeNull();
  });

  it('reports absence, never a guess, when the Wikidata name search is ambiguous', async () => {
    await seedSponsor({ kvkNumber: '01234567', legalName: 'Randstad N.V.' });
    const http = new FixtureHttpClient(
      new Map([
        [
          searchUrl('Randstad'),
          JSON.stringify({
            search: [
              { id: 'Q1', label: 'Randstad', match: { type: 'label', language: 'en', text: 'Randstad' } },
              { id: 'Q2', label: 'Randstad', match: { type: 'label', language: 'en', text: 'Randstad' } },
            ],
          }),
        ],
      ]),
    );

    const result = await resolveWorldwideSponsorMatch({
      http,
      database: database(),
      companyName: 'Randstad',
      location: 'Diemen, Netherlands',
    });

    expect(result).toBeNull();
    expect(http.requestedUrls).toEqual([searchUrl('Randstad')]);
  });

  it('reports absence when the matched entity has multiple official hosts, never picking one', async () => {
    await seedSponsor({ kvkNumber: '01234567', legalName: 'Heineken N.V.' });
    const http = new FixtureHttpClient(
      new Map([
        [
          searchUrl('Heineken'),
          JSON.stringify({
            search: [{ id: 'Q1', label: 'Heineken', match: { type: 'label', language: 'en', text: 'Heineken' } }],
          }),
        ],
        [
          claimsUrl('Q1'),
          JSON.stringify({
            entities: {
              Q1: {
                id: 'Q1',
                claims: {
                  P3220: [{ mainsnak: { snaktype: 'value', datavalue: { value: '01234567', type: 'string' } }, rank: 'normal' }],
                  P856: [
                    { mainsnak: { snaktype: 'value', datavalue: { value: 'https://heineken.nl/', type: 'string' } }, rank: 'normal' },
                    { mainsnak: { snaktype: 'value', datavalue: { value: 'https://theheinekencompany.com/', type: 'string' } }, rank: 'normal' },
                  ],
                },
              },
            },
          }),
        ],
      ]),
    );

    const result = await resolveWorldwideSponsorMatch({
      http,
      database: database(),
      companyName: 'Heineken',
      location: 'Amsterdam, Netherlands',
    });

    expect(result).toBeNull();
  });
});
