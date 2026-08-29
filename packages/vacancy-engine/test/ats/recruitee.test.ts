import { describe, expect, it } from 'vitest';

import { RecruiteeAdapter } from '../../src/ats/recruitee.js';
import { atsFixture, careerSource, FixtureHttpClient } from './helpers.js';

const source = careerSource('recruitee', 'acme', 'https://acme.recruitee.com');
const feedUrl = 'https://acme.recruitee.com/api/offers.xml';

describe('RecruiteeAdapter', () => {
  it('normalizes valid offers and marks a feed with malformed offers incomplete', async () => {
    const http = new FixtureHttpClient(new Map([[feedUrl, await atsFixture('recruitee/offers.xml')]]));
    const result = await new RecruiteeAdapter(http).listVacancies(source);

    expect(result).toMatchObject({ complete: false, requestCount: 1, invalidCount: 1 });
    expect(result.vacancies).toHaveLength(2);
    expect(result.vacancies[0]).toMatchObject({
      externalId: '700',
      remote: true,
      workplaceMode: 'remote',
      postedAt: new Date('2026-08-19T09:30:00Z'),
      employmentType: 'full_time',
      url: 'https://acme.recruitee.com/o/senior-backend-engineer',
    });
    expect(result.vacancies[0]?.description).toContain('Build payment services.');
    expect(result.vacancies[0]?.description).not.toContain('<p>');
    expect(result.vacancies[1]).toMatchObject({
      externalId: '701',
      remote: false,
      workplaceMode: 'onsite',
      postedAt: null,
      url: 'https://careers.acme.example/platform-engineer',
    });
  });

  it('accepts an exact custom-domain offer feed URL', async () => {
    const customFeedUrl = 'https://careers.example.com/api/offers.xml';
    const http = new FixtureHttpClient(
      new Map([[customFeedUrl, await atsFixture('recruitee/offers.xml')]]),
    );
    const adapter = new RecruiteeAdapter(http);
    const result = await adapter.listVacancies(
      careerSource('recruitee', customFeedUrl, 'https://careers.example.com'),
    );

    expect(result.vacancies.length).toBeGreaterThan(0);
    expect(http.requestedUrls).toEqual([customFeedUrl]);
  });

  it('accepts an empty offers container and rejects unrelated XML', async () => {
    const empty = new FixtureHttpClient(new Map([[feedUrl, '<hash><offers /></hash>']]));
    await expect(new RecruiteeAdapter(empty).listVacancies(source)).resolves.toMatchObject({
      vacancies: [],
      complete: true,
    });

    const unknown = new FixtureHttpClient(new Map([[feedUrl, '<hash><error>denied</error></hash>']]));
    await expect(new RecruiteeAdapter(unknown).listVacancies(source)).rejects.toThrow(
      'unknown response shape',
    );
  });
});
