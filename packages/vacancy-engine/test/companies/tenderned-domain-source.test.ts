import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AtsHttpResponse } from '../../src/ats/http.js';
import {
  fetchTendernedDomainEvidence,
  parseTendernedDomainEvidence,
  TENDERNED_BULK_DATASETS,
  TENDERNED_BULK_JSON_URL,
  TENDERNED_BULK_JSON_URLS,
} from '../../src/companies/tenderned-domain-source.js';
import { FixtureHttpClient } from '../ats/helpers.js';

async function fixture(): Promise<string> {
  return readFile(
    path.resolve(process.cwd(), 'test/fixtures/companies/tenderned-2026-h1.json'),
    'utf8',
  );
}

describe('TenderNed supplier domain source', () => {
  it('emits only exact Dutch KVK, legal-name, award, website, and notice pairings', async () => {
    const result = parseTendernedDomainEvidence(await fixture());

    expect(result).toMatchObject({
      releaseCount: 9,
      supplierPartyCount: 10,
      awardedSupplierPartyCount: 3,
      invalidIdentifierCount: 1,
      nonDutchSupplierCount: 1,
      unconfirmedAwardCount: 2,
      ambiguousPairingCount: 2,
      invalidUrlCount: 1,
      incompleteRecordCount: 1,
    });
    expect(result.evidence).toEqual([
      {
        source: 'tenderned',
        sourceVersion: 'tenderned-ocds-supplier-domain-2026-h1-v1',
        sourceRecordId: 'ocds-1l04xe-valid:500001:supplier:01234567',
        sourceName: 'Acme B.V.',
        kvkNumber: '01234567',
        officialUrl: 'https://www.acme.nl/about',
        hostnameKey: 'acme.nl',
        evidenceUrl: 'https://www.tenderned.nl/tenderned-tap/aankondigingen/500001',
      },
    ]);
  });

  it('downloads an injected pinned JSON subset through the safe HTTP client', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [
          TENDERNED_BULK_JSON_URL,
          {
            status: 200,
            finalUrl: TENDERNED_BULK_JSON_URL,
            headers: { 'content-type': 'application/json' },
            body: await fixture(),
          },
        ],
      ]),
    );

    const result = await fetchTendernedDomainEvidence(http, {
      datasetUrls: [TENDERNED_BULK_JSON_URL],
    });

    expect(result.evidence).toHaveLength(1);
    expect(result.datasetsFetched).toBe(1);
    expect(result.datasetStatistics).toEqual([
      expect.objectContaining({
        datasetUrl: TENDERNED_BULK_JSON_URL,
        period: '2026-h1',
        sourceVersion: 'tenderned-ocds-supplier-domain-2026-h1-v1',
        releaseCount: 9,
        evidenceCount: 1,
      }),
    ]);
    expect(http.requestedUrls).toEqual([TENDERNED_BULK_JSON_URL]);
    expect(http.requestedOptions).toEqual([
      { allowedOrigins: ['https://www.tenderned.nl'] },
    ]);
  });

  it('fetches selected snapshots sequentially, sums source stats, and deduplicates evidence', async () => {
    const firstUrl = TENDERNED_BULK_DATASETS[0].url;
    const secondUrl = TENDERNED_BULK_DATASETS[1].url;
    let firstFinished = false;
    const http = new FixtureHttpClient(
      new Map<string, () => Promise<AtsHttpResponse>>([
        [
          firstUrl,
          async () => {
            firstFinished = true;
            return {
              status: 200,
              finalUrl: firstUrl,
              headers: { 'content-type': 'application/json' },
              body: await fixture(),
            };
          },
        ],
        [
          secondUrl,
          async () => {
            expect(firstFinished).toBe(true);
            return {
              status: 200,
              finalUrl: secondUrl,
              headers: { 'content-type': 'application/json; charset=utf-8' },
              body: await fixture(),
            };
          },
        ],
      ]),
    );

    const result = await fetchTendernedDomainEvidence(http, {
      datasetUrls: [firstUrl, secondUrl],
    });

    expect(result).toMatchObject({
      datasetsFetched: 2,
      releaseCount: 18,
      supplierPartyCount: 20,
      awardedSupplierPartyCount: 6,
    });
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.sourceVersion).toBe(
      'tenderned-ocds-supplier-domain-2022-v1',
    );
    expect(result.datasetStatistics.map(({ period, evidenceCount }) => [period, evidenceCount]))
      .toEqual([
        ['2021', 1],
        ['2022', 1],
      ]);
    expect(http.requestedUrls).toEqual([firstUrl, secondUrl]);
  });

  it('pins all six official immutable annual snapshot URLs', () => {
    expect(TENDERNED_BULK_JSON_URLS).toEqual([
      'https://www.tenderned.nl/cms/sites/default/files/2026-07/Dataset_Tenderned-2021-01-01-2021-12-31.json',
      'https://www.tenderned.nl/cms/sites/default/files/2026-07/Dataset_Tenderned-2022-01-01-2022-12-31.json',
      'https://www.tenderned.nl/cms/sites/default/files/2026-07/Dataset_Tenderned-2023-01-01-2023-12-31.json',
      'https://www.tenderned.nl/cms/sites/default/files/2026-07/Dataset_Tenderned-2024-01-01-2024-12-31.json',
      'https://www.tenderned.nl/cms/sites/default/files/2026-07/Dataset_Tenderned-2025-01-01-2025-12-31.json',
      'https://www.tenderned.nl/cms/sites/default/files/2026-07/Dataset_Tenderned-2026-01-01-2026-06-30.json',
    ]);
  });

  it('fails closed on an unexpected dataset identity or redirected bulk response', async () => {
    expect(() =>
      parseTendernedDomainEvidence(
        JSON.stringify({
          uri: 'https://attacker.invalid/dataset',
          version: '1.1',
          releases: [],
        }),
      ),
    ).toThrow(/not the expected TenderNed OCDS dataset/u);

    const http = new FixtureHttpClient(
      new Map([
        [
          TENDERNED_BULK_JSON_URL,
          {
            status: 200,
            finalUrl: 'https://www.tenderned.nl/cms/login',
            headers: { 'content-type': 'text/html' },
            body: '<html></html>',
          },
        ],
      ]),
    );
    await expect(
      fetchTendernedDomainEvidence(http, { datasetUrls: [TENDERNED_BULK_JSON_URL] }),
    ).rejects.toThrow(
      /left the pinned TenderNed dataset URL/u,
    );
  });

  it('rejects unpinned or duplicate snapshot selections before any request', async () => {
    const http = new FixtureHttpClient(new Map());

    await expect(
      fetchTendernedDomainEvidence(http, {
        datasetUrls: ['https://www.tenderned.nl/cms/unpinned.json'],
      }),
    ).rejects.toThrow(/unpinned TenderNed snapshot URL/u);
    await expect(
      fetchTendernedDomainEvidence(http, {
        datasetUrls: [TENDERNED_BULK_JSON_URL, TENDERNED_BULK_JSON_URL],
      }),
    ).rejects.toThrow(/duplicate TenderNed snapshot URL/u);
    expect(http.requestedUrls).toEqual([]);
  });
});
