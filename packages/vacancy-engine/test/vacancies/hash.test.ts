import { describe, expect, it } from 'vitest';

import type { NormalizedVacancy } from '../../src/domain/models.js';
import {
  canonicalizeVacancyUrl,
  createVacancyContentHash,
  createVacancyRevisionHash,
  createVacancySemanticFingerprint,
} from '../../src/vacancies/hash.js';

function vacancy(overrides: Partial<NormalizedVacancy> = {}): NormalizedVacancy {
  return {
    externalId: '42',
    title: 'Senior Frontend Engineer',
    description: '<p>Angular &amp; TypeScript</p>',
    location: 'Amsterdam, Netherlands',
    remote: false,
    workplaceMode: 'onsite',
    url: 'https://jobs.example.com/42?utm_source=test',
    postedAt: null,
    employmentType: 'Full time',
    source: 'fixture',
    ...overrides,
  };
}

describe('vacancy content hashing', () => {
  it('ignores cosmetic HTML, entity, whitespace, and tracking changes', () => {
    const left = vacancy();
    const right = vacancy({
      description: '<div>  Angular   &amp;\nTypeScript </div>',
      url: 'https://jobs.example.com/42?utm_campaign=other#apply',
    });
    expect(createVacancyContentHash(left)).toBe(createVacancyContentHash(right));
  });

  it('changes when a meaningful requirement is added', () => {
    expect(createVacancyContentHash(vacancy())).not.toBe(
      createVacancyContentHash(vacancy({ description: '<p>Angular &amp; TypeScript. C1 Dutch is mandatory.</p>' })),
    );
  });

  it('keeps scoring content stable but revisions a changed publication date', () => {
    const original = vacancy({ postedAt: new Date('2026-08-20T12:00:00.000Z') });
    const reposted = vacancy({ postedAt: new Date('2026-08-21T12:00:00.000Z') });

    expect(createVacancyContentHash(original)).toBe(createVacancyContentHash(reposted));
    expect(createVacancyRevisionHash(original)).not.toBe(createVacancyRevisionHash(reposted));
  });

  it('removes only non-functional tracking parameters', () => {
    expect(
      canonicalizeVacancyUrl(
        'https://jobs.example.com/opening/?utm_source=x&gh_jid=42&department=web#apply',
      ),
    ).toBe('https://jobs.example.com/opening?department=web&gh_jid=42');
  });

  it('collapses repost URLs only when title, description, and location are semantically identical', () => {
    const original = vacancy();
    const repost = vacancy({ externalId: '99', url: 'https://jobs.example.com/99' });
    expect(createVacancySemanticFingerprint(original)).toBe(
      createVacancySemanticFingerprint(repost),
    );
    expect(createVacancySemanticFingerprint(original)).not.toBe(
      createVacancySemanticFingerprint({ ...repost, location: 'Rotterdam' }),
    );
  });
});
