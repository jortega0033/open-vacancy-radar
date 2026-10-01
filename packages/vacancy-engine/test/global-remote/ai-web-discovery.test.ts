import { describe, expect, it } from 'vitest';

import {
  AiWebDiscoveryCandidateSchema,
  isBlockedDiscoveryDomain,
  normalizeAiWebDiscoveryCandidates,
  type AiWebDiscoveryCandidate,
} from '../../src/global-remote/ai-web-discovery.js';
import { SOURCE_FILTER_CAPABILITIES } from '../../src/global-remote/focused-scan.js';
import type { GlobalRemoteConfig } from '../../src/global-remote/models.js';
import {
  globalRemoteSourceRegistry,
  prohibitedOrBlockedSourceRegistryEntries,
} from '../../src/global-remote/source-registry.js';

function validCandidate(overrides: Partial<AiWebDiscoveryCandidate> = {}): unknown {
  return {
    company: 'Acme Corp',
    title: 'Frontend Engineer',
    url: 'https://acme.example/careers/frontend-engineer-123',
    location: 'Worldwide',
    description: 'Build TypeScript user interfaces.',
    employmentType: 'full_time',
    currency: 'USD',
    salaryPeriod: 'annual',
    advertisedMinimum: 120_000,
    postedAt: '2026-09-01',
    evidence: {
      salary: { stated: true, quote: '$120,000/year base' },
      location: { stated: true, quote: 'Worldwide remote' },
      employmentType: { stated: true, quote: 'Full-time' },
      postedAt: { stated: true, quote: 'Posted Sep 1, 2026' },
      visaSponsorship: 'unknown',
      exactUrlVerified: true,
    },
    ...overrides,
  };
}

function registryProfile(): GlobalRemoteConfig {
  return {
    version: 'test',
    minimumAnnualBaseUsd: 100_000,
    discovery: {
      roleQuery: 'frontend',
      himalayasQueries: ['frontend'],
      himalayasCountry: 'NL',
      himalayasMaxPagesPerQuery: 1,
      jobicyCount: 1,
      freehireLimit: 1,
      jobOpportunitiesLimit: 1,
      remoteLandersMaxPages: 1,
      jobgetherMaxPages: 1,
      remoteFirstMaxPages: 1,
      jobRemotelyMaxPages: 1,
      arbeitnowMaxPages: 1,
      diceMaxPages: 1,
      remooteRoleTitle: 'frontend',
      remooteCountry: 'Netherlands',
      remooteLimit: 10,
      aiDevJobsMaxPages: 1,
      taiwanJobsMaxCities: 1,
      museEnabled: false,
      museMaxPages: 1,
      adzunaAppId: '',
      adzunaAppKey: '',
      adzunaMaxPages: 1,
      joobleApiKey: '',
      reedApiKey: '',
      jobspipeApiKey: '',
      atsRosterConcurrency: 1,
      navArbeidsplassenApiKey: '',
      navArbeidsplassenMaxPages: 1,
    },
    officialSources: [],
  };
}

