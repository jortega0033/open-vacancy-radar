import { createHash } from 'node:crypto';

import type {
  AdapterResult,
  CareerSourceDescriptor,
  NormalizedVacancy,
  VacancyAdapter,
} from '../domain/models.js';
import { isRecognizableAccessChallenge } from './company-site.js';
import { parseWorkdayBoard, type WorkdayBoard } from './detection.js';
import type { AtsHttpClient, AtsHttpResponse } from './http.js';
import { AtsResponseError, requireSuccessfulResponse } from './http.js';
import {
  htmlToText,
  httpUrl,
  joinNonEmpty,
  makeVacancy,
  normalizedSource,
  optionalString,
  parseDate,
  parseJson,
  requireBoardIdentifier,
  requireRecord,
  validPaginationOptions,
  type PaginationOptions,
} from './shared.js';

const provider = 'workday' as const;
const KNOWN_TOTAL_CAP = 2_000;
const LOCATION_ROLLUP = /^\d+\s+locations?$/iu;

export type WorkdayAdapterOptions = Partial<PaginationOptions> & {
  maxDetails?: number;
};

type WorkdaySummary = {
  externalPath: string;
  title: string;
  raw: Record<string, unknown>;
};

type WorkdaySearchPage = {
  total: number | null;
  rawCount: number;
  invalidCount: number;
  signature: string;
  summaries: WorkdaySummary[];
};

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function responseHeader(response: AtsHttpResponse, name: string): string | null {
  const expected = name.toLowerCase();
  return Object.entries(response.headers).find(([key]) => key.toLowerCase() === expected)?.[1] ?? null;
}

function parseResponseJson(response: AtsHttpResponse): unknown {
  requireSuccessfulResponse(provider, response);
  const contentType = responseHeader(response, 'content-type')?.toLowerCase() ?? '';
  const looksLikeHtml = contentType.includes('text/html') || /^\s*</u.test(response.body);
  if (looksLikeHtml && isRecognizableAccessChallenge(response.body)) {
    throw new AtsResponseError(provider, 'public endpoint returned an access challenge', 403);
  }
  return parseJson(response.body, provider);
}

function normalizeExternalPath(value: unknown, board: WorkdayBoard): string | null {
  const raw = optionalString(value);
  if (raw === null || !raw.startsWith('/') || raw.startsWith('//')) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw, board.origin);
  } catch {
    return null;
  }
  if (
    parsed.origin !== board.origin ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return null;
  }
  return parsed.pathname;
}

function parseSearchPage(value: unknown, board: WorkdayBoard): WorkdaySearchPage {
  const root = requireRecord(value, provider, 'job search');
  if (!Array.isArray(root.jobPostings)) {
    throw new AtsResponseError(provider, 'job search has an unknown response shape');
  }
  let total: number | null = null;
  if (root.total !== undefined && root.total !== null) {
    if (!Number.isSafeInteger(root.total) || (root.total as number) < 0) {
      throw new AtsResponseError(provider, 'job search total is invalid');
    }
    total = root.total as number;
  }

  const summaries: WorkdaySummary[] = [];
  let invalidCount = 0;
  const signatureParts: string[] = [];
  for (const value of root.jobPostings) {
    const raw = objectOrNull(value);
    const title = optionalString(raw?.title);
    const externalPath = normalizeExternalPath(raw?.externalPath, board);
    signatureParts.push(
      externalPath ?? optionalString(raw?.externalPath) ?? optionalString(raw?.title) ?? '<invalid>',
    );
    if (raw === null || title === null || externalPath === null) {
      invalidCount += 1;
      continue;
    }
    summaries.push({ externalPath, title, raw });
  }
  return {
    total,
    rawCount: root.jobPostings.length,
    invalidCount,
    signature: signatureParts.join('\u0000'),
    summaries,
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): string[] => {
    const normalized = optionalString(entry);
    return normalized === null ? [] : [normalized];
  });
}

