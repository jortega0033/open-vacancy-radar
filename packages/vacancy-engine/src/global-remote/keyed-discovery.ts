import type { AtsHttpClient } from '../ats/http.js';
import { AtsResponseError, requireSuccessfulResponse } from '../ats/http.js';
import {
  discoveryAudit,
  httpUrl,
  identifier,
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

function basicAuthHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`, 'utf8').toString('base64')}`;
}

async function discoverAdzuna(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const { adzunaAppId, adzunaAppKey } = config.discovery;
  const vacancies: DiscoveryVacancyAudit[] = [];
  let requests = 0;
  let successfulRequests = 0;
  let status: DiscoverySourceAudit['status'] = 'success';
  let errorMessage: string | null = null;
  let lastUrl = 'https://api.adzuna.com/v1/api/jobs/gb/search/1';
  try {
    for (let page = 1; page <= config.discovery.adzunaMaxPages; page += 1) {
      const url = new URL(`https://api.adzuna.com/v1/api/jobs/gb/search/${page}`);
      url.searchParams.set('app_id', adzunaAppId);
      url.searchParams.set('app_key', adzunaAppKey);
      url.searchParams.set('content-type', 'application/json');
      if (config.discovery.roleQuery) url.searchParams.set('what', config.discovery.roleQuery);
      url.searchParams.set('results_per_page', '50');
      lastUrl = url.toString();
      requests += 1;
      const root = parsedRoot(await http.get(lastUrl), 'adzuna');
      successfulRequests += 1;
      if (!Array.isArray(root.results)) throw new AtsResponseError('adzuna', 'results is not an array');
      for (const raw of root.results) {
        const job = record(raw);
        const title = stringValue(job?.title);
        const company = stringValue(record(job?.company)?.display_name);
        const urlValue = httpUrl(job?.redirect_url);
        if (job === null || title === null || company === null || urlValue === null) continue;
        const minimum = numberValue(job.salary_min);
        vacancies.push(discoveryAudit({
          key: `adzuna:${identifier(job.id, urlValue)}`,
          provider: 'adzuna',
          company,
          title,
          url: urlValue,
          location: stringValue(record(job.location)?.display_name) ?? 'United Kingdom',
          employmentType: stringValue(job.contract_time),
          currency: minimum !== null && minimum > 0 ? 'GBP' : null,
          salaryPeriod: minimum !== null && minimum > 0 ? 'annual' : null,
          advertisedMinimum: minimum !== null && minimum > 0 ? minimum : null,
          description: stringValue(job.description),
          raw,
          minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
        }));
      }
      if (root.results.length < 50) break;
      if (page === config.discovery.adzunaMaxPages) {
        status = 'partial';
        errorMessage = `Stopped at the configured ${config.discovery.adzunaMaxPages}-page limit.`;
      }
    }
  } catch (error) {
    const failure = sourceFailure(error);
    status = successfulRequests > 0 ? 'partial' : failure.status;
    errorMessage = failure.error;
  }
  return {
    sources: [{
      id: 'adzuna:gb-frontend-developer',
      provider: 'adzuna',
      url: lastUrl,
      requests,
      listings: vacancies.length,
      status,
      error: errorMessage,
    }],
    vacancies,
  };
}

async function discoverJooble(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const url = `https://jooble.org/api/${config.discovery.joobleApiKey}`;
  try {
    const response = await http.postJson(url, {
      ...(config.discovery.roleQuery ? { keywords: config.discovery.roleQuery } : {}),
      location: 'remote',
    });
    requireSuccessfulResponse('jooble', response);
    let root: unknown;
    try {
      root = JSON.parse(response.body) as unknown;
    } catch (error) {
      throw new AtsResponseError('jooble', 'invalid discovery JSON', response.status, { cause: error });
    }
    const parsed = record(root);
    if (!Array.isArray(parsed?.jobs)) throw new AtsResponseError('jooble', 'jobs is not an array');
    const vacancies = parsed.jobs.flatMap((raw): DiscoveryVacancyAudit[] => {
      const job = record(raw);
      const title = stringValue(job?.title);
      const company = stringValue(job?.company);
      const urlValue = httpUrl(job?.link);
      if (job === null || title === null || company === null || urlValue === null) return [];
      const snippet = stringValue(job.snippet);
      const salary = parseSalaryText(`${stringValue(job.salary) ?? ''} ${snippet ?? ''}`);
      return [discoveryAudit({
        key: `jooble:${identifier(job.id, urlValue)}`,
        provider: 'jooble',
        company,
        title,
        url: urlValue,
        location: stringValue(job.location) ?? 'Remote (eligibility unspecified)',
        employmentType: stringValue(job.type),
        currency: salary.currency,
        salaryPeriod: salary.period,
        advertisedMinimum: salary.minimum,
        description: snippet,
        raw,
        minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
      })];
    });
    return {
      sources: [{ id: 'jooble:frontend-remote', provider: 'jooble', url, requests: 1, listings: vacancies.length, status: 'success', error: null }],
      vacancies,
    };
  } catch (error) {
    return {
      sources: [{ id: 'jooble:frontend-remote', provider: 'jooble', url, requests: 1, listings: 0, ...sourceFailure(error) }],
      vacancies: [],
    };
  }
}

