import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  fetchIatiDomainEvidence,
  IATI_REPORTING_ORGS_URL,
  parseIatiDomainPage,
} from '../../src/companies/iati-domain-source.js';
import { FixtureHttpClient } from '../ats/helpers.js';

const PAGE_TWO_URL =
  'https://merged.dashboard.iatistandard.org/api/reporting-orgs/?format=json&page=2&page_size=5000';

async function fixture(name: string): Promise<string> {
  return readFile(path.resolve(process.cwd(), `test/fixtures/companies/${name}`), 'utf8');
}

describe('IATI reporting-org domain source', () => {
  it('accepts primary reporters with an exact NL-KVK prefix and strict website', async () => {
    const result = parseIatiDomainPage(JSON.parse(await fixture('iati-page-1.json')) as unknown);

    expect(result).toMatchObject({
      recordCount: 5,
      primarySourceCount: 4,
      invalidIdentifierCount: 1,
      invalidUrlCount: 1,
      incompleteRecordCount: 1,
    });
    expect(result.evidence).toEqual([
      expect.objectContaining({
        source: 'iati',
        kvkNumber: '01234567',
        officialUrl: 'https://www.acme.nl/',
        evidenceUrl:
          'https://merged.dashboard.iatistandard.org/api/reporting-orgs/acme/',
      }),
    ]);
  });

  it('follows same-feed pagination through the cached HTTP client', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [IATI_REPORTING_ORGS_URL, await fixture('iati-page-1.json')],
        [PAGE_TWO_URL, await fixture('iati-page-2.json')],
      ]),
    );

    const result = await fetchIatiDomainEvidence(http);

    expect(result).toMatchObject({
      pagesFetched: 2,
      reportedRecordCount: 8,
      recordCount: 8,
      primarySourceCount: 7,
    });
    expect(result.evidence).toHaveLength(4);
    expect(http.requestedUrls).toEqual([IATI_REPORTING_ORGS_URL, PAGE_TWO_URL]);
    expect(http.requestedOptions).toEqual([
      { allowedOrigins: ['https://merged.dashboard.iatistandard.org'] },
      { allowedOrigins: ['https://merged.dashboard.iatistandard.org'] },
    ]);
  });

  it('rejects pagination that leaves the reporting-org feed', async () => {
    const payload = JSON.stringify({
      count: 1,
      next: 'https://attacker.invalid/api/reporting-orgs/',
      results: [],
    });
    const http = new FixtureHttpClient(new Map([[IATI_REPORTING_ORGS_URL, payload]]));

    await expect(fetchIatiDomainEvidence(http)).rejects.toThrow(/left the reporting-org feed/u);
    expect(http.requestedUrls).toEqual([IATI_REPORTING_ORGS_URL]);
  });
});
