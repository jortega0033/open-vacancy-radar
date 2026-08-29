import type { AtsHttpClient } from '../ats/http.js';
import { AtsResponseError } from '../ats/http.js';
import {
  booleanValue,
  discoveryAudit,
  httpUrl,
  identifier,
  locations,
  numberValue,
  parseSalaryText,
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

const FREEHIRE_ATS_HOSTS = [
  'ashbyhq.com',
  'bamboohr.com',
  'breezy.hr',
  'greenhouse.io',
  'icims.com',
  'jobvite.com',
  'lever.co',
  'myworkdayjobs.com',
  'oraclecloud.com',
  'personio.com',
  'pinpointhq.com',
  'recruitee.com',
  'rippling.com',
  'smartrecruiters.com',
  'successfactors.com',
  'teamtailor.com',
  'workable.com',
] as const;

function directAtsUrl(value: unknown): string | null {
  const url = httpUrl(value);
  if (url === null) return null;
  const hostname = new URL(url).hostname.toLowerCase();
  return FREEHIRE_ATS_HOSTS.some((allowed) =>
    hostname === allowed || hostname.endsWith(`.${allowed}`))
    ? url
    : null;
}

function freehireLocation(job: Record<string, unknown>): string {
  if (Array.isArray(job.regions)) {
    const regionNames = job.regions.flatMap((value) => {
      const region = stringValue(value)?.toLowerCase();
      if (region === 'global') return ['Worldwide'];
      if (region === 'eu') return ['Europe'];
      if (region === 'uk') return ['United Kingdom'];
      return region === undefined ? [] : [region];
    });
    if (regionNames.length > 0) return regionNames.join(', ');
  }
  const countryNames = locations(job.countries, '');
  if (countryNames.length > 0) return countryNames;
  return stringValue(job.location) ?? 'Unknown';
}

async function discoverFreehire(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const url = new URL('https://freehire.me/api/v1/jobs/search');
  url.searchParams.set('category', 'frontend');
  url.searchParams.set('work_mode', 'remote');
  url.searchParams.set('regions', 'global,eu');
  url.searchParams.set('salary_currency', 'USD');
  url.searchParams.set('salary_min', String(config.minimumAnnualBaseUsd));
  url.searchParams.set('reality', 'fresh');
  url.searchParams.set('posted_within_days', '30');
  url.searchParams.set('sort', 'posted_at');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('limit', String(config.discovery.freehireLimit));
  const requestUrl = url.toString();
  try {
    const root = parsedRoot(await http.get(requestUrl), 'freehire');
    if (!Array.isArray(root.data)) throw new AtsResponseError('freehire', 'data is not an array');
    const meta = record(root.meta);
    const ignored = Array.isArray(meta?.ignored_params) ? meta.ignored_params : [];
    if (ignored.length > 0) {
      throw new AtsResponseError('freehire', `API ignored filters: ${ignored.join(', ')}`);
    }
    const vacancies = root.data.flatMap((raw): DiscoveryVacancyAudit[] => {
      const job = record(raw);
      const title = stringValue(job?.title);
      const company = stringValue(job?.company);
      const urlValue = directAtsUrl(job?.url);
      const enrichment = record(job?.enrichment);
      if (job === null || title === null || company === null || urlValue === null) return [];
      return [discoveryAudit({
        key: `freehire:${identifier(job.public_slug, urlValue)}`,
        provider: 'freehire',
        company,
        title,
        url: urlValue,
        location: freehireLocation(job),
        employmentType: stringValue(enrichment?.employment_type),
        currency: stringValue(enrichment?.salary_currency)?.toUpperCase() ?? null,
        salaryPeriod: stringValue(enrichment?.salary_period),
        advertisedMinimum: numberValue(enrichment?.salary_min),
        description: stringValue(job.description),
        raw,
        minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
      })];
    });
    const total = numberValue(meta?.total);
    const status = total !== null && total > root.data.length ? 'partial' : 'success';
    return {
      sources: [{
        id: 'freehire:global-remote-frontend',
        provider: 'freehire',
        url: requestUrl,
        requests: 1,
        listings: vacancies.length,
        status,
        error: status === 'partial' ? `Bounded to ${root.data.length} of ${total} matching rows.` : null,
      }],
      vacancies,
    };
  } catch (error) {
    return {
      sources: [{
        id: 'freehire:global-remote-frontend',
        provider: 'freehire',
        url: requestUrl,
        requests: 1,
        listings: 0,
        ...sourceFailure(error),
      }],
      vacancies: [],
    };
  }
}

function isEmployerDirectJob(job: Record<string, unknown>): boolean {
  return ['ats', 'career_site', 'government'].includes(stringValue(job.source_type) ?? '');
}

async function discoverJobOpportunities(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const url = new URL('https://api.jobopportunitiesapi.org/public/jobs');
  url.searchParams.set('q', 'frontend');
  url.searchParams.set('remote_confirmed', 'true');
  url.searchParams.set('require_fields', 'salary');
  url.searchParams.set('limit', String(config.discovery.jobOpportunitiesLimit));
  const requestUrl = url.toString();
  try {
    const root = parsedRoot(await http.get(requestUrl), 'job_opportunities');
    if (!Array.isArray(root.data)) {
      throw new AtsResponseError('job_opportunities', 'data is not an array');
    }
    const vacancies = root.data.flatMap((raw): DiscoveryVacancyAudit[] => {
      const job = record(raw);
      const fields = record(job?.field_sources);
      const title = stringValue(job?.title);
      const company = stringValue(job?.company);
      const urlValue = httpUrl(job?.apply_url);
      if (
        job === null
        || title === null
        || company === null
        || urlValue === null
        || !isEmployerDirectJob(job)
        || stringValue(fields?.salary) !== 'published'
        || booleanValue(job.remote_inferred) === true
      ) return [];
      return [discoveryAudit({
        key: `job_opportunities:${identifier(job.id, urlValue)}`,
        provider: 'job_opportunities',
        company,
        title,
        url: urlValue,
        location: stringValue(job.location) ?? stringValue(job.country) ?? 'Unknown',
        employmentType: stringValue(job.employment_type),
        currency: stringValue(job.salary_currency)?.toUpperCase() ?? null,
        salaryPeriod: stringValue(job.salary_period),
        advertisedMinimum: numberValue(job.salary_min),
        raw,
        minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
      })];
    });
    const partial = booleanValue(root.has_more) === true;
    return {
      sources: [{
        id: 'job_opportunities:frontend',
        provider: 'job_opportunities',
        url: requestUrl,
        requests: 1,
        listings: vacancies.length,
        status: partial ? 'partial' : 'success',
        error: partial ? 'More rows match; keyless access intentionally exposes one page.' : null,
      }],
      vacancies,
    };
  } catch (error) {
    return {
      sources: [{
        id: 'job_opportunities:frontend',
        provider: 'job_opportunities',
        url: requestUrl,
        requests: 1,
        listings: 0,
        ...sourceFailure(error),
      }],
      vacancies: [],
    };
  }
}

async function discoverRemoteLanders(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const vacancies: DiscoveryVacancyAudit[] = [];
  let requests = 0;
  let successfulRequests = 0;
  let status: DiscoverySourceAudit['status'] = 'success';
  let errorMessage: string | null = null;
  let lastUrl = 'https://remotelanders.com/api/jobs';
  const pageSize = 100;
  try {
    for (let page = 1; page <= config.discovery.remoteLandersMaxPages; page += 1) {
      const url = new URL('https://remotelanders.com/api/jobs');
      url.searchParams.set('category', 'Engineering');
      url.searchParams.set('limit', String(pageSize));
      url.searchParams.set('page', String(page));
      lastUrl = url.toString();
      requests += 1;
      const root = parsedRoot(await http.get(lastUrl), 'remote_landers');
      successfulRequests += 1;
      if (!Array.isArray(root.jobs)) {
        throw new AtsResponseError('remote_landers', 'jobs is not an array');
      }
      for (const raw of root.jobs) {
        const job = record(raw);
        const title = stringValue(job?.title);
        const company = stringValue(job?.company);
        const urlValue = httpUrl(job?.applyUrl);
        if (job === null || title === null || company === null || urlValue === null) continue;
        const salary = parseSalaryText(stringValue(job.salary));
        vacancies.push(discoveryAudit({
          key: `remote_landers:${identifier(job.slug, urlValue)}`,
          provider: 'remote_landers',
          company,
          title,
          url: urlValue,
          location: stringValue(job.location) ?? 'Unknown',
          employmentType: stringValue(job.type),
          currency: salary.currency,
          salaryPeriod: salary.period,
          advertisedMinimum: salary.minimum,
          raw,
          minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
        }));
      }
      const total = numberValue(root.total);
      const complete = root.jobs.length === 0
        || root.jobs.length < pageSize
        || (total !== null && page * pageSize >= total);
      if (complete) break;
      if (page === config.discovery.remoteLandersMaxPages) {
        status = 'partial';
        errorMessage = `Stopped at the configured ${config.discovery.remoteLandersMaxPages}-page limit.`;
      }
    }
  } catch (error) {
    const failure = sourceFailure(error);
    status = successfulRequests > 0 ? 'partial' : failure.status;
    errorMessage = failure.error;
  }
  return {
    sources: [{
      id: 'remote_landers:engineering',
      provider: 'remote_landers',
      url: lastUrl,
      requests,
      listings: vacancies.length,
      status,
      error: errorMessage,
    }],
    vacancies,
  };
}

async function discoverJobgether(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const vacancies: DiscoveryVacancyAudit[] = [];
  let requests = 0;
  let successfulRequests = 0;
  let status: DiscoverySourceAudit['status'] = 'success';
  let errorMessage: string | null = null;
  let lastUrl = 'https://jobgether.com/astroapi/ai/jobs.json';
  const pageSize = 25;
  try {
    for (let page = 1; page <= config.discovery.jobgetherMaxPages; page += 1) {
      const url = new URL('https://jobgether.com/astroapi/ai/jobs.json');
      url.searchParams.set('keyword', 'frontend');
      url.searchParams.set('remoteType', 'full-remote');
      url.searchParams.set('includeHybrid', 'false');
      url.searchParams.set('salaryMin', String(config.minimumAnnualBaseUsd));
      url.searchParams.set('currency', 'USD');
      url.searchParams.set('sort', 'date');
      url.searchParams.set('page', String(page));
      url.searchParams.set('limit', String(pageSize));
      lastUrl = url.toString();
      requests += 1;
      const root = parsedRoot(await http.get(lastUrl), 'jobgether');
      successfulRequests += 1;
      if (!Array.isArray(root.jobs)) throw new AtsResponseError('jobgether', 'jobs is not an array');
      for (const raw of root.jobs) {
        const job = record(raw);
        const title = stringValue(job?.title);
        const company = stringValue(job?.company);
        const urlValue = httpUrl(job?.url);
        if (job === null || title === null || company === null || urlValue === null) continue;
        const salary = parseSalaryText(stringValue(job.salaryRange));
        vacancies.push(discoveryAudit({
          key: `jobgether:${identifier(job.id, urlValue)}`,
          provider: 'jobgether',
          company,
          title,
          url: urlValue,
          location: stringValue(job.location) ?? 'Unknown',
          employmentType: stringValue(job.contractType),
          currency: salary.currency,
          salaryPeriod: salary.minimum === null ? null : (salary.period ?? 'annual'),
          advertisedMinimum: salary.minimum,
          raw,
          minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
        }));
      }
      const pagination = record(root.pagination);
      const hasMore = booleanValue(pagination?.hasMore) === true;
      if (!hasMore) break;
      if (page === config.discovery.jobgetherMaxPages) {
        status = 'partial';
        errorMessage = `Stopped at the documented ${config.discovery.jobgetherMaxPages}-page limit.`;
      }
    }
  } catch (error) {
    const failure = sourceFailure(error);
    status = successfulRequests > 0 ? 'partial' : failure.status;
    errorMessage = failure.error;
  }
  return {
    sources: [{
      id: 'jobgether:global-remote-frontend',
      provider: 'jobgether',
      url: lastUrl,
      requests,
      listings: vacancies.length,
      status,
      error: errorMessage,
    }],
    vacancies,
  };
}

export async function runStructuredDiscovery(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const runs = await Promise.all([
    discoverFreehire(http, config),
    discoverJobOpportunities(http, config),
    discoverRemoteLanders(http, config),
    discoverJobgether(http, config),
  ]);
  return {
    sources: runs.flatMap((run) => run.sources),
    vacancies: runs.flatMap((run) => run.vacancies),
  };
}