function bulletIdentifier(summary: WorkdaySummary): string | null {
  return stringArray(summary.raw.bulletFields)[0] ?? null;
}

function locationFromPath(path: string): string | null {
  const match = /^\/job\/([^/]+)\//u.exec(path);
  if (match?.[1] === undefined) return null;
  try {
    return decodeURIComponent(match[1]).replace(/[-_]+/gu, ' ').trim() || null;
  } catch {
    return match[1].replace(/[-_]+/gu, ' ').trim() || null;
  }
}

function concreteLocations(info: Record<string, unknown>, summary: WorkdaySummary): string | null {
  const detailLocations = [
    optionalString(info.location),
    ...stringArray(info.additionalLocations),
  ].filter((value): value is string => value !== null && !LOCATION_ROLLUP.test(value));
  if (detailLocations.length > 0) {
    return joinNonEmpty(detailLocations, ' / ');
  }
  const summaryLocation = optionalString(summary.raw.locationsText);
  if (summaryLocation !== null && !LOCATION_ROLLUP.test(summaryLocation)) return summaryLocation;
  return locationFromPath(summary.externalPath);
}

function workplace(remoteType: string | null): {
  remote: boolean | null;
  workplaceMode: 'remote' | 'hybrid' | 'onsite' | 'unknown';
} {
  const normalized = remoteType?.toLowerCase() ?? '';
  if (normalized.includes('hybrid')) return { remote: null, workplaceMode: 'hybrid' };
  if (normalized.includes('remote')) return { remote: true, workplaceMode: 'remote' };
  if (/on[ -]?site/u.test(normalized)) return { remote: false, workplaceMode: 'onsite' };
  return { remote: null, workplaceMode: 'unknown' };
}

function stableExternalId(
  info: Record<string, unknown>,
  summary: WorkdaySummary,
  board: WorkdayBoard,
): string {
  const candidate =
    optionalString(info.jobReqId) ??
    bulletIdentifier(summary) ??
    summary.externalPath.split('/').filter(Boolean).at(-1) ??
    summary.externalPath;
  const namespaced = `${board.tenant}:${board.site}:${candidate}`;
  if (namespaced.length <= 500) return namespaced;
  return `workday:${createHash('sha256').update(namespaced).digest('hex')}`;
}

function normalizeDetail(
  value: unknown,
  summary: WorkdaySummary,
  board: WorkdayBoard,
): NormalizedVacancy | null {
  const detail = objectOrNull(value);
  const info = objectOrNull(detail?.jobPostingInfo);
  if (detail === null || info === null) return null;
  const descriptionHtml = optionalString(info.jobDescription);
  const title = optionalString(info.title) ?? summary.title;
  if (descriptionHtml === null) return null;

  const remoteType = optionalString(info.remoteType) ?? optionalString(summary.raw.remoteType);
  const mode = workplace(remoteType);
  const fallbackUrl = `${board.boardUrl}${summary.externalPath}`;
  const url = httpUrl(info.externalUrl, board.boardUrl) ?? httpUrl(fallbackUrl);
  if (url === null) return null;

  return makeVacancy({
    externalId: stableExternalId(info, summary, board),
    title,
    description: htmlToText(descriptionHtml),
    location: concreteLocations(info, summary),
    remote: mode.remote,
    workplaceMode: mode.workplaceMode,
    url,
    postedAt: parseDate(info.startDate),
    employmentType:
      optionalString(info.timeType) ??
      optionalString(info.workerSubType) ??
      optionalString(summary.raw.timeType),
    source: normalizedSource(provider),
  });
}

/**
 * Deterministic adapter for Workday's public, credential-free CXS board
 * contract. The endpoint is not a documented Workday API, so every bound or
 * malformed response revokes completeness instead of triggering browser or
 * access-challenge workarounds.
 */
export class WorkdayAdapter implements VacancyAdapter {
  public readonly provider = provider;
  readonly #pagination: PaginationOptions;
  readonly #maxDetails: number;

