import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { CandidateProfile } from '../../src/candidate/profile.js';
import { WIKIDATA_API_ENDPOINT } from '../../src/companies/wikidata-name-source.js';
import type {
  DiscoveryProvider,
  DiscoveryVacancyAudit,
  GlobalRemoteReport,
  ScanProgressEvent,
} from '../../src/global-remote/models.js';
import { renderGlobalRemoteHtml } from '../../src/global-remote/report.js';
import {
  createDatabaseClient,
  migrateDatabase,
  type Database,
  type DatabaseClient,
} from '../../src/db/client.js';
import { indSponsors } from '../../src/db/schema.js';
import {
  applyWorkEligibilityEvidence,
  applyWorldwideProfileScores,
  applyWorldwideSponsorMatches,
  planWorldwideSponsorMatches,
  resolveRoleQuery,
  trackProgressiveRows,
  uniqueDiscovery,
} from '../../src/pipeline/global-remote.js';
import { FixtureHttpClient } from '../ats/helpers.js';

/** Mirrors `fetchWikidataNameSearch`'s exact query, so a fixture route matches a real request. */
function wikidataSearchUrl(companyName: string): string {
  const url = new URL(WIKIDATA_API_ENDPOINT);
  url.searchParams.set('action', 'wbsearchentities');
  url.searchParams.set('search', companyName);
  url.searchParams.set('language', 'en');
  url.searchParams.set('type', 'item');
  url.searchParams.set('limit', '10');
  url.searchParams.set('format', 'json');
  return url.toString();
}

/** Mirrors `fetchWikidataEntityClaims`'s exact query. */
function wikidataClaimsUrl(itemId: string): string {
  const url = new URL(WIKIDATA_API_ENDPOINT);
  url.searchParams.set('action', 'wbgetentities');
  url.searchParams.set('ids', itemId);
  url.searchParams.set('props', 'claims');
  url.searchParams.set('format', 'json');
  return url.toString();
}

function vacancy(
  provider: DiscoveryProvider,
  key: string,
  url: string,
  title: string,
  overrides: Partial<DiscoveryVacancyAudit> = {},
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
    profileScore: null,
    worldwideSponsorMatch: null,
    ...overrides,
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
          networkAttempts: 0,
          retries: 0,
          complete: false,
          completenessReason: 'stale snapshot from 2026-08-30T10:00:00.000Z <unsafe>',
          continuationCursor: null,
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
    // issue #279: the report surfaces network attempts/retries and completeness separately from
    // the pre-existing status/requests columns.
    expect(html).toContain('Network attempts / coverage');
    expect(html).toContain('incomplete');
  });
});

