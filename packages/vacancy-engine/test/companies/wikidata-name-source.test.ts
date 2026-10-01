import { describe, expect, it } from 'vitest';

import {
  fetchWikidataEntityClaims,
  fetchWikidataNameSearch,
  findWikidataCompanyByName,
  resolveWikidataNameClaims,
  selectWikidataNameMatch,
  WIKIDATA_API_ENDPOINT,
} from '../../src/companies/wikidata-name-source.js';
import { FixtureHttpClient } from '../ats/helpers.js';

type ClaimRank = 'preferred' | 'normal' | 'deprecated';

function searchResult(id: string, matchedText: string, label = matchedText) {
  return { id, label, match: { type: 'label', language: 'en', text: matchedText } };
}

function searchPayload(results: ReturnType<typeof searchResult>[]) {
  return { search: results, searchinfo: { search: 'unused' }, success: 1 };
}

function claim(value: string, rank: ClaimRank = 'normal') {
  return {
    mainsnak: { snaktype: 'value', datavalue: { value, type: 'string' } },
    type: 'statement',
    rank,
  };
}

function claimsPayload(itemId: string, claims: Record<string, ReturnType<typeof claim>[]>) {
  return { entities: { [itemId]: { id: itemId, claims } }, success: 1 };
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

describe('selectWikidataNameMatch', () => {
  it('selects the single entity whose matched text exactly equals the query', () => {
    const result = selectWikidataNameMatch(
      searchPayload([searchResult('Q217583', 'ASML Holding', 'ASML Holding')]),
      'ASML Holding',
    );
    expect(result).toEqual({ status: 'match', itemId: 'Q217583' });
  });

  it('is case- and whitespace-insensitive, but not substring-permissive', () => {
    expect(
      selectWikidataNameMatch(searchPayload([searchResult('Q1', 'asml  holding')]), '  ASML Holding '),
    ).toEqual({ status: 'match', itemId: 'Q1' });

    // "ASML Holding" (the matched text) is not equal to "ASML" (the query) -- a substring/prefix
    // match from Wikidata's own relevance search must not be treated as confirmation.
    expect(selectWikidataNameMatch(searchPayload([searchResult('Q1', 'ASML Holding')]), 'ASML')).toEqual({
      status: 'not_found',
      reasonCode: 'no_exact_name_match',
    });
  });

  it('rejects a wrong top hit whose matched text differs from the query, without any extra logic', () => {
    // Mirrors the issue's Philips spot-check: the top-ranked hit for "Philips" is "Philips
    // Records", a different, unrelated entity. Because its matched text is "Philips Records", not
    // "Philips", the exact-match filter already excludes it -- the near-miss is only harmless in
    // the issue's live check because that wrong entity also happened to carry no KVK/website
    // claims, which this function has no way to know about (see `resolveWikidataNameClaims`,
    // which is what actually would have produced `missing_kvk_claim` for that case).
    const result = selectWikidataNameMatch(searchPayload([searchResult('Q1', 'Philips Records')]), 'Philips');
    expect(result).toEqual({ status: 'not_found', reasonCode: 'no_exact_name_match' });
  });

  it('treats more than one exact-matching entity as ambiguous, never guessing which one', () => {
    // Two distinct Wikidata items can carry the identical matched trade name -- a risk a KVK-keyed
    // lookup never has, since a KVK number is already a unique key.
    const result = selectWikidataNameMatch(
      searchPayload([searchResult('Q2', 'Randstad'), searchResult('Q1', 'Randstad')]),
      'Randstad',
    );
    expect(result).toEqual({
      status: 'ambiguous',
      reasonCode: 'multiple_entities_matched_name',
      itemIds: ['Q1', 'Q2'],
    });
  });

  it('reports not_found for zero search results', () => {
    expect(selectWikidataNameMatch(searchPayload([]), 'Nonexistent Company BV')).toEqual({
      status: 'not_found',
      reasonCode: 'no_exact_name_match',
    });
  });
});

describe('resolveWikidataNameClaims', () => {
  it('resolves a clean single KVK claim paired with a single official host', () => {
    const result = resolveWikidataNameClaims(
      claimsPayload('Q1', {
        P3220: [claim('17014545')],
        P856: [claim('https://www.asml.com/')],
      }),
      'Q1',
    );
    expect(result).toEqual({
      status: 'match',
      itemId: 'Q1',
      kvkNumber: '17014545',
      officialUrl: 'https://www.asml.com/',
    });
  });

  it('picks the canonical URL deterministically when several valid URLs share one host', () => {
    const result = resolveWikidataNameClaims(
      claimsPayload('Q1', {
        P3220: [claim('17014545')],
        P856: [claim('http://www.asml.com/about/'), claim('https://asml.com/')],
      }),
      'Q1',
    );
    expect(result).toMatchObject({ status: 'match', officialUrl: 'https://asml.com/' });
  });

  it('rejects multiple websites on different hosts as ambiguous, mirroring the KVK-keyed rule', () => {
    // Heineken/Randstad-style: the entity is correct, but more than one distinct official
    // hostname means no single official URL can be picked without guessing.
    const result = resolveWikidataNameClaims(
      claimsPayload('Q1', {
        P3220: [claim('01234567')],
        P856: [claim('https://one.test/'), claim('https://two.test/')],
      }),
      'Q1',
    );
    expect(result).toEqual({ status: 'ambiguous', reasonCode: 'multiple_official_hosts' });
  });

  it('rejects multiple distinct KVK claims on one entity as ambiguous', () => {
    const result = resolveWikidataNameClaims(
      claimsPayload('Q1', {
        P3220: [claim('01234567'), claim('87654321')],
        P856: [claim('https://one.test/')],
      }),
      'Q1',
    );
    expect(result).toEqual({ status: 'ambiguous', reasonCode: 'duplicate_kvk_claims' });
  });

  it('reports not_found, not a guess, when the entity carries no KVK claim at all', () => {
    // This is the harmless side of a wrong-top-hit near-miss (e.g. "Philips Records"): even if
    // `selectWikidataNameMatch` had let a wrong entity through, an entity with no P3220 statement
    // resolves to absence here, never a fabricated match. A documented limitation, not a fix: this
    // function has no way to know the entity itself is the wrong one.
    const result = resolveWikidataNameClaims(claimsPayload('Q1', { P856: [claim('https://one.test/')] }), 'Q1');
    expect(result).toEqual({ status: 'not_found', reasonCode: 'missing_kvk_claim' });
  });

  it('reports not_found when the entity has a KVK claim but no website claim', () => {
    const result = resolveWikidataNameClaims(claimsPayload('Q1', { P3220: [claim('01234567')] }), 'Q1');
    expect(result).toEqual({ status: 'not_found', reasonCode: 'missing_website_claim' });
  });

  it('reports not_found for an entity id absent from the payload entirely', () => {
    const result = resolveWikidataNameClaims(claimsPayload('Q1', { P3220: [claim('01234567')] }), 'Q999');
    expect(result).toEqual({ status: 'not_found', reasonCode: 'missing_kvk_claim' });
  });

  it('ignores deprecated-rank statements rather than letting them create false ambiguity', () => {
    const result = resolveWikidataNameClaims(
      claimsPayload('Q1', {
        P3220: [claim('01234567'), claim('99999999', 'deprecated')],
        P856: [claim('https://one.test/'), claim('https://superseded.test/', 'deprecated')],
      }),
      'Q1',
    );
    expect(result).toEqual({
      status: 'match',
      itemId: 'Q1',
      kvkNumber: '01234567',
      officialUrl: 'https://one.test/',
    });
  });

  it('drops an invalid KVK format rather than treating it as a claim', () => {
    const result = resolveWikidataNameClaims(
      claimsPayload('Q1', { P3220: [claim('not-a-kvk-number')], P856: [claim('https://one.test/')] }),
      'Q1',
    );
    expect(result).toEqual({ status: 'not_found', reasonCode: 'missing_kvk_claim' });
  });
});

describe('findWikidataCompanyByName (fixture HTTP)', () => {
  it('resolves an end-to-end clean match, calling the search endpoint then the claims endpoint', async () => {
    const http = new FixtureHttpClient(
      new Map<string, string>([
        [searchUrl('ASML Holding'), JSON.stringify(searchPayload([searchResult('Q217583', 'ASML Holding')]))],
        [
          claimsUrl('Q217583'),
          JSON.stringify(
            claimsPayload('Q217583', {
              P3220: [claim('17014545')],
              P856: [claim('https://www.asml.com/')],
            }),
          ),
        ],
      ]),
    );

    const result = await findWikidataCompanyByName(http, 'ASML Holding');

    expect(result).toEqual({
      status: 'match',
      itemId: 'Q217583',
      kvkNumber: '17014545',
      officialUrl: 'https://www.asml.com/',
    });
    expect(http.requestedUrls).toEqual([searchUrl('ASML Holding'), claimsUrl('Q217583')]);
    expect(http.requestedOptions).toEqual([
      { allowedOrigins: [new URL(WIKIDATA_API_ENDPOINT).origin] },
      { allowedOrigins: [new URL(WIKIDATA_API_ENDPOINT).origin] },
    ]);
  });

  it('never requests entity claims when the name search itself is ambiguous', async () => {
    const http = new FixtureHttpClient(
      new Map<string, string>([
        [
          searchUrl('Randstad'),
          JSON.stringify(searchPayload([searchResult('Q1', 'Randstad'), searchResult('Q2', 'Randstad')])),
        ],
      ]),
    );

    const result = await findWikidataCompanyByName(http, 'Randstad');

    expect(result).toEqual({
      status: 'ambiguous',
      reasonCode: 'multiple_entities_matched_name',
      itemIds: ['Q1', 'Q2'],
    });
    expect(http.requestedUrls).toEqual([searchUrl('Randstad')]);
  });

  it('never requests entity claims when the name search finds nothing', async () => {
    const http = new FixtureHttpClient(
      new Map<string, string>([[searchUrl('Nonexistent Company BV'), JSON.stringify(searchPayload([]))]]),
    );

    const result = await findWikidataCompanyByName(http, 'Nonexistent Company BV');

    expect(result).toEqual({ status: 'not_found', reasonCode: 'no_exact_name_match' });
    expect(http.requestedUrls).toEqual([searchUrl('Nonexistent Company BV')]);
  });

  it('exposes the two fetch functions individually for reuse/testing', async () => {
    const http = new FixtureHttpClient(
      new Map<string, string>([
        [searchUrl('Acme'), JSON.stringify(searchPayload([searchResult('Q1', 'Acme')]))],
        [claimsUrl('Q1'), JSON.stringify(claimsPayload('Q1', { P3220: [claim('01234567')] }))],
      ]),
    );
    await expect(fetchWikidataNameSearch(http, 'Acme')).resolves.toEqual(searchPayload([searchResult('Q1', 'Acme')]));
    await expect(fetchWikidataEntityClaims(http, 'Q1')).resolves.toEqual(
      claimsPayload('Q1', { P3220: [claim('01234567')] }),
    );
  });
});
