import type { AtsHttpClient } from '../ats/http.js';
import { AtsResponseError } from '../ats/http.js';
import {
  booleanValue,
  discoveryAudit,
  httpUrl,
  identifier,
  isoPostedAt,
  numberValue,
  parsedRoot,
  record,
  sourceFailure,
  stringValue,
} from './discovery-shared.js';
import type { DiscoveryRun, DiscoveryVacancyAudit, GlobalRemoteConfig } from './models.js';

const JOBTECH_PROVIDER = 'jobtech_sweden' as const;
const JOBTECH_PAGE_SIZE = 100;
const JOBTECH_FIELDS = [
  'total{value}',
  'hits{id,headline,webpage_url,application_deadline,employment_type{label},salary_description,employer{name},application_details{url},workplace_address{municipality,region,country,city},removed,removed_date,publication_date}',
].join(',');

function jobtechSearchUrl(roleQuery: string): string {
  const url = new URL('https://jobsearch.api.jobtechdev.se/search');
  if (roleQuery) url.searchParams.set('q', roleQuery);
  url.searchParams.set('remote', 'true');
  url.searchParams.set('limit', String(JOBTECH_PAGE_SIZE));
  url.searchParams.set('offset', '0');
  return url.toString();
}

function locationFor(job: Record<string, unknown>): string {
  const address = record(job.workplace_address);
  const parts = [
    stringValue(address?.city),
    stringValue(address?.municipality),
    stringValue(address?.region),
    stringValue(address?.country),
  ].filter((part): part is string => part !== null);
  const uniqueParts = parts.filter(
    (part, index) =>
      parts.findIndex((candidate) => candidate.toLowerCase() === part.toLowerCase()) === index,
  );
  const workplace = uniqueParts.length === 0 ? 'Sweden' : uniqueParts.join(', ');
  return `Remote or partly remote · ${workplace}, Europe`;
}

function safeFingerprint(job: Record<string, unknown>, url: string): Record<string, unknown> {
  const employmentType = record(job.employment_type);
  const address = record(job.workplace_address);
  return {
    id: job.id,
    headline: job.headline,
    url,
    applicationDeadline: job.application_deadline,
    employmentType: employmentType?.label,
    salaryDescription: job.salary_description,
    employerName: record(job.employer)?.name,
    workplace: {
      city: address?.city,
      municipality: address?.municipality,
      region: address?.region,
      country: address?.country,
    },
    removed: job.removed,
    removedDate: job.removed_date,
  };
}

function normalizedVacancy(
  raw: unknown,
  minimumAnnualBaseUsd: number | null,
): DiscoveryVacancyAudit | null {
  const job = record(raw);
  if (job === null || booleanValue(job.removed) === true || stringValue(job.removed_date) !== null)
    return null;

  const title = stringValue(job.headline);
  const company = stringValue(record(job.employer)?.name);
  const applicationUrl = httpUrl(record(job.application_details)?.url);
  const url = applicationUrl ?? httpUrl(job.webpage_url);
  if (title === null || company === null || url === null) return null;

  return discoveryAudit({
    key: `${JOBTECH_PROVIDER}:${identifier(job.id, url)}`,
    provider: JOBTECH_PROVIDER,
    company,
    title,
    url,
    location: locationFor(job),
    employmentType: stringValue(record(job.employment_type)?.label),
    currency: null,
    salaryPeriod: null,
    advertisedMinimum: null,
    postedAt: isoPostedAt(stringValue(job.publication_date)),
    raw: safeFingerprint(job, url),
    minimumAnnualBaseUsd,
  });
}

/**
 * Searches the official Swedish public-employment API. The documented search
 * endpoint returns currently open ads, so a successful complete page is the
 * source-of-truth snapshot for this bounded frontend/remote query.
 */
export async function runJobtechDiscovery(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const url = jobtechSearchUrl(config.discovery.roleQuery);
  try {
    const root = parsedRoot(
      await http.get(url, {
        allowedOrigins: ['https://jobsearch.api.jobtechdev.se'],
        headers: {
          Accept: 'application/json',
          'X-Fields': JOBTECH_FIELDS,
        },
      }),
      JOBTECH_PROVIDER,
    );
    if (!Array.isArray(root.hits)) {
      throw new AtsResponseError(JOBTECH_PROVIDER, 'hits is not an array');
    }

    const vacancies: DiscoveryVacancyAudit[] = [];
    let invalidCount = 0;
    let removedCount = 0;
    for (const raw of root.hits) {
      const job = record(raw);
      if (job === null) {
        invalidCount += 1;
        continue;
      }
      if (booleanValue(job.removed) === true || stringValue(job.removed_date) !== null) {
        removedCount += 1;
        continue;
      }
      const vacancy = normalizedVacancy(job, config.minimumAnnualBaseUsd);
      if (vacancy === null) invalidCount += 1;
      else vacancies.push(vacancy);
    }
    const total = numberValue(record(root.total)?.value) ?? numberValue(root.total);
    const incompleteReasons: string[] = [];
    if (total === null) {
      incompleteReasons.push('Response omitted the total count; completeness is unknown.');
    } else if (total > root.hits.length) {
      incompleteReasons.push(
        `Bounded to ${root.hits.length} of ${total} active remote frontend matches.`,
      );
    } else if (total < root.hits.length) {
      incompleteReasons.push(`Returned ${root.hits.length} hits but reported a total of ${total}.`);
    }
    if (invalidCount > 0 || removedCount > 0) {
      incompleteReasons.push(
        `Dropped ${invalidCount} malformed and ${removedCount} removed hit(s).`,
      );
    }
    return {
      sources: [
        {
          id: `${JOBTECH_PROVIDER}:remote-frontend`,
          provider: JOBTECH_PROVIDER,
          url,
          requests: 1,
          listings: vacancies.length,
          status: incompleteReasons.length > 0 ? 'partial' : 'success',
          error: incompleteReasons.length > 0 ? incompleteReasons.join(' ') : null,
        },
      ],
      vacancies,
    };
  } catch (error) {
    return {
      sources: [
        {
          id: `${JOBTECH_PROVIDER}:remote-frontend`,
          provider: JOBTECH_PROVIDER,
          url,
          requests: 1,
          listings: 0,
          ...sourceFailure(error),
        },
      ],
      vacancies: [],
    };
  }
}