describe('issue #279 acceptance: the summary distinguishes provisional progressive rows from confirmed coverage', () => {
  describe('trackProgressiveRows', () => {
    it('returns a no-op tracker (count stays 0, no wrapping) when no onProgress listener is given', () => {
      const tracker = trackProgressiveRows(undefined);

      expect(tracker.onProgress).toBeUndefined();
      expect(tracker.count()).toBe(0);
    });

    it('tallies every row across every progress event without altering what the listener receives', () => {
      const seen: ScanProgressEvent[] = [];
      const tracker = trackProgressiveRows((event) => seen.push(event));

      tracker.onProgress?.({
        sourceId: 'himalayas',
        vacancies: [
          vacancy('himalayas', 'himalayas:1', 'https://example.test/1', 'Frontend Engineer'),
          vacancy('himalayas', 'himalayas:2', 'https://example.test/2', 'Backend Engineer'),
        ],
      });
      tracker.onProgress?.({
        sourceId: 'jobicy',
        vacancies: [vacancy('jobicy', 'jobicy:1', 'https://example.test/3', 'Platform Engineer')],
      });

      expect(tracker.count()).toBe(3);
      expect(seen.map((event) => event.sourceId)).toEqual(['himalayas', 'jobicy']);
      expect(seen[0]?.vacancies).toHaveLength(2);
    });

    it('is purely additive: the same row shown provisionally more than once (e.g. re-emitted across a page walk) is tallied every time it was shown, not deduplicated by this counter', () => {
      const row = vacancy('himalayas', 'himalayas:1', 'https://example.test/1', 'Frontend Engineer');
      const tracker = trackProgressiveRows(() => undefined);

      tracker.onProgress?.({ sourceId: 'himalayas', vacancies: [row] });
      tracker.onProgress?.({ sourceId: 'himalayas', vacancies: [row] });

      // This counter answers "how many rows were shown provisionally", not "how many distinct
      // rows" -- that distinct, deduplicated count is `discoveryUniqueListings` below, computed
      // completely independently by `uniqueDiscovery` over the final merged result.
      expect(tracker.count()).toBe(2);
    });
  });

  describe('confirmed coverage never double-counts a row that was also shown provisionally', () => {
    it('uniqueDiscovery collapses a row to one confirmed listing no matter how many progress events mentioned its key', () => {
      const row = vacancy('himalayas', 'himalayas:1', 'https://example.test/1', 'Frontend Engineer');
      const progressiveRowTracker = trackProgressiveRows(() => undefined);

      // Simulates the same row being shown provisionally three times (three progress events, as a
      // page walk re-confirms it) before the final merged discovery list -- which contains that row
      // only once, since `runGlobalRemoteDiscovery` accumulates each source's own rows once, not
      // once per progress event fired for it.
      progressiveRowTracker.onProgress?.({ sourceId: 'himalayas', vacancies: [row] });
      progressiveRowTracker.onProgress?.({ sourceId: 'himalayas', vacancies: [row] });
      progressiveRowTracker.onProgress?.({ sourceId: 'himalayas', vacancies: [row] });
      const finalMergedDiscovery = [row];

      const confirmed = uniqueDiscovery(finalMergedDiscovery);

      expect(progressiveRowTracker.count()).toBe(3);
      expect(confirmed).toHaveLength(1);
      // The two counts measure different things and neither is derived from the other -- a high
      // provisional count from a slow, chatty source must never inflate the confirmed total.
      expect(confirmed.length).not.toBe(progressiveRowTracker.count());
    });
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

describe('applyWorldwideProfileScores', () => {
  const configuredProfile: CandidateProfile = {
    profileVersion: 'candidate-profile-v1',
    candidateName: 'Jake Ortega',
    currentRole: 'Senior Frontend Engineer',
    location: 'Netherlands',
    experienceYears: 10,
    strongestSkills: ['Angular', 'TypeScript'],
    additionalSkills: [],
    targetRoles: ['Senior Frontend Engineer'],
    consideredRoles: [],
    excludedRoleFamilies: [],
    constraints: {
      professionalLanguage: 'English',
      dutchRequired: false,
      primaryCountry: 'Netherlands',
      allowRemoteEuSupportingNetherlands: true,
      minimumMonthlyBaseEur: 6_000,
    },
  };
  // Mirrors the checked-in `config/candidate-profile-v1.json` default: no target roles, no
  // strongest skills configured.
  const unconfiguredProfile: CandidateProfile = {
    ...configuredProfile,
    targetRoles: [],
    strongestSkills: [],
  };

  it('leaves every profileScore null, never a real-looking zero, when the candidate profile is not configured', () => {
    const vacancies = [
      vacancy('himalayas', 'himalayas:1', 'https://example.test/1', 'Senior Frontend Engineer', {
        description: 'Build Angular and TypeScript web applications.',
      }),
    ];

    const scored = applyWorldwideProfileScores(vacancies, unconfiguredProfile, 100_000);

    expect(scored.map((item) => item.profileScore)).toEqual([null]);
  });

  it('computes a profile score per vacancy while leaving every other field untouched', () => {
    const vacancies = [
      vacancy('himalayas', 'himalayas:1', 'https://example.test/1', 'Senior Frontend Engineer', {
        description:
          'Responsibilities\nBuild and own Angular and TypeScript web applications.\nRequirements\nStrong Angular and TypeScript experience.',
        annualizedMinimumUsd: 150_000,
      }),
    ];

    const scored = applyWorldwideProfileScores(vacancies, configuredProfile, 100_000);

    expect(scored[0]!.profileScore).toEqual(expect.any(Number));
    expect(scored[0]!.profileScore).toBeGreaterThan(0);
    expect(scored[0]).toMatchObject({
      key: 'himalayas:1',
      title: 'Senior Frontend Engineer',
      annualizedMinimumUsd: 150_000,
    });
  });

  it('caps a scored vacancy below the below-threshold salary floor, mirroring scoreWorldwideVacancy directly', () => {
    const vacancies = [
      vacancy('himalayas', 'himalayas:1', 'https://example.test/1', 'Senior Frontend Engineer', {
        description: 'Build Angular and TypeScript web applications.',
        annualizedMinimumUsd: 40_000,
      }),
    ];

    const scored = applyWorldwideProfileScores(vacancies, configuredProfile, 100_000);

    expect(scored[0]!.profileScore).not.toBeNull();
    expect(scored[0]!.profileScore).toBeLessThanOrEqual(69);
  });
});

describe('applyWorldwideSponsorMatches', () => {
  it('leaves every row null and never touches the network or database for non-Netherlands locations', async () => {
    const http = new FixtureHttpClient(new Map());
    const vacancies = [
      vacancy('himalayas', 'himalayas:1', 'https://example.test/1', 'Frontend Engineer', {
        company: 'Acme Corp',
        location: 'Remote (United States)',
      }),
      vacancy('jobicy', 'jobicy:2', 'https://example.test/2', 'Backend Engineer', {
        company: 'Widgets Inc',
        location: 'Worldwide',
      }),
    ];

    // A poisoned database stand-in: every row here is gated out before any database read, so this
    // throwing on access would fail the test rather than silently passing on a false negative.
    const result = await applyWorldwideSponsorMatches(vacancies, http, undefined as unknown as Database);

    expect(result.vacancies.map((item) => item.worldwideSponsorMatch)).toEqual([null, null]);
    expect(http.requestedUrls).toEqual([]);
    expect(result.statistics).toMatchObject({
      eligibleRows: 0,
      eligibleCompanies: 0,
      lookedUpCompanies: 0,
      unverifiedCompanies: 0,
    });
    // Every other field stays untouched.
    expect(result.vacancies[0]).toMatchObject({ key: 'himalayas:1', company: 'Acme Corp' });
  });

  it('never fails the whole batch when a single Wikidata lookup throws, and still processes every other row', async () => {
    // No routes registered at all: the one Netherlands-located row's lookup throws immediately
    // (FixtureHttpClient's "Unexpected fixture URL" for any request), simulating a network/parse
    // failure a real Wikidata call could produce.
    const http = new FixtureHttpClient(new Map());
    const vacancies = [
      vacancy('himalayas', 'himalayas:1', 'https://example.test/1', 'Frontend Engineer', {
        company: 'Acme Corp',
        location: 'Amsterdam, Netherlands',
      }),
      vacancy('jobicy', 'jobicy:2', 'https://example.test/2', 'Backend Engineer', {
        company: 'Widgets Inc',
        location: 'Worldwide',
      }),
    ];

    const result = await applyWorldwideSponsorMatches(vacancies, http, undefined as unknown as Database);

    expect(result.vacancies.map((item) => item.worldwideSponsorMatch)).toEqual([null, null]);
    expect(result.vacancies[0]).toMatchObject({ key: 'himalayas:1', company: 'Acme Corp' });
    expect(result.vacancies[1]).toMatchObject({ key: 'jobicy:2', company: 'Widgets Inc' });
    // A thrown lookup is still a lookup that happened: it must not be reported as an employer the
    // budget never reached, which is a different (and recoverable-by-rescanning) claim.
    expect(result.statistics).toMatchObject({
      eligibleRows: 1,
      eligibleCompanies: 1,
      lookedUpCompanies: 1,
      matchedCompanies: 0,
      unverifiedCompanies: 0,
      budgetExhausted: false,
    });
  });

  /**
   * The regression this whole module was rewritten for (a real worldwide scan froze for 15+
   * minutes after discovery finished, with nothing ever persisted). Two independent bugs produced
   * it, and this block pins both: the pass walked every discovered row instead of every distinct
   * employer, and it had no bound at all on how long the whole thing could take.
   */
  it('resolves one lookup per distinct employer, not per row, and fans the answer out to every row', async () => {
    const searchUrl = wikidataSearchUrl('Acme Corp');
    let searches = 0;
    const http = new FixtureHttpClient(
      new Map([
        [
          searchUrl,
          (): string => {
            searches += 1;
            // No exact-name match: the resolver stops here, so no claims request follows and no
            // database read happens either.
            return JSON.stringify({ search: [{ id: 'Q1', label: 'Something Else' }] });
          },
        ],
      ]),
    );
    // The same employer under three spellings that differ only in case and whitespace, plus one
    // ineligible row that must never cost a request.
    const vacancies = [
      ...Array.from({ length: 40 }, (_unused, index) =>
        vacancy('himalayas', `himalayas:${index}`, `https://example.test/nl-${index}`, 'Frontend Engineer', {
          company: index % 3 === 0 ? 'Acme Corp' : index % 3 === 1 ? 'ACME  CORP' : 'acme corp ',
          location: 'Amsterdam, Netherlands',
        }),
      ),
      vacancy('jobicy', 'jobicy:us', 'https://example.test/us', 'Frontend Engineer', {
        company: 'Acme Corp',
        location: 'Remote (United States)',
      }),
    ];

    const result = await applyWorldwideSponsorMatches(vacancies, http, undefined as unknown as Database);

    expect(searches).toBe(1);
    expect(http.requestedUrls).toEqual([searchUrl]);
    expect(result.statistics).toMatchObject({
      eligibleRows: 40,
      eligibleCompanies: 1,
      lookedUpCompanies: 1,
      matchedCompanies: 0,
      unverifiedCompanies: 0,
    });
    expect(result.vacancies).toHaveLength(41);
  });

  it('completes in bounded time against a large row count and a Wikidata call that never resolves', async () => {
    // Never settles -- the worst case a per-request timeout alone does not cover, since the pass
    // as a whole is what has to stay bounded.
    const http = new FixtureHttpClient(
      new Map([
        [wikidataSearchUrl('Company 0'), (): Promise<string> => new Promise<string>(() => undefined)],
      ]),
    );
    const vacancies = Array.from({ length: 20_000 }, (_unused, index) =>
      vacancy('himalayas', `himalayas:${index}`, `https://example.test/${index}`, 'Frontend Engineer', {
        // 500 distinct employers across 20k rows, well past the per-scan cap.
        company: `Company ${index % 500}`,
        location: 'Rotterdam, Netherlands',
      }),
    );

    const started = Date.now();
    const result = await applyWorldwideSponsorMatches(
      vacancies,
      http,
      undefined as unknown as Database,
      undefined,
      { budgetMs: 250 },
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(5_000);
    // A usable partial result, not a failure: every row is still returned, carrying the same
    // honest "nothing to show" null an unmatched row carries.
    expect(result.vacancies).toHaveLength(20_000);
    expect(result.vacancies.every((item) => item.worldwideSponsorMatch === null)).toBe(true);
    expect(result.statistics.eligibleRows).toBe(20_000);
    expect(result.statistics.eligibleCompanies).toBe(500);
    expect(result.statistics.budgetExhausted).toBe(true);
    // And the shortfall is reported rather than silently swallowed.
    expect(result.statistics.unverifiedCompanies).toBeGreaterThan(0);
    expect(result.statistics.lookedUpCompanies + result.statistics.unverifiedCompanies).toBe(500);
  });

  it('stops the whole pass at the first employer that stalls, rather than stalling on each in turn', async () => {
    // Exactly what Wikidata's rate limit looks like from here: the first few employers answer
    // instantly, and then every further request sits on a `Retry-After` the HTTP client honours.
    // Carrying on would cost a minute per employer; the pass must stop instead.
    const answered = new Set<string>();
    const http = new FixtureHttpClient(
      new Map(
        Array.from({ length: 50 }, (_unused, index): [string, () => string | Promise<string>] => [
          wikidataSearchUrl(`Company ${index}`),
          () => {
            if (answered.size >= 3) return new Promise<string>(() => undefined);
            answered.add(`Company ${index}`);
            return JSON.stringify({ search: [] });
          },
        ]),
      ),
    );
    const vacancies = Array.from({ length: 50 }, (_unused, index) =>
      vacancy('himalayas', `himalayas:${index}`, `https://example.test/${index}`, 'Frontend Engineer', {
        company: `Company ${index}`,
        location: 'Amsterdam, Netherlands',
      }),
    );

    const started = Date.now();
    const result = await applyWorldwideSponsorMatches(
      vacancies,
      http,
      undefined as unknown as Database,
      undefined,
      { perCompanyTimeoutMs: 150, budgetMs: 30_000 },
    );
    const elapsed = Date.now() - started;

    // Bounded by one stalled employer, not by 47 of them: without the "stop the pass" rule this
    // would be 47 * 150ms even with a per-employer timeout, and minutes against the real upstream.
    expect(elapsed).toBeLessThan(2_000);
    expect(result.statistics.budgetExhausted).toBe(true);
    expect(result.statistics.eligibleCompanies).toBe(50);
    expect(result.statistics.unverifiedCompanies).toBeGreaterThan(40);
  });
});

/**
 * Coverage of a rate-limited upstream only works if it accumulates: a scan that stops early must
 * leave the next one strictly better off, or bounding the pass would simply mean the sponsor check
 * never resolves anything at all.
 */
describe('applyWorldwideSponsorMatches persisted lookups', () => {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'vacancy-engine-sponsor-cache-'));
  const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
  let client: DatabaseClient | undefined;

  function db(): Database {
    if (client === undefined) throw new Error('test database is not initialized');
    return client.db;
  }

  beforeAll(async () => {
    client = createDatabaseClient(path.join(temporaryDirectory, 'sponsor-cache.db'));
    await migrateDatabase(client.db, migrationsFolder);
  }, 30_000);

  beforeEach(() => {
    client?.connection.exec('delete from "worldwide_sponsor_lookups"; delete from "ind_sponsors";');
  });

  afterAll(() => {
    client?.close();
    client = undefined;
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  function nlVacancies(companies: readonly string[]): DiscoveryVacancyAudit[] {
    return companies.map((company, index) =>
      vacancy('himalayas', `himalayas:${index}`, `https://example.test/${index}`, 'Frontend Engineer', {
        company,
        location: 'Amsterdam, Netherlands',
      }),
    );
  }

  /** Answers `count` employers and then stalls, the way the real rate limit does. */
  function rateLimitedClient(companies: readonly string[], count: number): FixtureHttpClient {
    let answered = 0;
    return new FixtureHttpClient(
      new Map(
        companies.map((company): [string, () => string | Promise<string>] => [
          wikidataSearchUrl(company),
          () => {
            if (answered >= count) return new Promise<string>(() => undefined);
            answered += 1;
            return JSON.stringify({ search: [] });
          },
        ]),
      ),
    );
  }

  it('asks Wikidata only about employers no earlier scan resolved, so coverage accumulates', async () => {
    const companies = ['Alpha BV', 'Beta BV', 'Gamma BV', 'Delta BV'];
    const vacancies = nlVacancies(companies);

    const first = await applyWorldwideSponsorMatches(
      vacancies,
      rateLimitedClient(companies, 2),
      db(),
      undefined,
      { perCompanyTimeoutMs: 150 },
    );
    expect(first.statistics.cachedCompanies).toBe(0);
    expect(first.statistics.lookedUpCompanies).toBe(2);
    expect(first.statistics.unverifiedCompanies).toBe(2);
    expect(first.statistics.budgetExhausted).toBe(true);

    // A second scan over the same rows: the two already-resolved employers cost nothing, and the
    // whole budget goes to the two that are still unknown.
    const secondHttp = rateLimitedClient(companies, 2);
    const second = await applyWorldwideSponsorMatches(vacancies, secondHttp, db(), undefined, {
      perCompanyTimeoutMs: 150,
    });

    expect(second.statistics.cachedCompanies).toBe(2);
    expect(second.statistics.lookedUpCompanies).toBe(2);
    expect(second.statistics.unverifiedCompanies).toBe(0);
    expect(second.statistics.budgetExhausted).toBe(false);
    // Only the two previously unresolved names were requested this time.
    expect(secondHttp.requestedUrls).toHaveLength(2);

    // And a third scan needs no Wikidata at all.
    const thirdHttp = new FixtureHttpClient(new Map());
    const third = await applyWorldwideSponsorMatches(vacancies, thirdHttp, db(), undefined, {
      perCompanyTimeoutMs: 150,
    });
    expect(thirdHttp.requestedUrls).toEqual([]);
    expect(third.statistics.cachedCompanies).toBe(4);
    expect(third.statistics.unverifiedCompanies).toBe(0);
  });

  it('re-reads the IND register on every scan, so a cached Wikidata answer never freezes sponsorship', async () => {
    const company = 'Acme BV';
    const vacancies = nlVacancies([company]);
    const http = new FixtureHttpClient(
      new Map([
        [
          wikidataSearchUrl(company),
          JSON.stringify({
            search: [{ id: 'Q42', label: company, match: { type: 'label', text: company } }],
          }),
        ],
        [
          wikidataClaimsUrl('Q42'),
          JSON.stringify({
            entities: {
              Q42: {
                claims: {
                  P3220: [
                    { mainsnak: { snaktype: 'value', datavalue: { value: '12345678' } }, rank: 'normal' },
                  ],
                  P856: [
                    {
                      mainsnak: { snaktype: 'value', datavalue: { value: 'https://acme.test/' } },
                      rank: 'normal',
                    },
                  ],
                },
              },
            },
          }),
        ],
      ]),
    );

    // Scan one: the KVK resolves, but the register does not list it, so there is no match.
    const first = await applyWorldwideSponsorMatches(vacancies, http, db());
    expect(first.statistics.matchedCompanies).toBe(0);
    expect(first.vacancies[0]!.worldwideSponsorMatch).toBeNull();

    // The register is re-synced between scans and now recognises that KVK.
    await db()
      .insert(indSponsors)
      .values({
        sourceIdentityKey: 'test:12345678',
        legalName: 'Acme B.V.',
        normalizedName: 'acme b.v.',
        searchName: 'acme b.v.',
        kvkNumber: '12345678',
        sourceUrl: 'https://ind.example.test/register',
        sourceRetrievedAt: new Date('2026-01-01T00:00:00.000Z'),
        active: true,
      });

    // Scan two answers the Wikidata half from cache but still picks the new recognition up.
    const cachedHttp = new FixtureHttpClient(new Map());
    const second = await applyWorldwideSponsorMatches(vacancies, cachedHttp, db());

    expect(cachedHttp.requestedUrls).toEqual([]);
    expect(second.statistics.cachedCompanies).toBe(1);
    expect(second.statistics.matchedCompanies).toBe(1);
    expect(second.vacancies[0]!.worldwideSponsorMatch).toEqual({
      legalName: 'Acme B.V.',
      kvkNumber: '12345678',
    });
  });
});

describe('planWorldwideSponsorMatches', () => {
  function nlVacancy(index: number, company: string): DiscoveryVacancyAudit {
    return vacancy('himalayas', `himalayas:${index}`, `https://example.test/${index}`, 'Frontend Engineer', {
      company,
      location: 'Utrecht, Netherlands',
    });
  }

  it('plans every eligible employer, leaving the per-scan cap to the network pass', () => {
    const plan = planWorldwideSponsorMatches(
      Array.from({ length: 5_000 }, (_unused, index) => nlVacancy(index, `Company ${index}`)),
    );

    expect(plan.eligibleRows).toBe(5_000);
    expect(plan.eligibleCompanies).toBe(5_000);
    // Not truncated here: an employer an earlier scan already resolved is free to answer, and a
    // capped plan would have thrown those answers away to stay under a budget they never touch.
    expect(plan.targets).toHaveLength(5_000);
  });

  it('orders employers by how many rows they cover, deterministically', () => {
    const plan = planWorldwideSponsorMatches([
      nlVacancy(0, 'Zeta'),
      nlVacancy(1, 'Alpha'),
      nlVacancy(2, 'Alpha'),
      nlVacancy(3, 'Beta'),
    ]);

    expect(plan.targets.map((target) => target.companyName)).toEqual(['Alpha', 'Beta', 'Zeta']);
    expect(plan.targets[0]!.rowIndexes).toEqual([1, 2]);
    expect(plan.eligibleCompanies).toBe(3);
  });

  it('caps only what a single scan fetches, and reports the rest as not yet checked', async () => {
    const companies = ['Alpha', 'Beta', 'Gamma'];
    const http = new FixtureHttpClient(
      new Map(
        companies.map((company): [string, string] => [
          wikidataSearchUrl(company),
          JSON.stringify({ search: [] }),
        ]),
      ),
    );

    const result = await applyWorldwideSponsorMatches(
      companies.map((company, index) => nlVacancy(index, company)),
      http,
      undefined as unknown as Database,
      undefined,
      { maxCompanies: 2 },
    );

    expect(http.requestedUrls).toHaveLength(2);
    expect(result.statistics).toMatchObject({
      eligibleCompanies: 3,
      lookedUpCompanies: 2,
      unverifiedCompanies: 1,
      budgetExhausted: false,
    });
  });

  it('ignores every row whose location is not the Netherlands', () => {
    const plan = planWorldwideSponsorMatches([
      nlVacancy(0, 'Alpha'),
      vacancy('jobicy', 'jobicy:1', 'https://example.test/a', 'Frontend Engineer', {
        company: 'Alpha',
        location: 'Worldwide',
      }),
      vacancy('jobicy', 'jobicy:2', 'https://example.test/b', 'Frontend Engineer', {
        company: 'Beta',
        location: 'Berlin, Germany',
      }),
    ]);

    expect(plan.eligibleRows).toBe(1);
    expect(plan.targets.map((target) => target.rowIndexes)).toEqual([[0]]);
  });
});

/**
 * Issue #280. This is where the mandatory-language gate becomes pipeline-wide rather than
 * per-source: discovery sources build their rows through `discoveryAudit`, which has no access to
 * the candidate profile, so this one post-discovery pass applies the same gate to every source's
 * rows at once and attaches the evidence record that explains each row's eligibility.
 */
describe('applyWorkEligibilityEvidence', () => {
  const NOW = new Date('2026-09-11T12:00:00.000Z');

  function emptyReport(): GlobalRemoteReport {
    return {
      runId: 'run-1',
      generatedAt: '2026-09-11T12:00:00.000Z',
      profileVersion: 'global-remote-profile-v1',
      criteria: {
        role: 'frontend',
        fullyRemote: true,
        applicantLocation: 'Worldwide',
        usCitizenshipRequired: false,
        minimumAnnualBaseUsd: 100_000,
        currency: 'USD',
      },
      statistics: {
        discoveryRequests: 0,
        discoveryListings: 1,
        discoveryUniqueListings: 1,
        discoveryOfficialReviewCandidates: 1,
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
      discoverySources: [],
      strictMatches: [],
      manualReview: [],
      nearMisses: [],
      excludedOrInactive: [],
      blockedOrErrored: [],
      officialAudit: [],
      discoveryAudit: [],
      methodology: [],
      attribution: [],
    };
  }

  const profile: CandidateProfile = {
    profileVersion: 'candidate-profile-v1',
    candidateName: 'Test Candidate',
    currentRole: 'Senior Frontend Engineer',
    location: 'Netherlands',
    experienceYears: 10,
    strongestSkills: ['Angular'],
    additionalSkills: [],
    targetRoles: ['Senior Frontend Engineer'],
    consideredRoles: [],
    excludedRoleFamilies: [],
    constraints: {
      professionalLanguage: 'English',
      dutchRequired: false,
      primaryCountry: 'Netherlands',
      allowRemoteEuSupportingNetherlands: true,
      minimumMonthlyBaseEur: 6_000,
      relocationWilling: true,
    },
  };

  const US_ONLY_REMOTE = `This is a fully remote role on a distributed team.
    Compensation
    The base salary range is benchmarked to the United States market.
    Eligibility
    You must be legally authorized to work in the United States.`;

  it('attaches an evidence record to every row, whatever source produced it', () => {
    const assessed = applyWorkEligibilityEvidence(
      [
        vacancy('himalayas', 'himalayas:1', 'https://example.test/1', 'Frontend Engineer'),
        vacancy('jobicy', 'jobicy:1', 'https://example.test/2', 'Frontend Engineer'),
        vacancy('remotive', 'remotive:1', 'https://example.test/3', 'Frontend Engineer'),
      ],
      profile,
      NOW,
    );

    expect(assessed).toHaveLength(3);
    for (const row of assessed) {
      expect(row.eligibility).not.toBeNull();
      expect(row.eligibility!.visaSponsorship.answer).toBe('unknown');
      expect(row.eligibility!.employerOfRecord.answer).toBe('unknown');
    }
  });

  it('does not mark a US-only remote vacancy eligible for the configured Netherlands candidate', () => {
    const assessed = applyWorkEligibilityEvidence(
      [
        vacancy('remotive', 'remotive:1', 'https://example.test/1', 'Frontend Engineer', {
          location: 'Remote (Anywhere)',
          description: US_ONLY_REMOTE,
        }),
      ],
      profile,
      NOW,
    );

    expect(assessed[0]!.eligibility!.candidateWorkCountry.answer).toBe('no');
    expect(assessed[0]!.eligibility!.salaryGeography.assumptionApplied).toBe(true);
  });

  it('applies the mandatory-language gate to a still-in-play row from any source', () => {
    const assessed = applyWorkEligibilityEvidence(
      [
        vacancy('himalayas', 'himalayas:1', 'https://example.test/1', 'Frontend Engineer', {
          decision: 'official_review_candidate',
          description: 'Requirements\nFluency in German is required for this role.',
        }),
        vacancy('ats_roster_lever', 'lever:1', 'https://example.test/2', 'Frontend Engineer', {
          decision: 'salary_unverified',
          description: 'Requirements\nFluency in German is required for this role.',
        }),
      ],
      profile,
      NOW,
    );

    expect(assessed.map((row) => row.decision)).toEqual(['language_mismatch', 'language_mismatch']);
    expect(assessed[0]!.reasons.join(' ')).toContain('German');
    expect(assessed[0]!.eligibility!.mandatoryLanguage.answer).toBe('no');
  });

  it('never overwrites a row that was already excluded for a different reason', () => {
    const assessed = applyWorkEligibilityEvidence(
      [
        vacancy('himalayas', 'himalayas:1', 'https://example.test/1', 'Backend Engineer', {
          decision: 'role_mismatch',
          reasons: ['Title is not explicitly frontend-only.'],
          description: 'Requirements\nFluency in German is required for this role.',
        }),
      ],
      profile,
      NOW,
    );

    expect(assessed[0]!.decision).toBe('role_mismatch');
    expect(assessed[0]!.reasons).toEqual(['Title is not explicitly frontend-only.']);
  });

  it('reports an IND sponsor match as employer evidence, never as a sponsorship promise', () => {
    const assessed = applyWorkEligibilityEvidence(
      [
        vacancy('jobicy', 'jobicy:1', 'https://example.test/1', 'Frontend Engineer', {
          location: 'Amsterdam, Netherlands',
          description: 'Build our customer portal with a small, senior team.',
          worldwideSponsorMatch: { legalName: 'Example Technologies B.V.', kvkNumber: '01234567' },
        }),
      ],
      profile,
      NOW,
    );

    const sponsorship = assessed[0]!.eligibility!.visaSponsorship;
    expect(sponsorship.answer).toBe('unknown');
    expect(sponsorship.scope).toBe('employer');
    expect(sponsorship.detail).toContain('Example Technologies B.V.');
    expect(sponsorship.detail).toContain('not a commitment to sponsor');
  });

  it('keeps candidate relocation willingness separate from the employer relocation offer', () => {
    const assessed = applyWorkEligibilityEvidence(
      [
        vacancy('jobicy', 'jobicy:1', 'https://example.test/1', 'Frontend Engineer', {
          description: 'We do not offer relocation assistance for this role.',
        }),
      ],
      profile,
      NOW,
    );

    expect(assessed[0]!.eligibility!.candidateRelocationWillingness.answer).toBe('yes');
    expect(assessed[0]!.eligibility!.employerRelocationSupport.answer).toBe('no');
  });

  it('renders every answer, its scope and the salary-geography caption into the report HTML', () => {
    const assessed = applyWorkEligibilityEvidence(
      [
        vacancy('remotive', 'remotive:1', 'https://example.test/1', 'Frontend Engineer', {
          decision: 'official_review_candidate',
          location: 'Remote (Anywhere)',
          description: US_ONLY_REMOTE,
          currency: 'USD',
          salaryPeriod: 'year',
          advertisedMinimum: 150_000,
        }),
      ],
      profile,
      NOW,
    );

    const html = renderGlobalRemoteHtml({
      ...emptyReport(),
      discoveryAudit: assessed,
    });

    expect(html).toContain('Eligibility evidence');
    expect(html).toContain('Employer of Record');
    expect(html).toContain('Candidate relocation willingness');
    expect(html).toContain('Employer relocation support');
    // The geographic salary assumption is printed, not folded into the salary column.
    expect(html).toMatch(/Reading it as Netherlands market pay assumes United States rates/u);
  });

  it('renders an honest "not assessed" for a report written before this record existed', () => {
    const html = renderGlobalRemoteHtml({
      ...emptyReport(),
      discoveryAudit: [
        vacancy('remotive', 'remotive:1', 'https://example.test/1', 'Frontend Engineer', {
          decision: 'official_review_candidate',
        }),
      ],
    });

    expect(html).toContain('Not assessed in this report.');
  });

  it('leaves every answer unknown and gates nothing for an unconfigured profile', () => {
    const unconfigured: CandidateProfile = {
      ...profile,
      constraints: {
        professionalLanguage: '',
        dutchRequired: false,
        primaryCountry: '',
        allowRemoteEuSupportingNetherlands: false,
        minimumMonthlyBaseEur: 0,
      },
    };

    const assessed = applyWorkEligibilityEvidence(
      [
        vacancy('himalayas', 'himalayas:1', 'https://example.test/1', 'Frontend Engineer', {
          decision: 'official_review_candidate',
          location: 'Remote (Anywhere)',
          description: `${US_ONLY_REMOTE}\nRequirements\nFluency in German is required.`,
        }),
      ],
      unconfigured,
      NOW,
    );

    const eligibility = assessed[0]!.eligibility!;
    expect(assessed[0]!.decision).toBe('official_review_candidate');
    expect(eligibility.candidateWorkCountry.answer).toBe('unknown');
    expect(eligibility.mandatoryLanguage.answer).toBe('unknown');
    expect(eligibility.candidateRelocationWillingness.answer).toBe('unknown');
  });
});
