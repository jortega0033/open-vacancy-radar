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

function normalizeRemooteJob(
  raw: unknown,
  minimumAnnualBaseUsd: number,
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
    raw: hashEvidence,
    minimumAnnualBaseUsd,
  });
}

function parseRemooteSearch(
  response: Awaited<ReturnType<AtsHttpClient['postJson']>>,
  config: GlobalRemoteConfig,
): DiscoveryVacancyAudit[] {
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

  return jobs.flatMap((raw): DiscoveryVacancyAudit[] => {
    const vacancy = normalizeRemooteJob(raw, config.minimumAnnualBaseUsd);
    return vacancy === null ? [] : [vacancy];
  });
}

export async function discoverRemoote(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  let requests = 0;
  try {
    requests += 1;
    const response = await http.postJson(
      REMOOTE_SEARCH_URL,
      {
        role_title: config.discovery.remooteRoleTitle,
        country: config.discovery.remooteCountry,
        salary_required: false,
        limit: config.discovery.remooteLimit,
      },
      {
        allowedOrigins: [REMOOTE_API_ORIGIN],
        headers: { Accept: 'application/json' },
      },
    );
    const vacancies = parseRemooteSearch(response, config);
    return {
      sources: [
        {
          id: 'remoote:public-search',
          provider: 'remoote',
          url: REMOOTE_SEARCH_URL,
          requests,
          listings: vacancies.length,
          status: 'success',
          error: null,
        },
      ],
      vacancies,
    };
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
