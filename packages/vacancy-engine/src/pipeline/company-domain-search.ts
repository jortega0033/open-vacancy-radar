import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { load } from 'cheerio';
import type { Logger } from 'pino';

import type { AtsHttpClient, AtsHttpResponse } from '../ats/http.js';
import { requireSuccessfulResponse } from '../ats/http.js';
import {
  listDueDomainSearchSponsors,
  persistDomainSearchAttempt,
  type DomainSearchSponsor,
} from '../companies/domain-search-repository.js';
import {
  companyDomainCandidateFileSchema,
  isForbiddenDiscoveryHostname,
  loadCompanyDomainCandidates,
  type CompanyDomainCandidate,
  type CompanyDomainCandidateFile,
} from '../companies/domain-candidates.js';
import { seedSponsorDiscovery } from '../companies/discovery-repository.js';
import type { AppConfig } from '../config.js';
import { isCrawlerHttpError } from '../crawler/errors.js';
import type { Database } from '../db/client.js';
import { createSearchName } from '../ind/normalize.js';
import { createDatabaseBackedAtsHttpClient } from './ats-http-client.js';
import { writeDomainCandidateCatalog } from './company-domain-enrichment.js';

export const BRAVE_DOMAIN_SEARCH_VERSION = 'brave-domain-search-v1';
export const BRAVE_DOMAIN_CATALOG_VERSION = 'company-domain-candidates-v3-brave-search';
const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const MAX_VERIFICATION_RESULTS = 3;
const EXCLUDED_HOSTS = [
  'linkedin.com',
  'indeed.com',
  'glassdoor.com',
  'google.com',
  'facebook.com',
  'instagram.com',
  'x.com',
  'twitter.com',
  'youtube.com',
  'kvk.nl',
  'companyinfo.nl',
  'transfirm.nl',
  'drimble.nl',
  'opencorporates.com',
  'bloomberg.com',
  'crunchbase.com',
  'wikipedia.org',
  'greenhouse.io',
  'lever.co',
  'myworkdayjobs.com',
  'teamtailor.com',
  'recruitee.com',
  'smartrecruiters.com',
  'personio.com',
];

export type BraveWebResult = {
  title: string;
  url: string;
  description: string;
};

export type DomainSearchAudit = {
  sponsorId: string;
  legalName: string;
  kvkNumber: string;
  queryHash: string;
  outcome: 'candidate_high' | 'candidate_manual' | 'not_found' | 'blocked' | 'error';
  resultUrl: string | null;
  officialUrl: string | null;
  httpStatus: number | null;
  reason: string;
  attemptedAt: string;
};

export type CompanyDomainSearchResult = {
  attempted: number;
  candidateHigh: number;
  candidateManual: number;
  notFound: number;
  blocked: number;
  errors: number;
  physicalRequests: number;
  candidatesPersisted: number;
  remainingBatchCapacity: number;
  catalogPath: string | null;
  latestAudit: string;
  timestampedAudit: string;
  audits: DomainSearchAudit[];
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function excludedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/u, '');
  return isForbiddenDiscoveryHostname(normalized)
    || EXCLUDED_HOSTS.some((host) => normalized === host || normalized.endsWith(`.${host}`));
}

export function parseBraveWebResults(body: string): BraveWebResult[] {
  const root = record(JSON.parse(body) as unknown);
  const web = record(root?.web);
  if (!Array.isArray(web?.results)) return [];
  const unique = new Map<string, BraveWebResult>();
  for (const raw of web.results) {
    const result = record(raw);
    const title = nonEmptyString(result?.title);
    const value = nonEmptyString(result?.url);
    if (title === null || value === null) continue;
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || excludedHostname(url.hostname)) continue;
      url.username = '';
      url.password = '';
      url.hash = '';
      const normalized = url.toString();
      if (!unique.has(normalized)) {
        unique.set(normalized, {
          title,
          url: normalized,
          description: nonEmptyString(result?.description) ?? '',
        });
      }
    } catch {
      // Ignore invalid and non-public search result URLs.
    }
  }
  return [...unique.values()];
}

