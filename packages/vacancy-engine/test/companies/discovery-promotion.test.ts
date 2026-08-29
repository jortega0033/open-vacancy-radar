import { describe, expect, it } from 'vitest';

import {
  canonicalizeSupportedDiscoverySource,
  DiscoveryPromotionBoundaryError,
  discoveryStatusForSourceOutcome,
  terminalStatusForPromotionFailure,
  type PromotionAttemptEvidence,
  type PromotionDiscoveryState,
  validatePromotionProvenance,
} from '../../src/companies/discovery-promotion.js';

function expectBoundary(
  operation: () => unknown,
  disposition: DiscoveryPromotionBoundaryError['disposition'],
): void {
  try {
    operation();
    throw new Error('Expected promotion boundary rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(DiscoveryPromotionBoundaryError);
    expect((error as DiscoveryPromotionBoundaryError).disposition).toBe(disposition);
  }
}

describe('automatic discovery source canonicalization', () => {
  it.each([
    [
      {
        provider: 'greenhouse',
        careersUrl: 'https://job-boards.greenhouse.io/Acme/jobs/123',
        boardIdentifier: 'Acme',
      },
      {
        provider: 'greenhouse',
        sourceType: 'public_ats_api',
        baseUrl: 'https://boards-api.greenhouse.io/v1/boards/Acme',
        boardIdentifier: 'Acme',
        canonicalKey: 'greenhouse:acme',
      },
    ],
    [
      {
        provider: 'lever',
        careersUrl: 'https://jobs.eu.lever.co/Acme/role-id',
        boardIdentifier: 'Acme',
      },
      {
        provider: 'lever',
        sourceType: 'public_ats_api',
        baseUrl: 'https://jobs.eu.lever.co/Acme',
        boardIdentifier: 'Acme',
        canonicalKey: 'lever:eu:acme',
      },
    ],
    [
      {
        provider: 'recruitee',
        careersUrl: 'https://acme.recruitee.com/o/frontend-engineer',
        boardIdentifier: 'acme',
      },
      {
        provider: 'recruitee',
        sourceType: 'public_xml',
        baseUrl: 'https://acme.recruitee.com',
        boardIdentifier: 'acme',
        canonicalKey: 'recruitee:acme',
      },
    ],
    [
      {
        provider: 'teamtailor',
        careersUrl: 'https://acme.teamtailor.com/jobs?department=engineering',
        boardIdentifier: 'https://acme.teamtailor.com/jobs.rss',
      },
      {
        provider: 'teamtailor',
        sourceType: 'public_rss',
        baseUrl: 'https://acme.teamtailor.com/jobs',
        boardIdentifier: 'https://acme.teamtailor.com/jobs.rss',
        canonicalKey: 'teamtailor:https://acme.teamtailor.com/jobs.rss',
      },
    ],
    [
      {
        provider: 'smartrecruiters',
        careersUrl: 'https://jobs.smartrecruiters.com/Qelp/role-id',
        boardIdentifier: 'Qelp',
      },
      {
        provider: 'smartrecruiters',
        sourceType: 'public_ats_api',
        baseUrl: 'https://jobs.smartrecruiters.com/Qelp',
        boardIdentifier: 'Qelp',
        canonicalKey: 'smartrecruiters:qelp',
      },
    ],
    [
      {
        provider: 'workday',
        careersUrl:
          'https://acme.wd5.myworkdayjobs.com/en-US/External/job/Amsterdam/Angular-Developer_JR-123',
        boardIdentifier: 'External',
      },
      {
        provider: 'workday',
        sourceType: 'public_ats_api',
        baseUrl: 'https://acme.wd5.myworkdayjobs.com/en-US/External',
        boardIdentifier: 'External',
        canonicalKey: 'workday:acme.wd5.myworkdayjobs.com:external',
      },
    ],
  ])('canonicalizes a guarded $provider observation', (input, expected) => {
    expect(canonicalizeSupportedDiscoverySource(input)).toEqual(expected);
  });

  it('does not promote unsupported or provider-generic observations', () => {
    expectBoundary(
      () =>
        canonicalizeSupportedDiscoverySource({
          provider: 'json_ld',
          careersUrl: 'https://acme.example/careers',
          boardIdentifier: '/careers/jobs',
        }),
      'unsupported',
    );
    expectBoundary(
      () =>
        canonicalizeSupportedDiscoverySource({
          provider: 'lever',
          careersUrl: 'https://jobs.lever.co/privacy',
          boardIdentifier: 'privacy',
        }),
      'manual_review',
    );
    expectBoundary(
      () =>
        canonicalizeSupportedDiscoverySource({
          provider: 'workday',
          careersUrl: 'https://acme.wd5.myworkdayjobs.com/en-US/jobs',
          boardIdentifier: 'jobs',
        }),
      'manual_review',
    );
  });
});

function state(): PromotionDiscoveryState {
  return {
    sponsorId: 'sponsor-1',
    officialUrl: 'https://acme.example/',
    officialHostname: 'acme.example',
    candidateSource: 'verified-domain-catalog',
    candidateVersion: 'domains-v1',
    candidateHash: 'a'.repeat(64),
    candidateVerifiedAt: new Date('2026-08-28T09:00:00.000Z'),
    confidence: 'high',
    brandName: 'Acme',
    careersUrl: 'https://jobs.eu.lever.co/acme',
    provider: 'lever',
    sourceBaseUrl: 'https://jobs.eu.lever.co',
    boardIdentifier: 'acme',
  };
}

function attempt(
  overrides: Partial<PromotionAttemptEvidence> = {},
): PromotionAttemptEvidence {
  return {
    id: 'attempt-1',
    outcome: 'careers_found',
    officialUrl: 'https://acme.example/',
    candidateSource: 'verified-domain-catalog',
    candidateVersion: 'domains-v1',
    candidateHash: 'a'.repeat(64),
    result: {
      status: 'careers_found',
      careersUrl: 'https://jobs.eu.lever.co/acme',
      provider: 'lever',
      sourceBaseUrl: 'https://jobs.eu.lever.co',
      boardIdentifier: 'acme',
      observations: [
        {
          provider: 'lever',
          boardIdentifier: 'acme',
          sourceBaseUrl: 'https://jobs.eu.lever.co',
          observedUrl: 'https://jobs.eu.lever.co/acme',
          observedOnPage: 'https://acme.example/careers',
          element: 'anchor',
        },
        {
          provider: 'lever',
          boardIdentifier: 'acme',
          sourceBaseUrl: 'https://jobs.eu.lever.co',
          observedUrl: 'https://jobs.eu.lever.co/acme/role-id',
          observedOnPage: 'https://acme.example/careers',
          element: 'script',
        },
      ],
    },
    ...overrides,
  };
}

describe('promotion provenance', () => {
  it('accepts duplicate observations only when they resolve to the exact current board', () => {
    expect(validatePromotionProvenance(state(), attempt())).toMatchObject({
      provider: 'lever',
      canonicalKey: 'lever:eu:acme',
    });
  });

  it('accepts URL-serialization-only root slash differences in persisted evidence', () => {
    const serializedAttempt = attempt();
    serializedAttempt.result.sourceBaseUrl = 'https://jobs.eu.lever.co/';

    expect(validatePromotionProvenance(state(), serializedAttempt)).toMatchObject({
      provider: 'lever',
      canonicalKey: 'lever:eu:acme',
    });
  });

  it('rejects stale candidates, cross-origin observation pages, and multiple boards', () => {
    expectBoundary(
      () => validatePromotionProvenance(state(), attempt({ candidateHash: 'b'.repeat(64) })),
      'stale',
    );

    const outsideAttempt = attempt();
    const outsideResult = outsideAttempt.result;
    const outsideObservations = outsideResult.observations as Record<string, unknown>[];
    outsideObservations[0] = {
      ...outsideObservations[0],
      observedOnPage: 'https://outside.example/careers',
    };
    expectBoundary(() => validatePromotionProvenance(state(), outsideAttempt), 'manual_review');

    const ambiguousAttempt = attempt();
    const ambiguousResult = ambiguousAttempt.result;
    const ambiguousObservations = ambiguousResult.observations as Record<string, unknown>[];
    ambiguousObservations.push({
      provider: 'lever',
      boardIdentifier: 'acme-labs',
      sourceBaseUrl: 'https://jobs.eu.lever.co',
      observedUrl: 'https://jobs.eu.lever.co/acme-labs',
      observedOnPage: 'https://acme.example/careers',
      element: 'anchor',
    });
    expectBoundary(
      () => validatePromotionProvenance(state(), ambiguousAttempt),
      'manual_review',
    );
  });
});

describe('source-scan reconciliation', () => {
  it('maps every source outcome to the persisted discovery lifecycle', () => {
    expect(discoveryStatusForSourceOutcome('succeeded')).toBe('active');
    expect(discoveryStatusForSourceOutcome('blocked')).toBe('blocked');
    expect(discoveryStatusForSourceOutcome('failed')).toBe('error');
    expect(discoveryStatusForSourceOutcome('unsupported')).toBe('unsupported');
    expect(discoveryStatusForSourceOutcome('manual_review')).toBe('manual_review');
  });

  it('terminalizes every non-promoted disposition so the queue can advance', () => {
    expect(terminalStatusForPromotionFailure('unsupported')).toBe('unsupported');
    expect(terminalStatusForPromotionFailure('stale')).toBe('manual_review');
    expect(terminalStatusForPromotionFailure('manual_review')).toBe('manual_review');
    expect(terminalStatusForPromotionFailure('unexpected_error')).toBe('error');
  });
});
