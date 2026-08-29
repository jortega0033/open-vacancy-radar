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
  optionalString,
  parseDate,
  parseJson,
  requireBoardIdentifier,
  validPaginationOptions,
  type PaginationOptions,
} from './shared.js';

const provider = 'lever' as const;

type LeverAdapterOptions = Partial<PaginationOptions>;

function apiOrigin(source: CareerSourceDescriptor): string {
  try {
    const hostname = new URL(source.baseUrl).hostname.toLowerCase();
    return hostname === 'jobs.eu.lever.co' || hostname === 'api.eu.lever.co'
      ? 'https://api.eu.lever.co'
      : 'https://api.lever.co';
  } catch {
    throw new AtsResponseError(provider, 'baseUrl is invalid');
  }
}

function normalizeLists(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const heading = optionalString(record.text);
    const content = optionalString(record.content);
    return content === null ? [] : [heading === null ? content : `<h3>${heading}</h3>${content}`];
  });
}

function normalizeJob(value: unknown): NormalizedVacancy | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const job = value as Record<string, unknown>;
  const id = optionalString(job.id);
  const title = optionalString(job.text);
  const categories =
    typeof job.categories === 'object' && job.categories !== null && !Array.isArray(job.categories)
      ? (job.categories as Record<string, unknown>)
      : {};
  const descriptionParts = [
    optionalString(job.descriptionPlain) ?? optionalString(job.description),
    ...normalizeLists(job.lists),
    optionalString(job.additionalPlain) ?? optionalString(job.additional),
  ];
  const description = joinNonEmpty(descriptionParts, '\n');
  const url = httpUrl(job.hostedUrl);
  if (id === null || title === null || description === null || url === null) return null;

  const allLocations = Array.isArray(categories.allLocations)
    ? categories.allLocations.map((location) => optionalString(location)).filter((location): location is string => location !== null)
    : [];
  const workplaceType = optionalString(job.workplaceType)?.toLowerCase() ?? null;
  const workplaceMode =
    workplaceType === 'remote'
      ? 'remote'
      : workplaceType === 'hybrid'
        ? 'hybrid'
        : ['on-site', 'onsite'].includes(workplaceType ?? '')
          ? 'onsite'
          : 'unknown';
  const remote = workplaceMode === 'remote' ? true : workplaceMode === 'onsite' ? false : null;
  return makeVacancy({
    externalId: id,
    title,
    description: htmlToText(description),
    location: joinNonEmpty([optionalString(categories.location), ...allLocations]),
    remote,
    workplaceMode,
    url,
    postedAt: parseDate(job.createdAt),
    employmentType: optionalString(categories.commitment),
    source: normalizedSource(provider),
  });
}

function pageSignature(entries: unknown[]): string {
  return entries
    .map((entry) =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry)
        ? optionalString((entry as Record<string, unknown>).id) ?? '?'
        : '?',
    )
    .join('\u0000');
}

export class LeverAdapter implements VacancyAdapter {
  public readonly provider = provider;
  readonly #pagination: PaginationOptions;

  public constructor(
    private readonly http: AtsHttpClient,
    options: LeverAdapterOptions = {},
  ) {
    this.#pagination = validPaginationOptions(provider, options, { pageSize: 100, maxPages: 100 }, 100);
  }

  public supports(source: CareerSourceDescriptor): boolean {
    return source.provider === provider && Boolean(source.boardIdentifier?.trim());
  }

  public async listVacancies(source: CareerSourceDescriptor): Promise<AdapterResult> {
    if (!this.supports(source)) throw new AtsResponseError(provider, 'source is not supported');
    const site = requireBoardIdentifier(source, provider);
    const origin = apiOrigin(source);
    const byId = new Map<string, NormalizedVacancy>();
    const signatures = new Set<string>();
    let requestCount = 0;
    let invalidCount = 0;
    let complete = false;

    for (let page = 0; page < this.#pagination.maxPages; page += 1) {
      const skip = page * this.#pagination.pageSize;
      const url = `${origin}/v0/postings/${encodeURIComponent(site)}?mode=json&skip=${skip}&limit=${this.#pagination.pageSize}`;
      requestCount += 1;
      const response = await this.http.get(url);
      requireSuccessfulResponse(provider, response);
      const payload = parseJson(response.body, provider);
      if (!Array.isArray(payload)) {
        throw new AtsResponseError(provider, 'job list has an unknown response shape');
      }
      const signature = pageSignature(payload);
      if (signatures.has(signature)) break;
      signatures.add(signature);

      for (const entry of payload) {
        const vacancy = normalizeJob(entry);
        if (vacancy !== null) byId.set(vacancy.externalId, vacancy);
        else invalidCount += 1;
      }
      if (payload.length < this.#pagination.pageSize) {
        complete = true;
        break;
      }
    }

    return {
      vacancies: [...byId.values()],
      complete: complete && invalidCount === 0,
      requestCount,
      invalidCount,
    };
  }
}
