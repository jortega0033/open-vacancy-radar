import { describe, expect, it } from 'vitest';

import {
  atsRequisitionFor,
  isGenericListingUrl,
  resolveApplyUrl,
  semanticIdentityKey,
  vacancyIdentityFor,
} from '../../src/vacancies/identity.js';

describe('atsRequisitionFor', () => {
  it('extracts a Greenhouse tenant and requisition ID from the public job-boards host', () => {
    expect(atsRequisitionFor('https://job-boards.greenhouse.io/acme/jobs/555000')).toEqual({
      provider: 'greenhouse',
      tenant: 'acme',
      requisitionId: '555000',
    });
  });

  it('extracts a Greenhouse tenant and requisition ID from the legacy boards host', () => {
    expect(atsRequisitionFor('https://boards.greenhouse.io/acme/jobs/555000')).toEqual({
      provider: 'greenhouse',
      tenant: 'acme',
      requisitionId: '555000',
    });
  });

  it('extracts a Greenhouse tenant and requisition ID from the API host', () => {
    expect(atsRequisitionFor('https://boards-api.greenhouse.io/v1/boards/acme/jobs/555000')).toEqual({
      provider: 'greenhouse',
      tenant: 'acme',
      requisitionId: '555000',
    });
  });

  it('extracts a Lever tenant and posting ID from the public host', () => {
    expect(
      atsRequisitionFor('https://jobs.lever.co/acme/f47ac10b-58cc-4372-a567-0e02b2c3d479'),
    ).toEqual({
      provider: 'lever',
      tenant: 'acme',
      requisitionId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    });
  });

  it('extracts a Lever tenant and posting ID with a trailing /apply segment', () => {
    expect(
      atsRequisitionFor('https://jobs.lever.co/acme/f47ac10b-58cc-4372-a567-0e02b2c3d479/apply'),
    ).toEqual({
      provider: 'lever',
      tenant: 'acme',
      requisitionId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    });
  });

  it('extracts an Ashby tenant and job ID', () => {
    expect(atsRequisitionFor('https://jobs.ashbyhq.com/acme/3d9f2b10-aaaa-bbbb-cccc-1234567890ab')).toEqual({
      provider: 'ashby',
      tenant: 'acme',
      requisitionId: '3d9f2b10-aaaa-bbbb-cccc-1234567890ab',
    });
  });

  it('extracts a Personio tenant and numeric job ID', () => {
    expect(atsRequisitionFor('https://acme.jobs.personio.de/job/1234567')).toEqual({
      provider: 'personio',
      tenant: 'acme',
      requisitionId: '1234567',
    });
  });

  it('extracts a Recruitee tenant and offer slug', () => {
    expect(atsRequisitionFor('https://acme.recruitee.com/o/senior-frontend-engineer')).toEqual({
      provider: 'recruitee',
      tenant: 'acme',
      requisitionId: 'senior-frontend-engineer',
    });
  });

  it('extracts a Rippling tenant and posting UUID', () => {
    expect(
      atsRequisitionFor('https://ats.rippling.com/acme/jobs/9c8b7a6d-1111-2222-3333-444455556666'),
    ).toEqual({
      provider: 'rippling',
      tenant: 'acme',
      requisitionId: '9c8b7a6d-1111-2222-3333-444455556666',
    });
  });

  it('returns null for a generic company careers page with no ATS shape', () => {
    expect(atsRequisitionFor('https://acme.com/careers')).toBeNull();
  });

  it('returns null for a Workable apply URL -- Workable stays a canonical-URL match, not a requisition', () => {
    expect(atsRequisitionFor('https://apply.workable.com/j/FRONTEND123')).toBeNull();
  });

  it('returns null for a malformed URL rather than throwing', () => {
    expect(atsRequisitionFor('not a url')).toBeNull();
  });

  it('returns null for a Greenhouse board URL missing the job ID', () => {
    expect(atsRequisitionFor('https://job-boards.greenhouse.io/acme/jobs')).toBeNull();
  });
});

describe('isGenericListingUrl', () => {
  it('flags a bare company careers page', () => {
    expect(isGenericListingUrl('https://acme.com/careers')).toBe(true);
  });

  it('flags an aggregator jobs-listing root', () => {
    expect(isGenericListingUrl('https://himalayas.app/jobs')).toBe(true);
  });

  it('flags a search-results-style URL with no job-specific query key', () => {
    expect(isGenericListingUrl('https://www.google.com/search?q=acme+careers')).toBe(true);
  });

  it('does not flag a URL carrying a job-specific query parameter', () => {
    expect(isGenericListingUrl('https://acme.com/careers?jobId=4821')).toBe(false);
  });

  it('does not flag a Workable job-detail URL', () => {
    expect(isGenericListingUrl('https://apply.workable.com/j/FRONTEND123')).toBe(false);
  });

  it('flags a Workable board-root URL (no specific job)', () => {
    expect(isGenericListingUrl('https://apply.workable.com/acme')).toBe(true);
  });

  it('does not flag a URL whose last path segment is a specific slug', () => {
    expect(isGenericListingUrl('https://acme.com/careers/senior-frontend-engineer')).toBe(false);
  });

  it('treats a malformed URL as generic rather than throwing', () => {
    expect(isGenericListingUrl('not a url')).toBe(true);
  });
});

