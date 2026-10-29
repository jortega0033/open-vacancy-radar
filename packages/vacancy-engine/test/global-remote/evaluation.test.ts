import { describe, expect, it } from 'vitest';

import {
  annualizedMinimumUsd,
  classifyDiscoveryVacancy,
  evaluateOfficialReview,
  hasExcludedRoleFamily,
  isFrontendOnlyTitle,
} from '../../src/global-remote/evaluation.js';
import type { GlobalRemoteSource } from '../../src/global-remote/models.js';

function reviewedSource(overrides: Partial<GlobalRemoteSource['review']> = {}): GlobalRemoteSource {
  return {
    id: 'acme:frontend',
    company: 'Acme, Inc.',
    provider: 'ashby',
    boardIdentifier: 'acme',
    externalId: 'frontend',
    expectedTitle: 'Senior Frontend Engineer',
    url: 'https://jobs.ashbyhq.com/acme/frontend',
    reviewedAt: '2026-08-28',
    reviewedContentHash: 'a'.repeat(64),
    review: {
      roleFrontendOnly: true,
      usMarketRole: 'yes',
      fullyRemote: 'yes',
      outsideUsEligible: 'yes',
      minimumAnnualBaseUsd: 150_000,
      salaryAppliesOutsideUs: 'yes',
      mandatoryLanguage: '',
      notes: [],
      ...overrides,
    },
  };
}

describe('global remote deterministic evaluation', () => {
  it('accepts explicit frontend and Angular titles but rejects adjacent or broader roles', () => {
    expect(isFrontendOnlyTitle('Software Engineer (Frontend)')).toBe(true);
    expect(isFrontendOnlyTitle('Senior Front-end Engineer')).toBe(true);
    expect(isFrontendOnlyTitle('Angular Developer')).toBe(true);
    expect(isFrontendOnlyTitle('Senior Full-Stack Engineer (Frontend Focus)')).toBe(false);
    expect(isFrontendOnlyTitle('Frontend Engineering Manager')).toBe(false);
    expect(isFrontendOnlyTitle('Senior Design Engineer')).toBe(false);
    expect(isFrontendOnlyTitle('Solidity Compiler Frontend Engineer')).toBe(false);
  });

  it('annualizes supported USD periods and refuses unsupported hourly assumptions', () => {
    expect(annualizedMinimumUsd(100_000, 'USD', 'annual', 'Full Time')).toBe(100_000);
    expect(annualizedMinimumUsd(8_500, 'USD', 'monthly', 'Full Time')).toBe(102_000);
    expect(annualizedMinimumUsd(60, 'USD', 'hourly', 'Full Time')).toBe(120_000);
    expect(annualizedMinimumUsd(100, 'USD', 'hourly', 'Contractor')).toBeNull();
    expect(annualizedMinimumUsd(140_000, 'CAD', 'yearly', 'Full Time')).toBeNull();
  });

  it('keeps discovery metadata preliminary even when all structured gates pass', () => {
    expect(classifyDiscoveryVacancy({
      title: 'Senior Frontend Engineer',
      location: 'Worldwide',
      annualizedMinimumUsd: 150_000,
      minimumAnnualBaseUsd: 100_000,
    })).toMatchObject({ decision: 'official_review_candidate' });
    expect(classifyDiscoveryVacancy({
      title: 'Senior Frontend Engineer',
      location: 'USA',
      annualizedMinimumUsd: 150_000,
      minimumAnnualBaseUsd: 100_000,
    })).toMatchObject({ decision: 'location_restricted' });
    expect(classifyDiscoveryVacancy({
      title: 'Staff Front-End Software Engineer (Remote)',
      location: 'Worldwide',
      annualizedMinimumUsd: 170_000,
      minimumAnnualBaseUsd: 100_000,
      description: 'Join our talent network. This is not an application for a specific job.',
    })).toMatchObject({ decision: 'non_vacancy' });
  });

  it('requires a matching reviewed hash and all official hard gates', () => {
    const strict = reviewedSource();
    expect(evaluateOfficialReview({
      source: strict,
      state: 'active',
      currentTitle: strict.expectedTitle,
      contentHash: strict.reviewedContentHash,
      minimumAnnualBaseUsd: 100_000,
    })).toMatchObject({ decision: 'strict_match' });

    expect(evaluateOfficialReview({
      source: strict,
      state: 'active',
      currentTitle: strict.expectedTitle,
      contentHash: 'b'.repeat(64),
      minimumAnnualBaseUsd: 100_000,
    })).toMatchObject({ decision: 'changed_since_review' });

    const localizedPay = reviewedSource({ salaryAppliesOutsideUs: 'uncertain' });
    expect(evaluateOfficialReview({
      source: localizedPay,
      state: 'active',
      currentTitle: localizedPay.expectedTitle,
      contentHash: localizedPay.reviewedContentHash,
      minimumAnnualBaseUsd: 100_000,
    })).toMatchObject({ decision: 'salary_confirmation' });

    const nearMiss = reviewedSource({ minimumAnnualBaseUsd: 95_000 });
    expect(evaluateOfficialReview({
      source: nearMiss,
      state: 'active',
      currentTitle: nearMiss.expectedTitle,
      contentHash: nearMiss.reviewedContentHash,
      minimumAnnualBaseUsd: 100_000,
    })).toMatchObject({ decision: 'salary_below_threshold' });
  });
});

