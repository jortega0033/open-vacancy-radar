import { describe, expect, it } from 'vitest';

import { GreenhouseAdapter } from '../../src/ats/greenhouse.js';
import { atsFixture, careerSource, FixtureHttpClient } from './helpers.js';

const source = careerSource('greenhouse', 'acme', 'https://job-boards.greenhouse.io/acme');
const listUrl = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true';

describe('GreenhouseAdapter', () => {
  it('normalizes valid jobs and marks a feed with malformed entries incomplete', async () => {
    const http = new FixtureHttpClient(new Map([[listUrl, await atsFixture('greenhouse/jobs.json')]]));
    const result = await new GreenhouseAdapter(http).listVacancies(source);

    expect(result).toMatchObject({ complete: false, requestCount: 1, invalidCount: 1 });
    expect(result.vacancies).toHaveLength(2);
    expect(result.vacancies[0]).toMatchObject({
      externalId: '101',
      title: 'Senior Platform Engineer',
      location: 'Amsterdam, Netherlands',
      url: 'https://job-boards.greenhouse.io/acme/jobs/101',
      postedAt: null,
      source: 'greenhouse',
    });
    expect(result.vacancies[0]?.description).toContain('TypeScript & Node.js');
  });

  it('accepts a recognized empty board and rejects an unknown root shape', async () => {
    const empty = new FixtureHttpClient(new Map([[listUrl, '{"jobs":[],"meta":{"total":0}}']]));
    await expect(new GreenhouseAdapter(empty).listVacancies(source)).resolves.toMatchObject({
      vacancies: [],
      complete: true,
    });

    const unknown = new FixtureHttpClient(new Map([[listUrl, '{"data":[]}']]));
    await expect(new GreenhouseAdapter(unknown).listVacancies(source)).rejects.toThrow('unknown response shape');
  });
});
