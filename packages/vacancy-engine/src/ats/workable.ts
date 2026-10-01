import type {
  AdapterResult,
  CareerSourceDescriptor,
  NormalizedVacancy,
  VacancyAdapter,
  WorkplaceMode,
} from '../domain/models.js';
import type { AtsHttpClient } from './http.js';
import { detectWorkableSource } from './detection.js';
import { AtsResponseError, requireSuccessfulResponse } from './http.js';
import {
  htmlToText,
  httpUrl,
  joinNonEmpty,
  makeVacancy,
  normalizedSource,
  optionalBoolean,
  optionalString,
  parseDate,
  parseJson,
  requireBoardIdentifier,
  requireRecord,
} from './shared.js';

const provider = 'workable' as const;
const validAccount = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(records: readonly Record<string, unknown>[], key: string): string | null {
  for (const value of records) {
    const candidate = optionalString(value[key]);
    if (candidate !== null) return candidate;
  }
  return null;
}

function firstUrl(records: readonly Record<string, unknown>[]): string | null {
  for (const job of records) {
    const url = httpUrl(job.url) ?? httpUrl(job.shortlink) ?? httpUrl(job.application_url);
    if (url !== null) return url;
  }
  return null;
}

function locationText(value: unknown): string | null {
  const location = record(value);
  if (location === null || optionalBoolean(location.hidden) === true) return null;
  return (
    optionalString(location.location_str) ??
    joinNonEmpty([
      optionalString(location.city),
      optionalString(location.region) ??
        optionalString(location.state) ??
        optionalString(location.state_code) ??
        optionalString(location.region_code),
      optionalString(location.country) ?? optionalString(location.country_name),
    ])
  );
}

function locationsText(records: readonly Record<string, unknown>[]): string | null {
  const locations: (string | null)[] = [];
  for (const job of records) {
    const hasHiddenLocation =
      Array.isArray(job.locations) &&
      job.locations.some((location) => optionalBoolean(record(location)?.hidden) === true);
    if (Array.isArray(job.locations)) {
      locations.push(...job.locations.map((location) => locationText(location)));
    }
    const primaryLocation = record(job.location);
    locations.push(locationText(primaryLocation));
    if (optionalBoolean(primaryLocation?.hidden) !== true && !hasHiddenLocation) {
      locations.push(
        joinNonEmpty([
          optionalString(job.city),
          optionalString(job.state),
          optionalString(job.country),
        ]),
      );
    }
  }
  return joinNonEmpty(locations, ' | ');
}

function normalizedWorkplaceType(value: unknown): WorkplaceMode | null {
  switch (optionalString(value)?.toLowerCase().replaceAll('-', '_').replaceAll(' ', '_')) {
    case 'remote':
      return 'remote';
    case 'hybrid':
      return 'hybrid';
    case 'on_site':
    case 'onsite':
      return 'onsite';
    default:
      return null;
  }
}

function workplace(records: readonly Record<string, unknown>[]): {
  remote: boolean | null;
  workplaceMode: WorkplaceMode;
} {
  for (const job of records) {
    const location = record(job.location);
    const workplaceMode =
      normalizedWorkplaceType(job.workplace_type) ??
      normalizedWorkplaceType(location?.workplace_type);
    if (workplaceMode === 'remote') return { remote: true, workplaceMode };
    if (workplaceMode === 'hybrid') return { remote: null, workplaceMode };
    if (workplaceMode === 'onsite') return { remote: false, workplaceMode };
  }

  for (const job of records) {
    const location = record(job.location);
    const telecommuting =
      optionalBoolean(job.telecommuting) ?? optionalBoolean(location?.telecommuting);
    if (telecommuting === true) return { remote: true, workplaceMode: 'remote' };
    if (telecommuting === false) return { remote: false, workplaceMode: 'unknown' };
  }
  return { remote: null, workplaceMode: 'unknown' };
}

function normalizeJob(records: readonly Record<string, unknown>[]): NormalizedVacancy | null {
  const externalId = firstString(records, 'shortcode');
  const title = firstString(records, 'title');
  const descriptionHtml =
    firstString(records, 'description') ?? firstString(records, 'full_description');
  const url = firstUrl(records);
  if (externalId === null || title === null || descriptionHtml === null || url === null)
    return null;
  const { remote, workplaceMode } = workplace(records);

  return makeVacancy({
    externalId,
    title,
    description: htmlToText(descriptionHtml),
    location: locationsText(records),
    remote,
    workplaceMode,
    url,
    postedAt: parseDate(firstString(records, 'published_on')),
    employmentType: firstString(records, 'employment_type'),
    source: normalizedSource(provider),
  });
}

export class WorkableAdapter implements VacancyAdapter {
  public readonly provider = provider;

  public constructor(private readonly http: AtsHttpClient) {}

  public supports(source: CareerSourceDescriptor): boolean {
    const identifier = source.boardIdentifier?.trim();
    const detected = detectWorkableSource(source.baseUrl);
    return (
      source.provider === provider &&
      identifier !== undefined &&
      validAccount.test(identifier) &&
      detected?.boardIdentifier.toLowerCase() === identifier.toLowerCase()
    );
  }

  public async listVacancies(source: CareerSourceDescriptor): Promise<AdapterResult> {
    if (!this.supports(source)) throw new AtsResponseError(provider, 'source is not supported');
    const boardIdentifier = requireBoardIdentifier(source, provider);
    const url = `https://www.workable.com/api/accounts/${encodeURIComponent(boardIdentifier)}?details=true`;
    const response = await this.http.get(url, {
      allowedOrigins: ['https://www.workable.com'],
    });
    requireSuccessfulResponse(provider, response);
    const root = requireRecord(parseJson(response.body, provider), provider, 'job list');
    if (!Array.isArray(root.jobs)) {
      throw new AtsResponseError(provider, 'job list has an unknown response shape');
    }

    const groupedJobs = new Map<string, Record<string, unknown>[]>();
    let invalidCount = 0;
    for (const value of root.jobs) {
      const job = record(value);
      const shortcode = optionalString(job?.shortcode);
      if (job === null || shortcode === null) {
        invalidCount += 1;
        continue;
      }
      const group = groupedJobs.get(shortcode);
      if (group === undefined) groupedJobs.set(shortcode, [job]);
      else group.push(job);
    }

    const vacancies: NormalizedVacancy[] = [];
    for (const group of groupedJobs.values()) {
      const vacancy = normalizeJob(group);
      if (vacancy === null) invalidCount += 1;
      else vacancies.push(vacancy);
    }
    return { vacancies, complete: invalidCount === 0, requestCount: 1, invalidCount };
  }
}
