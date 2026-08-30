import * as cheerio from 'cheerio';

import type {
  AdapterResult,
  CareerSourceDescriptor,
  NormalizedVacancy,
  VacancyAdapter,
} from '../domain/models.js';
import { isRecognizableAccessChallenge } from './company-site.js';
import { extractJsonLdVacanciesWithDiagnostics } from './json-ld.js';
import type { AtsHttpClient, AtsHttpResponse } from './http.js';
import { AtsResponseError, requireSuccessfulResponse } from './http.js';
import {
  htmlToText,
  joinNonEmpty,
  makeVacancy,
  normalizedSource,
  optionalString,
  parseDate,
  requireBoardIdentifier,
} from './shared.js';

const provider = 'successfactors' as const;
const DEFAULT_MAX_DETAILS = 500;
const ABSOLUTE_MAX_DETAILS = 1_000;
const SITEMAP_PATH = '/job_sitemap.xml';
const ACCESS_DENIAL_STATUSES = new Set([401, 403, 407, 429, 451]);

export type SuccessFactorsAdapterOptions = {
  maxDetails?: number;
};

type SuccessFactorsBoard = {
  origin: string;
  sitemapUrl: string;
};

type SuccessFactorsJobUrl = {
  externalId: string;
  locale: string | null;
  url: string;
};

type SitemapEntry = {
  requestedUrl: string;
  postedAt: Date | null;
};

type SitemapResult = {
  entries: SitemapEntry[];
  invalidCount: number;
};

type DetailResult = {
  vacancy: NormalizedVacancy | null;
  invalidCount: number;
};

function responseHeader(response: AtsHttpResponse, name: string): string | null {
  const expected = name.toLowerCase();
  return (
    Object.entries(response.headers).find(([key]) => key.toLowerCase() === expected)?.[1] ?? null
  );
}

function exactHttpsUrl(value: string): URL | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === 'https:' && url.username === '' && url.password === '' && url.port === ''
    ? url
    : null;
}

function parseBoard(source: CareerSourceDescriptor): SuccessFactorsBoard | null {
  if (source.provider !== provider) return null;
  const baseUrl = exactHttpsUrl(source.baseUrl);
  const identifier = source.boardIdentifier?.trim();
  if (
    baseUrl === null ||
    identifier === undefined ||
    identifier.length === 0 ||
    identifier !== identifier.toLowerCase() ||
    identifier !== baseUrl.hostname.toLowerCase() ||
    baseUrl.pathname !== '/' ||
    baseUrl.search !== '' ||
    baseUrl.hash !== ''
  ) {
    return null;
  }
  return {
    origin: baseUrl.origin,
    sitemapUrl: new URL(SITEMAP_PATH, baseUrl.origin).toString(),
  };
}

function normalizedLocale(value: string | undefined): string | null {
  if (value === undefined) return null;
  const [language, region] = value.split('_');
  if (language === undefined) return null;
  return region === undefined
    ? language.toLowerCase()
    : `${language.toLowerCase()}_${region.toUpperCase()}`;
}

function parseJobUrl(value: string, board: SuccessFactorsBoard): SuccessFactorsJobUrl | null {
  const url = exactHttpsUrl(value);
  if (url === null || url.origin !== board.origin || url.search !== '' || url.hash !== '') {
    return null;
  }
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
  const jobIndex = segments.findIndex((segment) => segment.toLowerCase() === 'job');
  if (jobIndex < 0 || jobIndex >= segments.length - 2) return null;
  const tail = segments.at(-1);
  const match =
    tail === undefined ? null : /^(?<id>\d+)(?:-(?<locale>[a-z]{2}(?:_[a-z]{2})?))?$/iu.exec(tail);
  const externalId = match?.groups?.id;
  if (externalId === undefined) return null;
  const locale = normalizedLocale(match?.groups?.locale);
  const canonicalTail = locale === null ? externalId : `${externalId}-${locale}`;
  segments[segments.length - 1] = canonicalTail;
  url.pathname = `/${segments.join('/')}/`;
  return { externalId, locale, url: url.toString() };
}

