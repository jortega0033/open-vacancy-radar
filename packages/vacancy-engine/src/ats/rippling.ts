import type {
  AdapterResult,
  CareerSourceDescriptor,
  NormalizedVacancy,
  VacancyAdapter,
  WorkplaceMode,
} from '../domain/models.js';
import type { AtsHttpClient } from './http.js';
import { AtsResponseError, requireSuccessfulResponse } from './http.js';
import {
  decodeEscapedMarkup,
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

const provider = 'rippling' as const;

/**
 * Undocumented Rippling ATS board API, confirmed live against several public Rippling-hosted
 * boards (including Rippling's own `ats.rippling.com/rippling/jobs`) while building this adapter:
 *
 *  - `GET {API_ROOT}/board/{slug}/jobs` lists postings. Without `groupJobsByLocation=true` a
 *    posting open in N locations is returned as N rows that share one `id` (uuid) and each carry a
 *    single-element `locations` array -- confirmed live on a real board with a two-location
 *    posting. Passing `groupJobsByLocation=true` makes the server return one row per posting with
 *    every location folded into that row's `locations` array, but since this is unauthenticated
 *    and undocumented behaviour with no stability guarantee, the adapter also groups by `id`
 *    itself instead of trusting the parameter alone -- see `RipplingAdapter.listVacancies` and the
 *    "groups a posting open in multiple locations into a single vacancy" test.
 *  - `GET {API_ROOT}/board/{slug}/jobs/{uuid}` returns full posting detail: confirmed live to
 *    include `description` (an object of HTML sections rather than one field), `workLocations`
 *    (plural, an array of display strings), `employmentType` ({label, id}, where `id` is
 *    confusingly the human label and `label` the machine code), `createdOn`, and `payRangeDetails`
 *    (present on some postings, empty on others). There is no documented bulk "everything" call
 *    analogous to Greenhouse's `content=true`, so full detail is one list call plus one detail call
 *    per posting; `#maxDetails` bounds that fan-out the same way the SmartRecruiters and Workday
 *    adapters already bound theirs.
 *  - Detail responses were observed live with `Cache-Control: no-store` and no `ETag` or
 *    `Last-Modified`, so the shared conditional-GET HTTP cache (see `crawler/http-cache.ts`) cannot
 *    revalidate them cheaply; there is nothing in this codebase that tracks "postings already seen"
 *    across adapter runs (vacancy content hashing in `vacancies/hash.ts` only runs after a detail
 *    fetch has already produced a full `NormalizedVacancy`), so per-posting detail fetches cannot be
 *    skipped for known-unchanged postings without inventing new persisted state. `#maxDetails` is
 *    the existing, precedented way this codebase already bounds N+1 ATS fan-out.
 */
const API_ROOT = 'https://ats.rippling.com/api/v2';

export type RipplingAdapterOptions = Partial<PaginationOptions> & {
  maxDetails?: number;
};

type PostingSummary = {
  uuid: string;
  workplaceTypes: Set<string>;
};

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): string[] => {
    const text = optionalString(entry);
    return text === null ? [] : [text];
  });
}

function parseListPage(value: unknown): { items: unknown[]; totalPages: number | null } {
  const root = requireRecord(value, provider, 'job list');
  if (!Array.isArray(root.items)) {
    throw new AtsResponseError(provider, 'job list has an unknown response shape');
  }
  return { items: root.items, totalPages: optionalNumber(root.totalPages) };
}

/**
 * Combines the per-location `workplaceType` flags collected across every list row seen for one
 * posting's uuid (there can be more than one row -- see the module doc comment). A posting that
 * mixes onsite and remote locations is treated as hybrid, matching the precedent set by the
 * Personio and Workday adapters' own location-text heuristics for the same ambiguous case.
 */
function workplaceFromTypes(types: ReadonlySet<string>): {
  remote: boolean | null;
  workplaceMode: WorkplaceMode;
} {
  if (types.size === 0) return { remote: null, workplaceMode: 'unknown' };
  const hasRemote = types.has('REMOTE');
  const hasOnsite = types.has('ON_SITE');
  const hasHybrid = types.has('HYBRID');
  if (hasHybrid || (hasRemote && hasOnsite)) return { remote: null, workplaceMode: 'hybrid' };
  if (hasRemote) return { remote: true, workplaceMode: 'remote' };
  if (hasOnsite) return { remote: false, workplaceMode: 'onsite' };
  return { remote: null, workplaceMode: 'unknown' };
}

function descriptionText(value: unknown): string | null {
  const sections = objectOrNull(value);
  if (sections === null) return null;
  const parts: string[] = [];
  for (const rawSection of Object.values(sections)) {
    const html = optionalString(rawSection);
    if (html === null) continue;
    const text = optionalString(htmlToText(decodeEscapedMarkup(html)));
    if (text !== null) parts.push(text);
  }
  return parts.length === 0 ? null : parts.join('\n\n');
}

