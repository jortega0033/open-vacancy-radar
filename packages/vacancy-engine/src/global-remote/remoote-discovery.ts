import { AtsResponseError, type AtsHttpClient } from '../ats/http.js';
import {
  discoveryAudit,
  numberValue,
  parsedRoot,
  record,
  sourceFailure,
  stringValue,
} from './discovery-shared.js';
import type { DiscoveryRun, DiscoveryVacancyAudit, GlobalRemoteConfig } from './models.js';

const REMOOTE_API_ORIGIN = 'https://api.remoote.app';
export const REMOOTE_SEARCH_URL = `${REMOOTE_API_ORIGIN}/remoote/agents/search_jobs`;
export const REMOOTE_PUBLIC_LIMIT = 10;
export const REMOOTE_CACHE_TTL_MS = 5 * 60_000;
const REMOOTE_CACHE_MAX_ENTRIES = 20;

type ParsedRemooteSearch = {
  vacancies: DiscoveryVacancyAudit[];
  rejectedRows: number;
};

type RemooteSearchCacheEntry = {
  expiresAt: number;
  value: ParsedRemooteSearch;
};

export type RemooteSearchCache = Map<string, RemooteSearchCacheEntry>;

export type RemooteDiscoveryOptions = {
  cache?: RemooteSearchCache;
  now?: () => number;
};

export type RemooteJobDetail =
  | { status: 'inactive'; job: null }
  | {
      status: 'active';
      job: {
        id: number;
        url: string;
        location: string | null;
        advertisedMinimum: number | null;
        currency: string | null;
        salaryPeriod: string | null;
      };
    };

const defaultSearchCache: RemooteSearchCache = new Map();

export function createRemooteSearchCache(): RemooteSearchCache {
  return new Map();
}

