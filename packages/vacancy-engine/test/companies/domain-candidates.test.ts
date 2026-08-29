import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  companyDomainCandidateFileSchema,
  hashDomainCandidate,
  loadCompanyDomainCandidates,
  normalizeOfficialUrl,
} from '../../src/companies/domain-candidates.js';

const file = {
  version: 'company-domain-candidates-test-v1',
  verifiedAt: '2026-08-28T08:00:00.000Z',
  candidates: [
    {
      legalName: 'Example Technology B.V.',
      kvkNumber: '12345678',
      brandName: 'Example Technology',
      officialUrl: 'https://www.example.test/',
      confidence: 'high' as const,
      source: 'reviewed-public-register',
      evidenceUrls: ['https://evidence.example.test/company/12345678'],
      priority: 75,
    },
  ],
};

describe('trusted company-domain candidate configuration', () => {
  it('loads an empty, versioned fixture without implying a network target', async () => {
    const loaded = await loadCompanyDomainCandidates(
      path.resolve(process.cwd(), 'test/fixtures/company-domain-candidates-empty.json'),
    );
    expect(loaded.version).toBe('company-domain-candidates-v1');
    expect(loaded.candidates).toEqual([]);
  });

  it('requires an exact sponsor identity and public evidence', () => {
    expect(companyDomainCandidateFileSchema.safeParse(file).success).toBe(true);
    expect(
      companyDomainCandidateFileSchema.safeParse({
        ...file,
        candidates: [
          ...file.candidates,
          { ...file.candidates[0], legalName: 'Example Technology BV' },
        ],
      }).success,
    ).toBe(false);
    expect(
      companyDomainCandidateFileSchema.safeParse({
        ...file,
        candidates: [{ ...file.candidates[0], evidenceUrls: [] }],
      }).success,
    ).toBe(false);
  });

  it('rejects credential-bearing or parameterized official URLs', () => {
    for (const officialUrl of [
      'https://user:secret@example.test/',
      'https://example.test/?company=12345678',
      'https://example.test/#careers',
      'https://www.linkedin.com/company/example/',
      'https://jobs.linkedin.com/example/',
      'file:///tmp/company',
    ]) {
      expect(
        companyDomainCandidateFileSchema.safeParse({
          ...file,
          candidates: [{ ...file.candidates[0], officialUrl }],
        }).success,
      ).toBe(false);
    }
  });

  it('normalizes trailing slashes and hashes all provenance fields', () => {
    expect(normalizeOfficialUrl('https://EXAMPLE.test/company///')).toBe(
      'https://example.test/company',
    );
    const parsed = companyDomainCandidateFileSchema.parse(file);
    const candidate = parsed.candidates[0];
    expect(candidate).toBeDefined();
    if (candidate === undefined) return;
    const hash = hashDomainCandidate(candidate);
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      hashDomainCandidate({ ...candidate, evidenceUrls: [...candidate.evidenceUrls, 'https://evidence.example.test/second'] }),
    ).not.toBe(hash);
  });
});
