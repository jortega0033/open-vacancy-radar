import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Logger } from 'pino';

import type { AtsHttpClient } from '../ats/http.js';
import { loadCandidateProfile, type CandidateProfile } from '../candidate/profile.js';
import { resolveWorldwideSponsorMatch } from '../companies/worldwide-sponsor-match.js';
import type { AppConfig } from '../config.js';
import type { Database } from '../db/client.js';
import { runGlobalRemoteDiscovery } from '../global-remote/discovery.js';
import { evaluateOfficialReview } from '../global-remote/evaluation.js';
import {
  globalRemoteConfigSchema,
  type DiscoveryVacancyAudit,
  type DiscoverySourceAudit,
  type GlobalRemoteConfig,
  type GlobalRemoteDecision,
  type GlobalRemoteReport,
  type OfficialVacancyAudit,
} from '../global-remote/models.js';
import { runOfficialGlobalRemoteSources } from '../global-remote/official.js';
import { scoreWorldwideVacancy } from '../filtering/index.js';
import { globalRemoteSourceRegistry } from '../global-remote/source-registry.js';
import {
  runWorkableGlobalDiscovery,
  WORKABLE_GLOBAL_MAX_RESPONSE_BYTES,
  WORKABLE_GLOBAL_TIMEOUT_MS,
} from '../global-remote/workable-global-discovery.js';
import { writeGlobalRemoteReport, type GlobalRemoteReportFiles } from '../global-remote/report.js';
import { createDatabaseBackedHttpClients } from './ats-http-client.js';

const MANUAL_DECISIONS = new Set<GlobalRemoteDecision>([
  'salary_confirmation',
  'location_confirmation',
  'remote_confirmation',
  'company_confirmation',
  'salary_unknown',
  'changed_since_review',
]);
const EXCLUDED_DECISIONS = new Set<GlobalRemoteDecision>([
  'excluded_location',
  'excluded_not_remote',
  'excluded_not_us_market',
  'excluded_role',
  'inactive',
]);

async function loadGlobalRemoteConfig(projectRoot: string): Promise<GlobalRemoteConfig> {
  const file = path.resolve(projectRoot, 'config', 'global-remote-profile-v1.json');
  const relative = path.relative(projectRoot, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Global remote profile must remain inside the project root');
  }
  return globalRemoteConfigSchema.parse(JSON.parse(await readFile(file, 'utf8')) as unknown);
}

function canonicalWorkableUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.origin !== 'https://apply.workable.com' ||
      url.search.length > 0 ||
      !/^\/j\/[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(url.pathname)
    ) {
      return null;
    }
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

export function uniqueDiscovery(vacancies: DiscoveryVacancyAudit[]): DiscoveryVacancyAudit[] {
  const directWorkableUrls = new Set(
    vacancies
      .filter((vacancy) => vacancy.provider === 'workable_global')
      .map((vacancy) => canonicalWorkableUrl(vacancy.url))
      .filter((url): url is string => url !== null),
  );
  const prioritized = vacancies
    .map((vacancy, index) => ({ vacancy, index }))
    .sort((left, right) => {
      const leftPriority = left.vacancy.provider === 'workable_global' ? 0 : 1;
      const rightPriority = right.vacancy.provider === 'workable_global' ? 0 : 1;
      return leftPriority - rightPriority || left.index - right.index;
    });
  const keys = new Set<string>();
  const retainedWorkableUrls = new Set<string>();
  const unique: DiscoveryVacancyAudit[] = [];
  for (const { vacancy } of prioritized) {
    const workableUrl = canonicalWorkableUrl(vacancy.url);
    if (
      keys.has(vacancy.key) ||
      (workableUrl !== null &&
        ((vacancy.provider !== 'workable_global' && directWorkableUrls.has(workableUrl)) ||
          retainedWorkableUrls.has(workableUrl)))
    ) {
      continue;
    }
    keys.add(vacancy.key);
    if (vacancy.provider === 'workable_global' && workableUrl !== null) {
      retainedWorkableUrls.add(workableUrl);
    }
    unique.push(vacancy);
  }
  return unique.sort(
    (left, right) =>
      left.company.localeCompare(right.company) || left.title.localeCompare(right.title),
  );
}

function candidateProfilePathFor(projectRoot: string): string {
  return path.join(projectRoot, 'config', 'candidate-profile-v1.json');
}

/**
 * Computed once here, after discovery, rather than threaded through each of the ~30
 * `discoveryAudit()` call sites in global-remote/*.ts: unlike `description`/`postedAt`, which are
 * per-source raw metadata, a profile score needs the candidate profile and the pipeline's own
 * salary floor -- neither of which any individual discovery source has, or should have, access to.
 * This mirrors how the Netherlands pipeline only scores after `runVacancyScan` has already produced
 * its vacancy list (see the `deterministic_scoring` stage in `runUnlockedEndToEndScan`, full-scan.ts).
 */
