import * as cheerio from 'cheerio';

import type {
  AdapterResult,
  CareerSourceDescriptor,
  NormalizedVacancy,
  VacancyAdapter,
} from '../domain/models.js';
import { extractJsonLdVacanciesWithDiagnostics } from './json-ld.js';
import type { AtsHttpClient, AtsHttpResponse } from './http.js';
import { AtsResponseError, requireSuccessfulResponse } from './http.js';
import { httpUrl, requireBoardIdentifier } from './shared.js';

const provider = 'json_ld' as const;
const DEFAULT_MAX_DETAILS = 100;
const ABSOLUTE_MAX_DETAILS = 500;
const ACCESS_CHALLENGE_PATTERN =
  /(?:cf-chl-|cdn-cgi\/challenge-platform|cloudflare\s+ray\s+id|just\s+a\s+moment.{0,120}cloudflare|enable\s+javascript\s+and\s+cookies\s+to\s+continue)/isu;
const PAGINATION_TEXT_PATTERN =
  /^(?:next|next page|load more|show more|volgende|meer vacatures)(?:\s*[›»→>])?$/iu;

export function isRecognizableAccessChallenge(html: string): boolean {
  return ACCESS_CHALLENGE_PATTERN.test(html);
}

export type CompanySiteJsonLdAdapterOptions = {
  maxDetails?: number;
};

type SourceBoundary = {
  seedUrl: URL;
  detailPrefix: URL;
  normalizedPrefixPath: string;
};

function safeHttpUrl(value: string, baseUrl?: string): URL | null {
  const normalized = httpUrl(value, baseUrl);
  return normalized === null ? null : new URL(normalized);
}

function sourceBoundary(source: CareerSourceDescriptor): SourceBoundary | null {
  const seedUrl = safeHttpUrl(source.baseUrl);
  const identifier = source.boardIdentifier?.trim();
  if (seedUrl === null || identifier === undefined || identifier.length === 0) return null;
  const detailPrefix = safeHttpUrl(identifier, seedUrl.toString());
  if (detailPrefix === null) return null;
  if (
    detailPrefix.origin !== seedUrl.origin ||
    detailPrefix.search.length > 0 ||
    detailPrefix.hash.length > 0
  ) {
    return null;
  }
  const normalizedPrefixPath = detailPrefix.pathname.replace(/\/+$/u, '');
  if (normalizedPrefixPath.length === 0) return null;
  return { seedUrl, detailPrefix, normalizedPrefixPath };
}

function pathMatchesPrefix(pathname: string, normalizedPrefixPath: string): boolean {
  return pathname === normalizedPrefixPath || pathname.startsWith(`${normalizedPrefixPath}/`);
}

function isWithinDetailBoundary(url: URL, boundary: SourceBoundary): boolean {
  return (
    url.origin === boundary.detailPrefix.origin &&
    pathMatchesPrefix(url.pathname, boundary.normalizedPrefixPath)
  );
}

function responseHeader(response: AtsHttpResponse, name: string): string | null {
  const expected = name.toLowerCase();
  const entry = Object.entries(response.headers).find(([key]) => key.toLowerCase() === expected);
  return entry?.[1] ?? null;
}

function validateHtmlResponse(response: AtsHttpResponse, context: string): URL {
  requireSuccessfulResponse(provider, response);
  const finalUrl = safeHttpUrl(response.finalUrl);
  if (finalUrl === null) throw new AtsResponseError(provider, `${context} returned an unsafe final URL`);
  const contentType = responseHeader(response, 'content-type');
  if (
    contentType !== null &&
    !contentType.toLowerCase().includes('text/html') &&
    !contentType.toLowerCase().includes('application/xhtml+xml')
  ) {
    throw new AtsResponseError(provider, `${context} did not return HTML`);
  }
  if (isRecognizableAccessChallenge(response.body)) {
    throw new AtsResponseError(provider, `${context} returned an access challenge`, 403);
  }
  return finalUrl;
}

function discoverDetailLinks(
  html: string,
  pageUrl: URL,
  boundary: SourceBoundary,
): { urls: string[]; disallowed: number; paginationSignals: number } {
  const $ = cheerio.load(html);
  const urls = new Set<string>();
  let disallowed = 0;
  let paginationSignals = 0;
  $('a[href]').each((_index, anchor) => {
    const element = $(anchor);
    const candidate = safeHttpUrl(element.attr('href') ?? '', pageUrl.toString());
    const relTokens = (element.attr('rel') ?? '').toLowerCase().split(/\s+/u);
    const visibleText = element.text().replace(/\s+/gu, ' ').trim();
    if (
      relTokens.includes('next') ||
      PAGINATION_TEXT_PATTERN.test(visibleText) ||
      (candidate !== null &&
        candidate.origin === pageUrl.origin &&
        ((candidate.pathname === pageUrl.pathname && candidate.search !== pageUrl.search) ||
          /(?:^|\/)page\/\d+\/?$/iu.test(candidate.pathname)))
    ) {
      paginationSignals += 1;
    }
    if (
      candidate === null ||
      !pathMatchesPrefix(candidate.pathname, boundary.normalizedPrefixPath)
    ) {
      return;
    }
    if (candidate.origin !== boundary.detailPrefix.origin) {
      disallowed += 1;
      return;
    }
    candidate.hash = '';
    if (candidate.toString() !== pageUrl.toString()) urls.add(candidate.toString());
  });
  $('link[rel~="next"][href], [data-next-page], [data-load-more]').each(() => {
    paginationSignals += 1;
  });
  $('button, [role="button"]').each((_index, button) => {
    if (PAGINATION_TEXT_PATTERN.test($(button).text().replace(/\s+/gu, ' ').trim())) {
      paginationSignals += 1;
    }
  });
  return { urls: [...urls].sort(), disallowed, paginationSignals };
}

