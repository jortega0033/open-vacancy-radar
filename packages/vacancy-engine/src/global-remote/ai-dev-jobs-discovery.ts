import type { AtsHttpClient } from '../ats/http.js';
import { AtsResponseError, requireSuccessfulResponse } from '../ats/http.js';
import {
  attributeNetworkRequests,
  networkAttemptFields,
  newNetworkAttemptCounters,
} from './discovery-attribution.js';
import {
  booleanValue,
  completeAudit,
  discoveryAudit,
  httpUrl,
  incompleteAudit,
  isoPostedAt,
  numberValue,
  parsedRoot,
  record,
  sourceFailure,
  stringValue,
} from './discovery-shared.js';
import type {
  DiscoveryRun,
  DiscoverySourceAudit,
  DiscoveryVacancyAudit,
  GlobalRemoteConfig,
} from './models.js';

/**
 * AI Dev Jobs (https://aidevboard.com) — official public REST API for AI/ML developer roles.
 * Anonymous reads are free and unauthenticated; an optional API key only raises the hourly abuse
 * throttle (see docs/job-source-evidence.md). Neither the exact anonymous hourly quota nor a safe
 * full-enumeration budget is published, so this adapter stays `linked_index`: bounded pagination,
 * no bulk export, and every request stays within the shared `AtsHttpClient`'s own retry/backoff
 * policy (see `sourceFailure` below) rather than adding source-specific retries on top of it.
 *
 * The terms (https://aidevboard.com/terms) permit API data "in your applications" but forbid
 * reselling it "as a standalone dataset" -- this adapter only ever surfaces normalized vacancy
 * metadata through the existing discovery/report pipeline, never a raw export endpoint.
 */
export const AI_DEV_JOBS_API_ORIGIN = 'https://aidevboard.com';
export const AI_DEV_JOBS_JOBS_URL = `${AI_DEV_JOBS_API_ORIGIN}/api/v1/jobs`;
/** Documented API ceiling ("Results per page (default 20, max 50)"); never requested above this. */
export const AI_DEV_JOBS_MAX_PAGE_SIZE = 50;

