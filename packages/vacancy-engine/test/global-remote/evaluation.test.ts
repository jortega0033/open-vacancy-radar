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