export function applyWorldwideProfileScores(
  vacancies: readonly DiscoveryVacancyAudit[],
  profile: CandidateProfile,
  minimumAnnualBaseUsd: number | null,
): DiscoveryVacancyAudit[] {
  return vacancies.map((vacancy) => ({
    ...vacancy,
    profileScore:
      scoreWorldwideVacancy(vacancy, profile, minimumAnnualBaseUsd)?.deterministicScore ?? null,
  }));
}

/** Rows processed at once by `applyWorldwideSponsorMatches`. `resolveWorldwideSponsorMatch` already
 * returns immediately (no network call) for every non-Netherlands-located row, so this only bounds
 * how many *actual* Wikidata lookups run concurrently -- a courtesy to a public API this feature
 * reuses, not one built for this volume of traffic. */
const WORLDWIDE_SPONSOR_MATCH_CONCURRENCY = 4;

/**
 * Computed once here, after discovery, mirroring `applyWorldwideProfileScores` immediately above --
 * but async and network/database-backed, since resolving a match needs a Wikidata name search and
 * an `indSponsors` read (see `worldwide-sponsor-match.ts`), neither of which belongs inside any
 * individual `discoveryAudit()` call site in global-remote/*.ts.
 */
export async function applyWorldwideSponsorMatches(
  vacancies: readonly DiscoveryVacancyAudit[],
  http: AtsHttpClient,
  database: Database,
  logger?: Pick<Logger, 'debug'>,
): Promise<DiscoveryVacancyAudit[]> {
  const results = [...vacancies];
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= results.length) return;
      const vacancy = results[index]!;
      // A failed or malformed Wikidata call for one company must never fail the whole worldwide
      // scan over a best-effort enrichment -- every other discovery source in this package already
      // catches its own network/parse errors (see `sourceFailure` throughout global-remote/*.ts)
      // rather than letting them propagate. A lookup failure is indistinguishable here from "found
      // nothing" for the same reason `resolveWorldwideSponsorMatch`'s own doc comment gives: neither
      // has a meaningful claim beyond "nothing to show". Logged, not silently discarded, though --
      // a genuine coding bug must not become permanently indistinguishable from a network hiccup.
      let worldwideSponsorMatch: DiscoveryVacancyAudit['worldwideSponsorMatch'] = null;
      try {
        worldwideSponsorMatch = await resolveWorldwideSponsorMatch({
          http,
          database,
          companyName: vacancy.company,
          location: vacancy.location,
        });
      } catch (error) {
        logger?.debug({ error, company: vacancy.company }, 'worldwide sponsor match lookup failed');
      }
      results[index] = { ...vacancy, worldwideSponsorMatch };
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(WORLDWIDE_SPONSOR_MATCH_CONCURRENCY, results.length) }, worker),
  );
  return results;
}

function groupOfficial(
  audits: OfficialVacancyAudit[],
): Pick<
  GlobalRemoteReport,
  'strictMatches' | 'manualReview' | 'nearMisses' | 'excludedOrInactive' | 'blockedOrErrored'
> {
  return {
    strictMatches: audits.filter((item) => item.decision === 'strict_match'),
    manualReview: audits.filter((item) => MANUAL_DECISIONS.has(item.decision)),
    nearMisses: audits.filter((item) => item.decision === 'salary_below_threshold'),
    excludedOrInactive: audits.filter((item) => EXCLUDED_DECISIONS.has(item.decision)),
    blockedOrErrored: audits.filter((item) => ['blocked', 'error'].includes(item.decision)),
  };
}

export type GlobalRemoteScanResult = {
  report: GlobalRemoteReport;
  files: GlobalRemoteReportFiles;
};

export type GlobalRemoteScanOptions = {
  officialOnly?: boolean;
  offlineReclassify?: boolean;
  /**
   * Overrides the checked-in profile's static `discovery.roleQuery` for this run only, so the
   * role/keyword a caller actually searched for scopes each source's own server-side search
   * parameter (see the `config.discovery.roleQuery` reads across global-remote/*.ts) instead of
   * always fetching the same static default and filtering everything client-side afterward.
   * Ignored when empty/whitespace-only, which keeps the static default.
   */
  query?: string;
};

async function loadPreviousDiscovery(projectRoot: string): Promise<{
  sources: DiscoverySourceAudit[];
  vacancies: DiscoveryVacancyAudit[];
}> {
  const file = path.resolve(projectRoot, 'reports', 'global-remote', 'latest.json');
  const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<GlobalRemoteReport>;
  if (!Array.isArray(parsed.discoverySources) || !Array.isArray(parsed.discoveryAudit)) {
    throw new Error('Previous global remote report does not contain reusable discovery audit data');
  }
  return {
    sources: parsed.discoverySources.map((source) => ({ ...source, requests: 0 })),
    vacancies: parsed.discoveryAudit,
  };
}