function positiveNumber(value: unknown): number | null {
  const parsed = numberValue(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

/**
 * The API's own `url` field has been observed to point at either `/job/{id}` (list responses) or
 * `/job/{slug}` (detail responses) for the same listing -- both are accepted here as long as the
 * origin and path segment match this job's own id or slug, so a malformed or cross-listing URL
 * (which would misattribute the canonical link) is rejected rather than trusted blindly.
 */
function canonicalAiDevJobsUrl(value: unknown, job: Record<string, unknown>): string | null {
  const raw = stringValue(value);
  if (raw === null) return null;
  try {
    const url = new URL(raw);
    if (
      url.origin !== AI_DEV_JOBS_API_ORIGIN ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== ''
    ) {
      return null;
    }
    const match = /^\/job\/([^/]+)\/?$/u.exec(url.pathname);
    const segment = match?.[1];
    if (segment === undefined) return null;
    const id = stringValue(job.id);
    const slug = stringValue(job.slug);
    if (segment !== id && segment !== slug) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Normalizes one raw `Job` object (from either the list or the detail endpoint) into the shared
 * discovery shape, or returns `null` when the row cannot be trusted as a live, attributable
 * vacancy. Returning `null` (rather than throwing) lets the list scan below silently drop one bad
 * row without failing the whole page -- matching every other discovery adapter in this package.
 *
 * `url` is the direct employer/ATS apply link (preferred for display and canonical identity per
 * docs/job-source-policy.md's coverage-review guidance) when the API supplies a usable one; the
 * AI Dev Jobs canonical listing page is preserved too, as the first line of `description`, so the
 * indexed-source attribution required by the ticket is never lost even though the shared
 * `DiscoveryVacancyAudit` shape only has one clickable `url` slot.
 */
function normalizeAiDevJob(
  raw: unknown,
  minimumAnnualBaseUsd: number | null,
): DiscoveryVacancyAudit | null {
  const job = record(raw);
  if (job === null) return null;
  // An explicit non-active status (e.g. "expired", "closed", "draft") means the listing must not
  // be surfaced as a live vacancy, even if it is still reachable by direct id/slug lookup. A
  // missing status is treated as active: it is not part of the published OpenAPI `Job` schema, so
  // its absence must not silently disable every row from a response that omits it.
  const status = stringValue(job.status);
  if (status !== null && status !== 'active') return null;

  const id = stringValue(job.id);
  const title = stringValue(job.title);
  const company = stringValue(job.company_name);
  const canonicalUrl = canonicalAiDevJobsUrl(job.url, job);
  const applyUrl = httpUrl(job.apply_url);
  const primaryUrl = applyUrl ?? canonicalUrl;
  if (id === null || title === null || company === null || canonicalUrl === null || primaryUrl === null) {
    return null;
  }

  const tags = Array.isArray(job.tags)
    ? job.tags
        .flatMap((value): string[] => {
          const tag = stringValue(value);
          return tag === null ? [] : [tag];
        })
        .slice(0, 20)
    : [];
  const level = stringValue(job.experience_level);
  const descriptionBody = stringValue(job.description);
  const description = [
    `AI Dev Jobs listing: ${canonicalUrl}`,
    level === null ? null : `Level: ${level}`,
    tags.length === 0 ? null : `Tags: ${tags.join(', ')}`,
    descriptionBody,
  ]
    .filter((value): value is string => value !== null && value.length > 0)
    .join('\n');

  const advertisedMinimum = positiveNumber(job.salary_min);
  // The OpenAPI document defines salary_min/salary_max explicitly as "USD/year"; there is no
  // per-listing currency or period field to read instead.
  const currency = advertisedMinimum === null ? null : 'USD';
  const salaryPeriod = advertisedMinimum === null ? null : 'annual';

  return discoveryAudit({
    key: `ai_dev_jobs:${id}`,
    provider: 'ai_dev_jobs',
    company,
    title,
    url: primaryUrl,
    location: stringValue(job.location) ?? 'Remote (eligibility unspecified)',
    employmentType: stringValue(job.job_type),
    currency,
    salaryPeriod,
    advertisedMinimum,
    description,
    postedAt: isoPostedAt(stringValue(job.published_at)) ?? isoPostedAt(stringValue(job.created_at)),
    raw,
    minimumAnnualBaseUsd,
  });
}

function searchUrl(config: GlobalRemoteConfig, page: number): URL {
  const url = new URL(AI_DEV_JOBS_JOBS_URL);
  // The global-remote pipeline only ever wants fully-remote roles (see
  // `GlobalRemoteReport.criteria.fullyRemote`); every other discovery source in this pipeline
  // applies an equivalent source-side remote filter, so this one does too.
  url.searchParams.set('workplace', 'remote');
  if (config.discovery.roleQuery) url.searchParams.set('q', config.discovery.roleQuery);
  url.searchParams.set('limit', String(AI_DEV_JOBS_MAX_PAGE_SIZE));
  url.searchParams.set('page', String(page));
  return url;
}

export async function discoverAiDevJobs(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const counters = newNetworkAttemptCounters();
  http = attributeNetworkRequests(http, counters);
  const vacancies: DiscoveryVacancyAudit[] = [];
  let requests = 0;
  let successfulRequests = 0;
  let status: DiscoverySourceAudit['status'] = 'success';
  let errorMessage: string | null = null;
  let continuationCursor: string | null = null;
  let lastUrl = AI_DEV_JOBS_JOBS_URL;
  try {
    for (let page = 1; page <= config.discovery.aiDevJobsMaxPages; page += 1) {
      const url = searchUrl(config, page);
      lastUrl = url.toString();
      requests += 1;
      const root = parsedRoot(await http.get(lastUrl), 'ai_dev_jobs');
      // A page requested past the end of the result set returns `jobs: null`, not `[]` -- an
      // exhausted page, not a malformed response, so it is normalized to an empty array here
      // rather than treated as a contract violation.
      const rawJobs = root.jobs === null ? [] : root.jobs;
      if (!Array.isArray(rawJobs)) throw new AtsResponseError('ai_dev_jobs', 'jobs is not an array');
      // Counted only once the page's shape is confirmed usable, so a malformed *first* page (no
      // real coverage obtained at all) is reported as `error`, not `partial`; a malformed page
      // after at least one good page still correctly reports `partial`.
      successfulRequests += 1;
      for (const raw of rawJobs) {
        const vacancy = normalizeAiDevJob(raw, config.minimumAnnualBaseUsd);
        if (vacancy !== null) vacancies.push(vacancy);
      }
      const hasNext = booleanValue(root.has_next);
      if (rawJobs.length === 0 || hasNext !== true) break;
      if (page === config.discovery.aiDevJobsMaxPages) {
        status = 'partial';
        continuationCursor = String(page + 1);
        errorMessage = `Stopped at the configured ${config.discovery.aiDevJobsMaxPages}-page limit.`;
      }
    }
  } catch (error) {
    const failure = sourceFailure(error);
    status = successfulRequests > 0 ? 'partial' : failure.status;
    errorMessage = failure.error;
    continuationCursor = null;
  }
  return {
    sources: [{
      id: 'ai_dev_jobs:remote-search',
      provider: 'ai_dev_jobs',
      url: lastUrl,
      requests,
      listings: vacancies.length,
      status,
      error: errorMessage,
      ...networkAttemptFields(counters),
      ...(status === 'success' ? completeAudit() : incompleteAudit(errorMessage ?? status, continuationCursor)),
    }],
    vacancies,
  };
}

export type AiDevJobDetail =
  | { status: 'not_found'; job: null }
  | { status: 'inactive'; job: null }
  | { status: 'active'; job: DiscoveryVacancyAudit };

export function aiDevJobDetailUrl(idOrSlug: string): string {
  if (idOrSlug.trim().length === 0) {
    throw new RangeError('AI Dev Jobs job id/slug must be a non-empty string');
  }
  return `${AI_DEV_JOBS_JOBS_URL}/${encodeURIComponent(idOrSlug)}`;
}

/**
 * On-demand single-listing lookup ("fetch details only when needed" per the ticket), kept separate
 * from the bulk list scan above -- nothing in this package calls it automatically today, matching
 * how `fetchRemooteJobDetail` (remoote-discovery.ts) is also a standalone helper.
 */
export async function fetchAiDevJobDetail(
  http: AtsHttpClient,
  idOrSlug: string,
  minimumAnnualBaseUsd: number | null,
): Promise<AiDevJobDetail> {
  const response = await http.get(aiDevJobDetailUrl(idOrSlug), {
    allowedOrigins: [AI_DEV_JOBS_API_ORIGIN],
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (response.status === 404) return { status: 'not_found', job: null };
  requireSuccessfulResponse('ai_dev_jobs', response);
  let root: unknown;
  try {
    root = JSON.parse(response.body) as unknown;
  } catch (error) {
    throw new AtsResponseError('ai_dev_jobs', 'invalid detail JSON', response.status, { cause: error });
  }
  const job = record(root);
  if (job === null) throw new AtsResponseError('ai_dev_jobs', 'detail response is not an object', response.status);
  const status = stringValue(job.status);
  if (status !== null && status !== 'active') return { status: 'inactive', job: null };
  const vacancy = normalizeAiDevJob(job, minimumAnnualBaseUsd);
  if (vacancy === null) {
    throw new AtsResponseError('ai_dev_jobs', 'detail job contract is invalid', response.status);
  }
  return { status: 'active', job: vacancy };
}
