import { describe, expect, it } from 'vitest';
import { ALL_COUNTRIES } from '../../src/geo/countries.js';
import {
  applyFocusedScanCriteria,
  SOURCE_FILTER_CAPABILITIES,
  upstreamCountryFor,
  upstreamEmploymentFor,
  withFocusedScanPlan,
} from '../../src/global-remote/focused-scan.js';
import type {
  DiscoverySourceAudit,
  DiscoveryVacancyAudit,
} from '../../src/global-remote/models.js';

function vacancy(overrides: Partial<DiscoveryVacancyAudit> = {}): DiscoveryVacancyAudit {
  return {
    key: 'job-1',
    provider: 'jobicy',
    company: 'Acme',
    title: 'Frontend Engineer',
    url: 'https://example.com/job',
    location: 'Amsterdam, Netherlands',
    locations: ['Amsterdam, Netherlands'],
    employmentType: 'full_time',
    currency: null,
    salaryPeriod: null,
    advertisedMinimum: null,
    annualizedMinimumUsd: null,
    decision: 'official_review_candidate',
    reasons: [],
    contentHash: 'hash',
    description: 'Build TypeScript user interfaces.',
    postedAt: null,
    profileScore: null,
    worldwideSponsorMatch: null,
    ...overrides,
  };
}

const source: DiscoverySourceAudit = {
  id: 'jobicy:test',
  provider: 'jobicy',
  url: 'https://example.com',
  requests: 1,
  listings: 1,
  status: 'success',
  error: null,
  networkAttempts: 1,
  retries: 0,
  complete: true,
  completenessReason: null,
  continuationCursor: null,
};

describe('focused scan capability contract', () => {
  it('declares a reviewed entry for every adapter and never guesses employment parameters', () => {
    expect(Object.keys(SOURCE_FILTER_CAPABILITIES)).toHaveLength(38);
    expect(SOURCE_FILTER_CAPABILITIES.jobicy.employment).toBeUndefined();
    expect(SOURCE_FILTER_CAPABILITIES.jobspresso.role).toBeUndefined();
    expect(SOURCE_FILTER_CAPABILITIES.remote_frontend_jobs.role).toBeUndefined();
    expect(SOURCE_FILTER_CAPABILITIES.nav_arbeidsplassen.role).toBeUndefined();
    expect(SOURCE_FILTER_CAPABILITIES.jobicy.role?.pagination).toBe('not_applicable');
  });

  it('records applied and deferred criteria per source', () => {
    const planned = withFocusedScanPlan(source, {
      role: 'frontend',
      country: 'Netherlands',
      employment: 'full_time',
    });
    expect(planned.focusedScan?.requested).toEqual({
      role: 'frontend',
      country: 'Netherlands',
      employment: 'full_time',
    });
    expect(planned.focusedScan?.applied).toMatchObject([{ criterion: 'role', parameter: 'tag' }]);
    expect(planned.focusedScan?.unsupported).toEqual([
      expect.objectContaining({ criterion: 'country', normalizedValue: 'Netherlands', reason: expect.any(String) }),
      expect.objectContaining({ criterion: 'employment', normalizedValue: 'full_time', reason: expect.any(String) }),
    ]);
  });

  it('maps countries only for sources with a documented vocabulary and leaves Unspecified local', () => {
    for (const country of ALL_COUNTRIES) {
      expect(upstreamCountryFor('himalayas', country)).toMatch(/^[A-Z]{2}$/);
    }
    expect(upstreamCountryFor('himalayas', 'Netherlands')).toBe('NL');
    expect(upstreamCountryFor('himalayas', 'Germany')).toBe('DE');
    expect(upstreamCountryFor('himalayas', 'Japan')).toBe('JP');
    expect(upstreamCountryFor('remoote', 'Holland')).toBe('Netherlands');
    expect(upstreamCountryFor('himalayas', 'Unspecified location')).toBeNull();

    const planned = withFocusedScanPlan({ ...source, provider: 'himalayas' }, {
      role: 'frontend',
      country: 'Netherlands',
      employment: null,
    });
    expect(planned.focusedScan?.applied).toMatchObject([
      { criterion: 'role', parameter: 'q', value: 'frontend' },
      { criterion: 'country', parameter: 'country', value: 'NL' },
    ]);
    expect(withFocusedScanPlan({ ...source, provider: 'himalayas' }, {
      role: '', country: 'Unspecified location', employment: null,
    }).focusedScan?.deferred).toEqual([expect.objectContaining({
      criterion: 'country', value: 'Unspecified location', normalizedValue: 'Unspecified location', reason: expect.any(String),
    })]);
  });

  it('maps Himalayas employment values to its emitted enum', () => {
    expect(upstreamEmploymentFor('himalayas', 'full_time')).toBe('Full Time');
    expect(upstreamEmploymentFor('himalayas', 'contract')).toBe('Contractor');
    expect(upstreamEmploymentFor('himalayas', 'permanent')).toBeNull();
    const planned = withFocusedScanPlan({ ...source, provider: 'himalayas' }, {
      role: '', country: null, employment: 'full_time',
    });
    expect(planned.focusedScan?.applied).toEqual([expect.objectContaining({
      criterion: 'employment', parameter: 'employment_type', value: 'Full Time', valueFormat: 'enumerated',
    })]);
  });
});

describe('applyFocusedScanCriteria', () => {
  it('uses title and description locally, includes any listed country, and excludes unknown employment separately', () => {
    const matchByDescription = vacancy({
      key: 'description',
      title: 'Engineer',
      locations: ['Remote', 'Netherlands'],
      location: 'Remote, Netherlands',
    });
    const unknownEmployment = vacancy({ key: 'unknown', employmentType: null });
    const explicitMismatch = vacancy({ key: 'mismatch', employmentType: 'contract' });
    const result = applyFocusedScanCriteria(
      [matchByDescription, unknownEmployment, explicitMismatch],
      { role: 'typescript', country: 'Netherlands', employment: 'full_time' },
    );
    expect(result.vacancies.map((item) => item.key)).toEqual(['description']);
    expect(result.unknownEmployment).toBe(1);
    expect(result.explicitEmploymentMismatch).toBe(1);
  });

  it('uses canonical country aliases and never treats Indianapolis as India', () => {
    const india = vacancy({ key: 'india', location: 'Bengaluru, India', locations: ['Bengaluru, India'] });
    const indianapolis = vacancy({ key: 'indianapolis', location: 'Indianapolis, United States', locations: ['Indianapolis, United States'] });
    const unspecified = vacancy({ key: 'unspecified', location: 'Remote', locations: ['Remote'] });
    const mixed = vacancy({ key: 'mixed', location: 'Remote', locations: ['Remote', 'Netherlands'] });
    expect(applyFocusedScanCriteria([india, indianapolis], {
      role: '', country: 'India', employment: null,
    }).vacancies.map((item) => item.key)).toEqual(['india']);
    expect(applyFocusedScanCriteria([india], {
      role: '', country: 'Holland', employment: null,
    }).vacancies).toEqual([]);
    expect(applyFocusedScanCriteria([india, unspecified, mixed], {
      role: '', country: 'Unspecified location', employment: null,
    }).vacancies.map((item) => item.key)).toEqual(['unspecified']);
  });

  it('keeps every vacancy when browse-all supplies no focused criteria', () => {
    expect(applyFocusedScanCriteria([vacancy({ key: 'other', title: 'Operations Manager' })], {
      role: '', country: null, employment: null,
    }).vacancies.map((item) => item.key)).toEqual(['other']);
  });
});