function compatibleLegalName(legalName: string, text: string): boolean {
  const ignored = new Set(['bv', 'nv', 'vof', 'b', 'v', 'n']);
  const expected = createSearchName(legalName)
    .split(' ')
    .filter((token) => token.length >= 3 && !ignored.has(token));
  if (expected.length === 0) return false;
  const observed = new Set(createSearchName(text).split(' '));
  const matched = expected.filter((token) => observed.has(token)).length;
  return matched >= Math.min(2, expected.length);
}

function containsExactKvk(text: string, kvkNumber: string): boolean {
  const pattern = kvkNumber.split('').join('[\\s.\\-]*');
  return new RegExp(`(?:kvk|kamer\\s+van\\s+koophandel)?[^0-9]{0,30}${pattern}`, 'iu').test(text);
}

function rootOfficialUrl(value: string): string {
  const url = new URL(value);
  return `${url.protocol}//${url.host}/`;
}

export function verifyBraveCandidatePage(
  sponsor: Pick<DomainSearchSponsor, 'legalName' | 'kvkNumber'>,
  searchResult: BraveWebResult,
  response: AtsHttpResponse,
): { candidate: CompanyDomainCandidate; reason: string } | null {
  requireSuccessfulResponse('brave_domain_verification', response);
  const finalUrl = new URL(response.finalUrl);
  if (excludedHostname(finalUrl.hostname)) return null;
  const pageText = load(response.body).text().replace(/\s+/gu, ' ').trim();
  const combined = `${searchResult.title} ${searchResult.description} ${pageText}`;
  if (!compatibleLegalName(sponsor.legalName, combined)) return null;
  const exactKvk = containsExactKvk(combined, sponsor.kvkNumber);
  const officialUrl = rootOfficialUrl(finalUrl.toString());
  return {
    candidate: {
      legalName: sponsor.legalName,
      kvkNumber: sponsor.kvkNumber,
      brandName: sponsor.legalName,
      officialUrl,
      confidence: exactKvk ? 'high' : 'medium',
      source: BRAVE_DOMAIN_SEARCH_VERSION,
      evidenceUrls: [...new Set([searchResult.url, officialUrl])],
      priority: exactKvk ? 55 : 20,
    },
    reason: exactKvk
      ? 'Fetched candidate page contains the compatible legal name and exact eight-digit KVK number.'
      : 'Fetched candidate page contains a compatible legal name but no exact KVK number; manual review required.',
  };
}

function queryFor(sponsor: DomainSearchSponsor): string {
  return `"${sponsor.legalName}" "${sponsor.kvkNumber}" official website`;
}

function queryHash(query: string): string {
  return createHash('sha256').update(query).digest('hex');
}

function nextCheck(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1_000);
}

function safeFailure(error: unknown): { outcome: 'blocked' | 'error'; status: number | null; reason: string } {
  if (isCrawlerHttpError(error)) {
    return {
      outcome: ['blocked', 'rate_limited'].includes(error.category) ? 'blocked' : 'error',
      status: error.status ?? null,
      reason: `${error.category}/${error.code}: ${error.message}`,
    };
  }
  return {
    outcome: 'error',
    status: null,
    reason: error instanceof Error ? error.message : String(error),
  };
}

