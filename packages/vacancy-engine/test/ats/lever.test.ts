import { describe, expect, it } from 'vitest';

import { LeverAdapter } from '../../src/ats/lever.js';
import { atsFixture, careerSource, FixtureHttpClient } from './helpers.js';

const source = careerSource('lever', 'acme', 'https://jobs.eu.lever.co/acme');
const pageUrl = (skip: number) =>
  `https://api.eu.lever.co/v0/postings/acme?mode=json&skip=${skip}&limit=2`;

describe('LeverAdapter', () => {
  it('uses the discovered region, paginates within bounds, and deduplicates by posting id', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [pageUrl(0), await atsFixture('lever/page-1.json')],
        [pageUrl(2), await atsFixture('lever/page-2.json')],
        [pageUrl(4), '[]'],
      ]),
    );
    const result = await new LeverAdapter(http, { pageSize: 2, maxPages: 3 }).listVacancies(source);

    expect(result).toMatchObject({ complete: true, requestCount: 3 });
    expect(result.vacancies.map((vacancy) => vacancy.externalId)).toEqual(['lever-1', 'lever-2', 'lever-3']);
    expect(result.vacancies[0]).toMatchObject({ workplaceMode: 'hybrid', remote: null });
    expect(result.vacancies[0]?.description).toContain('What you bring');
    expect(result.vacancies[1]).toMatchObject({
      workplaceMode: 'remote',
      remote: true,
      location: 'Remote - Netherlands',
    });
    expect(result.vacancies[2]).toMatchObject({
      workplaceMode: 'onsite',
      remote: false,
      url: 'https://jobs.lever.co/acme/lever-3',
    });
  });

  it('marks a full final page incomplete when the page bound is reached', async () => {
    const http = new FixtureHttpClient(new Map([[pageUrl(0), await atsFixture('lever/page-1.json')]]));
    const result = await new LeverAdapter(http, { pageSize: 2, maxPages: 1 }).listVacancies(source);
    expect(result.complete).toBe(false);
    expect(result.requestCount).toBe(1);
  });

  it('rejects an object wrapper because Lever lists are arrays', async () => {
    const http = new FixtureHttpClient(new Map([[pageUrl(0), '{"postings":[]}']]));
    await expect(
      new LeverAdapter(http, { pageSize: 2, maxPages: 1 }).listVacancies(source),
    ).rejects.toThrow('unknown response shape');
  });
});
