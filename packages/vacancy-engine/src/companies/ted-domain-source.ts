import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import type { AtsHttpClient } from '../ats/http.js';
import { AtsResponseError, requireSuccessfulResponse } from '../ats/http.js';
import { normalizeLegalName } from '../ind/normalize.js';
import {
  createStructuredDomainEvidence,
  normalizeStructuredKvk,
  type StructuredDomainEvidence,
} from './structured-domain-evidence.js';

export const TED_DOMAIN_SOURCE_VERSION = 'ted-winner-domain-v1-2024plus';
export const TED_SEARCH_URL = 'https://api.ted.europa.eu/v3/notices/search';

const TED_ORIGIN = new URL(TED_SEARCH_URL).origin;
const TED_PAGE_SIZE = 250;
const MAX_TED_PAGES = 500;
const MAX_PAGE_NUMBER_RESULTS = 15_000;
const FIRST_TED_YEAR = 2024;
const DEFAULT_PAGE_DELAY_MS = 500;
export const TED_SNAPSHOT_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1_000;
const TED_FIELDS = [
  'publication-number',
  'publication-date',
  'winner-identifier',
  'winner-name',
  'winner-internet-address',
  'winner-country',
] as const;

const noticeSchema = z.looseObject({
  'publication-number': z.string().optional().default(''),
  'publication-date': z.string().optional().default(''),
  'winner-identifier': z.array(z.string()).optional().default([]),
  'winner-name': z.record(z.string(), z.array(z.string())).optional().default({}),
  'winner-internet-address': z.array(z.string()).optional().default([]),
  'winner-country': z.array(z.string()).optional().default([]),
});

const searchResponseSchema = z.looseObject({
  notices: z.array(noticeSchema),
  totalNoticeCount: z.number().int().nonnegative().nullable().optional(),
  iterationNextToken: z.string().nullable().optional(),
  timedOut: z.boolean().optional().default(false),
});

const tedEvidenceSnapshotSchema = z.object({
  source: z.literal('ted'),
  sourceVersion: z.string(),
  sourceRecordId: z.string(),
  sourceName: z.string(),
  kvkNumber: z.string(),
  officialUrl: z.string(),
  hostnameKey: z.string(),
  evidenceUrl: z.string(),
});

const tedResultSnapshotSchema = z.object({
  evidence: z.array(tedEvidenceSnapshotSchema),
  noticeCount: z.number().int().nonnegative(),
  eligibleSingletonNoticeCount: z.number().int().nonnegative(),
  invalidIdentifierCount: z.number().int().nonnegative(),
  ambiguousPairingCount: z.number().int().nonnegative(),
  invalidUrlCount: z.number().int().nonnegative(),
  incompleteRecordCount: z.number().int().nonnegative(),
  pagesFetched: z.number().int().positive(),
  reportedNoticeCount: z.number().int().nonnegative(),
});

const tedSnapshotSchema = z.object({
  sourceVersion: z.literal(TED_DOMAIN_SOURCE_VERSION),
  retrievedAt: z.iso.datetime({ offset: true }),
  startYear: z.number().int(),
  endYear: z.number().int(),
  result: tedResultSnapshotSchema,
});

type TedSearchResponse = z.infer<typeof searchResponseSchema>;

export type TedDomainParseResult = {
  evidence: StructuredDomainEvidence[];
  noticeCount: number;
  eligibleSingletonNoticeCount: number;
  invalidIdentifierCount: number;
  ambiguousPairingCount: number;
  invalidUrlCount: number;
  incompleteRecordCount: number;
};

export type TedDomainFetchResult = TedDomainParseResult & {
  pagesFetched: number;
  reportedNoticeCount: number;
};

export type TedDomainFetchOptions = {
  startYear?: number;
  endYear?: number;
  pageSize?: number;
  maxPages?: number;
  pageDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  snapshotPath?: string;
  snapshotMaxAgeMs?: number;
  now?: Date;
};

export type TedSearchRequest = {
  query: string;
  fields: readonly string[];
  page: number;
  limit: number;
  scope: 'ALL';
  checkQuerySyntax: false;
  paginationMode: 'PAGE_NUMBER';
  onlyLatestVersions: true;
};