async function searchOneSponsor(
  http: AtsHttpClient,
  sponsor: DomainSearchSponsor,
  apiKey: string,
  now: Date,
): Promise<{ audit: DomainSearchAudit; candidate: CompanyDomainCandidate | null }> {
  const query = queryFor(sponsor);
  const attemptedAt = now.toISOString();
  try {
    const searchUrl = new URL(BRAVE_SEARCH_ENDPOINT);
    searchUrl.searchParams.set('q', query);
    searchUrl.searchParams.set('count', '5');
    searchUrl.searchParams.set('country', 'nl');
    searchUrl.searchParams.set('search_lang', 'nl');
    searchUrl.searchParams.set('safesearch', 'moderate');
    const response = await http.get(searchUrl.toString(), {
      allowedOrigins: ['https://api.search.brave.com'],
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey,
      },
    });
    requireSuccessfulResponse('brave_domain_search', response);
    const results = parseBraveWebResults(response.body).slice(0, MAX_VERIFICATION_RESULTS);
    let manual: { candidate: CompanyDomainCandidate; reason: string; resultUrl: string } | null = null;
    let lastFailure: ReturnType<typeof safeFailure> | null = null;
    for (const result of results) {
      try {
        const verified = verifyBraveCandidatePage(sponsor, result, await http.get(result.url));
        if (verified === null) continue;
        if (verified.candidate.confidence === 'high') {
          return {
            candidate: verified.candidate,
            audit: {
              sponsorId: sponsor.sponsorId,
              legalName: sponsor.legalName,
              kvkNumber: sponsor.kvkNumber,
              queryHash: queryHash(query),
              outcome: 'candidate_high',
              resultUrl: result.url,
              officialUrl: verified.candidate.officialUrl,
              httpStatus: 200,
              reason: verified.reason,
              attemptedAt,
            },
          };
        }
        manual ??= { ...verified, resultUrl: result.url };
      } catch (error) {
        lastFailure = safeFailure(error);
      }
    }
    if (manual !== null) {
      return {
        candidate: manual.candidate,
        audit: {
          sponsorId: sponsor.sponsorId,
          legalName: sponsor.legalName,
          kvkNumber: sponsor.kvkNumber,
          queryHash: queryHash(query),
          outcome: 'candidate_manual',
          resultUrl: manual.resultUrl,
          officialUrl: manual.candidate.officialUrl,
          httpStatus: 200,
          reason: manual.reason,
          attemptedAt,
        },
      };
    }
    if (results.length > 0 && lastFailure !== null) {
      return {
        candidate: null,
        audit: {
          sponsorId: sponsor.sponsorId,
          legalName: sponsor.legalName,
          kvkNumber: sponsor.kvkNumber,
          queryHash: queryHash(query),
          outcome: lastFailure.outcome,
          resultUrl: null,
          officialUrl: null,
          httpStatus: lastFailure.status,
          reason: `Search returned candidates, but verification failed: ${lastFailure.reason}`,
          attemptedAt,
        },
      };
    }
    return {
      candidate: null,
      audit: {
        sponsorId: sponsor.sponsorId,
        legalName: sponsor.legalName,
        kvkNumber: sponsor.kvkNumber,
        queryHash: queryHash(query),
        outcome: 'not_found',
        resultUrl: null,
        officialUrl: null,
        httpStatus: response.status,
        reason: results.length === 0
          ? 'Brave returned no eligible official-site candidates.'
          : 'Eligible search results did not contain a compatible legal-name signal.',
        attemptedAt,
      },
    };
  } catch (error) {
    const failure = safeFailure(error);
    return {
      candidate: null,
      audit: {
        sponsorId: sponsor.sponsorId,
        legalName: sponsor.legalName,
        kvkNumber: sponsor.kvkNumber,
        queryHash: queryHash(query),
        outcome: failure.outcome,
        resultUrl: null,
        officialUrl: null,
        httpStatus: failure.status,
        reason: failure.reason,
        attemptedAt,
      },
    };
  }
}

function candidateIdentity(candidate: Pick<CompanyDomainCandidate, 'kvkNumber' | 'legalName'>): string {
  return `${candidate.kvkNumber}:${createSearchName(candidate.legalName)}`;
}

export function mergeBraveCandidates(
  current: CompanyDomainCandidateFile,
  candidates: readonly CompanyDomainCandidate[],
  now: Date,
): CompanyDomainCandidateFile {
  const byIdentity = new Map(current.candidates.map((candidate) => [candidateIdentity(candidate), candidate]));
  for (const candidate of candidates) {
    const identity = candidateIdentity(candidate);
    if (!byIdentity.has(identity)) byIdentity.set(identity, candidate);
  }
  const verifiedAt = new Date(Math.max(now.getTime(), Date.parse(current.verifiedAt) + 1));
  return companyDomainCandidateFileSchema.parse({
    version: BRAVE_DOMAIN_CATALOG_VERSION,
    verifiedAt: verifiedAt.toISOString(),
    candidates: [...byIdentity.values()].sort((left, right) =>
      left.kvkNumber.localeCompare(right.kvkNumber) || left.legalName.localeCompare(right.legalName)),
  });
}