async function loadPreviousOfficial(
  projectRoot: string,
  profile: GlobalRemoteConfig,
): Promise<{ audits: OfficialVacancyAudit[]; requestCount: number }> {
  const file = path.resolve(projectRoot, 'reports', 'global-remote', 'latest.json');
  const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<GlobalRemoteReport>;
  if (!Array.isArray(parsed.officialAudit)) {
    throw new Error('Previous global remote report does not contain reusable official audit data');
  }
  const previous = new Map(parsed.officialAudit.map((audit) => [audit.id, audit]));
  const audits = profile.officialSources.map((source): OfficialVacancyAudit => {
    const prior = previous.get(source.id);
    if (prior === undefined) {
      return {
        id: source.id,
        company: source.company,
        title: source.expectedTitle,
        url: source.url,
        provider: source.provider,
        state: 'error',
        decision: 'error',
        reasons: ['Source has no prior official audit and requires a network verification run.'],
        evidence: source.review.notes,
        minimumAnnualBaseUsd: source.review.minimumAnnualBaseUsd,
        contentHash: null,
        reviewedContentHash: source.reviewedContentHash,
        reviewedAt: source.reviewedAt,
        requestCount: 0,
        httpStatus: null,
      };
    }
    const evaluation = evaluateOfficialReview({
      source,
      state: prior.state,
      currentTitle: prior.title,
      contentHash: prior.contentHash,
      minimumAnnualBaseUsd: profile.minimumAnnualBaseUsd,
    });
    return {
      ...prior,
      company: source.company,
      provider: source.provider,
      decision: evaluation.decision,
      reasons: evaluation.reasons,
      minimumAnnualBaseUsd: source.review.minimumAnnualBaseUsd,
      reviewedContentHash: source.reviewedContentHash,
      reviewedAt: source.reviewedAt,
      requestCount: 0,
    };
  });
  return { audits, requestCount: 0 };
}

/**
 * A blank/whitespace-only override keeps the checked-in profile's static default rather than
 * clearing it, and `globalRemoteConfigSchema.discovery.roleQuery` caps at 200 characters, so an
 * override longer than that would otherwise pass validation on load but violate it on this path.
 */
export function resolveRoleQuery(staticRoleQuery: string, queryOverride: string | undefined): string {
  const trimmed = queryOverride?.trim();
  return trimmed ? trimmed.slice(0, 200) : staticRoleQuery;
}

