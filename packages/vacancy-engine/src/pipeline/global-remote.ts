import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Logger } from 'pino';

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
import { globalRemoteSourceRegistry } from '../global-remote/source-registry.js';
import {
  writeGlobalRemoteReport,
  type GlobalRemoteReportFiles,
} from '../global-remote/report.js';
import { createDatabaseBackedAtsHttpClient } from './ats-http-client.js';

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
    throw new Error('Worldwide / Remote profile must remain inside the project root.');
  }
  return globalRemoteConfigSchema.parse(JSON.parse(await readFile(file, 'utf8')) as unknown);
}

function uniqueDiscovery(vacancies: DiscoveryVacancyAudit[]): DiscoveryVacancyAudit[] {
  const unique = new Map<string, DiscoveryVacancyAudit>();
  for (const vacancy of vacancies) {
    if (!unique.has(vacancy.key)) unique.set(vacancy.key, vacancy);
  }
  return [...unique.values()].sort((left, right) =>
    left.company.localeCompare(right.company) || left.title.localeCompare(right.title));
}

function groupOfficial(audits: OfficialVacancyAudit[]): Pick<
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

export type GlobalRemoteScanOptions = { officialOnly?: boolean; offlineReclassify?: boolean };

async function loadPreviousDiscovery(projectRoot: string): Promise<{
  sources: DiscoverySourceAudit[];
  vacancies: DiscoveryVacancyAudit[];
}> {
  const file = path.resolve(projectRoot, 'reports', 'global-remote', 'latest.json');
  const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<GlobalRemoteReport>;
  if (!Array.isArray(parsed.discoverySources) || !Array.isArray(parsed.discoveryAudit)) {
    throw new Error('Previous Worldwide / Remote report does not contain reusable discovery audit data.');
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
    throw new Error('Previous Worldwide / Remote report does not contain reusable official audit data.');
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
      adzunaAppId: appConfig.keyedDiscovery.adzunaAppId,
      adzunaAppKey: appConfig.keyedDiscovery.adzunaAppKey,
      joobleApiKey: appConfig.keyedDiscovery.joobleApiKey,
      reedApiKey: appConfig.keyedDiscovery.reedApiKey,
      jobspipeApiKey: appConfig.keyedDiscovery.jobspipeApiKey,
    },
  };
  const http = createDatabaseBackedAtsHttpClient(appConfig, database, {
    onNetworkRequest(url) {
      logger.debug({ url }, 'Worldwide / Remote scan HTTP request');
    },
    onCacheError(error, operation, url) {
      logger.warn({ error, operation, url }, 'Worldwide / Remote scan cache operation failed');
    },
  });
  const reuseDiscovery = options.officialOnly === true || options.offlineReclassify === true;
  const [discovery, official] = await Promise.all([
    reuseDiscovery
      ? loadPreviousDiscovery(projectRoot)
      : runGlobalRemoteDiscovery(http, profile),
    options.offlineReclassify
      ? loadPreviousOfficial(projectRoot, profile)
      : runOfficialGlobalRemoteSources(http, profile),
  ]);
  const discoveryAudit = uniqueDiscovery(discovery.vacancies);
  const officialAudit = [...official.audits].sort((left, right) =>
    left.company.localeCompare(right.company) || left.title.localeCompare(right.title));
  const groups = groupOfficial(officialAudit);
  const sourceRegistry = globalRemoteSourceRegistry(profile);
  const activeRegistrySources = sourceRegistry.filter((source) => source.state === 'active').length;
  const gatedRegistrySources = sourceRegistry.filter((source) =>
    ['configuration_required', 'partner_required', 'blocked'].includes(source.state)).length;
  const manualOrProhibitedRegistrySources = sourceRegistry.length
    - activeRegistrySources
    - gatedRegistrySources;
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
      discoveryOfficialReviewCandidates: discoveryAudit.filter((item) => item.decision === 'official_review_candidate').length,
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
    discoveryAudit,
    methodology: [
      'Free remote-job APIs are discovery inputs only; their geography and salary labels never create a strict match.',
      'Current official ATS APIs or normal employer HTML are fetched with bounded concurrency, timeouts, retries, conditional caching, and a descriptive User-Agent.',
      'Exact official vacancy content is hashed. A changed or unbaselined posting is routed to manual review instead of silently trusting old facts.',
      'No LinkedIn scraping, browser-agent production crawl, CAPTCHA bypass, proxy rotation, or paid AI service is used.',
      'One blocked or malformed source is logged and does not fail the other sources.',
      'Dice results are retrieved through Dice’s AI-powered MCP search and are clearly treated as discovery leads requiring official employer verification.',
      ...(reuseDiscovery ? ['Discovery API data was reused from the prior report; this run made no new discovery-feed requests.'] : []),
      ...(options.offlineReclassify ? ['Official content and hashes were reused from the immediately prior report; this reclassification made no network requests.'] : []),
    ],
    attribution: sourceRegistry
      .filter((source) => source.state === 'active')
      .map((source) => ({ name: source.name, url: source.url })),
  };
  const files = await writeGlobalRemoteReport(report, projectRoot);
  return { report, files };
}