function validateResponse(
  response: AtsHttpResponse,
  board: SuccessFactorsBoard,
  context: 'sitemap' | 'job detail',
): URL {
  requireSuccessfulResponse(provider, response);
  const finalUrl = exactHttpsUrl(response.finalUrl);
  if (finalUrl === null || finalUrl.origin !== board.origin) {
    throw new AtsResponseError(provider, `${context} redirected outside the configured origin`);
  }
  if (isRecognizableAccessChallenge(response.body)) {
    throw new AtsResponseError(provider, `${context} returned an access challenge`, 403);
  }
  const contentType = responseHeader(response, 'content-type')?.toLowerCase() ?? '';
  if (
    contentType.length > 0 &&
    (context === 'sitemap'
      ? !contentType.includes('xml') && !contentType.includes('text/plain')
      : !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml'))
  ) {
    throw new AtsResponseError(provider, `${context} returned an unexpected content type`);
  }
  return finalUrl;
}

function parseSitemap(response: AtsHttpResponse, board: SuccessFactorsBoard): SitemapResult {
  const finalUrl = validateResponse(response, board, 'sitemap');
  if (finalUrl.pathname !== SITEMAP_PATH || finalUrl.search !== '' || finalUrl.hash !== '') {
    throw new AtsResponseError(provider, 'sitemap redirected away from the documented path');
  }
  const $ = cheerio.load(response.body, { xmlMode: true });
  const root = $('urlset').first();
  if (root.length === 0 || root.parent().is('urlset')) {
    throw new AtsResponseError(provider, 'sitemap has an unknown response shape');
  }

  const entries: SitemapEntry[] = [];
  const seen = new Set<string>();
  let invalidCount = 0;
  for (const node of root.children('url').toArray()) {
    const item = $(node);
    const rawUrl = optionalString(item.children('loc').first().text());
    const parsedUrl = rawUrl === null ? null : parseJobUrl(rawUrl, board);
    if (parsedUrl === null) {
      invalidCount += 1;
      continue;
    }
    if (seen.has(parsedUrl.url)) {
      invalidCount += 1;
      continue;
    }
    seen.add(parsedUrl.url);
    const rawLastModified = optionalString(item.children('lastmod').first().text());
    const postedAt = parseDate(rawLastModified);
    if (rawLastModified !== null && postedAt === null) invalidCount += 1;
    entries.push({ requestedUrl: parsedUrl.url, postedAt });
  }
  return { entries, invalidCount };
}

function propertyValue(
  $: cheerio.CheerioAPI,
  container: ReturnType<cheerio.CheerioAPI>,
  property: string,
): string | null {
  for (const node of container.find(`[itemprop="${property}"]`).toArray()) {
    const element = $(node);
    const value =
      optionalString(element.attr('content')) ??
      optionalString(element.attr('datetime')) ??
      optionalString(element.text());
    if (value !== null) return value;
  }
  return null;
}

function richestDescription(
  $: cheerio.CheerioAPI,
  container: ReturnType<cheerio.CheerioAPI>,
): string | null {
  let richest: { html: string; length: number } | null = null;
  for (const node of container.find('[itemprop="description"]').toArray()) {
    const rawHtml = optionalString($(node).html());
    if (rawHtml === null) continue;
    const length = htmlToText(rawHtml).length;
    if (length > 0 && (richest === null || length > richest.length)) {
      richest = { html: rawHtml, length };
    }
  }
  return richest?.html ?? null;
}

function microdataVacancy(
  html: string,
  jobUrl: SuccessFactorsJobUrl,
  postedAt: Date | null,
): NormalizedVacancy | null {
  const $ = cheerio.load(html);
  const container = $('[itemscope][itemtype]')
    .filter((_index, element) => {
      const itemType = ($(element).attr('itemtype') ?? '').toLowerCase();
      return /(?:schema\.org|schema\.org\/docs)\/jobposting\/?$/u.test(itemType);
    })
    .first();
  if (container.length === 0) return null;
  const title =
    propertyValue($, container, 'title') ??
    optionalString($('meta[property="og:title"]').first().attr('content'));
  const descriptionHtml = richestDescription($, container);
  if (title === null || descriptionHtml === null) return null;

  const location = joinNonEmpty([
    propertyValue($, container, 'streetAddress'),
    propertyValue($, container, 'postalCode'),
    propertyValue($, container, 'addressLocality'),
    propertyValue($, container, 'addressRegion'),
    propertyValue($, container, 'addressCountry'),
  ]);
  const rawMode = propertyValue($, container, 'jobLocationType')?.toLowerCase() ?? '';
  const workplaceMode = rawMode.includes('hybrid')
    ? 'hybrid'
    : rawMode.includes('telecommute') || rawMode.includes('remote')
      ? 'remote'
      : rawMode.includes('onsite') || rawMode.includes('on-site')
        ? 'onsite'
        : 'unknown';
  const remote = workplaceMode === 'remote' ? true : workplaceMode === 'onsite' ? false : null;
  return makeVacancy({
    externalId: jobUrl.externalId,
    title,
    description: htmlToText(descriptionHtml),
    location,
    remote,
    workplaceMode,
    url: jobUrl.url,
    postedAt: parseDate(propertyValue($, container, 'datePosted')) ?? postedAt,
    employmentType: propertyValue($, container, 'employmentType'),
    source: normalizedSource(provider),
  });
}

function canonicalJobUrl(
  html: string,
  finalUrl: URL,
  board: SuccessFactorsBoard,
): SuccessFactorsJobUrl | null {
  const $ = cheerio.load(html);
  const rawCanonical = optionalString($('link[rel~="canonical"]').first().attr('href'));
  if (rawCanonical === null) return parseJobUrl(finalUrl.toString(), board);
  let canonical: URL;
  try {
    canonical = new URL(rawCanonical, finalUrl);
  } catch {
    return null;
  }
  return parseJobUrl(canonical.toString(), board);
}

function parseDetail(
  response: AtsHttpResponse,
  board: SuccessFactorsBoard,
  entry: SitemapEntry,
): DetailResult {
  const finalUrl = validateResponse(response, board, 'job detail');
  if (parseJobUrl(finalUrl.toString(), board) === null) {
    return { vacancy: null, invalidCount: 1 };
  }
  const jobUrl = canonicalJobUrl(response.body, finalUrl, board);
  if (jobUrl === null) return { vacancy: null, invalidCount: 1 };

  const jsonLd = extractJsonLdVacanciesWithDiagnostics(response.body, finalUrl.toString(), {
    source: provider,
    allowedOrigins: [board.origin],
  });
  const diagnosticCount = jsonLd.invalidNodes + jsonLd.duplicateNodes + jsonLd.malformedScripts;
  const structured = jsonLd.vacancies[0];
  if (structured !== undefined) {
    const vacancy = makeVacancy({
      ...structured,
      externalId: jobUrl.externalId,
      url: jobUrl.url,
      postedAt: structured.postedAt ?? entry.postedAt,
      source: normalizedSource(provider),
    });
    return {
      vacancy,
      invalidCount:
        diagnosticCount + (jsonLd.vacancies.length > 1 ? jsonLd.vacancies.length - 1 : 0),
    };
  }
  return {
    vacancy: microdataVacancy(response.body, jobUrl, entry.postedAt),
    invalidCount: diagnosticCount,
  };
}

function isAccessDenial(error: unknown): boolean {
  return (
    error instanceof AtsResponseError &&
    error.status !== null &&
    ACCESS_DENIAL_STATUSES.has(error.status)
  );
}

/**
 * Public Career Site Builder adapter. SAP career sites expose a job sitemap at
 * `/job_sitemap.xml`; every selected entry is loaded once, sequentially, and
 * only on the exact configured origin. A bound or malformed entry revokes the
 * authoritative-complete claim, and access challenges stop the source.
 */
export class SuccessFactorsAdapter implements VacancyAdapter {
  public readonly provider = provider;
  readonly #maxDetails: number;

  public constructor(
    private readonly http: AtsHttpClient,
    options: SuccessFactorsAdapterOptions = {},
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
    return parseBoard(source) !== null;
  }

  public async listVacancies(source: CareerSourceDescriptor): Promise<AdapterResult> {
    if (!this.supports(source)) {
      throw new AtsResponseError(
        provider,
        'source requires an exact HTTPS career-site origin and matching lowercase hostname',
      );
    }
    requireBoardIdentifier(source, provider);
    const board = parseBoard(source);
    if (board === null) throw new AtsResponseError(provider, 'source boundary is invalid');

    let requestCount = 1;
    const requestOptions = { allowedOrigins: [board.origin] } as const;
    const sitemapResponse = await this.http.get(board.sitemapUrl, requestOptions);
    const sitemap = parseSitemap(sitemapResponse, board);
    const capped = sitemap.entries.length > this.#maxDetails;
    const selected = sitemap.entries.slice(0, this.#maxDetails);
    const vacancies = new Map<string, NormalizedVacancy>();
    let invalidCount = sitemap.invalidCount;
    let complete = !capped && invalidCount === 0;

    for (const entry of selected) {
      requestCount += 1;
      try {
        const response = await this.http.get(entry.requestedUrl, requestOptions);
        const detail = parseDetail(response, board, entry);
        invalidCount += detail.invalidCount;
        if (detail.vacancy === null) {
          invalidCount += 1;
          complete = false;
          continue;
        }
        vacancies.set(detail.vacancy.externalId, detail.vacancy);
        if (detail.invalidCount > 0) complete = false;
      } catch (error) {
        if (isAccessDenial(error)) throw error;
        invalidCount += 1;
        complete = false;
      }
    }

    return {
      vacancies: [...vacancies.values()],
      complete: complete && invalidCount === 0,
      requestCount,
      invalidCount,
    };
  }
}