describe('semanticIdentityKey', () => {
  it('is stable across whitespace and case differences', () => {
    const first = semanticIdentityKey('Acme Inc.', 'Senior Frontend Engineer', 'Remote');
    const second = semanticIdentityKey('  acme inc.  ', 'senior   frontend engineer', 'REMOTE');
    expect(first).toBe(second);
  });

  it('differs when the company differs, even with an identical title and location', () => {
    const first = semanticIdentityKey('Acme Inc.', 'Senior Frontend Engineer', 'Remote');
    const second = semanticIdentityKey('Globex Inc.', 'Senior Frontend Engineer', 'Remote');
    expect(first).not.toBe(second);
  });

  it('differs when the title differs, even slightly', () => {
    const first = semanticIdentityKey('Acme Inc.', 'Senior Frontend Engineer', 'Remote');
    const second = semanticIdentityKey('Acme Inc.', 'Frontend Engineer', 'Remote');
    expect(first).not.toBe(second);
  });
});

describe('vacancyIdentityFor', () => {
  const base = { company: 'Acme Inc.', title: 'Senior Frontend Engineer', location: 'Remote' };

  it('prefers a requisition identity when the URL resolves to one', () => {
    const identity = vacancyIdentityFor({ ...base, url: 'https://job-boards.greenhouse.io/acme/jobs/555000' });
    expect(identity).toEqual({
      kind: 'requisition',
      key: 'greenhouse:acme:555000',
      employerKey: 'greenhouse:acme',
      requisitionId: '555000',
    });
  });

  it('falls back to a canonical-URL identity for a specific-looking non-ATS URL', () => {
    const identity = vacancyIdentityFor({ ...base, url: 'https://acme.com/careers/senior-frontend-engineer' });
    expect(identity.kind).toBe('canonical_url');
    expect(identity.employerKey).toBeNull();
    expect(identity.requisitionId).toBeNull();
  });

  it('canonicalizes tracking parameters and hash fragments identically for the canonical-URL tier', () => {
    const a = vacancyIdentityFor({
      ...base,
      url: 'https://acme.com/careers/senior-frontend-engineer?utm_source=twitter#apply',
    });
    const b = vacancyIdentityFor({ ...base, url: 'https://acme.com/careers/senior-frontend-engineer' });
    expect(a.kind).toBe('canonical_url');
    expect(a.key).toBe(b.key);
  });

  it('falls back to a semantic identity for a generic careers-page URL', () => {
    const identity = vacancyIdentityFor({ ...base, url: 'https://acme.com/careers' });
    expect(identity.kind).toBe('semantic');
    expect(identity.key).toBe(semanticIdentityKey(base.company, base.title, base.location));
  });

  it('two different requisition IDs at the same employer never share an identity', () => {
    const first = vacancyIdentityFor({ ...base, url: 'https://job-boards.greenhouse.io/acme/jobs/1' });
    const second = vacancyIdentityFor({ ...base, url: 'https://job-boards.greenhouse.io/acme/jobs/2' });
    expect(first.key).not.toBe(second.key);
  });

  it('the same requisition ID at different employer tenants never shares an identity', () => {
    const first = vacancyIdentityFor({ ...base, url: 'https://job-boards.greenhouse.io/acme/jobs/1' });
    const second = vacancyIdentityFor({ ...base, url: 'https://job-boards.greenhouse.io/globex/jobs/1' });
    expect(first.key).not.toBe(second.key);
  });
});

describe('resolveApplyUrl', () => {
  it('marks a requisition identity as verified', () => {
    const identity = vacancyIdentityFor({
      url: 'https://job-boards.greenhouse.io/acme/jobs/555000',
      company: 'Acme',
      title: 'Senior Frontend Engineer',
      location: 'Remote',
    });
    const result = resolveApplyUrl(identity, 'https://job-boards.greenhouse.io/acme/jobs/555000');
    expect(result.status).toBe('verified');
    expect(result.url).toBe('https://job-boards.greenhouse.io/acme/jobs/555000');
    expect(result.reasons.join(' ')).toContain('greenhouse:acme');
  });

  it('never marks a generic careers page as verified', () => {
    const identity = vacancyIdentityFor({
      url: 'https://acme.com/careers',
      company: 'Acme',
      title: 'Senior Frontend Engineer',
      location: 'Remote',
    });
    const result = resolveApplyUrl(identity, 'https://acme.com/careers');
    expect(result.status).toBe('unresolved');
  });

  it('never marks an aggregator listing page as verified', () => {
    const identity = vacancyIdentityFor({
      url: 'https://himalayas.app/jobs',
      company: 'Acme',
      title: 'Senior Frontend Engineer',
      location: 'Remote',
    });
    const result = resolveApplyUrl(identity, 'https://himalayas.app/jobs');
    expect(result.status).toBe('unresolved');
  });

  it('never marks a search-result snippet as verified', () => {
    const identity = vacancyIdentityFor({
      url: 'https://www.google.com/search?q=acme+careers',
      company: 'Acme',
      title: 'Senior Frontend Engineer',
      location: 'Remote',
    });
    const result = resolveApplyUrl(identity, 'https://www.google.com/search?q=acme+careers');
    expect(result.status).toBe('unresolved');
  });

  it('still carries the url and a reason even when unresolved, never dropping the row', () => {
    const identity = vacancyIdentityFor({
      url: 'https://acme.com/careers',
      company: 'Acme',
      title: 'Senior Frontend Engineer',
      location: 'Remote',
    });
    const result = resolveApplyUrl(identity, 'https://acme.com/careers');
    expect(result.url).toBe('https://acme.com/careers');
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});
