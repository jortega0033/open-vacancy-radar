import { describe, expect, it } from 'vitest';

import type { CandidateProfile } from '../../src/candidate/profile.js';
import { RELEVANCE_THRESHOLD, scoreWorldwideVacancy, type WorldwideScorableVacancy } from '../../src/filtering/index.js';

const profile: CandidateProfile = {
  profileVersion: 'candidate-profile-v1',
  candidateName: 'Jake Ortega',
  currentRole: 'Senior Frontend Engineer',
  location: 'Netherlands',
  experienceYears: 10,
  strongestSkills: ['Angular', 'TypeScript', 'JavaScript', 'RxJS', 'React', 'design systems'],
  additionalSkills: ['Node.js'],
  targetRoles: ['Senior Frontend Engineer', 'Frontend Engineer', 'Angular Developer'],
  consideredRoles: [],
  excludedRoleFamilies: ['backend-only', 'data science', 'embedded'],
  constraints: {
    professionalLanguage: 'English',
    dutchRequired: false,
    primaryCountry: 'Netherlands',
    allowRemoteEuSupportingNetherlands: true,
    minimumMonthlyBaseEur: 6_000,
  },
};

// Mirrors the checked-in `config/candidate-profile-v1.json` default: no bias ships out of the box,
// so a fresh install has no target roles and no strongest skills configured.
const unconfiguredProfile: CandidateProfile = {
  ...profile,
  targetRoles: [],
  strongestSkills: [],
};

function vacancy(overrides: Partial<WorldwideScorableVacancy> = {}): WorldwideScorableVacancy {
  return {
    title: 'Senior Frontend Engineer',
    description: `Responsibilities
      Build and own an Angular and TypeScript web application.
      Create accessible UI components for our design system.
      Requirements
      Strong Angular, RxJS and frontend architecture experience.`,
    annualizedMinimumUsd: 150_000,
    ...overrides,
  };
}

describe('scoreWorldwideVacancy', () => {
  it('returns null, never a real-looking zero, when the candidate profile is not configured', () => {
    expect(scoreWorldwideVacancy(vacancy(), unconfiguredProfile, 100_000)).toBeNull();
  });

  it('scores a well-matched frontend vacancy above the relevance threshold using only technical/role/seniority fit', () => {
    const result = scoreWorldwideVacancy(vacancy(), profile, 100_000);

    expect(result).not.toBeNull();
    expect(result!.relevant).toBe(true);
    expect(result!.deterministicScore).toBeGreaterThanOrEqual(RELEVANCE_THRESHOLD);
    expect(result!.technicalFit).toBeGreaterThan(0);
    expect(result!.roleFit).toBeGreaterThan(0);
    expect(result!.seniorityFit).toBeGreaterThan(0);
    expect(result!.primaryFit).toMatch(/frontend/i);
    expect(result!.matchingSkills).toContain('Angular');
    expect(result!.gaps).not.toContain('Advertised USD annual base salary is below the configured minimum');
  });

  it('scores a vacancy with no description text honestly, without throwing', () => {
    const result = scoreWorldwideVacancy(vacancy({ description: null }), profile, 100_000);

    expect(result).not.toBeNull();
    expect(Number.isFinite(result!.deterministicScore)).toBe(true);
    expect(result!.matchingSkills).toEqual([]);
    expect(result!.gaps).toContain('No explicit candidate skill match found');
  });

  it('caps the score and reports a gap when the advertised USD salary is below the configured floor', () => {
    const result = scoreWorldwideVacancy(vacancy({ annualizedMinimumUsd: 60_000 }), profile, 100_000);

    expect(result).not.toBeNull();
    expect(result!.deterministicScore).toBeLessThanOrEqual(69);
    expect(result!.relevant).toBe(false);
    expect(result!.gaps).toContain('Advertised USD annual base salary is below the configured minimum');
    expect(result!.reasons.some((reason) => reason.includes('Eligibility cap applied'))).toBe(true);
  });

  it('applies no salary cap when the advertised USD salary meets the configured floor', () => {
    const result = scoreWorldwideVacancy(vacancy({ annualizedMinimumUsd: 150_000 }), profile, 100_000);

    expect(result).not.toBeNull();
    expect(result!.gaps).not.toContain('Advertised USD annual base salary is below the configured minimum');
  });

  it('applies no salary cap and reports an honest gap when the vacancy carries no USD floor at all', () => {
    const result = scoreWorldwideVacancy(vacancy({ annualizedMinimumUsd: null }), profile, 100_000);

    expect(result).not.toBeNull();
    expect(result!.deterministicScore).toBeGreaterThanOrEqual(RELEVANCE_THRESHOLD);
    expect(result!.gaps).toContain('Minimum USD annual base salary is not advertised');
    expect(result!.gaps).not.toContain('Advertised USD annual base salary is below the configured minimum');
  });

  it('applies no salary cap when the pipeline itself has no configured USD floor for this run', () => {
    const result = scoreWorldwideVacancy(vacancy({ annualizedMinimumUsd: 60_000 }), profile, null);

    expect(result).not.toBeNull();
    expect(result!.deterministicScore).toBeGreaterThanOrEqual(RELEVANCE_THRESHOLD);
    expect(result!.gaps).not.toContain('Advertised USD annual base salary is below the configured minimum');
  });

  it('hard-caps the score when the primary role family is excluded by the candidate profile', () => {
    const result = scoreWorldwideVacancy(
      vacancy({
        title: 'Backend Engineer',
        description: 'Build Java Spring Boot microservices and REST APIs for our backend platform.',
      }),
      profile,
      100_000,
    );

    expect(result).not.toBeNull();
    expect(result!.deterministicScore).toBeLessThanOrEqual(45);
    expect(result!.gaps.some((gap) => gap.startsWith('Excluded primary role family'))).toBe(true);
  });
});
