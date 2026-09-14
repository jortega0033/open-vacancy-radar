import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadAtsSourceObservations } from '../../src/companies/ats-source-observation-repository.js';
import { loadAtsRoster } from '../../src/companies/ats-roster-repository.js';
import { loadConfig } from '../../src/config.js';
import type { DnsResolver } from '../../src/crawler/url-safety.js';
import type { Database } from '../../src/db/client.js';
import { createLogger } from '../../src/logger.js';
import { runAtsSourceObservationImport } from '../../src/pipeline/ats-source-observation-import.js';

const publicResolver: DnsResolver = () =>
  Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
const noDatabase = undefined as unknown as Database;
const asFetch = (
  implementation: (input: string | URL | Request) => Promise<Response>,
): typeof fetch => implementation as typeof fetch;

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'ats-source-observation-import-'));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe('runAtsSourceObservationImport', () => {
  it('promotes only tenants that pass the existing safe adapter and stable vacancy checks', async () => {
    const inputFile = join(projectRoot, 'scout.json');
    await writeFile(
      inputFile,
      JSON.stringify({
        version: 1,
        generatedAt: '2026-01-03T00:00:00.000Z',
        sources: [
          {
            company: 'Acme',
            url: 'https://job-boards.greenhouse.io/acme',
            evidence: 'live sample',
          },
          {
            company: 'Empty',
            url: 'https://job-boards.greenhouse.io/empty',
            evidence: 'healthy empty board',
          },
          {
            company: 'Unsupported',
            url: 'https://apply.workable.com/example',
            evidence: 'unsupported provider',
          },
        ],
      }),
      'utf8',
    );
    const fetchFn = asFetch((input) => {
      const url = input.toString();
      if (url.includes('/boards/acme/jobs')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              jobs: [
                {
                  id: 123,
                  title: 'Frontend Engineer',
                  absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/123',
                  content: '<p>Build the product.</p>',
                  location: { name: 'Amsterdam, Netherlands' },
                },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      if (url.includes('/boards/empty/jobs')) {
        return Promise.resolve(new Response(JSON.stringify({ jobs: [] }), { status: 200 }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const config = loadConfig({}, projectRoot);
    const logger = createLogger({ logLevel: 'silent' });

    const result = await runAtsSourceObservationImport(
      noDatabase,
      config,
      logger,
      inputFile,
      projectRoot,
      { fetchFn, resolver: publicResolver },
    );

    expect(result).toMatchObject({
      acceptedCount: 1,
      rejectedCount: 1,
      invalidCount: 1,
      duplicateCount: 0,
    });
    await expect(loadAtsRoster(projectRoot)).resolves.toEqual([
      {
        provider: 'greenhouse',
        slug: 'acme',
        baseUrl: 'https://job-boards.greenhouse.io',
        company: 'Acme',
      },
    ]);
    const observations = await loadAtsSourceObservations(projectRoot);
    expect(observations.observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: 'acme',
          status: 'verified',
          promotedAt: expect.any(String),
        }),
        expect.objectContaining({ slug: 'empty', status: 'empty', promotedAt: null }),
      ]),
    );
  });
});