export async function runGlobalRemoteScan(
  database: Database,
  appConfig: AppConfig,
  logger: Logger,
  projectRoot = process.cwd(),
  options: GlobalRemoteScanOptions = {},
): Promise<GlobalRemoteScanResult> {
  const loadedProfile = await loadGlobalRemoteConfig(projectRoot);
  // Keyed-discovery credentials always come from process env, never the checked-in profile
  // JSON, so a secret can never land in git even if someone sets these fields in the file.
  const profile: GlobalRemoteConfig = {
    ...loadedProfile,
    discovery: {
      ...loadedProfile.discovery,
      roleQuery: resolveRoleQuery(loadedProfile.discovery.roleQuery, options.query),
      adzunaAppId: appConfig.keyedDiscovery.adzunaAppId,
      adzunaAppKey: appConfig.keyedDiscovery.adzunaAppKey,
      joobleApiKey: appConfig.keyedDiscovery.joobleApiKey,
      reedApiKey: appConfig.keyedDiscovery.reedApiKey,
      jobspipeApiKey: appConfig.keyedDiscovery.jobspipeApiKey,
    },
  };
  const { safeClient, atsClient: http } = createDatabaseBackedHttpClients(appConfig, database, {
    maxStreamTimeoutMs: WORKABLE_GLOBAL_TIMEOUT_MS,
    maxStreamResponseBytes: WORKABLE_GLOBAL_MAX_RESPONSE_BYTES,
    onNetworkRequest(url) {
      logger.debug({ url }, 'Global remote scan HTTP request');
    },
    onCacheError(error, operation, url) {
      logger.warn({ error, operation, url }, 'Global remote scan cache operation failed');
    },
  });
  const reuseDiscovery = options.officialOnly === true || options.offlineReclassify === true;
  const [baseDiscovery, official] = await Promise.all([
    reuseDiscovery ? loadPreviousDiscovery(projectRoot) : runGlobalRemoteDiscovery(http, profile),
    options.offlineReclassify
      ? loadPreviousOfficial(projectRoot, profile)
      : runOfficialGlobalRemoteSources(http, profile),
  ]);
  const workableGlobal = reuseDiscovery
    ? null
    : await runWorkableGlobalDiscovery(safeClient, profile, projectRoot);
  const discovery =
    workableGlobal === null
      ? baseDiscovery
      : {
          sources: [...baseDiscovery.sources, ...workableGlobal.sources],
          vacancies: [...baseDiscovery.vacancies, ...workableGlobal.vacancies],
        };
  const discoveryAudit = uniqueDiscovery(discovery.vacancies);
  const candidateProfile = await loadCandidateProfile(candidateProfilePathFor(projectRoot));
  const scoredDiscoveryAudit = applyWorldwideProfileScores(
    discoveryAudit,
    candidateProfile,
    profile.minimumAnnualBaseUsd,
  );
  const sponsorMatchedDiscoveryAudit = await applyWorldwideSponsorMatches(
    scoredDiscoveryAudit,
    http,
    database,
    logger,
  );
  const officialAudit = [...official.audits].sort(
    (left, right) =>
      left.company.localeCompare(right.company) || left.title.localeCompare(right.title),
  );
  const groups = groupOfficial(officialAudit);
  const sourceRegistry = globalRemoteSourceRegistry(profile);
  const activeRegistrySources = sourceRegistry.filter((source) => source.state === 'active').length;
  const gatedRegistrySources = sourceRegistry.filter((source) =>
    ['configuration_required', 'partner_required', 'blocked'].includes(source.state),
  ).length;
  const manualOrProhibitedRegistrySources =
    sourceRegistry.length - activeRegistrySources - gatedRegistrySources;
  const report: GlobalRemoteReport = {
    runId: randomUUID(),
    generatedAt: new Date().toISOString(),
    profileVersion: profile.version,
    criteria: {
      role: 'Explicit frontend engineer/developer/architect; no full-stack, backend, or people-manager titles',
      fullyRemote: true,
      applicantLocation: 'Netherlands or an explicitly worldwide/Europe-compatible location',
      usCitizenshipRequired: false,
      minimumAnnualBaseUsd: profile.minimumAnnualBaseUsd,
      currency: 'USD',
    },
    statistics: {
      discoveryRequests: discovery.sources.reduce((sum, source) => sum + source.requests, 0),
      discoveryListings: discovery.sources.reduce((sum, source) => sum + source.listings, 0),
      discoveryUniqueListings: discoveryAudit.length,
      discoveryOfficialReviewCandidates: discoveryAudit.filter(
        (item) => item.decision === 'official_review_candidate',
      ).length,
      officialBoardsOrPagesAttempted: profile.officialSources.length,
      officialRequests: official.requestCount,
      strictMatches: groups.strictMatches.length,
      manualReview: groups.manualReview.length,
      nearMisses: groups.nearMisses.length,
      excludedOrInactive: groups.excludedOrInactive.length,
      blockedOrErrored: groups.blockedOrErrored.length,
      registrySources: sourceRegistry.length,
      activeRegistrySources,
      gatedRegistrySources,
      manualOrProhibitedRegistrySources,
    },
    sourceRegistry,
    discoverySources: discovery.sources,
    ...groups,
    officialAudit,
    discoveryAudit: sponsorMatchedDiscoveryAudit,
    methodology: [
      'Free remote-job APIs are discovery inputs only; their geography and salary labels never create a strict match.',
      'Current official ATS APIs or normal employer HTML are fetched with bounded concurrency, timeouts, retries, conditional caching, and a descriptive User-Agent.',
      'Exact official vacancy content is hashed. A changed or unbaselined posting is routed to manual review instead of silently trusting old facts.',
      'No LinkedIn scraping, browser-agent production crawl, CAPTCHA bypass, proxy rotation, or paid AI service is used.',
      'One blocked or malformed source is logged and does not fail the other sources.',
      'The official Workable all-customer XML is streamed only after normal source scans, parsed incrementally, and cached as a compact hourly snapshot; raw XML is never buffered or persisted.',
      'Dice results are retrieved through Dice’s AI-powered MCP search and are clearly treated as discovery leads requiring official employer verification.',
      'Remoote results come from one capped anonymous REST search, retain only canonical Remoote links, use a five-minute bounded in-memory cache after sanitization, and are never expanded into a bulk export.',
      ...(reuseDiscovery
        ? [
            'Discovery API data was reused from the prior report; this run made no new discovery-feed requests.',
          ]
        : []),
      ...(options.offlineReclassify
        ? [
            'Official content and hashes were reused from the immediately prior report; this reclassification made no network requests.',
          ]
        : []),
    ],
    attribution: sourceRegistry
      .filter((source) => source.state === 'active')
      .map((source) => ({ name: source.name, url: source.url })),
  };
  const files = await writeGlobalRemoteReport(report, projectRoot);
  return { report, files };
}
