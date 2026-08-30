import { describe, expect, it } from 'vitest';

import type { AtsHttpResponse } from '../../src/ats/http.js';
import { PersonioAdapter } from '../../src/ats/personio.js';
import { createVacancyAdapter } from '../../src/pipeline/vacancies.js';
import { atsFixture, careerSource, FixtureHttpClient } from './helpers.js';

const feedUrl = 'https://acme.jobs.personio.de/xml?language=en';
const source = careerSource('personio', 'acme', 'https://acme.jobs.personio.de');

describe('PersonioAdapter', () => {
  it('is registered in the production vacancy-adapter factory', () => {
    expect(createVacancyAdapter('personio', new FixtureHttpClient(new Map()))).toBeInstanceOf(
      PersonioAdapter,
    );
  });

  it('normalizes localized descriptions and all offices while counting invalid positions', async () => {
    const response: AtsHttpResponse = {
      status: 200,
      finalUrl: 'https://acme.jobs.personio.com/xml?language=en',
      headers: { 'content-type': 'application/xml' },
      body: await atsFixture('personio/positions.xml'),
    };
    const http = new FixtureHttpClient(new Map([[feedUrl, response]]));
    const result = await new PersonioAdapter(http).listVacancies(source);

    expect(http.requestedUrls).toEqual([feedUrl]);
    expect(http.requestedOptions).toEqual([
      {
        allowedOrigins: ['https://acme.jobs.personio.de', 'https://acme.jobs.personio.com'],
      },
    ]);
    expect(result).toMatchObject({ complete: false, requestCount: 1, invalidCount: 1 });
    expect(result.vacancies).toHaveLength(2);
    expect(result.vacancies[0]).toMatchObject({
      externalId: '1834171',
      title: 'Staff Software Engineer, Data Platform',
      location: 'Munich | Berlin | Amsterdam',
      remote: null,
      workplaceMode: 'unknown',
      url: 'https://acme.jobs.personio.com/job/1834171',
      postedAt: new Date('2024-11-13T14:10:41Z'),
      employmentType: 'permanent',
      source: 'personio',
    });
    expect(result.vacancies[0]?.description).toContain('Your mission\nBuild the data platform.');
    expect(result.vacancies[0]?.description).toContain(
      'What you bring\nTypeScript & distributed systems',
    );
    expect(result.vacancies[0]?.description).not.toContain('<li>');
    expect(result.vacancies[1]).toMatchObject({
      externalId: '1834172',
      location: 'Remote (EU)',
      remote: true,
      workplaceMode: 'remote',
      url: 'https://acme.jobs.personio.com/job/1834172',
      postedAt: null,
      employmentType: 'full-time',
    });
    expect(result.vacancies[1]?.description).toContain('Deine Aufgaben');
  });

  it('accepts a .com feed URL and normalizes its language to English', async () => {
    const englishFeed = 'https://acme.jobs.personio.com/xml?language=en';
    const http = new FixtureHttpClient(new Map([[englishFeed, '<workzag-jobs />']]));
    const adapter = new PersonioAdapter(http);
    const result = await adapter.listVacancies(
      careerSource(
        'personio',
        'https://acme.jobs.personio.com/xml?language=de',
        'https://acme.jobs.personio.com',
      ),
    );

    expect(result).toEqual({ vacancies: [], complete: true, requestCount: 1, invalidCount: 0 });
    expect(http.requestedUrls).toEqual([englishFeed]);
  });

  it('preserves a validated matching .com base URL for a bare tenant', async () => {
    const englishFeed = 'https://acme.jobs.personio.com/xml?language=en';
    const http = new FixtureHttpClient(new Map([[englishFeed, '<workzag-jobs />']]));
    const result = await new PersonioAdapter(http).listVacancies(
      careerSource('personio', 'acme', 'https://acme.jobs.personio.com'),
    );

    expect(result).toMatchObject({ vacancies: [], complete: true, requestCount: 1 });
    expect(http.requestedUrls).toEqual([englishFeed]);

    const mismatchedHttp = new FixtureHttpClient(new Map());
    const mismatchedAdapter = new PersonioAdapter(mismatchedHttp);
    const mismatchedSource = careerSource(
      'personio',
      'acme',
      'https://another.jobs.personio.com',
    );
    expect(mismatchedAdapter.supports(mismatchedSource)).toBe(false);
    await expect(mismatchedAdapter.listVacancies(mismatchedSource)).rejects.toThrow(
      'source is not supported',
    );
    expect(mismatchedHttp.requestedUrls).toEqual([]);
  });

  it('distinguishes an empty feed from malformed XML and rejects unrelated origins', async () => {
    const empty = new FixtureHttpClient(new Map([[feedUrl, '<workzag-jobs></workzag-jobs>']]));
    await expect(new PersonioAdapter(empty).listVacancies(source)).resolves.toMatchObject({
      vacancies: [],
      complete: true,
      requestCount: 1,
      invalidCount: 0,
    });

    const malformed = new FixtureHttpClient(
      new Map([[feedUrl, '<html><body>Not a job feed</body></html>']]),
    );
    await expect(new PersonioAdapter(malformed).listVacancies(source)).rejects.toThrow(
      'unknown response shape',
    );

    const adapter = new PersonioAdapter(new FixtureHttpClient(new Map()));
    expect(
      adapter.supports(
        careerSource('personio', 'https://careers.example.com/xml', 'https://careers.example.com'),
      ),
    ).toBe(false);
  });
});