/**
 * Bounded official-site fallback: one curated listing page, one same-origin
 * detail-path prefix, and one level of JSON-LD JobPosting detail pages.
 */
export class CompanySiteJsonLdAdapter implements VacancyAdapter {
  public readonly provider = provider;
  readonly #maxDetails: number;

  public constructor(
    private readonly http: AtsHttpClient,
    options: CompanySiteJsonLdAdapterOptions = {},
  ) {
    this.#maxDetails = options.maxDetails ?? DEFAULT_MAX_DETAILS;
    if (
      !Number.isInteger(this.#maxDetails) ||
      this.#maxDetails < 1 ||
      this.#maxDetails > ABSOLUTE_MAX_DETAILS
    ) {
      throw new AtsResponseError(
        provider,
        `maxDetails must be between 1 and ${ABSOLUTE_MAX_DETAILS}`,
      );
    }
  }

  public supports(source: CareerSourceDescriptor): boolean {
    return source.provider === provider && sourceBoundary(source) !== null;
  }

  public async listVacancies(source: CareerSourceDescriptor): Promise<AdapterResult> {
    if (!this.supports(source)) {
      throw new AtsResponseError(
        provider,
        'source requires an exact HTTP(S) careers seed and same-origin detail URL prefix',
      );
    }
    // Keep the explicit requirement close to the execution path as well as supports().
    requireBoardIdentifier(source, provider);
    const boundary = sourceBoundary(source);
    if (boundary === null) throw new AtsResponseError(provider, 'source boundary is invalid');

    let requestCount = 1;
    const requestOptions = { allowedOrigins: [boundary.seedUrl.origin] } as const;
    const listingResponse = await this.http.get(boundary.seedUrl.toString(), requestOptions);
    const listingFinalUrl = validateHtmlResponse(listingResponse, 'careers listing');
    if (listingFinalUrl.origin !== boundary.seedUrl.origin) {
      throw new AtsResponseError(
        provider,
        'careers listing redirected outside the configured origin',
      );
    }

    const discovered = discoverDetailLinks(
      listingResponse.body,
      listingFinalUrl,
      boundary,
    );
    // Equality is deliberately conservative: reaching the configured ceiling is
    // enough to withhold an authoritative complete-feed claim.
    const capped = discovered.urls.length >= this.#maxDetails;
    const selectedUrls = discovered.urls.slice(0, this.#maxDetails);
    const vacanciesById = new Map<string, NormalizedVacancy>();
    const detailByExternalId = new Map<string, string>();
    let invalidCount = discovered.disallowed;

    for (const detailUrl of selectedUrls) {
      requestCount += 1;
      const response = await this.http.get(detailUrl, requestOptions);
      const finalUrl = validateHtmlResponse(response, 'vacancy detail');
      if (!isWithinDetailBoundary(finalUrl, boundary)) {
        invalidCount += 1;
        continue;
      }
      const extraction = extractJsonLdVacanciesWithDiagnostics(
        response.body,
        finalUrl.toString(),
        {
          source: provider,
          allowedOrigins: [boundary.seedUrl.origin],
        },
      );
      invalidCount +=
        extraction.invalidNodes + extraction.duplicateNodes + extraction.malformedScripts;
      if (extraction.jobPostingNodes === 0) invalidCount += 1;
      for (const vacancy of extraction.vacancies) {
        const vacancyUrl = safeHttpUrl(vacancy.url);
        if (vacancyUrl === null || !isWithinDetailBoundary(vacancyUrl, boundary)) {
          invalidCount += 1;
          continue;
        }
        const previousDetail = detailByExternalId.get(vacancy.externalId);
        if (previousDetail !== undefined && previousDetail !== finalUrl.toString()) {
          invalidCount += 1;
          continue;
        }
        detailByExternalId.set(vacancy.externalId, finalUrl.toString());
        vacanciesById.set(vacancy.externalId, vacancy);
      }
    }

    const complete =
      source.lifecycleAuthoritative === true &&
      discovered.urls.length > 0 &&
      !capped &&
      discovered.disallowed === 0 &&
      discovered.paginationSignals === 0 &&
      invalidCount === 0;
    return {
      vacancies: [...vacanciesById.values()],
      complete,
      requestCount,
      invalidCount,
    };
  }
}