function positiveNumber(value: unknown): number | null {
  const parsed = numberValue(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function canonicalRemooteJobUrl(value: unknown, expectedId: number): string | null {
  const rawUrl = stringValue(value);
  if (rawUrl === null) return null;
  try {
    const url = new URL(rawUrl);
    if (
      url.origin !== 'https://remoote.app' ||
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return null;
    }
    const match = /^\/jobs\/([1-9]\d*)(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\/?$/u.exec(url.pathname);
    if (match?.[1] === undefined || Number(match[1]) !== expectedId) return null;
    return url.href;
  } catch {
    return null;
  }
}

function cloneParsedSearch(value: ParsedRemooteSearch): ParsedRemooteSearch {
  return {
    vacancies: value.vacancies.map((vacancy) => ({
      ...vacancy,
      reasons: [...vacancy.reasons],
    })),
    rejectedRows: value.rejectedRows,
  };
}

function readSearchCache(
  cache: RemooteSearchCache,
  key: string,
  now: number,
): ParsedRemooteSearch | null {
  const entry = cache.get(key);
  if (entry === undefined) return null;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return null;
  }
  return cloneParsedSearch(entry.value);
}

function writeSearchCache(
  cache: RemooteSearchCache,
  key: string,
  value: ParsedRemooteSearch,
  now: number,
): void {
  if (!cache.has(key) && cache.size >= REMOOTE_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, {
    expiresAt: now + REMOOTE_CACHE_TTL_MS,
    value: cloneParsedSearch(value),
  });
}

function normalizeRemooteJob(
  raw: unknown,
  minimumAnnualBaseUsd: number | null,
): DiscoveryVacancyAudit | null {
  const job = record(raw);
  const id = positiveNumber(job?.id);
  if (id === null || !Number.isSafeInteger(id)) return null;
  const title = stringValue(job?.title);
  const companyRecord = record(job?.company);
  const company = stringValue(companyRecord?.title);
  const url = canonicalRemooteJobUrl(job?.remoote_url, id);
  if (job === null || title === null || company === null || url === null) return null;

  const salary = record(job.salary);
  const locationRecord = record(job.location);
  const location = stringValue(locationRecord?.geo_raw) ?? 'Remote (eligibility unspecified)';
  const employmentType = stringValue(job.employment_type);
  const seniority = stringValue(job.seniority_level);
  const skills = Array.isArray(job.skills)
    ? job.skills
        .flatMap((value): string[] => {
          const skill = stringValue(value);
          return skill === null ? [] : [skill];
        })
        .slice(0, 20)
    : [];
  const advertisedMinimum = positiveNumber(salary?.min);
  const currency = stringValue(salary?.currency);
  const salaryPeriod = stringValue(salary?.period);
  const summary = stringValue(job.summary);
  const requirements = stringValue(job.requirements_excerpt);
  const responsibilities = stringValue(job.responsibilities_excerpt);
  const skillsText = skills.length === 0 ? null : `Skills: ${skills.join(', ')}`;
  const description = [summary, skillsText, requirements, responsibilities]
    .filter((value): value is string => value !== null)
    .join('\n');

  // Hash only the public fields OVR consumes. Unknown response fields—including any future raw
  // employer-application URL—must not be persisted, logged, rendered, or folded into report data.
  const hashEvidence = {
    id,
    title,
    company,
    url,
    location,
    employmentType,
    seniority,
    skills,
    advertisedMinimum,
    currency,
    salaryPeriod,
    summary,
    requirements,
    responsibilities,
    postedAt: stringValue(job.posted_at),
    updatedAt: stringValue(job.updated_or_last_seen_at),
  };

  return discoveryAudit({
    key: `remoote:${id}`,
    provider: 'remoote',
    company,
    title,
    url,
    location,
    employmentType,
    currency,
    salaryPeriod,
    advertisedMinimum,
    description,
    postedAt: hashEvidence.postedAt,
    raw: hashEvidence,
    minimumAnnualBaseUsd,
  });
}

function parseRemooteSearch(
  response: Awaited<ReturnType<AtsHttpClient['postJson']>>,
  config: GlobalRemoteConfig,
): ParsedRemooteSearch {
  const root = parsedRoot(response, 'remoote');
  if (stringValue(root.status) !== 'ok') {
    throw new AtsResponseError('remoote', 'search response status is not ok', response.status);
  }
  const data = record(root.data);
  const jobs = data?.jobs;
  if (!Array.isArray(jobs)) {
    throw new AtsResponseError('remoote', 'data.jobs is not an array', response.status);
  }
  const limits = record(root.limits);
  const appliedLimit = positiveNumber(limits?.applied_limit);
  const publicLimit = positiveNumber(limits?.max_public_results);
  if (
    appliedLimit === null ||
    publicLimit === null ||
    !Number.isSafeInteger(appliedLimit) ||
    !Number.isSafeInteger(publicLimit) ||
    publicLimit > REMOOTE_PUBLIC_LIMIT ||
    appliedLimit > publicLimit ||
    appliedLimit > config.discovery.remooteLimit ||
    jobs.length > appliedLimit
  ) {
    throw new AtsResponseError('remoote', 'public result limits are invalid', response.status);
  }

  const vacancies = jobs.flatMap((raw): DiscoveryVacancyAudit[] => {
    const vacancy = normalizeRemooteJob(raw, config.minimumAnnualBaseUsd);
    return vacancy === null ? [] : [vacancy];
  });
  const rejectedRows = jobs.length - vacancies.length;
  if (jobs.length > 0 && vacancies.length === 0) {
    throw new AtsResponseError(
      'remoote',
      'search response contained no usable jobs',
      response.status,
    );
  }
  return { vacancies, rejectedRows };
}

function searchRequest(config: GlobalRemoteConfig): Record<string, unknown> {
  return {
    ...(config.discovery.remooteRoleTitle ? { role_title: config.discovery.remooteRoleTitle } : {}),
    ...(config.discovery.remooteCountry ? { country: config.discovery.remooteCountry } : {}),
    salary_required: false,
    limit: config.discovery.remooteLimit,
  };
}

function searchCacheKey(config: GlobalRemoteConfig, request: Record<string, unknown>): string {
  return JSON.stringify({
    request,
    minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
  });
}

function successfulDiscovery(parsed: ParsedRemooteSearch, requests: number): DiscoveryRun {
  const partial = parsed.rejectedRows > 0;
  return {
    sources: [
      {
        id: 'remoote:public-search',
        provider: 'remoote',
        url: REMOOTE_SEARCH_URL,
        requests,
        listings: parsed.vacancies.length,
        status: partial ? 'partial' : 'success',
        error: partial ? `ignored ${parsed.rejectedRows} invalid Remoote result(s)` : null,
      },
    ],
    vacancies: parsed.vacancies,
  };
}

function parseRemooteDetail(
  response: Awaited<ReturnType<AtsHttpClient['get']>>,
  expectedId: number,
): RemooteJobDetail {
  const root = parsedRoot(response, 'remoote');
  const status = stringValue(root.status);
  if (status === 'not_found' && root.data === null) return { status: 'inactive', job: null };
  if (status !== 'ok') {
    throw new AtsResponseError('remoote', 'detail response status is invalid', response.status);
  }

  const data = record(root.data);
  const job = record(data?.job);
  const id = positiveNumber(job?.id);
  const url = canonicalRemooteJobUrl(job?.remoote_url, expectedId);
  const applyAction = record(job?.apply_action);
  const applyUrl = canonicalRemooteJobUrl(applyAction?.url, expectedId);
  if (id !== expectedId || url === null || applyUrl !== url) {
    throw new AtsResponseError('remoote', 'detail job contract is invalid', response.status);
  }

  const salary = record(job?.salary);
  const location = record(job?.location);
  return {
    status: 'active',
    job: {
      id,
      url,
      location: stringValue(location?.geo_raw),
      advertisedMinimum: positiveNumber(salary?.min),
      currency: stringValue(salary?.currency),
      salaryPeriod: stringValue(salary?.period),
    },
  };
}

export function remooteJobDetailUrl(jobId: number): string {
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    throw new RangeError('Remoote job ID must be a positive safe integer');
  }
  return `${REMOOTE_API_ORIGIN}/remoote/agents/jobs/${jobId}`;
}

export async function fetchRemooteJobDetail(
  http: AtsHttpClient,
  jobId: number,
): Promise<RemooteJobDetail> {
  return parseRemooteDetail(
    await http.get(remooteJobDetailUrl(jobId), {
      allowedOrigins: [REMOOTE_API_ORIGIN],
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    }),
    jobId,
  );
}

export async function discoverRemoote(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
  options: RemooteDiscoveryOptions = {},
): Promise<DiscoveryRun> {
  const cache = options.cache ?? defaultSearchCache;
  const now = options.now ?? Date.now;
  const request = searchRequest(config);
  const cacheKey = searchCacheKey(config, request);
  const cached = readSearchCache(cache, cacheKey, now());
  if (cached !== null) return successfulDiscovery(cached, 0);

  let requests = 0;
  try {
    requests += 1;
    const response = await http.postJson(REMOOTE_SEARCH_URL, request, {
      allowedOrigins: [REMOOTE_API_ORIGIN],
      headers: { Accept: 'application/json' },
    });
    const parsed = parseRemooteSearch(response, config);
    writeSearchCache(cache, cacheKey, parsed, now());
    return successfulDiscovery(parsed, requests);
  } catch (error) {
    const failure = sourceFailure(error);
    return {
      sources: [
        {
          id: 'remoote:public-search',
          provider: 'remoote',
          url: REMOOTE_SEARCH_URL,
          requests,
          listings: 0,
          status: failure.status,
          error: failure.error,
        },
      ],
      vacancies: [],
    };
  }
}