async function discoverReed(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const reedUrl = new URL('https://www.reed.co.uk/api/1.0/search');
  if (config.discovery.roleQuery) reedUrl.searchParams.set('keywords', config.discovery.roleQuery);
  reedUrl.searchParams.set('resultsToTake', '100');
  const url = reedUrl.toString();
  try {
    const response = await http.get(url, { headers: { Authorization: basicAuthHeader(config.discovery.reedApiKey) } });
    requireSuccessfulResponse('reed', response);
    let root: unknown;
    try {
      root = JSON.parse(response.body) as unknown;
    } catch (error) {
      throw new AtsResponseError('reed', 'invalid discovery JSON', response.status, { cause: error });
    }
    const parsed = record(root);
    if (!Array.isArray(parsed?.results)) throw new AtsResponseError('reed', 'results is not an array');
    const vacancies = parsed.results.flatMap((raw): DiscoveryVacancyAudit[] => {
      const job = record(raw);
      const title = stringValue(job?.jobTitle);
      const company = stringValue(job?.employerName);
      const urlValue = httpUrl(job?.jobUrl);
      if (job === null || title === null || company === null || urlValue === null) return [];
      const minimum = numberValue(job.minimumSalary);
      const currency = stringValue(job.currency)?.toUpperCase() ?? null;
      return [discoveryAudit({
        key: `reed:${identifier(job.jobId, urlValue)}`,
        provider: 'reed',
        company,
        title,
        url: urlValue,
        location: stringValue(job.locationName) ?? 'United Kingdom',
        employmentType: null,
        currency: minimum !== null && minimum > 0 ? currency : null,
        salaryPeriod: minimum !== null && minimum > 0 ? 'annual' : null,
        advertisedMinimum: minimum !== null && minimum > 0 ? minimum : null,
        description: stringValue(job.jobDescription),
        raw,
        minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
      })];
    });
    return {
      sources: [{ id: 'reed:frontend-developer', provider: 'reed', url, requests: 1, listings: vacancies.length, status: 'success', error: null }],
      vacancies,
    };
  } catch (error) {
    return {
      sources: [{ id: 'reed:frontend-developer', provider: 'reed', url, requests: 1, listings: 0, ...sourceFailure(error) }],
      vacancies: [],
    };
  }
}

async function discoverJobsPipe(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const url = 'https://api.jobspipe.dev/v1/jobs/search';
  try {
    const response = await http.postJson(
      url,
      {
        ...(config.discovery.roleQuery ? { job_title_or: [config.discovery.roleQuery] } : {}),
        remote: true,
        posted_at_max_age_days: 30,
        limit: 25,
      },
      { headers: { Authorization: `Bearer ${config.discovery.jobspipeApiKey}` } },
    );
    requireSuccessfulResponse('jobspipe', response);
    let root: unknown;
    try {
      root = JSON.parse(response.body) as unknown;
    } catch (error) {
      throw new AtsResponseError('jobspipe', 'invalid discovery JSON', response.status, { cause: error });
    }
    const parsed = record(root);
    if (!Array.isArray(parsed?.data)) throw new AtsResponseError('jobspipe', 'data is not an array');
    const vacancies = parsed.data.flatMap((raw): DiscoveryVacancyAudit[] => {
      const job = record(raw);
      const title = stringValue(job?.job_title);
      const company = stringValue(job?.company);
      const urlValue = httpUrl(job?.source_url);
      if (job === null || title === null || company === null || urlValue === null) return [];
      return [discoveryAudit({
        key: `jobspipe:${identifier(job.id, urlValue)}`,
        provider: 'jobspipe',
        company,
        title,
        url: urlValue,
        location: stringValue(job.location) ?? stringValue(job.country_code) ?? 'Remote (eligibility unspecified)',
        employmentType: null,
        currency: null,
        salaryPeriod: null,
        advertisedMinimum: null,
        description: stringValue(job.seniority),
        raw,
        minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
      })];
    });
    return {
      sources: [{ id: 'jobspipe:frontend-remote', provider: 'jobspipe', url, requests: 1, listings: vacancies.length, status: 'success', error: null }],
      vacancies,
    };
  } catch (error) {
    return {
      sources: [{ id: 'jobspipe:frontend-remote', provider: 'jobspipe', url, requests: 1, listings: 0, ...sourceFailure(error) }],
      vacancies: [],
    };
  }
}

export async function runKeyedDiscovery(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const runs = await Promise.all([
    ...(config.discovery.adzunaAppId.trim().length > 0 && config.discovery.adzunaAppKey.trim().length > 0
      ? [discoverAdzuna(http, config)]
      : []),
    ...(config.discovery.joobleApiKey.trim().length > 0 ? [discoverJooble(http, config)] : []),
    ...(config.discovery.reedApiKey.trim().length > 0 ? [discoverReed(http, config)] : []),
    ...(config.discovery.jobspipeApiKey.trim().length > 0 ? [discoverJobsPipe(http, config)] : []),
  ]);
  return {
    sources: runs.flatMap((run) => run.sources),
    vacancies: runs.flatMap((run) => run.vacancies),
  };
}
