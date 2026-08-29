import { describe, expect, it } from 'vitest';

import { TeamtailorAdapter } from '../../src/ats/teamtailor.js';
import { atsFixture, careerSource, FixtureHttpClient } from './helpers.js';

const feed = 'https://acme.teamtailor.com/jobs.rss';
const source = careerSource('teamtailor', feed, 'https://acme.teamtailor.com/jobs');
const pageUrl = (offset: number) => `${feed}?offset=${offset}&per_page=2`;

describe('TeamtailorAdapter', () => {
  it('paginates the official RSS feed and preserves item links as canonical URLs', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [pageUrl(0), await atsFixture('teamtailor/page-1.xml')],
        [pageUrl(2), await atsFixture('teamtailor/page-2.xml')],
      ]),
    );
    const result = await new TeamtailorAdapter(http, { pageSize: 2, maxPages: 3 }).listVacancies(source);

    expect(result).toMatchObject({ complete: true, requestCount: 2 });
    expect(result.vacancies).toHaveLength(3);
    expect(result.vacancies[0]).toMatchObject({
      externalId: 'teamtailor-500',
      location: 'Amsterdam',
      remote: null,
      workplaceMode: 'hybrid',
      url: 'https://acme.teamtailor.com/jobs/500-staff-software-engineer',
    });
    expect(result.vacancies[1]?.remote).toBe(true);
    expect(result.vacancies[2]?.remote).toBe(false);
  });

  it('distinguishes a recognized empty RSS channel from an unrelated XML document', async () => {
    const empty = new FixtureHttpClient(
      new Map([[pageUrl(0), '<rss version="2.0"><channel><title>Empty</title></channel></rss>']]),
    );
    await expect(
      new TeamtailorAdapter(empty, { pageSize: 2, maxPages: 1 }).listVacancies(source),
    ).resolves.toMatchObject({ vacancies: [], complete: true });

    const unknown = new FixtureHttpClient(new Map([[pageUrl(0), '<html><body>Not RSS</body></html>']]));
    await expect(
      new TeamtailorAdapter(unknown, { pageSize: 2, maxPages: 1 }).listVacancies(source),
    ).rejects.toThrow('unknown response shape');
  });
});
