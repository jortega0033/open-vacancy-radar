import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  fetchRooDomainEvidence,
  parseRooDomainEvidence,
  ROO_BULK_XML_URL,
} from '../../src/companies/roo-domain-source.js';
import { FixtureHttpClient } from '../ats/helpers.js';

async function fixture(): Promise<string> {
  return readFile(
    path.resolve(process.cwd(), 'test/fixtures/companies/roo-export.xml'),
    'utf8',
  );
}

describe('ROO bulk domain source', () => {
  it('parses exact record KVK and direct organisation contact URLs only', async () => {
    const result = parseRooDomainEvidence(await fixture());

    expect(result).toMatchObject({
      recordCount: 5,
      kvkRecordCount: 5,
      invalidKvkRecordCount: 1,
      invalidUrlCount: 1,
      incompleteRecordCount: 0,
    });
    expect(result.evidence.map(({ kvkNumber, officialUrl }) => [kvkNumber, officialUrl])).toEqual([
      ['01234567', 'https://www.acme.nl/about'],
      ['01234567', 'https://acme.nl/'],
      ['87654321', 'https://one.nl/'],
      ['87654321', 'https://two.nl/'],
      ['22222222', 'https://child.nl/'],
    ]);
    expect(result.evidence.some(({ kvkNumber }) => kvkNumber === '11111111')).toBe(false);
    expect(result.evidence.some(({ officialUrl }) => officialUrl.includes('wetten.overheid.nl'))).toBe(
      false,
    );
    expect(result.evidence.some(({ officialUrl }) => officialUrl.includes('employee.invalid.nl'))).toBe(
      false,
    );
  });

  it('uses the shared HTTP seam with an exact redirect boundary', async () => {
    const http = new FixtureHttpClient(new Map([[ROO_BULK_XML_URL, await fixture()]]));

    const result = await fetchRooDomainEvidence(http);

    expect(result.evidence).toHaveLength(5);
    expect(http.requestedUrls).toEqual([ROO_BULK_XML_URL]);
    expect(http.requestedOptions).toEqual([
      { allowedOrigins: ['https://organisaties.overheid.nl'] },
    ]);
  });

  it('rejects non-ROO XML', () => {
    expect(() => parseRooDomainEvidence('<root><organisation /></root>')).toThrow(
      /not a ROO export/u,
    );
  });
});
