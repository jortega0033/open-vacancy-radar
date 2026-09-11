// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  deriveApplicationIdentity,
  normalizeCanonicalUrlKey,
  normalizeEmployerName,
} from '../electron/workspace/application-identity.js';

/**
 * #275's requisition identity, tested on its own because it is pure string work and because the
 * repository tests should be about the dedup *rules*, not about URL parsing.
 *
 * Every employer, board and requisition id below is invented. Only the host shapes are real -- the
 * whole point of this module is reading identity out of a genuine ATS apply URL.
 */

describe('normalizeCanonicalUrlKey', () => {
  it('drops the scheme, a leading www., the fragment and a trailing slash', () => {
    const canonical = normalizeCanonicalUrlKey('https://careers.northwind.invalid/openings/platform-engineer');
    expect(normalizeCanonicalUrlKey('http://www.careers.northwind.invalid/openings/platform-engineer/#apply')).toBe(
      canonical,
    );
  });

  it('drops tracking parameters and keeps the ones that select a posting', () => {
    expect(
      normalizeCanonicalUrlKey('https://jobs.northwind.invalid/view?utm_source=digest&id=884&gh_src=x&ref=friend'),
    ).toBe('jobs.northwind.invalid/view?id=884');
  });

  it('sorts the surviving query so two orderings of the same request compare equal', () => {
    expect(normalizeCanonicalUrlKey('https://jobs.northwind.invalid/view?b=2&a=1')).toBe(
      normalizeCanonicalUrlKey('https://jobs.northwind.invalid/view?a=1&b=2'),
    );
  });

  it('leaves something that is not an http(s) URL alone rather than rewriting it', () => {
    expect(normalizeCanonicalUrlKey('  Internal Referral #4012  ')).toBe('internal referral #4012');
    expect(normalizeCanonicalUrlKey('')).toBe('');
  });
});

describe('normalizeEmployerName', () => {
  it('folds case, diacritics and punctuation', () => {
    expect(normalizeEmployerName('Nörthwind  Labs, Inc.')).toBe('northwind-labs-inc');
  });

  it('does NOT strip a legal form, which would merge distinct entities', () => {
    expect(normalizeEmployerName('Northwind Labs B.V.')).not.toBe(normalizeEmployerName('Northwind Labs'));
  });
});