describe('AiWebDiscoveryCandidateSchema', () => {
  it('accepts a fully-populated, honestly-evidenced candidate', () => {
    const result = AiWebDiscoveryCandidateSchema.safeParse(validCandidate());
    expect(result.success).toBe(true);
  });

  it('accepts a candidate with every missing fact as null/unknown, never fabricated', () => {
    const result = AiWebDiscoveryCandidateSchema.safeParse(
      validCandidate({
        location: 'Not stated',
        description: null,
        employmentType: null,
        currency: null,
        salaryPeriod: null,
        advertisedMinimum: null,
        postedAt: null,
        evidence: {
          salary: { stated: false, quote: null },
          location: { stated: false, quote: null },
          employmentType: { stated: false, quote: null },
          postedAt: { stated: false, quote: null },
          visaSponsorship: 'unknown',
          exactUrlVerified: false,
        },
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a candidate missing a required field (company)', () => {
    const candidate = validCandidate() as Record<string, unknown>;
    delete candidate.company;
    const result = AiWebDiscoveryCandidateSchema.safeParse(candidate);
    expect(result.success).toBe(false);
  });

  it('rejects a candidate with a wrong type (advertisedMinimum as a string)', () => {
    const result = AiWebDiscoveryCandidateSchema.safeParse(
      validCandidate({ advertisedMinimum: '120000' as unknown as number | null }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a candidate whose url is not a valid URL', () => {
    const result = AiWebDiscoveryCandidateSchema.safeParse(validCandidate({ url: 'not-a-url' }));
    expect(result.success).toBe(false);
  });

  it('rejects an invented salary figure paired with evidence.salary.stated === false', () => {
    const result = AiWebDiscoveryCandidateSchema.safeParse(
      validCandidate({
        evidence: {
          salary: { stated: false, quote: null },
          location: { stated: true, quote: 'Worldwide remote' },
          employmentType: { stated: true, quote: 'Full-time' },
          postedAt: { stated: true, quote: 'Posted Sep 1, 2026' },
          visaSponsorship: 'unknown',
          exactUrlVerified: true,
        },
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an invented visa-sponsorship value outside yes/no/unknown', () => {
    const candidate = validCandidate() as { evidence: Record<string, unknown> };
    candidate.evidence.visaSponsorship = 'probably';
    const result = AiWebDiscoveryCandidateSchema.safeParse(candidate);
    expect(result.success).toBe(false);
  });

  describe('url field: non-http(s) schemes and embedded credentials (issue #398 security fix)', () => {
    it('rejects a javascript: URL', () => {
      const result = AiWebDiscoveryCandidateSchema.safeParse(validCandidate({ url: 'javascript:alert(1)' }));
      expect(result.success).toBe(false);
    });

    it('rejects a data: URL', () => {
      const result = AiWebDiscoveryCandidateSchema.safeParse(
        validCandidate({ url: 'data:text/html,<script>alert(1)</script>' }),
      );
      expect(result.success).toBe(false);
    });

    it('rejects a file: URL', () => {
      const result = AiWebDiscoveryCandidateSchema.safeParse(validCandidate({ url: 'file:///etc/passwd' }));
      expect(result.success).toBe(false);
    });

    it('rejects a vbscript: URL', () => {
      const result = AiWebDiscoveryCandidateSchema.safeParse(validCandidate({ url: 'vbscript:msgbox(1)' }));
      expect(result.success).toBe(false);
    });

    it('rejects an http(s) URL with embedded credentials', () => {
      const result = AiWebDiscoveryCandidateSchema.safeParse(
        validCandidate({ url: 'http://user:pass@host.example/x' }),
      );
      expect(result.success).toBe(false);
    });

    it('still accepts a plain http(s) URL with no credentials', () => {
      const result = AiWebDiscoveryCandidateSchema.safeParse(validCandidate({ url: 'https://acme.example/careers/eng-1' }));
      expect(result.success).toBe(true);
    });
  });

  describe('evidence.<fact>.stated === false implies the paired value must be the honest "missing" sentinel (issue #398, extended to every fact, not only salary)', () => {
    it('rejects a claimed location while evidence.location.stated is false', () => {
      const result = AiWebDiscoveryCandidateSchema.safeParse(
        validCandidate({
          location: 'Amsterdam, Netherlands',
          evidence: {
            salary: { stated: true, quote: '$120,000/year base' },
            location: { stated: false, quote: null },
            employmentType: { stated: true, quote: 'Full-time' },
            postedAt: { stated: true, quote: 'Posted Sep 1, 2026' },
            visaSponsorship: 'unknown',
            exactUrlVerified: true,
          },
        }),
      );
      expect(result.success).toBe(false);
    });

    it('rejects a non-null employmentType while evidence.employmentType.stated is false', () => {
      const result = AiWebDiscoveryCandidateSchema.safeParse(
        validCandidate({
          employmentType: 'full_time',
          evidence: {
            salary: { stated: true, quote: '$120,000/year base' },
            location: { stated: true, quote: 'Worldwide remote' },
            employmentType: { stated: false, quote: null },
            postedAt: { stated: true, quote: 'Posted Sep 1, 2026' },
            visaSponsorship: 'unknown',
            exactUrlVerified: true,
          },
        }),
      );
      expect(result.success).toBe(false);
    });

    it('rejects a non-null postedAt while evidence.postedAt.stated is false', () => {
      const result = AiWebDiscoveryCandidateSchema.safeParse(
        validCandidate({
          postedAt: '2026-09-01',
          evidence: {
            salary: { stated: true, quote: '$120,000/year base' },
            location: { stated: true, quote: 'Worldwide remote' },
            employmentType: { stated: true, quote: 'Full-time' },
            postedAt: { stated: false, quote: null },
            visaSponsorship: 'unknown',
            exactUrlVerified: true,
          },
        }),
      );
      expect(result.success).toBe(false);
    });
  });
});

describe('normalizeAiWebDiscoveryCandidates', () => {
  it('produces a well-formed DiscoveryVacancyAudit with provider: ai_web_search', () => {
    const parsed = AiWebDiscoveryCandidateSchema.parse(validCandidate());
    const [row] = normalizeAiWebDiscoveryCandidates([parsed]);
    expect(row).toBeDefined();
    expect(row?.provider).toBe('ai_web_search');
    expect(row?.company).toBe('Acme Corp');
    expect(row?.title).toBe('Frontend Engineer');
    expect(row?.url).toBe('https://acme.example/careers/frontend-engineer-123');
    expect(row?.key).toBe('ai_web_search:https://acme.example/careers/frontend-engineer-123');
    expect(row?.advertisedMinimum).toBe(120_000);
    expect(row?.identity).toBeDefined();
    expect(row?.sources).toEqual([
      { provider: 'ai_web_search', key: row?.key, url: row?.url },
    ]);
  });

  it('keeps missing facts as null rather than inventing values', () => {
    const parsed = AiWebDiscoveryCandidateSchema.parse(
      validCandidate({
        location: 'Not stated',
        description: null,
        employmentType: null,
        currency: null,
        salaryPeriod: null,
        advertisedMinimum: null,
        postedAt: null,
        evidence: {
          salary: { stated: false, quote: null },
          location: { stated: false, quote: null },
          employmentType: { stated: false, quote: null },
          postedAt: { stated: false, quote: null },
          visaSponsorship: 'unknown',
          exactUrlVerified: false,
        },
      }),
    );
    const [row] = normalizeAiWebDiscoveryCandidates([parsed]);
    expect(row?.advertisedMinimum).toBeNull();
    expect(row?.currency).toBeNull();
    expect(row?.description).toBeNull();
    expect(row?.postedAt).toBeNull();
  });
});

describe('isBlockedDiscoveryDomain', () => {
  const registry = globalRemoteSourceRegistry(registryProfile());

  it('returns true for a linkedin.com URL', () => {
    expect(isBlockedDiscoveryDomain('https://linkedin.com/jobs/view/12345', registry)).toBe(true);
  });

  it('returns true for a www.linkedin.com URL', () => {
    expect(isBlockedDiscoveryDomain('https://www.linkedin.com/jobs/view/12345', registry)).toBe(true);
  });

  it('returns true for an indeed.com URL', () => {
    expect(isBlockedDiscoveryDomain('https://www.indeed.com/viewjob?jk=abc123', registry)).toBe(true);
  });

  it('returns true for a country-subdomain LinkedIn variant (nl.linkedin.com)', () => {
    expect(isBlockedDiscoveryDomain('https://nl.linkedin.com/jobs/view/12345', registry)).toBe(true);
  });

  it('returns true for another LinkedIn subdomain (jobs.linkedin.com)', () => {
    expect(isBlockedDiscoveryDomain('https://jobs.linkedin.com/view/12345', registry)).toBe(true);
  });

  it('returns true for a country-subdomain Indeed variant (uk.indeed.com)', () => {
    expect(isBlockedDiscoveryDomain('https://uk.indeed.com/viewjob?jk=abc123', registry)).toBe(true);
  });

  it('returns false for an unrelated domain', () => {
    expect(isBlockedDiscoveryDomain('https://acme.example/careers/frontend', registry)).toBe(false);
  });

  it('returns false for a look-alike, differently-registrable domain (linkedin.com.evil.com)', () => {
    expect(isBlockedDiscoveryDomain('https://linkedin.com.evil.com/jobs/view/12345', registry)).toBe(false);
  });

  it('fails closed (returns true) for a malformed URL string', () => {
    expect(isBlockedDiscoveryDomain('not-a-url-at-all', registry)).toBe(true);
  });

  it('fails closed (returns true) for an empty string', () => {
    expect(isBlockedDiscoveryDomain('', registry)).toBe(true);
  });
});

describe('SOURCE_FILTER_CAPABILITIES / DiscoveryProvider compile-time coverage', () => {
  it('defines an entry for ai_web_search', () => {
    expect(SOURCE_FILTER_CAPABILITIES.ai_web_search).toBeDefined();
    expect(SOURCE_FILTER_CAPABILITIES.ai_web_search).toEqual({});
  });
});

describe('prohibitedOrBlockedSourceRegistryEntries', () => {
  it('takes no GlobalRemoteConfig argument and returns exactly the prohibited/blocked entries', () => {
    const entries = prohibitedOrBlockedSourceRegistryEntries();
    expect(entries.every((entry) => entry.state === 'prohibited' || entry.state === 'blocked')).toBe(true);
    const ids = entries.map((entry) => entry.id).sort();
    expect(ids).toEqual(
      ['eures', 'glassdoor_direct', 'google_jobs', 'indeed', 'linkedin', 'ziprecruiter'].sort(),
    );
  });

  it('matches the prohibited/blocked subset of the full, config-driven registry', () => {
    const full = globalRemoteSourceRegistry(registryProfile()).filter(
      (entry) => entry.state === 'prohibited' || entry.state === 'blocked',
    );
    expect(prohibitedOrBlockedSourceRegistryEntries().map((entry) => entry.id).sort()).toEqual(
      full.map((entry) => entry.id).sort(),
    );
  });

  it('never includes a manual_only entry like Built In (not actually caught by isBlockedDiscoveryDomain)', () => {
    const ids = prohibitedOrBlockedSourceRegistryEntries().map((entry) => entry.id);
    expect(ids).not.toContain('built_in');
  });
});