  public constructor(
    private readonly http: AtsHttpClient,
    options: WorkdayAdapterOptions = {},
  ) {
    this.#pagination = validPaginationOptions(
      provider,
      options,
      { pageSize: 20, maxPages: 100 },
      20,
    );
    this.#maxDetails = options.maxDetails ?? 500;
    if (!Number.isInteger(this.#maxDetails) || this.#maxDetails < 1) {
      throw new AtsResponseError(provider, 'maxDetails must be a positive integer');
    }
  }

  public supports(source: CareerSourceDescriptor): boolean {
    if (source.provider !== provider) return false;
    const board = parseWorkdayBoard(source.baseUrl);
    const configuredSite = source.boardIdentifier?.trim();
    return (
      board !== null &&
      configuredSite !== undefined &&
      configuredSite.length > 0 &&
      board.site.toLowerCase() === configuredSite.toLowerCase()
    );
  }

  public async listVacancies(source: CareerSourceDescriptor): Promise<AdapterResult> {
    if (!this.supports(source)) throw new AtsResponseError(provider, 'source is not supported');
    const configuredSite = requireBoardIdentifier(source, provider);
    const board = parseWorkdayBoard(source.baseUrl);
    if (board?.site.toLowerCase() !== configuredSite.toLowerCase()) {
      throw new AtsResponseError(provider, 'source does not identify an exact Workday board');
    }

    const summaries = new Map<string, WorkdaySummary>();
    const signatures = new Set<string>();
    let requestCount = 0;
    let invalidCount = 0;
    let listingComplete = false;
    let reportedTotal: number | null = null;
    let reportedKnownCap = false;
    let offset = 0;

    for (let page = 0; page < this.#pagination.maxPages; page += 1) {
      const payload = {
        appliedFacets: {},
        limit: this.#pagination.pageSize,
        offset,
        searchText: '',
      };
      requestCount += 1;
      const response = await this.http.postJson(board.listUrl, payload, {
        allowedOrigins: [board.origin],
      });
      const parsed = parseSearchPage(parseResponseJson(response), board);
      if (signatures.has(parsed.signature)) break;
      signatures.add(parsed.signature);
      invalidCount += parsed.invalidCount;

      if (parsed.total !== null && parsed.total > 0) {
        reportedTotal = Math.max(reportedTotal ?? 0, parsed.total);
        if (parsed.total === KNOWN_TOTAL_CAP) reportedKnownCap = true;
      }

      let added = 0;
      for (const summary of parsed.summaries) {
        if (summaries.has(summary.externalPath)) continue;
        summaries.set(summary.externalPath, summary);
        added += 1;
      }

      const consumed = offset + parsed.rawCount;
      if (parsed.rawCount === 0) {
        listingComplete = reportedTotal === null || consumed >= reportedTotal;
        break;
      }
      if (added === 0) break;
      if (reportedTotal !== null && consumed >= reportedTotal) {
        listingComplete = true;
        break;
      }
      if (parsed.rawCount < this.#pagination.pageSize) {
        listingComplete = reportedTotal === null || consumed >= reportedTotal;
        break;
      }
      offset = consumed;
    }

    const selected = [...summaries.values()].slice(0, this.#maxDetails);
    let complete =
      listingComplete &&
      !reportedKnownCap &&
      selected.length === summaries.size &&
      invalidCount === 0;
    const vacancies: NormalizedVacancy[] = [];
    for (const summary of selected) {
      requestCount += 1;
      const response = await this.http.get(`${board.detailPrefix}${summary.externalPath}`, {
        allowedOrigins: [board.origin],
      });
      const vacancy = normalizeDetail(parseResponseJson(response), summary, board);
      if (vacancy === null) {
        invalidCount += 1;
        complete = false;
      } else {
        vacancies.push(vacancy);
      }
    }

    return { vacancies, complete, requestCount, invalidCount };
  }
}