/** payRangeDetails is undocumented and, per live sampling, empty on most postings. */
function compensationText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const raw of value) {
    const entry = objectOrNull(raw);
    if (entry === null) continue;
    const currency = optionalString(entry.currency);
    const rangeStart = optionalNumber(entry.rangeStart);
    const rangeEnd = optionalNumber(entry.rangeEnd);
    if (currency === null || rangeStart === null || rangeEnd === null) continue;
    const frequency = optionalString(entry.frequency)?.toLowerCase() ?? null;
    const location = optionalString(entry.location);
    const amount = `${currency} ${rangeStart.toLocaleString('en-US')} to ${rangeEnd.toLocaleString('en-US')}`;
    const suffix = frequency === null ? '' : ` per ${frequency}`;
    const scope = location === null ? '' : ` (${location})`;
    parts.push(`${amount}${suffix}${scope}`);
  }
  return parts.length === 0 ? null : parts.join('; ');
}

function normalizeDetail(value: unknown, summary: PostingSummary): NormalizedVacancy | null {
  const job = objectOrNull(value);
  if (job === null || optionalBoolean(job.unlistedFromSearch) === true) return null;
  const uuid = optionalString(job.uuid) ?? summary.uuid;
  const title = optionalString(job.name);
  const url = httpUrl(job.url);
  const description = descriptionText(job.description);
  if (title === null || url === null || description === null) return null;

  const location = joinNonEmpty(stringArray(job.workLocations), ' | ');
  const mode = workplaceFromTypes(summary.workplaceTypes);
  const salary = compensationText(job.payRangeDetails);
  const employmentType =
    optionalString(objectOrNull(job.employmentType)?.id) ??
    optionalString(objectOrNull(job.employmentType)?.label);

  return makeVacancy({
    externalId: uuid,
    title,
    description: salary === null ? description : `${description}\n\nCompensation: ${salary}`,
    location,
    remote: mode.remote,
    workplaceMode: mode.workplaceMode,
    url,
    postedAt: parseDate(job.createdOn),
    employmentType,
    source: normalizedSource(provider),
  });
}

/**
 * Adapter for Rippling-hosted career boards (`ats.rippling.com/{slug}/jobs`). Rippling posting
 * pages are a client-rendered Next.js app with no JSON-LD, so the generic `json_ld` adapter cannot
 * read them; this adapter instead calls the board API the page itself calls. See the module doc
 * comment above for exactly what was confirmed live versus assumed.
 */
export class RipplingAdapter implements VacancyAdapter {
  public readonly provider = provider;
  readonly #pagination: PaginationOptions;
  readonly #maxDetails: number;

  public constructor(
    private readonly http: AtsHttpClient,
    options: RipplingAdapterOptions = {},
  ) {
    this.#pagination = validPaginationOptions(provider, options, { pageSize: 100, maxPages: 100 }, 1000);
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
    const slug = requireBoardIdentifier(source, provider);

    const summaries = new Map<string, PostingSummary>();
    let requestCount = 0;
    let invalidCount = 0;
    let listingComplete = false;

    for (let page = 0; page < this.#pagination.maxPages; page += 1) {
      const url = new URL(`${API_ROOT}/board/${encodeURIComponent(slug)}/jobs`);
      url.searchParams.set('groupJobsByLocation', 'true');
      url.searchParams.set('page', String(page));
      url.searchParams.set('pageSize', String(this.#pagination.pageSize));
      requestCount += 1;
      const response = await this.http.get(url.toString());
      requireSuccessfulResponse(provider, response);
      const parsed = parseListPage(parseJson(response.body, provider));

      for (const raw of parsed.items) {
        const job = objectOrNull(raw);
        const uuid = optionalString(job?.id);
        if (job === null || uuid === null) {
          invalidCount += 1;
          continue;
        }
        // Defensive grouping: a posting open in multiple locations may appear as more than one
        // row sharing this uuid even with groupJobsByLocation=true requested (see module doc
        // comment), so every row for a uuid is folded into one summary here rather than trusted
        // to already be grouped.
        const existing = summaries.get(uuid) ?? { uuid, workplaceTypes: new Set<string>() };
        const locations = Array.isArray(job.locations) ? job.locations : [];
        for (const rawLocation of locations) {
          const workplaceType = optionalString(objectOrNull(rawLocation)?.workplaceType);
          if (workplaceType !== null) existing.workplaceTypes.add(workplaceType.toUpperCase());
        }
        summaries.set(uuid, existing);
      }

      if (parsed.items.length === 0) {
        listingComplete = true;
        break;
      }
      if (parsed.totalPages !== null && page + 1 >= parsed.totalPages) {
        listingComplete = true;
        break;
      }
      if (parsed.items.length < this.#pagination.pageSize) {
        listingComplete = true;
        break;
      }
    }

    const selected = [...summaries.values()].slice(0, this.#maxDetails);
    let complete = listingComplete && selected.length === summaries.size && invalidCount === 0;
    const vacancies: NormalizedVacancy[] = [];
    for (const summary of selected) {
      requestCount += 1;
      const detailUrl = `${API_ROOT}/board/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(summary.uuid)}`;
      const response = await this.http.get(detailUrl);
      requireSuccessfulResponse(provider, response);
      const vacancy = normalizeDetail(parseJson(response.body, provider), summary);
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