/**
 * Issue #280, acceptance check 3: an explicit mandatory-language requirement is enforced against
 * the configured candidate constraints in every applicable pipeline. This file covers two of the
 * three (the discovery classifier and the official-source review); the worldwide deterministic
 * scorer is covered in `test/filtering/worldwide-relevance.test.ts`, and the post-discovery pass
 * that applies the same gate to every discovery source at once in
 * `test/pipeline/global-remote.test.ts`.
 */
describe('mandatory-language enforcement in the discovery classifier', () => {
  const description = `Senior Frontend Engineer
    Build and own our customer-facing web application.
    Requirements
    Strong Angular and TypeScript experience.
    Fluency in German is required, as all client communication is in German.`;

  it('routes a vacancy whose mandatory language the candidate lacks to language_mismatch', () => {
    const classification = classifyDiscoveryVacancy({
      title: 'Senior Frontend Engineer',
      location: 'Worldwide',
      annualizedMinimumUsd: 150_000,
      minimumAnnualBaseUsd: 100_000,
      description,
      candidateLanguages: ['English'],
    });

    expect(classification.decision).toBe('language_mismatch');
    expect(classification.reasons.join(' ')).toContain('German');
  });

  it('keeps the vacancy a review candidate when the candidate has the language', () => {
    expect(
      classifyDiscoveryVacancy({
        title: 'Senior Frontend Engineer',
        location: 'Worldwide',
        annualizedMinimumUsd: 150_000,
        minimumAnnualBaseUsd: 100_000,
        description,
        candidateLanguages: ['English', 'German'],
      }),
    ).toMatchObject({ decision: 'official_review_candidate' });
  });

  it('gates nothing when no candidate language is configured, and nothing on a preferred language', () => {
    expect(
      classifyDiscoveryVacancy({
        title: 'Senior Frontend Engineer',
        location: 'Worldwide',
        annualizedMinimumUsd: 150_000,
        minimumAnnualBaseUsd: 100_000,
        description,
        candidateLanguages: [],
      }),
    ).toMatchObject({ decision: 'official_review_candidate' });

    expect(
      classifyDiscoveryVacancy({
        title: 'Senior Frontend Engineer',
        location: 'Worldwide',
        annualizedMinimumUsd: 150_000,
        minimumAnnualBaseUsd: 100_000,
        description: 'Requirements\nAngular experience.\nNice to have\nGerman is a plus.',
        candidateLanguages: ['English'],
      }),
    ).toMatchObject({ decision: 'official_review_candidate' });
  });

  it('reports the role mismatch first, so a gated language never hides a different exclusion', () => {
    expect(
      classifyDiscoveryVacancy({
        title: 'Senior Backend Engineer',
        location: 'Worldwide',
        annualizedMinimumUsd: 150_000,
        minimumAnnualBaseUsd: 100_000,
        description,
        candidateLanguages: ['English'],
      }),
    ).toMatchObject({ decision: 'role_mismatch' });
  });
});

