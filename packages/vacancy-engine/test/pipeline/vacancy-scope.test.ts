import { describe, expect, it } from 'vitest';

import {
  assertRequestedCareerSourcesResolved,
  MAX_SCOPED_VACANCY_SCAN_SOURCES,
  normalizeVacancyScanScope,
} from '../../src/pipeline/vacancies.js';

const sourceId = '11111111-1111-4111-8111-111111111111';

describe('vacancy scan scope', () => {
  it('normalizes a provider-bound, deduplicated source selection', () => {
    expect(
      normalizeVacancyScanScope({
        provider: 'workday',
        limit: 3,
        careerSourceIds: [sourceId, sourceId],
      }),
    ).toEqual({ provider: 'workday', limit: 3, careerSourceIds: [sourceId] });
  });

  it('enforces the hard pilot cap', () => {
    expect(() =>
      normalizeVacancyScanScope({
        provider: 'workday',
        limit: MAX_SCOPED_VACANCY_SCAN_SOURCES + 1,
      }),
    ).toThrow(/1 through 50/u);
  });

  it('rejects malformed source ids before querying the database', () => {
    expect(() =>
      normalizeVacancyScanScope({
        provider: 'workday',
        limit: 1,
        careerSourceIds: ['not-a-uuid'],
      }),
    ).toThrow(/not a UUID/u);
  });

  it('accepts an exact resolved source set', () => {
    const secondSourceId = '22222222-2222-4222-8222-222222222222';
    expect(() =>
      assertRequestedCareerSourcesResolved('greenhouse', [sourceId, secondSourceId], [
        { id: secondSourceId },
        { id: sourceId },
      ]),
    ).not.toThrow();
  });

  it('rejects missing or wrong-provider ids instead of reporting an empty success', () => {
    const missingSourceId = '22222222-2222-4222-8222-222222222222';
    expect(() =>
      assertRequestedCareerSourcesResolved('greenhouse', [sourceId, missingSourceId], [
        { id: sourceId },
      ]),
    ).toThrow(
      `Scoped greenhouse vacancy scan could not resolve requested source ids: ${missingSourceId}`,
    );
  });
});