describe('deriveApplicationIdentity', () => {
  const cases: { name: string; url: string; employerKey: string; requisitionId: string }[] = [
    {
      name: 'greenhouse',
      url: 'https://boards.greenhouse.io/northwindlabs/jobs/4012345',
      employerKey: 'greenhouse:northwindlabs',
      requisitionId: '4012345',
    },
    {
      name: 'greenhouse (embedded form)',
      url: 'https://boards.greenhouse.io/embed/job_app?for=northwindlabs&token=4012345',
      employerKey: 'greenhouse:northwindlabs',
      requisitionId: '4012345',
    },
    {
      name: 'lever',
      url: 'https://jobs.lever.co/northwind/8a1b2c3d-0000-4000-8000-000000000001',
      employerKey: 'lever:northwind',
      requisitionId: '8a1b2c3d-0000-4000-8000-000000000001',
    },
    {
      name: 'ashby',
      url: 'https://jobs.ashbyhq.com/northwind/22222222-0000-4000-8000-000000000002',
      employerKey: 'ashby:northwind',
      requisitionId: '22222222-0000-4000-8000-000000000002',
    },
    {
      name: 'rippling',
      url: 'https://ats.rippling.com/northwind/jobs/33333333-0000-4000-8000-000000000003',
      employerKey: 'rippling:northwind',
      requisitionId: '33333333-0000-4000-8000-000000000003',
    },
    {
      name: 'smartrecruiters',
      url: 'https://jobs.smartrecruiters.com/NorthwindLabs/744000000000001-platform-engineer',
      employerKey: 'smartrecruiters:northwindlabs',
      requisitionId: '744000000000001',
    },
    {
      name: 'workable',
      url: 'https://apply.workable.com/northwind/j/ABCDEF0123/',
      employerKey: 'workable:northwind',
      requisitionId: 'ABCDEF0123',
    },
    {
      name: 'recruitee',
      url: 'https://northwind.recruitee.com/o/platform-engineer',
      employerKey: 'recruitee:northwind',
      requisitionId: 'platform-engineer',
    },
    {
      name: 'personio',
      url: 'https://northwind.jobs.personio.de/job/1234567',
      employerKey: 'personio:northwind',
      requisitionId: '1234567',
    },
    {
      name: 'teamtailor',
      url: 'https://northwind.teamtailor.com/jobs/4455667-platform-engineer',
      employerKey: 'teamtailor:northwind',
      requisitionId: '4455667-platform-engineer',
    },
    {
      name: 'workday',
      url: 'https://northwind.wd3.myworkdayjobs.com/en-US/External/job/Amsterdam/Platform-Engineer_JR-0012345',
      employerKey: 'workday:northwind',
      requisitionId: 'JR-0012345',
    },
  ];

  for (const atsCase of cases) {
    it(`reads the employer and requisition out of a ${atsCase.name} apply URL`, () => {
      expect(deriveApplicationIdentity({ company: 'Whatever the source called them', canonicalUrl: atsCase.url })).toMatchObject({
        employerKey: atsCase.employerKey,
        requisitionId: atsCase.requisitionId,
      });
    });
  }

  it('ignores the company name entirely when the URL is a recognised ATS link', () => {
    const url = 'https://boards.greenhouse.io/northwindlabs/jobs/4012345';
    expect(deriveApplicationIdentity({ company: 'Northwind Labs', canonicalUrl: url })).toEqual(
      deriveApplicationIdentity({ company: 'NORTHWIND LABS B.V.', canonicalUrl: url }),
    );
  });

  it('keeps two openings at one employer distinct', () => {
    const one = deriveApplicationIdentity({ company: 'Northwind Labs', canonicalUrl: 'https://boards.greenhouse.io/northwindlabs/jobs/4012345' });
    const two = deriveApplicationIdentity({ company: 'Northwind Labs', canonicalUrl: 'https://boards.greenhouse.io/northwindlabs/jobs/4012999' });
    expect(one.employerKey).toBe(two.employerKey);
    expect(one.requisitionId).not.toBe(two.requisitionId);
  });

  it('invents nothing for a careers page it does not recognise', () => {
    expect(
      deriveApplicationIdentity({ company: 'Northwind Labs', canonicalUrl: 'https://careers.northwind.invalid/openings/platform-engineer' }),
    ).toEqual({
      employerKey: 'northwind-labs',
      requisitionId: null,
      canonicalUrlKey: 'careers.northwind.invalid/openings/platform-engineer',
    });
  });

  it('falls back to a caller-supplied requisition id, scoped to the company rather than an ATS board', () => {
    expect(deriveApplicationIdentity({ company: 'Northwind Labs', requisitionId: 'REQ-884' })).toEqual({
      employerKey: 'northwind-labs',
      requisitionId: 'REQ-884',
      canonicalUrlKey: '',
    });
  });

  it('prefers the URL over a caller-supplied requisition id, which cannot be checked against anything', () => {
    expect(
      deriveApplicationIdentity({
        company: 'Northwind Labs',
        canonicalUrl: 'https://boards.greenhouse.io/northwindlabs/jobs/4012345',
        requisitionId: 'REQ-884',
      }).requisitionId,
    ).toBe('4012345');
  });

  it('produces an empty, match-nothing identity for an attempt with no URL and no company', () => {
    expect(deriveApplicationIdentity({ company: '' })).toEqual({
      employerKey: '',
      requisitionId: null,
      canonicalUrlKey: '',
    });
  });
});
