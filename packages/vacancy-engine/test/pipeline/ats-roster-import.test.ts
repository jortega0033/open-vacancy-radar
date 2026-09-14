import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { atsRosterCsvUrl } from '../../src/companies/ats-roster-source.js';
import { loadAtsRoster } from '../../src/companies/ats-roster-repository.js';
import { loadConfig } from '../../src/config.js';
import type { Database } from '../../src/db/client.js';
import type { DnsResolver } from '../../src/crawler/url-safety.js';
import { createLogger } from '../../src/logger.js';
import { runAtsRosterImport } from '../../src/pipeline/ats-roster-import.js';

function silentLogger() {
  return createLogger({ logLevel: 'silent' });
}

const publicResolver: DnsResolver = () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]);

function asFetch(
  implementation: (input: string | URL | Request) => Promise<Response>,
): typeof fetch {
  return implementation as typeof fetch;
}

const csvFor = (rows: string): string => `name,slug,url\n${rows}`;

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'ats-roster-import-'));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

// A poisoned database stand-in, matching the pattern in `pipeline/global-remote.test.ts`: the HTTP
// cache read/write both fail immediately, which `SafeHttpClient` already treats as non-fatal (see
// `onCacheError`), so this proves the import never actually depends on the cache succeeding.
const noDatabase = undefined as unknown as Database;

describe('runAtsRosterImport', () => {
  it('imports every in-scope provider and writes a merged roster file', async () => {
    const responses = new Map<string, string>([
      [atsRosterCsvUrl('greenhouse'), csvFor('Acme Corp,acme,https://job-boards.greenhouse.io/acme')],
      [atsRosterCsvUrl('lever'), csvFor('Widgets Inc,widgets,https://jobs.lever.co/widgets')],
      [atsRosterCsvUrl('ashby'), csvFor('OpenAI,openai,https://jobs.ashbyhq.com/openai')],
      [atsRosterCsvUrl('recruitee'), csvFor('Biovian,biovian,https://biovian.recruitee.com')],
      [atsRosterCsvUrl('personio'), csvFor('Acme DE,acme,https://acme.jobs.personio.com')],
    ]);
    const fetchFn = asFetch((input) => {
      const url = input.toString();
      const body = responses.get(url);
      if (body === undefined) throw new Error(`Unexpected fetch: ${url}`);
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    const config = loadConfig({}, projectRoot);
    const logger = silentLogger();

    const result = await runAtsRosterImport(noDatabase, config, logger, projectRoot, {
      fetchFn,
      resolver: publicResolver,
    });

    expect(result.totalEntries).toBe(5);
    expect(result.providers.every((provider) => provider.status === 'success')).toBe(true);
    expect(result.providers.map((provider) => provider.importedCount)).toEqual([1, 1, 1, 1, 1]);

    const roster = await loadAtsRoster(projectRoot);
    expect(roster).toHaveLength(5);
    expect(roster.map((entry) => entry.provider).sort()).toEqual(
      ['ashby', 'greenhouse', 'lever', 'personio', 'recruitee'].sort(),
    );
  });

  it('isolates one failing provider CSV, still writing a roster from the providers that succeeded', async () => {
    const fetchFn = asFetch((input) => {
      const url = input.toString();
      if (url === atsRosterCsvUrl('greenhouse')) {
        return Promise.resolve(new Response('server error', { status: 500 }));
      }
      if (url === atsRosterCsvUrl('lever')) {
        return Promise.resolve(
          new Response(csvFor('Widgets Inc,widgets,https://jobs.lever.co/widgets'), { status: 200 }),
        );
      }
      // Ashby/Recruitee/Personio: empty (but well-formed) CSVs.
      return Promise.resolve(new Response('name,slug,url\n', { status: 200 }));
    });
    const config = loadConfig({}, projectRoot);
    // The 500 above would otherwise be retried by the shared HTTP client's normal retry policy;
    // this test only cares about isolation, not retry timing, so retries are disabled.
    config.maxRetries = 0;
    const logger = silentLogger();

    const result = await runAtsRosterImport(noDatabase, config, logger, projectRoot, {
      fetchFn,
      resolver: publicResolver,
    });

    const greenhouseResult = result.providers.find((provider) => provider.provider === 'greenhouse');
    expect(greenhouseResult?.status).toBe('error');
    const leverResult = result.providers.find((provider) => provider.provider === 'lever');
    expect(leverResult).toMatchObject({ status: 'success', importedCount: 1 });
    expect(result.totalEntries).toBe(1);

    const roster = await loadAtsRoster(projectRoot);
    expect(roster).toEqual([
      { provider: 'lever', slug: 'widgets', baseUrl: 'https://jobs.lever.co', company: 'Widgets Inc' },
    ]);
  });

  it('never reads or writes a country field anywhere in the imported roster', async () => {
    const fetchFn = asFetch((input) => {
      const url = input.toString();
      if (url === atsRosterCsvUrl('greenhouse')) {
        return Promise.resolve(
          new Response(csvFor('Acme Corp,acme,https://job-boards.greenhouse.io/acme'), { status: 200 }),
        );
      }
      return Promise.resolve(new Response('name,slug,url\n', { status: 200 }));
    });
    const config = loadConfig({}, projectRoot);
    const logger = silentLogger();

    await runAtsRosterImport(noDatabase, config, logger, projectRoot, { fetchFn, resolver: publicResolver });

    const roster = await loadAtsRoster(projectRoot);
    expect(roster).toHaveLength(1);
    for (const entry of roster) {
      expect(Object.keys(entry)).not.toContain('country');
    }
  });
});
