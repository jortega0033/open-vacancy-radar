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

  it('decodes HTML entities left raw in the board API JSON (QA regression: "J. J. Keller &#038; Associates, Inc.")', async () => {
    // Real bug: Greenhouse's JSON board API can return `title`/`location.name` pre-escaped with
    // HTML entities (WordPress-style boards do this routinely). `JSON.parse` only unescapes JSON's
    // own `\"`/`\\` syntax, never HTML entities sitting inside a string value, so without an
    // explicit decode step this reaches the UI, gets persisted, and gets fed into AI letter
    // prompts exactly as broken as it arrived.
    const entityFixture = JSON.stringify({
      jobs: [
        {
          id: 201,
          title: 'Account Manager &#038; Client Success Lead',
          location: { name: 'Amsterdam &amp; Remote' },
          absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/201',
          content: '<p>Support our &quot;flagship&quot; account.</p>',
        },
      ],
      meta: { total: 1 },
    });
    const http = new FixtureHttpClient(new Map([[listUrl, entityFixture]]));
    const result = await new GreenhouseAdapter(http).listVacancies(source);

    expect(result.vacancies).toHaveLength(1);
    expect(result.vacancies[0]).toMatchObject({
      title: 'Account Manager & Client Success Lead',
      location: 'Amsterdam & Remote',
    });
    expect(result.vacancies[0]?.description).toContain('Support our "flagship" account.');
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
