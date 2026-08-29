import { describe, expect, it } from 'vitest';

import { resolveWikidataDomains } from '../../src/companies/wikidata-domain-source.js';

function binding(item: string, kvk: string, website: string) {
  return {
    item: { type: 'uri', value: item },
    kvk: { type: 'literal', value: kvk },
    website: { type: 'uri', value: website },
  };
}

const sponsors = [
  { id: 'sponsor-1', legalName: 'Example B.V.', kvkNumber: '01234567' },
  { id: 'sponsor-2', legalName: 'Missing B.V.', kvkNumber: '87654321' },
  { id: 'sponsor-3', legalName: 'No KVK Foundation', kvkNumber: null },
];
const exampleSponsor = { id: 'sponsor-1', legalName: 'Example B.V.', kvkNumber: '01234567' };

describe('Wikidata exact-KVK domain source', () => {
  it('selects one deterministic URL for one exact KVK and normalized host', () => {
    const resolution = resolveWikidataDomains(
      {
        results: {
          bindings: [
            binding('https://www.wikidata.org/entity/Q1', '1234567', 'http://www.example.test/about/'),
            binding('https://www.wikidata.org/entity/Q1', '01234567', 'https://example.test/'),
          ],
        },
      },
      sponsors,
    );

    expect(resolution.candidates).toEqual([
      {
        sponsorId: 'sponsor-1',
        legalName: 'Example B.V.',
        kvkNumber: '01234567',
        officialUrl: 'https://example.test/',
        wikidataItems: ['https://www.wikidata.org/entity/Q1'],
      },
    ]);
    expect(resolution.outcomes.map(({ status }) => status)).toEqual([
      'candidate',
      'not_found',
      'missing_kvk',
    ]);
  });

  it('keeps multiple official hosts and duplicate KVK items out of the crawl queue', () => {
    const multiHost = resolveWikidataDomains(
      {
        results: {
          bindings: [
            binding('https://www.wikidata.org/entity/Q1', '01234567', 'https://one.test/'),
            binding('https://www.wikidata.org/entity/Q1', '01234567', 'https://two.test/'),
          ],
        },
      },
      [exampleSponsor],
    );
    const duplicateItem = resolveWikidataDomains(
      {
        results: {
          bindings: [
            binding('https://www.wikidata.org/entity/Q1', '01234567', 'https://one.test/'),
            binding('https://www.wikidata.org/entity/Q2', '01234567', 'https://one.test/'),
          ],
        },
      },
      [exampleSponsor],
    );

    expect(multiHost.candidates).toHaveLength(0);
    expect(multiHost.outcomes[0]).toMatchObject({
      status: 'ambiguous',
      reasonCode: 'multiple_structured_official_hosts',
    });
    expect(duplicateItem.candidates).toHaveLength(0);
    expect(duplicateItem.outcomes[0]).toMatchObject({
      status: 'ambiguous',
      reasonCode: 'duplicate_structured_kvk_items',
    });
  });

  it('drops unsafe, credentialed, non-web, and LinkedIn bindings', () => {
    const resolution = resolveWikidataDomains(
      {
        results: {
          bindings: [
            binding('https://www.wikidata.org/entity/Q1', '01234567', 'file:///tmp/example'),
            binding('https://www.wikidata.org/entity/Q1', '01234567', 'https://user:pass@example.test/'),
            binding('https://www.wikidata.org/entity/Q1', '01234567', 'https://nl.linkedin.com/company/example'),
            binding('bad-item', '01234567', 'https://example.test/'),
          ],
        },
      },
      [exampleSponsor],
    );

    expect(resolution.candidates).toHaveLength(0);
    expect(resolution.invalidBindingCount).toBe(4);
    expect(resolution.outcomes[0]).toMatchObject({ status: 'not_found' });
  });
});