describe('approved search-plan titles in the discovery classifier (#686)', () => {
  const base = { location: 'Worldwide', annualizedMinimumUsd: 150_000, minimumAnnualBaseUsd: 100_000 };

  it('lets an approved title stand in for the positive title check only', () => {
    for (const [title, approvedTitle] of [
      ['React Developer', 'React developer'],
      ['Senior Frontend ontwikkelaar', 'Frontend ontwikkelaar'],
      ['Frontend Engineer (Remote)', 'Frontend engineer'],
      ['Angular Developer', 'React developer'],
    ] as const) {
      const result = classifyDiscoveryVacancy({ ...base, title, approvedTitle });
      expect(result.decision, title).toBe('official_review_candidate');
      expect(result.reasons[0]).toBe(`The title matches "${approvedTitle}", a title approved in the search plan.`);
    }
    // Without the approval the same English-only check still rejects the listings it always rejected.
    expect(classifyDiscoveryVacancy({ ...base, title: 'React Developer' }).decision).toBe('role_mismatch');
    expect(classifyDiscoveryVacancy({ ...base, title: 'Senior Frontend ontwikkelaar' }).decision).toBe('role_mismatch');
  });

  it('keeps every excluded role family out, even when the title contains an approved title', () => {
    const embedded: [string, string][] = [
      ['Frontend Engineering Manager', 'Frontend engineer'],
      ['Engineering Manager, Frontend Engineering', 'Frontend engineer'],
      ['Full Stack Frontend Engineer', 'Frontend engineer'],
      ['Full-Stack React Developer', 'React developer'],
      ['Frontend Engineer (Mobile)', 'Frontend engineer'],
      ['Frontend Engineer, Android', 'Frontend engineer'],
      ['iOS React Developer', 'React developer'],
      ['Head of Frontend Engineering', 'Frontend engineer'],
      ['Director, Frontend Engineering', 'Frontend engineer'],
      ['Backend and Frontend Engineer', 'Frontend engineer'],
      ['Frontend QA Engineer', 'Frontend engineer'],
      ['Senior UI Engineer, Salesforce', 'UI engineer'],
    ];
    for (const [title, approvedTitle] of embedded) {
      expect(hasExcludedRoleFamily(title), title).toBe(true);
      // The very same decision and reason as the listing gets with no plan at all.
      const without = classifyDiscoveryVacancy({ ...base, title });
      const withApproval = classifyDiscoveryVacancy({ ...base, title, approvedTitle });
      expect(without, title).toEqual({ decision: 'role_mismatch', reasons: ['Title is not explicitly frontend-only.'] });
      expect(withApproval, title).toEqual(without);
    }
    // An approved title that is itself an excluded family does not widen the product's role scope.
    expect(classifyDiscoveryVacancy({ ...base, title: 'Full Stack Developer', approvedTitle: 'Full Stack Developer' }).decision).toBe('role_mismatch');
    expect(hasExcludedRoleFamily('React Developer')).toBe(false);
    expect(isFrontendOnlyTitle('Frontend Engineering Manager')).toBe(false);
  });

  it('applies the unchanged language, location and salary gates behind an approved title', () => {
    const dutch = 'Fluent Dutch is required. Je werkt met klanten in het Nederlands.';
    const common = { ...base, title: 'Frontend ontwikkelaar', approvedTitle: 'Frontend ontwikkelaar', candidateLanguages: ['English'] };
    expect(classifyDiscoveryVacancy({ ...common, description: dutch }).decision).toBe('language_mismatch');
    expect(classifyDiscoveryVacancy({ ...common, description: 'Wij zoeken een ontwikkelaar.' }).decision).toBe('official_review_candidate');
    expect(classifyDiscoveryVacancy({ ...common, location: 'United States only' }).decision).toBe('location_restricted');
    expect(classifyDiscoveryVacancy({ ...common, annualizedMinimumUsd: null }).decision).toBe('salary_unverified');
    expect(classifyDiscoveryVacancy({ ...common, annualizedMinimumUsd: 50_000 }).decision).toBe('salary_below_threshold');
    // A talent pool is still not a vacancy, whatever it is called.
    expect(classifyDiscoveryVacancy({ ...common, description: 'Join our talent pool for future opportunities.' }).decision).toBe('non_vacancy');
  });
});

describe('mandatory-language enforcement in the official-source review', () => {
  it('excludes a reviewed mandatory language the candidate does not have', () => {
    const source = reviewedSource({ mandatoryLanguage: 'German' });

    expect(
      evaluateOfficialReview({
        source,
        state: 'active',
        currentTitle: source.expectedTitle,
        contentHash: source.reviewedContentHash,
        minimumAnnualBaseUsd: 100_000,
        candidateLanguages: ['English'],
      }),
    ).toMatchObject({ decision: 'excluded_language' });
  });

  it('routes a reviewed mandatory language to confirmation when there is nothing to check it against', () => {
    const source = reviewedSource({ mandatoryLanguage: 'German' });

    expect(
      evaluateOfficialReview({
        source,
        state: 'active',
        currentTitle: source.expectedTitle,
        contentHash: source.reviewedContentHash,
        minimumAnnualBaseUsd: 100_000,
        candidateLanguages: [],
      }),
    ).toMatchObject({ decision: 'language_confirmation' });
  });

  it('still reaches a strict match when the candidate has the reviewed mandatory language', () => {
    const source = reviewedSource({ mandatoryLanguage: 'Nederlands' });

    expect(
      evaluateOfficialReview({
        source,
        state: 'active',
        currentTitle: source.expectedTitle,
        contentHash: source.reviewedContentHash,
        minimumAnnualBaseUsd: 100_000,
        candidateLanguages: ['English', 'Dutch'],
      }),
    ).toMatchObject({ decision: 'strict_match' });
  });

  it('leaves an empty reviewed mandatory language gating nothing', () => {
    const source = reviewedSource();

    expect(
      evaluateOfficialReview({
        source,
        state: 'active',
        currentTitle: source.expectedTitle,
        contentHash: source.reviewedContentHash,
        minimumAnnualBaseUsd: 100_000,
        candidateLanguages: ['English'],
      }),
    ).toMatchObject({ decision: 'strict_match' });
  });
});