function uniqueTrimmed(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.normalize('NFKC').trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

function uniqueNames(names: Readonly<Record<string, readonly string[]>>): string[] {
  const byNormalizedName = new Map<string, string>();
  for (const name of uniqueTrimmed(Object.values(names).flat())) {
    const normalized = normalizeLegalName(name);
    if (normalized.length === 0) continue;
    const current = byNormalizedName.get(normalized);
    if (
      current === undefined ||
      name.length < current.length ||
      (name.length === current.length && name.localeCompare(current) < 0)
    ) {
      byNormalizedName.set(normalized, name);
    }
  }
  return [...byNormalizedName.values()].sort((left, right) => left.localeCompare(right));
}

function noticeEvidenceUrl(publicationNumber: string): string {
  return `https://ted.europa.eu/en/notice/-/detail/${encodeURIComponent(publicationNumber)}`;
}

function explicitWebsiteUrl(value: string): string {
  const trimmed = value.trim();
  return /^[a-z][a-z0-9+.-]*:/iu.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function buildTedWinnerSearchRequest(
  year: number,
  page = 1,
  pageSize = TED_PAGE_SIZE,
): TedSearchRequest {
  const boundedYear = boundedInteger(year, 'year', FIRST_TED_YEAR, 9999);
  const boundedPageSize = boundedInteger(pageSize, 'pageSize', 1, TED_PAGE_SIZE);
  return {
    query: `winner-country = NLD AND publication-date >= ${boundedYear}0101 AND publication-date <= ${boundedYear}1231`,
    fields: TED_FIELDS,
    page: boundedInteger(page, 'page', 1, Math.ceil(MAX_PAGE_NUMBER_RESULTS / boundedPageSize)),
    limit: boundedPageSize,
    scope: 'ALL',
    checkQuerySyntax: false,
    paginationMode: 'PAGE_NUMBER',
    onlyLatestVersions: true,
  };
}

function parseSearchResponse(payload: unknown): TedSearchResponse {
  return searchResponseSchema.parse(payload);
}

export function parseTedDomainPage(payload: unknown): TedDomainParseResult {
  const page = parseSearchResponse(payload);
  if (page.timedOut) {
    throw new AtsResponseError('ted_domain_source', 'search response timed out');
  }

  const result: TedDomainParseResult = {
    evidence: [],
    noticeCount: page.notices.length,
    eligibleSingletonNoticeCount: 0,
    invalidIdentifierCount: 0,
    ambiguousPairingCount: 0,
    invalidUrlCount: 0,
    incompleteRecordCount: 0,
  };

  for (const notice of page.notices) {
    const publicationNumber = notice['publication-number'].trim();
    const identifiers = uniqueTrimmed(notice['winner-identifier']);
    const countries = uniqueTrimmed(notice['winner-country']).map((value) => value.toUpperCase());
    const names = uniqueNames(notice['winner-name']);
    const websites = uniqueTrimmed(notice['winner-internet-address']);

    if (
      publicationNumber.length === 0 ||
      countries.length !== 1 ||
      countries[0] !== 'NLD' ||
      names.length === 0 ||
      websites.length === 0
    ) {
      result.incompleteRecordCount += 1;
      continue;
    }

    if (identifiers.length === 0 || identifiers.some((value) => !/^\d{8}$/u.test(value))) {
      result.invalidIdentifierCount += 1;
      continue;
    }
    const normalizedIdentifiers = identifiers.map(normalizeStructuredKvk);
    const kvkNumbers = [...new Set(normalizedIdentifiers.filter((value) => value !== null))];
    if (kvkNumbers.length !== 1 || names.length !== 1) {
      result.ambiguousPairingCount += 1;
      continue;
    }
    const kvkNumber = kvkNumbers[0];
    const sourceName = names[0];
    if (kvkNumber === undefined || sourceName === undefined) {
      result.incompleteRecordCount += 1;
      continue;
    }

    result.eligibleSingletonNoticeCount += 1;
    const sourceRecordId = `${publicationNumber}:winner:${kvkNumber}`;
    const seen = new Set<string>();
    for (const officialUrl of websites) {
      const item = createStructuredDomainEvidence({
        source: 'ted',
        sourceVersion: TED_DOMAIN_SOURCE_VERSION,
        sourceRecordId,
        sourceName,
        kvkNumber,
        officialUrl: explicitWebsiteUrl(officialUrl),
        evidenceUrl: noticeEvidenceUrl(publicationNumber),
      });
      if (item === null) {
        result.invalidUrlCount += 1;
        continue;
      }
      const identity = `${item.sourceRecordId}\u0000${item.officialUrl}`;
      if (!seen.has(identity)) {
        seen.add(identity);
        result.evidence.push(item);
      }
    }
  }

  return result;
}

function mergePageResult(target: TedDomainParseResult, page: TedDomainParseResult): void {
  target.evidence.push(...page.evidence);
  target.noticeCount += page.noticeCount;
  target.eligibleSingletonNoticeCount += page.eligibleSingletonNoticeCount;
  target.invalidIdentifierCount += page.invalidIdentifierCount;
  target.ambiguousPairingCount += page.ambiguousPairingCount;
  target.invalidUrlCount += page.invalidUrlCount;
  target.incompleteRecordCount += page.incompleteRecordCount;
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function validatedSnapshotResult(value: unknown): TedDomainFetchResult | null {
  const parsed = tedResultSnapshotSchema.safeParse(value);
  if (!parsed.success) return null;
  const evidence: StructuredDomainEvidence[] = [];
  for (const item of parsed.data.evidence) {
    const normalized = createStructuredDomainEvidence(item);
    if (normalized === null) return null;
    if (
      normalized.sourceVersion !== TED_DOMAIN_SOURCE_VERSION ||
      normalized.kvkNumber !== item.kvkNumber ||
      normalized.officialUrl !== item.officialUrl ||
      normalized.hostnameKey !== item.hostnameKey
    ) {
      return null;
    }
    evidence.push(normalized);
  }
  return { ...parsed.data, evidence };
}

async function loadTedSnapshot(
  snapshotPath: string,
  startYear: number,
  endYear: number,
  maxAgeMs: number,
  now: Date,
): Promise<TedDomainFetchResult | null> {
  try {
    const parsed = tedSnapshotSchema.safeParse(
      JSON.parse(await readFile(snapshotPath, 'utf8')) as unknown,
    );
    if (!parsed.success || parsed.data.startYear !== startYear || parsed.data.endYear !== endYear) {
      return null;
    }
    const retrievedAt = Date.parse(parsed.data.retrievedAt);
    const ageMs = now.getTime() - retrievedAt;
    if (!Number.isFinite(retrievedAt) || ageMs < 0 || ageMs > maxAgeMs) return null;
    return validatedSnapshotResult(parsed.data.result);
  } catch {
    return null;
  }
}

async function writeTedSnapshot(
  snapshotPath: string,
  startYear: number,
  endYear: number,
  result: TedDomainFetchResult,
  retrievedAt: Date,
): Promise<void> {
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  const temporary = `${snapshotPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({
        sourceVersion: TED_DOMAIN_SOURCE_VERSION,
        retrievedAt: retrievedAt.toISOString(),
        startYear,
        endYear,
        result,
      })}\n`,
      'utf8',
    );
    await rename(temporary, snapshotPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function fetchTedDomainEvidence(
  http: AtsHttpClient,
  options: TedDomainFetchOptions = {},
): Promise<TedDomainFetchResult> {
  const now = options.now ?? new Date();
  const currentYear = now.getUTCFullYear();
  const startYear = boundedInteger(
    options.startYear ?? FIRST_TED_YEAR,
    'startYear',
    FIRST_TED_YEAR,
    9999,
  );
  const endYear = boundedInteger(
    options.endYear ?? currentYear,
    'endYear',
    FIRST_TED_YEAR,
    9999,
  );
  if (endYear < startYear) throw new RangeError('endYear must not be before startYear');
  const pageSize = boundedInteger(options.pageSize ?? TED_PAGE_SIZE, 'pageSize', 1, TED_PAGE_SIZE);
  const maxPages = boundedInteger(options.maxPages ?? MAX_TED_PAGES, 'maxPages', 1, MAX_TED_PAGES);
  const snapshotMaxAgeMs = boundedInteger(
    options.snapshotMaxAgeMs ?? TED_SNAPSHOT_MAX_AGE_MS,
    'snapshotMaxAgeMs',
    1,
    365 * 24 * 60 * 60 * 1_000,
  );
  const pageDelayMs = boundedInteger(
    options.pageDelayMs ?? DEFAULT_PAGE_DELAY_MS,
    'pageDelayMs',
    0,
    10_000,
  );
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  if (options.snapshotPath !== undefined) {
    const snapshot = await loadTedSnapshot(
      options.snapshotPath,
      startYear,
      endYear,
      snapshotMaxAgeMs,
      now,
    );
    if (snapshot !== null) return snapshot;
  }
  const aggregate: TedDomainParseResult = {
    evidence: [],
    noticeCount: 0,
    eligibleSingletonNoticeCount: 0,
    invalidIdentifierCount: 0,
    ambiguousPairingCount: 0,
    invalidUrlCount: 0,
    incompleteRecordCount: 0,
  };
  const seenPublicationNumbers = new Set<string>();
  let pagesFetched = 0;
  let reportedNoticeCount = 0;

  for (let year = startYear; year <= endYear; year += 1) {
    let yearReportedCount: number | null = null;
    let yearObservedCount = 0;
    let expectedPages = 1;
    for (let pageNumber = 1; pageNumber <= expectedPages; pageNumber += 1) {
      if (pagesFetched >= maxPages) {
        throw new AtsResponseError('ted_domain_source', 'pagination exceeded the page limit');
      }
      if (pagesFetched > 0 && pageDelayMs > 0) await sleep(pageDelayMs);
      const request = buildTedWinnerSearchRequest(year, pageNumber, pageSize);
      const response = await http.postJson(TED_SEARCH_URL, request, {
        allowedOrigins: [TED_ORIGIN],
      });
      requireSuccessfulResponse('ted_domain_source', response);
      if (new URL(response.finalUrl).origin !== TED_ORIGIN) {
        throw new AtsResponseError('ted_domain_source', 'response left the TED API origin');
      }

      let payload: unknown;
      try {
        payload = JSON.parse(response.body) as unknown;
      } catch (error) {
        throw new AtsResponseError('ted_domain_source', 'response is not valid JSON', null, {
          cause: error,
        });
      }
      const parsedResponse = parseSearchResponse(payload);
      if (parsedResponse.timedOut) {
        throw new AtsResponseError('ted_domain_source', 'search response timed out');
      }
      const pageReportedCount = parsedResponse.totalNoticeCount;
      if (pageReportedCount === null || pageReportedCount === undefined) {
        throw new AtsResponseError('ted_domain_source', 'search response omitted its result count');
      }
      if (pageReportedCount > MAX_PAGE_NUMBER_RESULTS) {
        throw new AtsResponseError(
          'ted_domain_source',
          `year ${year} exceeds the page-number result limit`,
        );
      }
      if (yearReportedCount !== null && pageReportedCount !== yearReportedCount) {
        throw new AtsResponseError('ted_domain_source', `year ${year} result count changed mid-fetch`);
      }
      yearReportedCount = pageReportedCount;
      expectedPages = Math.max(1, Math.ceil(pageReportedCount / pageSize));
      const maximumPages = Math.ceil(MAX_PAGE_NUMBER_RESULTS / pageSize);
      if (expectedPages > maximumPages) {
        throw new AtsResponseError('ted_domain_source', `year ${year} exceeds the page limit`);
      }

      for (const notice of parsedResponse.notices) {
        const publicationNumber = notice['publication-number'].trim();
        if (publicationNumber.length === 0) continue;
        if (seenPublicationNumbers.has(publicationNumber)) {
          throw new AtsResponseError('ted_domain_source', 'duplicate notice across result pages');
        }
        seenPublicationNumbers.add(publicationNumber);
      }
      yearObservedCount += parsedResponse.notices.length;
      mergePageResult(aggregate, parseTedDomainPage(parsedResponse));
      pagesFetched += 1;
    }
    if (yearReportedCount === null || yearObservedCount !== yearReportedCount) {
      throw new AtsResponseError('ted_domain_source', `year ${year} result count was incomplete`);
    }
    reportedNoticeCount += yearReportedCount;
  }

  const result = { ...aggregate, pagesFetched, reportedNoticeCount };
  if (options.snapshotPath !== undefined) {
    try {
      await writeTedSnapshot(options.snapshotPath, startYear, endYear, result, now);
    } catch {
      // Snapshot persistence is an optimization; the verified live result remains usable.
    }
  }
  return result;
}
