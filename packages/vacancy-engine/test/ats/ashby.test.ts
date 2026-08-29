import { describe, expect, it } from 'vitest';

import { AshbyAdapter } from '../../src/ats/ashby.js';
import { careerSource, FixtureHttpClient } from './helpers.js';

const source = careerSource('ashby', 'acme', 'https://jobs.ashbyhq.com/acme');
const listUrl = 'https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true';

describe('AshbyAdapter', () => {
  it('uses the official public board API and includes exposed compensation', async () => {
    const body = JSON.stringify({
      apiVersion: '1',
      jobs: [
        {
          id: 'job-1',
          title: 'Senior Frontend Engineer',
          location: 'USA',
          secondaryLocations: [{ location: 'Europe' }],
          isListed: true,
          isRemote: true,
          workplaceType: 'Remote',
          descriptionPlain: 'Build accessible product interfaces.',
          publishedAt: '2026-08-01T10:00:00.000Z',
          employmentType: 'FullTime',
          jobUrl: 'https://jobs.ashbyhq.com/acme/job-1',
          compensation: { scrapeableCompensationSalarySummary: '$150K - $210K' },
        },
        {
          id: 'hidden',
          title: 'Unlisted role',
          isListed: false,
          descriptionPlain: 'Not for the public board.',
          jobUrl: 'https://jobs.ashbyhq.com/acme/hidden',
        },
      ],
    });
    const http = new FixtureHttpClient(new Map([[listUrl, body]]));
    const result = await new AshbyAdapter(http).listVacancies(source);

    expect(result).toMatchObject({ complete: true, requestCount: 1, invalidCount: 0 });
    expect(result.vacancies).toHaveLength(1);
    expect(result.vacancies[0]).toMatchObject({
      externalId: 'job-1',
      title: 'Senior Frontend Engineer',
      location: 'USA | Europe',
      remote: true,
      workplaceMode: 'remote',
      employmentType: 'FullTime',
      source: 'ashby',
    });
    expect(result.vacancies[0]?.description).toContain('Compensation: $150K - $210K');
    expect(http.requestedUrls).toEqual([listUrl]);
  });

  it('marks malformed listed jobs incomplete', async () => {
    const http = new FixtureHttpClient(new Map([[listUrl, '{"jobs":[{"isListed":true}]}']]));
    await expect(new AshbyAdapter(http).listVacancies(source)).resolves.toMatchObject({
      vacancies: [],
      complete: false,
      invalidCount: 1,
    });
  });
});
