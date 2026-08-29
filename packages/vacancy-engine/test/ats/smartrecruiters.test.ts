import { describe, expect, it } from 'vitest';

import { SmartRecruitersAdapter } from '../../src/ats/smartrecruiters.js';
import { atsFixture, careerSource, FixtureHttpClient } from './helpers.js';

const source = careerSource(
  'smartrecruiters',
  'Acme',
  'https://careers.smartrecruiters.com/Acme',
);
const listUrl = (offset: number) =>
  `https://api.smartrecruiters.com/v1/companies/Acme/postings?destination=PUBLIC&limit=2&offset=${offset}`;
const detailUrl = (id: string) =>
  `https://api.smartrecruiters.com/v1/companies/Acme/postings/${id}`;

describe('SmartRecruitersAdapter', () => {
  it('paginates summaries, fetches details sequentially, and normalizes official posting URLs', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [listUrl(0), await atsFixture('smartrecruiters/list-1.json')],
        [listUrl(2), await atsFixture('smartrecruiters/list-2.json')],
        [detailUrl('sr-1'), await atsFixture('smartrecruiters/detail-1.json')],
        [detailUrl('sr-2'), await atsFixture('smartrecruiters/detail-2.json')],
        [detailUrl('sr-3'), await atsFixture('smartrecruiters/detail-3.json')],
      ]),
    );
    const result = await new SmartRecruitersAdapter(http, {
      pageSize: 2,
      maxPages: 3,
      maxDetails: 10,
    }).listVacancies(source);

    expect(result).toMatchObject({ complete: true, requestCount: 5 });
    expect(result.vacancies).toHaveLength(3);
    expect(result.vacancies[0]).toMatchObject({
      externalId: 'sr-1',
      remote: null,
      employmentType: 'Full-time',
      url: 'https://jobs.smartrecruiters.com/Acme/sr-1-senior-software-engineer',
    });
    expect(result.vacancies[0]?.description).toContain('Qualifications');
    expect(result.vacancies[1]).toMatchObject({ remote: false, location: 'Rotterdam, Netherlands' });
    expect(result.vacancies[2]?.remote).toBe(true);
    expect(http.requestedUrls.slice(2)).toEqual([
      detailUrl('sr-1'),
      detailUrl('sr-2'),
      detailUrl('sr-3'),
    ]);
  });

  it('marks malformed individual details incomplete without discarding other entries', async () => {
    const oneSummary = JSON.stringify({
      offset: 0,
      limit: 2,
      totalFound: 2,
      content: [
        { id: 'sr-1', name: 'Valid' },
        { id: 'sr-bad', name: 'Malformed detail' },
      ],
    });
    const http = new FixtureHttpClient(
      new Map([
        [listUrl(0), oneSummary],
        [detailUrl('sr-1'), await atsFixture('smartrecruiters/detail-1.json')],
        [detailUrl('sr-bad'), '{"unexpected":true}'],
      ]),
    );
    const result = await new SmartRecruitersAdapter(http, { pageSize: 2, maxPages: 1 }).listVacancies(
      source,
    );
    expect(result.complete).toBe(false);
    expect(result.vacancies.map((vacancy) => vacancy.externalId)).toEqual(['sr-1']);
  });

  it('marks malformed list summaries incomplete instead of treating them as absent jobs', async () => {
    const listWithMalformedSummary = JSON.stringify({
      offset: 0,
      limit: 2,
      totalFound: 2,
      content: [{ id: 'sr-1', name: 'Valid' }, { name: 'Missing identifier' }],
    });
    const http = new FixtureHttpClient(
      new Map([
        [listUrl(0), listWithMalformedSummary],
        [detailUrl('sr-1'), await atsFixture('smartrecruiters/detail-1.json')],
      ]),
    );
    const result = await new SmartRecruitersAdapter(http, {
      pageSize: 2,
      maxPages: 1,
    }).listVacancies(source);

    expect(result).toMatchObject({ complete: false, invalidCount: 1, requestCount: 2 });
    expect(result.vacancies.map((vacancy) => vacancy.externalId)).toEqual(['sr-1']);
  });

  it('accepts a recognized empty page and rejects an unknown list shape', async () => {
    const empty = new FixtureHttpClient(
      new Map([[listUrl(0), '{"offset":0,"limit":2,"totalFound":0,"content":[]}']]),
    );
    await expect(
      new SmartRecruitersAdapter(empty, { pageSize: 2, maxPages: 1 }).listVacancies(source),
    ).resolves.toMatchObject({ vacancies: [], complete: true, requestCount: 1 });

    const unknown = new FixtureHttpClient(new Map([[listUrl(0), '{"content":[]}']]));
    await expect(
      new SmartRecruitersAdapter(unknown, { pageSize: 2, maxPages: 1 }).listVacancies(source),
    ).rejects.toThrow('unknown response shape');
  });

  it('marks a detail cap as partial coverage', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [listUrl(0), await atsFixture('smartrecruiters/list-1.json')],
        [listUrl(2), await atsFixture('smartrecruiters/list-2.json')],
        [detailUrl('sr-1'), await atsFixture('smartrecruiters/detail-1.json')],
      ]),
    );
    const result = await new SmartRecruitersAdapter(http, {
      pageSize: 2,
      maxPages: 2,
      maxDetails: 1,
    }).listVacancies(source);
    expect(result).toMatchObject({ complete: false, requestCount: 3 });
    expect(result.vacancies).toHaveLength(1);
  });
});
