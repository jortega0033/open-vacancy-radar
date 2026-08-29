import { describe, expect, it } from 'vitest';

import type { AtsHttpResponse } from '../src/ats/http.js';
import type { CompanyDomainCandidateFile } from '../src/companies/domain-candidates.js';
import {
  mergeBraveCandidates,
  parseBraveWebResults,
  verifyBraveCandidatePage,
} from '../src/pipeline/company-domain-search.js';

function response(body: string, finalUrl = 'https://acme.example/about'): AtsHttpResponse {
  return { status: 200, finalUrl, headers: { 'content-type': 'text/html' }, body };
}

describe('Brave employer-domain discovery boundary', () => {
  it('filters portals and ATS hosts before official-page verification', () => {
    const results = parseBraveWebResults(JSON.stringify({
      web: {
        results: [
          { title: 'Acme', url: 'https://acme.example/about', description: 'Official website' },
          { title: 'Acme jobs', url: 'https://www.linkedin.com/company/acme', description: '' },
          { title: 'Acme jobs', url: 'https://jobs.lever.co/acme', description: '' },
        ],
      },
    }));

    expect(results).toEqual([{
      title: 'Acme',
      url: 'https://acme.example/about',
      description: 'Official website',
    }]);
  });

  it('promotes only exact KVK plus compatible-name evidence to high confidence', () => {
    const high = verifyBraveCandidatePage(
      { legalName: 'Acme Nederland B.V.', kvkNumber: '12345678' },
      { title: 'Acme Nederland', url: 'https://acme.example/about', description: 'Official website' },
      response('<html><body>Acme Nederland B.V. · KVK 12 34 56 78</body></html>'),
    );
    const manual = verifyBraveCandidatePage(
      { legalName: 'Acme Nederland B.V.', kvkNumber: '12345678' },
      { title: 'Acme Nederland', url: 'https://acme.example/about', description: 'Official website' },
      response('<html><body>Acme Nederland builds useful software.</body></html>'),
    );

    expect(high?.candidate).toMatchObject({
      officialUrl: 'https://acme.example/',
      confidence: 'high',
      source: 'brave-domain-search-v1',
    });
    expect(manual?.candidate.confidence).toBe('medium');
  });

  it('preserves reviewed candidates and appends new search evidence deterministically', () => {
    const current: CompanyDomainCandidateFile = {
      version: 'existing',
      verifiedAt: '2026-08-28T00:00:00.000Z',
      candidates: [{
        legalName: 'Existing B.V.',
        kvkNumber: '11111111',
        brandName: 'Existing',
        officialUrl: 'https://existing.example/',
        confidence: 'high',
        source: 'manual',
        evidenceUrls: ['https://existing.example/'],
        priority: 100,
      }],
    };
    const merged = mergeBraveCandidates(current, [{
      legalName: 'Acme Nederland B.V.',
      kvkNumber: '12345678',
      brandName: 'Acme Nederland B.V.',
      officialUrl: 'https://acme.example/',
      confidence: 'medium',
      source: 'brave-domain-search-v1',
      evidenceUrls: ['https://acme.example/about'],
      priority: 20,
    }], new Date('2026-08-29T00:00:00.000Z'));

    expect(merged.version).toBe('company-domain-candidates-v3-brave-search');
    expect(merged.candidates).toHaveLength(2);
    expect(merged.candidates.find((candidate) => candidate.kvkNumber === '11111111')?.source)
      .toBe('manual');
  });
});
