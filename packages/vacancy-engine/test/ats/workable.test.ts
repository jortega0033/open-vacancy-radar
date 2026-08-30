import { describe, expect, it } from 'vitest';

import { WorkableAdapter } from '../../src/ats/workable.js';
import { createVacancyAdapter } from '../../src/pipeline/vacancies.js';
import { atsFixture, careerSource, FixtureHttpClient } from './helpers.js';

const source = careerSource('workable', 'acme', 'https://apply.workable.com/acme');
const listUrl = 'https://www.workable.com/api/accounts/acme?details=true';

describe('WorkableAdapter', () => {
  it('is registered in the production vacancy-adapter factory', () => {
    expect(createVacancyAdapter('workable', new FixtureHttpClient(new Map()))).toBeInstanceOf(
      WorkableAdapter,
    );
  });

  it('normalizes, merges locations, and deduplicates public jobs by shortcode', async () => {
    const http = new FixtureHttpClient(
      new Map([[listUrl, await atsFixture('workable/jobs.json')]]),
    );
    const result = await new WorkableAdapter(http).listVacancies(source);

    expect(result).toMatchObject({ complete: false, requestCount: 1, invalidCount: 1 });
    expect(result.vacancies).toHaveLength(3);
    expect(result.vacancies[0]).toMatchObject({
      externalId: 'HYBRID123',
      title: 'Senior Platform Engineer',
      location: 'Amsterdam, Noord-Holland, Netherlands | Utrecht, Netherlands | Berlin, Germany',
      remote: null,
      workplaceMode: 'hybrid',
      url: 'https://apply.workable.com/j/HYBRID123',
      postedAt: new Date('2026-08-20'),
      employmentType: 'Full-time',
      source: 'workable',
    });
    expect(result.vacancies[0]?.description).toBe(
      'Build dependable platforms.\n\nShip them safely.',
    );
    expect(result.vacancies[1]).toMatchObject({
      externalId: 'REMOTE456',
      location: 'Worldwide',
      remote: true,
      workplaceMode: 'remote',
      url: 'https://apply.workable.com/j/REMOTE456',
    });
    expect(result.vacancies[2]).toMatchObject({
      externalId: 'ONSITE789',
      remote: false,
      workplaceMode: 'onsite',
    });
    expect(http.requestedUrls).toEqual([listUrl]);
    expect(http.requestedOptions).toEqual([{ allowedOrigins: ['https://www.workable.com'] }]);
  });

  it('accepts an empty public job collection', async () => {
    const http = new FixtureHttpClient(
      new Map([[listUrl, await atsFixture('workable/empty.json')]]),
    );

    await expect(new WorkableAdapter(http).listVacancies(source)).resolves.toEqual({
      vacancies: [],
      complete: true,
      requestCount: 1,
      invalidCount: 0,
    });
  });

  it('does not reveal top-level location fallbacks when Workable marks a location hidden', async () => {
    const http = new FixtureHttpClient(
      new Map([
        [
          listUrl,
          JSON.stringify({
            jobs: [
              {
                shortcode: 'HIDDEN123',
                title: 'Frontend Engineer',
                description: '<p>Build interfaces.</p>',
                url: 'https://apply.workable.com/j/HIDDEN123',
                location: { hidden: true },
                city: 'Confidential City',
                state: 'Confidential State',
                country: 'Confidential Country',
              },
              {
                shortcode: 'HIDDEN123',
                title: 'Frontend Engineer',
                description: '<p>Build interfaces.</p>',
                url: 'https://apply.workable.com/j/HIDDEN123',
                locations: [{ hidden: true }],
                city: 'Confidential Other City',
                country: 'Confidential Other Country',
              },
            ],
          }),
        ],
      ]),
    );

    const result = await new WorkableAdapter(http).listVacancies(source);

    expect(result.vacancies[0]?.location).toBeNull();
    expect(JSON.stringify(result)).not.toContain('Confidential');
  });

  it('rejects invalid JSON and unknown response shapes', async () => {
    const invalid = new FixtureHttpClient(new Map([[listUrl, '{not-json']]));
    await expect(new WorkableAdapter(invalid).listVacancies(source)).rejects.toThrow(
      'response is not valid JSON',
    );

    const unknown = new FixtureHttpClient(
      new Map([[listUrl, await atsFixture('workable/unknown-shape.json')]]),
    );
    await expect(new WorkableAdapter(unknown).listVacancies(source)).rejects.toThrow(
      'unknown response shape',
    );

    expect(
      new WorkableAdapter(new FixtureHttpClient(new Map())).supports(
        careerSource('workable', '../not-an-account', 'https://apply.workable.com'),
      ),
    ).toBe(false);
    expect(
      new WorkableAdapter(new FixtureHttpClient(new Map())).supports(
        careerSource('workable', 'acme', 'https://apply.workable.com/another'),
      ),
    ).toBe(false);
  });
});
