import { describe, expect, it } from 'vitest';

import {
  annualizedMinimumUsd,
  classifyDiscoveryVacancy,
  evaluateOfficialReview,
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
