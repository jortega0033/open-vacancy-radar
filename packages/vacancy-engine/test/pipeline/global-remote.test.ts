import { describe, expect, it } from 'vitest';

import type {
  DiscoveryProvider,
  DiscoveryVacancyAudit,
  GlobalRemoteReport,
} from '../../src/global-remote/models.js';
import { renderGlobalRemoteHtml } from '../../src/global-remote/report.js';
import { resolveRoleQuery, uniqueDiscovery } from '../../src/pipeline/global-remote.js';

function vacancy(
  provider: DiscoveryProvider,
  key: string,
  url: string,
  title: string,
): DiscoveryVacancyAudit {
  return {
    key,
    provider,
    company: 'Example Company',
    title,
    url,
    location: 'Worldwide',
    employmentType: null,
    currency: null,
    salaryPeriod: null,
    advertisedMinimum: null,
    annualizedMinimumUsd: null,
    decision: 'salary_unverified',
    reasons: ['Salary is not stated.'],
    contentHash: key.padEnd(64, '0').slice(0, 64),
    description: null,
    postedAt: null,
  };
}

describe('global remote discovery aggregation', () => {
  it('deduplicates canonical URLs and prefers the direct Workable record', () => {
    const url = 'https://apply.workable.com/j/FRONTEND123';
    const results = uniqueDiscovery([
      vacancy('arbeitnow', 'arbeitnow:duplicate', url, 'Aggregator title'),
      vacancy('workable_global', 'workable_global:FRONTEND123', `${url}#details`, 'Official title'),
      vacancy('jobicy', 'jobicy:unique', 'https://jobicy.com/jobs/unique', 'Other role'),
      vacancy('jobicy', 'jobicy:shared-1', 'https://example.com/careers', 'Shared URL one'),
      vacancy('jobicy', 'jobicy:shared-2', 'https://example.com/careers', 'Shared URL two'),
    ]);

    expect(results).toHaveLength(4);
    expect(results.find((result) => result.url.startsWith(url))).toMatchObject({
      provider: 'workable_global',
      title: 'Official title',
    });
  });

  it('renders discovery source health and safely exposes stale snapshot age', () => {
    const report = {
      runId: 'run-1',
      generatedAt: '2026-08-30T12:00:00.000Z',
      profileVersion: 'global-remote-profile-v1',
      criteria: {
        role: 'frontend',
        fullyRemote: true,
        applicantLocation: 'Netherlands',
        usCitizenshipRequired: false,
        minimumAnnualBaseUsd: 100_000,
        currency: 'USD',
      },
      statistics: {
        discoveryRequests: 0,
        discoveryListings: 1,
        discoveryUniqueListings: 1,
        discoveryOfficialReviewCandidates: 0,
        officialBoardsOrPagesAttempted: 0,
        officialRequests: 0,
        strictMatches: 0,
        manualReview: 0,
        nearMisses: 0,
        excludedOrInactive: 0,
        blockedOrErrored: 0,
        registrySources: 0,
        activeRegistrySources: 0,
        gatedRegistrySources: 0,
        manualOrProhibitedRegistrySources: 0,
      },
      sourceRegistry: [],
      discoverySources: [
        {
          id: 'workable_global:all-customers',
          provider: 'workable_global',
          url: 'https://www.workable.com/boards/workable.xml',
          requests: 0,
          listings: 1,
          status: 'partial',
          error: 'stale snapshot from 2026-08-30T10:00:00.000Z <unsafe>',
        },
      ],
      strictMatches: [],
      manualReview: [],
      nearMisses: [],
      excludedOrInactive: [],
      blockedOrErrored: [],
      officialAudit: [],
      discoveryAudit: [
        vacancy(
          'workable_global',
          'workable_global:FRONTEND123',
          'https://apply.workable.com/j/FRONTEND123',
          'Frontend Engineer',
        ),
      ],
      methodology: [],
      attribution: [],
    } satisfies GlobalRemoteReport;

    const html = renderGlobalRemoteHtml(report);
    expect(html).toContain('Discovery source health');
    expect(html).toContain('2026-08-30T10:00:00.000Z');
    expect(html).toContain('&lt;unsafe&gt;');
    expect(html).not.toContain('<unsafe>');
  });
});

describe('resolveRoleQuery', () => {
  it('uses the caller-supplied query, trimmed, when one is given', () => {
    expect(resolveRoleQuery('frontend', '  backend engineer  ')).toBe('backend engineer');
  });

  it('falls back to the static profile default when no override is given', () => {
    expect(resolveRoleQuery('frontend', undefined)).toBe('frontend');
  });

  it('falls back to the static default for a blank or whitespace-only override', () => {
    expect(resolveRoleQuery('frontend', '')).toBe('frontend');
    expect(resolveRoleQuery('frontend', '   ')).toBe('frontend');
  });

  it('caps an override at 200 characters, matching the profile schema limit', () => {
    const tooLong = 'x'.repeat(250);
    expect(resolveRoleQuery('frontend', tooLong)).toBe('x'.repeat(200));
  });
});
