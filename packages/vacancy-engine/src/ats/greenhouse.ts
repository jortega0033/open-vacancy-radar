import type {
  AdapterResult,
  CareerSourceDescriptor,
  NormalizedVacancy,
  VacancyAdapter,
} from '../domain/models.js';
import type { AtsHttpClient } from './http.js';
import { AtsResponseError, requireSuccessfulResponse } from './http.js';
import {
  decodeEscapedMarkup,
  htmlToText,
  httpUrl,
  makeVacancy,
  normalizedSource,
  optionalString,
  parseJson,
  requireBoardIdentifier,
  requireRecord,
} from './shared.js';

const provider = 'greenhouse' as const;

function normalizeJob(value: unknown): NormalizedVacancy | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const job = value as Record<string, unknown>;
  const id = typeof job.id === 'number' || typeof job.id === 'string' ? String(job.id) : null;
  const title = optionalString(job.title);
  const descriptionHtml = optionalString(job.content);
  const url = httpUrl(job.absolute_url);
  const locationRecord =
    typeof job.location === 'object' && job.location !== null && !Array.isArray(job.location)
      ? (job.location as Record<string, unknown>)
      : null;
  if (id === null || title === null || descriptionHtml === null || url === null) return null;

  return makeVacancy({
    externalId: id,
    title,
    description: htmlToText(decodeEscapedMarkup(descriptionHtml)),
    location: optionalString(locationRecord?.name),
    remote: null,
    url,
    // Greenhouse's public response exposes updated_at, not a reliable publication date.
    postedAt: null,
    employmentType: null,
    source: normalizedSource(provider),
  });
}

export class GreenhouseAdapter implements VacancyAdapter {
  public readonly provider = provider;

  public constructor(private readonly http: AtsHttpClient) {}

  public supports(source: CareerSourceDescriptor): boolean {
    return source.provider === provider && Boolean(source.boardIdentifier?.trim());
  }

  public async listVacancies(source: CareerSourceDescriptor): Promise<AdapterResult> {
    if (!this.supports(source)) throw new AtsResponseError(provider, 'source is not supported');
    const boardIdentifier = requireBoardIdentifier(source, provider);
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardIdentifier)}/jobs?content=true`;
    const response = await this.http.get(url);
    requireSuccessfulResponse(provider, response);
    const root = requireRecord(parseJson(response.body, provider), provider, 'job list');
    if (!Array.isArray(root.jobs)) {
      throw new AtsResponseError(provider, 'job list has an unknown response shape');
    }
    const vacancies = root.jobs
      .map((job) => normalizeJob(job))
      .filter((job): job is NormalizedVacancy => job !== null);
    const invalidCount = root.jobs.length - vacancies.length;
    return { vacancies, complete: invalidCount === 0, requestCount: 1, invalidCount };
  }
}
