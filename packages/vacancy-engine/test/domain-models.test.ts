import { describe, expect, it } from 'vitest';

import { httpUrl } from '../src/ats/shared.js';
import { normalizedVacancySchema } from '../src/domain/models.js';

describe('vacancy URL hygiene', () => {
  it('rejects credential-bearing URLs during ATS parsing and normalization', () => {
    const credentialed = 'https://user:secret@jobs.example.test/opening';

    expect(httpUrl(credentialed)).toBeNull();
    expect(
      normalizedVacancySchema.safeParse({
        externalId: 'job-1',
        title: 'Frontend Engineer',
        description: 'Build Angular applications.',
        location: null,
        remote: null,
        workplaceMode: 'unknown',
        url: credentialed,
        postedAt: null,
        employmentType: null,
        source: 'test',
      }).success,
    ).toBe(false);
  });
});
