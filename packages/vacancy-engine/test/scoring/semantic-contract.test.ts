import { describe, expect, it } from 'vitest';

import { parseSemanticScore } from '../../src/scoring/semantic-contract.js';

const validScore = {
  relevant: true,
  score: 91,
  technicalFit: 95,
  seniorityFit: 80,
  languageFit: 100,
  locationFit: 90,
  dutchRequired: false,
  primaryFit: 'Frontend product engineering',
  matchingSkills: ['TypeScript', 'React'],
  gaps: ['Azure DevOps'],
  reasons: ['Strong hands-on frontend product fit'],
};

describe('semantic score contract', () => {
  it('accepts the provider-neutral structured output contract', () => {
    expect(parseSemanticScore(validScore)).toEqual(validScore);
  });

  it.each([
    { ...validScore, score: 101 },
    { ...validScore, score: 90.5 },
    { ...validScore, relevant: 'yes' },
    { ...validScore, unexpected: 'field' },
    { score: 90 },
  ])('rejects malformed or unbounded output', (candidate) => {
    expect(() => parseSemanticScore(candidate)).toThrow();
  });
});
