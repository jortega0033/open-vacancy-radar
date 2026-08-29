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
  htmlToText,
  httpUrl,
  makeVacancy,
  normalizedSource,
  optionalBoolean,
  optionalString,
  parseDate,
  parseJson,
  requireBoardIdentifier,
  requireRecord,
} from './shared.js';

const provider = 'ashby' as const;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function externalId(job: Record<string, unknown>, jobUrl: string): string | null {
  const id = optionalString(job.id);
  if (id !== null) return id;
  const segments = new URL(jobUrl).pathname.split('/').filter(Boolean);
  return segments.at(-1) ?? null;
}

function locationText(job: Record<string, unknown>): string | null {
  const locations = [optionalString(job.location)];
  if (Array.isArray(job.secondaryLocations)) {
    for (const value of job.secondaryLocations) {
      locations.push(optionalString(record(value)?.location));
    }
  }
  const unique = [...new Set(locations.filter((value): value is string => value !== null))];
  return unique.length === 0 ? null : unique.join(' | ');
}

function workplaceMode(value: unknown, remote: boolean | null): WorkplaceMode {
  const normalized = optionalString(value)?.toLowerCase();
  if (normalized === 'remote' || remote === true) return 'remote';
  if (normalized === 'hybrid') return 'hybrid';
  if (normalized === 'onsite' || normalized === 'on-site') return 'onsite';
  return 'unknown';
}

function compensationText(job: Record<string, unknown>): string | null {
  const compensation = record(job.compensation);
  return optionalString(compensation?.scrapeableCompensationSalarySummary)
    ?? optionalString(compensation?.compensationTierSummary);
}

function normalizeJob(value: unknown): NormalizedVacancy | null {
  const job = record(value);
  if (job === null || optionalBoolean(job.isListed) === false) return null;
  const title = optionalString(job.title);
  const url = httpUrl(job.jobUrl);
  const plain = optionalString(job.descriptionPlain);
  const descriptionHtml = optionalString(job.descriptionHtml);
  if (title === null || url === null || (plain === null && descriptionHtml === null)) return null;
  const id = externalId(job, url);
  if (id === null) return null;
  const salary = compensationText(job);
  const description = plain ?? htmlToText(descriptionHtml ?? '');
  const remote = optionalBoolean(job.isRemote);

  return makeVacancy({
    externalId: id,
    title,
    description: salary === null ? description : `${description}\n\nCompensation: ${salary}`,
    location: locationText(job),
    remote,
    workplaceMode: workplaceMode(job.workplaceType, remote),
    url,
    postedAt: parseDate(job.publishedAt),
    employmentType: optionalString(job.employmentType),
    source: normalizedSource(provider),
  });
}

export class AshbyAdapter implements VacancyAdapter {
  public readonly provider = provider;

  public constructor(private readonly http: AtsHttpClient) {}

  public supports(source: CareerSourceDescriptor): boolean {
    return source.provider === provider && Boolean(source.boardIdentifier?.trim());
  }

  public async listVacancies(source: CareerSourceDescriptor): Promise<AdapterResult> {
    if (!this.supports(source)) throw new AtsResponseError(provider, 'source is not supported');
    const boardIdentifier = requireBoardIdentifier(source, provider);
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(boardIdentifier)}?includeCompensation=true`;
    const response = await this.http.get(url);
    requireSuccessfulResponse(provider, response);
    const root = requireRecord(parseJson(response.body, provider), provider, 'job list');
    if (!Array.isArray(root.jobs)) {
      throw new AtsResponseError(provider, 'job list has an unknown response shape');
    }
    const listedJobs = root.jobs.filter((job) => optionalBoolean(record(job)?.isListed) !== false);
    const vacancies = listedJobs
      .map((job) => normalizeJob(job))
      .filter((job): job is NormalizedVacancy => job !== null);
    const invalidCount = listedJobs.length - vacancies.length;
    return { vacancies, complete: invalidCount === 0, requestCount: 1, invalidCount };
  }
}