async function writeAuditFiles(
  audits: readonly DomainSearchAudit[],
  now: Date,
  projectRoot: string,
): Promise<{ latestAudit: string; timestampedAudit: string }> {
  const output = path.resolve(projectRoot, 'reports', 'company-domain-search');
  const relative = path.relative(projectRoot, output);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Company-domain search report path must remain inside the project root');
  }
  await mkdir(output, { recursive: true });
  const timestamp = now.toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const latestAudit = path.join(output, 'latest.ndjson');
  const timestampedAudit = path.join(output, `${timestamp}.ndjson`);
  const contents = audits.map((audit) => JSON.stringify(audit)).join('\n').concat(audits.length > 0 ? '\n' : '');
  for (const target of [timestampedAudit, latestAudit]) {
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporary, contents, 'utf8');
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  return { latestAudit, timestampedAudit };
}

export async function runCompanyDomainSearch(
  database: Database,
  config: AppConfig,
  logger: Logger,
  options: { projectRoot?: string; now?: Date; candidateFilePath?: string } = {},
): Promise<CompanyDomainSearchResult> {
  const apiKey = config.braveSearch.apiKey.trim();
  if (apiKey.length === 0) {
    throw new Error('BRAVE_SEARCH_API_KEY is required for companies:domains:search; no machine credentials are auto-discovered');
  }
  const projectRoot = options.projectRoot ?? process.cwd();
  const candidateFilePath = options.candidateFilePath ?? 'config/company-domain-candidates-v1.json';
  const current = await loadCompanyDomainCandidates(path.resolve(projectRoot, candidateFilePath));
  const now = options.now ?? new Date();
  await seedSponsorDiscovery(database, current, now);
  const limit = Math.min(config.braveSearch.batchSize, config.braveSearch.maxRequests);
  const sponsors = await listDueDomainSearchSponsors(database, limit, now);
  let physicalRequests = 0;
  const http = createDatabaseBackedAtsHttpClient(
    { ...config, globalConcurrency: Math.min(config.globalConcurrency, 2), perDomainConcurrency: 1 },
    database,
    { onNetworkRequest: () => { physicalRequests += 1; } },
  );
  const audits: DomainSearchAudit[] = [];
  const candidates: CompanyDomainCandidate[] = [];
  for (const sponsor of sponsors) {
    const result = await searchOneSponsor(http, sponsor, apiKey, now);
    audits.push(result.audit);
    if (result.candidate !== null) candidates.push(result.candidate);
    const retryDays = result.audit.outcome === 'not_found'
      ? config.braveSearch.recheckDays
      : result.audit.outcome === 'blocked' || result.audit.outcome === 'error'
        ? Math.min(7, config.braveSearch.recheckDays)
        : config.braveSearch.recheckDays;
    await persistDomainSearchAttempt(database, {
      sponsorId: sponsor.sponsorId,
      outcome: result.audit.outcome,
      reason: result.audit.reason,
      resultUrl: result.audit.resultUrl,
      httpStatus: result.audit.httpStatus,
      attemptedAt: now,
      nextCheckAt: result.candidate === null ? nextCheck(now, retryDays) : null,
    });
    logger.info({
      sponsorId: sponsor.sponsorId,
      legalName: sponsor.legalName,
      kvkNumber: sponsor.kvkNumber,
      outcome: result.audit.outcome,
      officialUrl: result.audit.officialUrl,
      httpStatus: result.audit.httpStatus,
      reason: result.audit.reason,
    }, 'Employer-domain search company result');
  }

  let catalogPath: string | null = null;
  let candidatesPersisted = current.candidates.length;
  if (candidates.length > 0) {
    const merged = mergeBraveCandidates(current, candidates, now);
    catalogPath = await writeDomainCandidateCatalog(merged, candidateFilePath, projectRoot);
    candidatesPersisted = merged.candidates.length;
    await seedSponsorDiscovery(database, merged, new Date(merged.verifiedAt));
  }
  const files = await writeAuditFiles(audits, now, projectRoot);
  const count = (outcome: DomainSearchAudit['outcome']): number =>
    audits.filter((audit) => audit.outcome === outcome).length;
  return {
    attempted: audits.length,
    candidateHigh: count('candidate_high'),
    candidateManual: count('candidate_manual'),
    notFound: count('not_found'),
    blocked: count('blocked'),
    errors: count('error'),
    physicalRequests,
    candidatesPersisted,
    remainingBatchCapacity: limit - audits.length,
    catalogPath,
    ...files,
    audits,
  };
}
