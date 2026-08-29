import type {
  AdapterResult,
  CareerSourceDescriptor,
  NormalizedVacancy,
  VacancyAdapter,
} from '../domain/models.js';
import type { AtsHttpClient } from './http.js';
import { AtsResponseError, requireSuccessfulResponse } from './http.js';
import {
  htmlToText,
  httpUrl,
  joinNonEmpty,
  makeVacancy,
  normalizedSource,
  optionalBoolean,
  optionalNumber,
  optionalString,
  parseDate,
  parseJson,
  requireBoardIdentifier,
  requireRecord,
  validPaginationOptions,
  type PaginationOptions,
} from './shared.js';

const provider = 'smartrecruiters' as const;

type SmartRecruitersAdapterOptions = Partial<PaginationOptions> & {
  maxDetails?: number;
};

type PostingSummary = {
  id: string;
  raw: Record<string, unknown>;
};

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function labelledValue(value: unknown): string | null {
  if (typeof value === 'string') return optionalString(value);
  const record = objectOrNull(value);
  return optionalString(record?.label) ?? optionalString(record?.name);
}

function descriptionFromSections(value: unknown): string | null {
  const sections = objectOrNull(value);
  if (sections === null) return null;
  const parts: string[] = [];
  for (const sectionValue of Object.values(sections)) {
    if (typeof sectionValue === 'string') {
      const text = optionalString(sectionValue);
      if (text !== null) parts.push(text);
      continue;
    }
    const section = objectOrNull(sectionValue);
    const title = optionalString(section?.title);
    const text = optionalString(section?.text) ?? optionalString(section?.content);
    if (text !== null) parts.push(title === null ? text : `<h2>${title}</h2>${text}`);
  }
  return parts.length === 0 ? null : parts.join('\n');
}

function normalizeDetail(detailValue: unknown, summary: PostingSummary): NormalizedVacancy | null {
  const detail = objectOrNull(detailValue);
  if (detail === null) return null;
  const id = optionalString(detail.id) ?? summary.id;
  const title = optionalString(detail.name) ?? optionalString(summary.raw.name);
  const jobAd = objectOrNull(detail.jobAd);
  const descriptionHtml = descriptionFromSections(jobAd?.sections);
  const url = httpUrl(detail.postingUrl) ?? httpUrl(detail.applyUrl);
  if (id.length === 0 || title === null || descriptionHtml === null || url === null) return null;

  const location = objectOrNull(detail.location) ?? objectOrNull(summary.raw.location);
  const remoteFlag = optionalBoolean(location?.remote);
  const hybridFlag = optionalBoolean(location?.hybrid);
  const remote = remoteFlag === true ? true : hybridFlag === true ? null : remoteFlag;
  const workplaceMode =
    remoteFlag === true
      ? 'remote'
      : hybridFlag === true
        ? 'hybrid'
        : remoteFlag === false
          ? 'onsite'
          : 'unknown';
  return makeVacancy({
    externalId: id,
    title,
    description: htmlToText(descriptionHtml),
    location:
      optionalString(location?.fullLocation) ??
      joinNonEmpty([
        optionalString(location?.city),
        optionalString(location?.region),
        optionalString(location?.country),
      ]),
    remote,
    workplaceMode,
    url,
    postedAt: parseDate(detail.releasedDate ?? summary.raw.releasedDate),
    employmentType: labelledValue(detail.typeOfEmployment ?? summary.raw.typeOfEmployment),
    source: normalizedSource(provider),
  });
}

function parseListPage(value: unknown): {
  totalFound: number;
  content: unknown[];
} {
  const root = requireRecord(value, provider, 'posting list');
  const offset = optionalNumber(root.offset);
  const limit = optionalNumber(root.limit);
  const totalFound = optionalNumber(root.totalFound);
  if (
    offset === null ||
    limit === null ||
    totalFound === null ||
    offset < 0 ||
    limit < 0 ||
    totalFound < 0 ||
    !Array.isArray(root.content)
  ) {
    throw new AtsResponseError(provider, 'posting list has an unknown response shape');
  }
  return { totalFound, content: root.content };
}

export class SmartRecruitersAdapter implements VacancyAdapter {
  public readonly provider = provider;
  readonly #pagination: PaginationOptions;
  readonly #maxDetails: number;

  public constructor(
    private readonly http: AtsHttpClient,
    options: SmartRecruitersAdapterOptions = {},
  ) {
    this.#pagination = validPaginationOptions(provider, options, { pageSize: 100, maxPages: 100 }, 100);
    this.#maxDetails = options.maxDetails ?? 500;
    if (!Number.isInteger(this.#maxDetails) || this.#maxDetails < 1) {
      throw new AtsResponseError(provider, 'maxDetails must be a positive integer');
    }
  }

  public supports(source: CareerSourceDescriptor): boolean {
    return source.provider === provider && Boolean(source.boardIdentifier?.trim());
  }

  public async listVacancies(source: CareerSourceDescriptor): Promise<AdapterResult> {
    if (!this.supports(source)) throw new AtsResponseError(provider, 'source is not supported');
    const companyIdentifier = requireBoardIdentifier(source, provider);
    const summaries = new Map<string, PostingSummary>();
    const signatures = new Set<string>();
    let requestCount = 0;
    let listingComplete = false;
    let invalidCount = 0;

    for (let page = 0; page < this.#pagination.maxPages; page += 1) {
      const offset = page * this.#pagination.pageSize;
      const url = new URL(
        `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(companyIdentifier)}/postings`,
      );
      url.searchParams.set('destination', 'PUBLIC');
      url.searchParams.set('limit', String(this.#pagination.pageSize));
      url.searchParams.set('offset', String(offset));
      requestCount += 1;
      const response = await this.http.get(url.toString());
      requireSuccessfulResponse(provider, response);
      const pageResult = parseListPage(parseJson(response.body, provider));
      const pageSummaries = pageResult.content.flatMap((entry): PostingSummary[] => {
        const raw = objectOrNull(entry);
        const id = optionalString(raw?.id);
        if (raw === null || id === null) {
          invalidCount += 1;
          return [];
        }
        return [{ id, raw }];
      });
      const signature = pageSummaries.map((summary) => summary.id).join('\u0000');
      if (signatures.has(signature)) break;
      signatures.add(signature);
      for (const summary of pageSummaries) summaries.set(summary.id, summary);

      const consumed = offset + pageResult.content.length;
      if (consumed >= pageResult.totalFound) {
        listingComplete = true;
        break;
      }
      if (pageResult.content.length === 0) break;
    }

    const selectedSummaries = [...summaries.values()].slice(0, this.#maxDetails);
    let complete =
      listingComplete && selectedSummaries.length === summaries.size && invalidCount === 0;
    const vacancies: NormalizedVacancy[] = [];
    for (const summary of selectedSummaries) {
      const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(companyIdentifier)}/postings/${encodeURIComponent(summary.id)}`;
      requestCount += 1;
      const response = await this.http.get(url);
      requireSuccessfulResponse(provider, response);
      const parsed = parseJson(response.body, provider);
      const vacancy = normalizeDetail(parsed, summary);
      if (vacancy === null) {
        complete = false;
        invalidCount += 1;
      }
      else vacancies.push(vacancy);
    }

    return { vacancies, complete, requestCount, invalidCount };
  }
}
