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

/**
 * The description text this adapter stores for one board job, exactly as the scan builds it, or null
 * when the job carries no description field at all. Shared with the posting verifier (#720), so a
 * re-read of the same board compares like with like. `toText` lets the verifier convert markup inside
 * its own parsing budget; it defaults to the adapter's parser.
 */
export function ashbyJobDescription(
  job: Record<string, unknown>,
  toText: (html: string) => string = htmlToText,
): string | null {
  const plain = optionalString(job.descriptionPlain);
  const descriptionHtml = optionalString(job.descriptionHtml);
  if (plain === null && descriptionHtml === null) return null;
  const description = plain ?? toText(descriptionHtml ?? '');
  const salary = compensationText(job);
  return salary === null ? description : `${description}\n\nCompensation: ${salary}`;
}

/**
 * Whether a board job is the listed posting with this id (the last path segment of
 * `https://jobs.ashbyhq.com/{board}/{id}`, which is Ashby's job id). A job the board marks unlisted
 * never matches: the adapter drops it as well, so to this app it is not on the board.
 */
export function isListedAshbyJob(value: unknown, jobId: string): boolean {
  const job = record(value);
  if (job === null || optionalBoolean(job.isListed) === false) return false;
  const wanted = jobId.toLowerCase();
  if (optionalString(job.id)?.toLowerCase() === wanted) return true;
  const url = httpUrl(job.jobUrl);
  return url !== null && new URL(url).pathname.split('/').filter(Boolean).at(-1)?.toLowerCase() === wanted;
}

function normalizeJob(value: unknown): NormalizedVacancy | null {
  const job = record(value);
  if (job === null || optionalBoolean(job.isListed) === false) return null;
  const title = optionalString(job.title);
  const url = httpUrl(job.jobUrl);
  const description = ashbyJobDescription(job);
  if (title === null || url === null || description === null) return null;
  const id = externalId(job, url);
  if (id === null) return null;
  const remote = optionalBoolean(job.isRemote);

  return makeVacancy({
    externalId: id,
    title,
    description,
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
