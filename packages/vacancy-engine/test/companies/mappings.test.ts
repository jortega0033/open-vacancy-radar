import { describe, expect, it } from 'vitest';

import {
  companyMappingFileSchema,
  loadCompanyMappings,
} from '../../src/companies/mappings.js';
import { canonicalKeyForCatalogSource } from '../../src/companies/repository.js';

describe('verified company mapping configuration', () => {
  it('keeps legal entities, public brands, and career sources explicit', async () => {
    const file = await loadCompanyMappings();
    expect(file.mappings.length).toBeGreaterThanOrEqual(9);
    expect(new Set(file.mappings.map((mapping) => mapping.domain)).size).toBe(file.mappings.length);
    expect(file.mappings.find((mapping) => mapping.brandName === 'Leaseweb')?.sponsors).toHaveLength(3);
    const bitvavo = file.mappings.find((mapping) => mapping.brandName === 'Bitvavo');
    expect(bitvavo?.scanEnabled).toBe(false);
    expect(bitvavo?.careerSources[0]?.status).toBe('manual_review');
    expect(bitvavo?.careerSources[0]?.statusDiagnostic?.reason).toContain('no circumvention');
    expect(bitvavo?.careerSources[0]?.statusDiagnostic?.observedAt).toBe(
      '2026-08-28T00:00:00.000Z',
    );
  });

  it('never derives a domain from a legal name at load time', async () => {
    const file = await loadCompanyMappings();
    for (const mapping of file.mappings) {
      expect(mapping.mappingSource).not.toBe('inferred_domain');
      expect(mapping.evidenceUrls.length).toBeGreaterThan(0);
    }
  });

  it('accepts only an exact same-origin detail prefix for official-site JSON-LD sources', async () => {
    const file = await loadCompanyMappings();
    const mapping = file.mappings[0];
    expect(mapping).toBeDefined();
    if (mapping === undefined) return;
    const source = {
      sourceType: 'official_company_careers_html',
      provider: 'json_ld' as const,
      baseUrl: 'https://careers.example.com/openings',
      boardIdentifier: '/openings/jobs/',
      discoveryMethod: 'verified official careers page',
      evidenceUrls: ['https://example.com/careers'],
      lifecycleAuthoritative: true,
      status: 'active' as const,
    };
    const candidate = { ...file, mappings: [{ ...mapping, careerSources: [source] }] };

    expect(companyMappingFileSchema.safeParse(candidate).success).toBe(true);
    expect(
      companyMappingFileSchema.safeParse({
        ...candidate,
        mappings: [
          {
            ...mapping,
            careerSources: [
              { ...source, boardIdentifier: 'https://outside.example/openings/jobs/' },
            ],
          },
        ],
      }).success,
    ).toBe(false);

    expect(
      companyMappingFileSchema.safeParse({
        ...candidate,
        mappings: [
          {
            ...mapping,
            careerSources: [
              {
                ...source,
                boardIdentifier: 'https://user:secret@careers.example.com/openings/jobs/',
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('canonicalKeyForCatalogSource', () => {
  it('derives a Recruitee key from an exact feed URL behind a custom careers domain', () => {
    expect(
      canonicalKeyForCatalogSource({
        provider: 'recruitee',
        baseUrl: 'https://jobs.funda.nl',
        boardIdentifier: 'https://funda.recruitee.com/api/offers.xml',
      }),
    ).toBe('recruitee:funda');
  });

  it('normalizes a Recruitee feed URL when the base URL is provider-hosted', () => {
    expect(
      canonicalKeyForCatalogSource({
        provider: 'recruitee',
        baseUrl: 'https://freeday.recruitee.com',
        boardIdentifier: 'https://freeday.recruitee.com/api/offers.xml',
      }),
    ).toBe('recruitee:freeday');
  });
});
