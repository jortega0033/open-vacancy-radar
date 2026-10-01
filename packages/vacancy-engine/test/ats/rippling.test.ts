import { describe, expect, it } from 'vitest';

import { RipplingAdapter } from '../../src/ats/rippling.js';
import { atsFixture, careerSource, FixtureHttpClient } from './helpers.js';

const source = careerSource('rippling', 'acme-careers', 'https://ats.rippling.com/acme-careers/jobs');
const listUrl = (page: number) =>
  `https://ats.rippling.com/api/v2/board/acme-careers/jobs?groupJobsByLocation=true&page=${page}&pageSize=2`;
const detailUrl = (uuid: string) => `https://ats.rippling.com/api/v2/board/acme-careers/jobs/${uuid}`;

const implementationManagerUuid = 'c3fe4961-2d04-4093-b05b-e916b0873463';
const revOpsUuid = '9145705c-c0ee-4d64-b6e5-5441587e7353';
const solutionConsultantUuid = '3ef41f25-465a-4f06-9058-2071a3041bf9';

describe('RipplingAdapter', () => {
  it('groups a posting open in multiple locations into a single vacancy, never one per location', async () => {
    // list-page-1 fixture carries two rows for the SAME uuid (one per location), reproducing what
    // was observed live against a real multi-location Rippling posting even when the adapter asks
    // the list endpoint to pre-group by location -- see the module doc comment in rippling.ts.
    const http = new FixtureHttpClient(
      new Map([
        [listUrl(0), await atsFixture('rippling/list-page-1.json')],
        [detailUrl(implementationManagerUuid), await atsFixture('rippling/detail-implementation-manager.json')],
      ]),
    );
    const result = await new RipplingAdapter(http, { pageSize: 2, maxPages: 1 }).listVacancies(source);

    expect(result.vacancies).toHaveLength(1);
    expect(result.vacancies[0]).toMatchObject({
      externalId: implementationManagerUuid,
      title: 'Implementation Manager, Strategic Workforce Planning',
      location: 'London, United Kingdom | Germany',
      // One location was ON_SITE and the other REMOTE, so the combined posting reads as hybrid.
      remote: null,
      workplaceMode: 'hybrid',
    });
    // One list request plus exactly one detail request for the shared uuid, not two.
    expect(result.requestCount).toBe(2);
  });

  it('groups a posting into a single vacancy when the server pre-groups locations itself', async () => {
    // list-pregrouped-page fixture carries a SINGLE row for the posting whose own `locations`
    // array already has both entries -- the shape `groupJobsByLocation=true` is documented (if
    // undocumented-server-behaviour-ly) to produce, and was confirmed live per the module doc
    // comment in rippling.ts, as opposed to the two-rows-sharing-a-uuid shape covered by the test
    // above. The adapter's own uuid-keyed grouping should be a no-op here, not double-count it.
    const http = new FixtureHttpClient(
      new Map([
        [listUrl(0), await atsFixture('rippling/list-pregrouped-page.json')],
        [detailUrl(implementationManagerUuid), await atsFixture('rippling/detail-implementation-manager.json')],
      ]),
    );
    const result = await new RipplingAdapter(http, { pageSize: 2, maxPages: 1 }).listVacancies(source);

    expect(result.vacancies).toHaveLength(1);
    expect(result.vacancies[0]).toMatchObject({
      externalId: implementationManagerUuid,
      title: 'Implementation Manager, Strategic Workforce Planning',
      location: 'London, United Kingdom | Germany',
      remote: null,
      workplaceMode: 'hybrid',
    });
    expect(result.requestCount).toBe(2);
  });

  it('paginates the list, fetches one detail per unique posting, and normalizes fields', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [listUrl(0), await atsFixture('rippling/list-page-1.json')],
        [listUrl(1), await atsFixture('rippling/list-page-2.json')],
        [detailUrl(implementationManagerUuid), await atsFixture('rippling/detail-implementation-manager.json')],
        [detailUrl(revOpsUuid), await atsFixture('rippling/detail-revops-analyst.json')],
        [detailUrl(solutionConsultantUuid), await atsFixture('rippling/detail-solution-consultant.json')],
      ]),
    );
    const result = await new RipplingAdapter(http, { pageSize: 2, maxPages: 5 }).listVacancies(source);

    expect(result).toMatchObject({ complete: true, invalidCount: 0, requestCount: 5 });
    expect(result.vacancies).toHaveLength(3);
    expect(result.vacancies.map((vacancy) => vacancy.externalId)).toEqual([
      implementationManagerUuid,
      revOpsUuid,
      solutionConsultantUuid,
    ]);

    const revOps = result.vacancies.find((vacancy) => vacancy.externalId === revOpsUuid);
    expect(revOps).toMatchObject({
      location: 'Bengaluru, India',
      remote: false,
      workplaceMode: 'onsite',
      employmentType: 'Salaried, full-time',
      url: `https://ats.rippling.com/acme-careers/jobs/${revOpsUuid}`,
    });
    expect(revOps?.postedAt?.toISOString()).toBe(new Date('2026-06-02T09:15:00.000000-07:00').toISOString());

    const solutionConsultant = result.vacancies.find(
      (vacancy) => vacancy.externalId === solutionConsultantUuid,
    );
    expect(solutionConsultant?.employmentType).toBe('Hourly, full-time');
    expect(solutionConsultant?.description).toContain('Compensation: USD 170,000 to 250,000 per year (US)');
  });

  it('marks a malformed detail response incomplete without discarding the other postings', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [listUrl(0), await atsFixture('rippling/list-single-page.json')],
        [detailUrl(revOpsUuid), await atsFixture('rippling/detail-revops-analyst.json')],
        [detailUrl(solutionConsultantUuid), '{"unexpected":true}'],
      ]),
    );
    const result = await new RipplingAdapter(http, { pageSize: 2, maxPages: 1 }).listVacancies(source);

    expect(result.complete).toBe(false);
    expect(result.invalidCount).toBe(1);
    expect(result.vacancies.map((vacancy) => vacancy.externalId)).toEqual([revOpsUuid]);
  });

  it('marks malformed list rows incomplete instead of silently dropping them', async () => {
    const malformedList = JSON.stringify({
      items: [{ id: revOpsUuid, name: 'Valid' }, { name: 'Missing id' }],
      page: 0,
      pageSize: 2,
      totalItems: 2,
      totalPages: 1,
    });
    const http = new FixtureHttpClient(
      new Map([
        [listUrl(0), malformedList],
        [detailUrl(revOpsUuid), await atsFixture('rippling/detail-revops-analyst.json')],
      ]),
    );
    const result = await new RipplingAdapter(http, { pageSize: 2, maxPages: 1 }).listVacancies(source);

    expect(result).toMatchObject({ complete: false, invalidCount: 1, requestCount: 2 });
    expect(result.vacancies.map((vacancy) => vacancy.externalId)).toEqual([revOpsUuid]);
  });

  it('accepts a recognized empty page and rejects an unknown list shape', async () => {
    const empty = new FixtureHttpClient(
      new Map([[listUrl(0), '{"items":[],"page":0,"pageSize":2,"totalItems":0,"totalPages":0}']]),
    );
    await expect(
      new RipplingAdapter(empty, { pageSize: 2, maxPages: 1 }).listVacancies(source),
    ).resolves.toMatchObject({ vacancies: [], complete: true, requestCount: 1 });

    const unknown = new FixtureHttpClient(new Map([[listUrl(0), '{"totalItems":0}']]));
    await expect(
      new RipplingAdapter(unknown, { pageSize: 2, maxPages: 1 }).listVacancies(source),
    ).rejects.toThrow('unknown response shape');
  });

  it('marks a detail cap as partial coverage, matching the SmartRecruiters/Workday precedent', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [listUrl(0), await atsFixture('rippling/list-single-page.json')],
        [detailUrl(revOpsUuid), await atsFixture('rippling/detail-revops-analyst.json')],
      ]),
    );
    const result = await new RipplingAdapter(http, {
      pageSize: 2,
      maxPages: 1,
      maxDetails: 1,
    }).listVacancies(source);

    expect(result).toMatchObject({ complete: false, requestCount: 2 });
    expect(result.vacancies).toHaveLength(1);
  });

  it('excludes postings marked unlistedFromSearch without counting them as invalid', async () => {
    // unlistedFromSearch is Rippling's own delisting signal -- a posting the employer took down,
    // not a malformed response. It must be dropped silently (complete stays true, invalidCount
    // stays 0), the same way AshbyAdapter drops isListed: false postings, so that
    // global-remote/official.ts can still tell "confirmed inactive" apart from "inconclusive
    // error" for a Rippling vacancy that disappears from the board -- see the doc comment on
    // `isUnlisted` in rippling.ts.
    const detail = JSON.parse(await atsFixture('rippling/detail-revops-analyst.json')) as Record<
      string,
      unknown
    >;
    const http = new FixtureHttpClient(
      new Map([
        [listUrl(0), await atsFixture('rippling/list-single-page.json')],
        [detailUrl(revOpsUuid), JSON.stringify({ ...detail, unlistedFromSearch: true })],
        [detailUrl(solutionConsultantUuid), await atsFixture('rippling/detail-solution-consultant.json')],
      ]),
    );
    const result = await new RipplingAdapter(http, { pageSize: 2, maxPages: 1 }).listVacancies(source);

    expect(result).toMatchObject({ complete: true, invalidCount: 0 });
    expect(result.vacancies.map((vacancy) => vacancy.externalId)).toEqual([solutionConsultantUuid]);
  });

  it('does not support a source from another provider or without a board slug', () => {
    const adapter = new RipplingAdapter(new FixtureHttpClient(new Map()));
    expect(adapter.supports(careerSource('rippling', null, 'https://ats.rippling.com/acme/jobs'))).toBe(
      false,
    );
    expect(
      adapter.supports(careerSource('greenhouse', 'acme-careers', 'https://ats.rippling.com/acme/jobs')),
    ).toBe(false);
  });
});
