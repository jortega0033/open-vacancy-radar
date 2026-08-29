import { describe, expect, it } from 'vitest';

import {
  matchTrustedDomainCandidates,
  type TrustedCandidateMatchResult,
} from '../../src/companies/discovery-repository.js';
import type { CompanyDomainCandidate } from '../../src/companies/domain-candidates.js';

function candidate(
  overrides: Partial<CompanyDomainCandidate> = {},
): CompanyDomainCandidate {
  return {
    legalName: 'Acme Technologies B.V.',
    kvkNumber: '12345678',
    brandName: 'Acme',
    officialUrl: 'https://acme.example/',
    confidence: 'high',
    source: 'curated-test-evidence',
    evidenceUrls: ['https://evidence.example/acme'],
    priority: 50,
    ...overrides,
  };
}

function match(
  sponsors: Parameters<typeof matchTrustedDomainCandidates>[0],
  candidates: CompanyDomainCandidate[],
): TrustedCandidateMatchResult {
  return matchTrustedDomainCandidates(sponsors, candidates);
}

describe('trusted domain candidate matching', () => {
  it('requires an exact KVK and normalized legal name', () => {
    const exactSponsor = {
      id: 'exact',
      legalName: 'ACME Technologies B.V.',
      kvkNumber: '12345678',
    };
    const result = match(
      [
        exactSponsor,
        { id: 'wrong-kvk', legalName: 'Acme Technologies BV', kvkNumber: '87654321' },
        { id: 'similar-name', legalName: 'Acme Technology BV', kvkNumber: '12345678' },
      ],
      [candidate({ legalName: 'Acme Technologies BV' })],
    );

    expect(result.matches).toEqual([
      { sponsor: exactSponsor, candidate: candidate({ legalName: 'Acme Technologies BV' }) },
    ]);
    expect(result.misses).toEqual([]);
  });

  it('does not guess when the exact identity is missing or ambiguous', () => {
    const ambiguousCandidate = candidate();
    const missingCandidate = candidate({
      legalName: 'Missing Sponsor B.V.',
      kvkNumber: '11112222',
      brandName: 'Missing',
      officialUrl: 'https://missing.example/',
    });
    const result = match(
      [
        { id: 'duplicate-a', legalName: 'Acme Technologies BV', kvkNumber: '12345678' },
        { id: 'duplicate-b', legalName: 'ACME Technologies B.V.', kvkNumber: '12345678' },
        { id: 'without-kvk', legalName: 'Missing Sponsor B.V.', kvkNumber: null },
      ],
      [ambiguousCandidate, missingCandidate],
    );

    expect(result.matches).toEqual([]);
    expect(result.misses).toEqual([
      { candidate: ambiguousCandidate, reason: 'ambiguous' },
      { candidate: missingCandidate, reason: 'not_found' },
    ]);
  });
});
