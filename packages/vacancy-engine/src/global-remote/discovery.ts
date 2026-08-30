import type { AtsHttpClient } from '../ats/http.js';
import { AtsResponseError } from '../ats/http.js';
import { runAdditionalDiscovery } from './additional-discovery.js';
import { runFeedDiscovery } from './feed-discovery.js';
import { runJobtechDiscovery } from './jobtech-discovery.js';
import { runKeyedDiscovery } from './keyed-discovery.js';
import {
  discoveryAudit,
  httpUrl,
  identifier,
  locations,
  numberValue,
  parsedRoot,
  record,
  sourceFailure,
  stringValue,
} from './discovery-shared.js';
import { runStructuredDiscovery } from './structured-discovery.js';
import type {
  DiscoveryRun,
  DiscoverySourceAudit,
  DiscoveryVacancyAudit,
  GlobalRemoteConfig,
} from './models.js';

async function discoverHimalayas(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const sources: DiscoverySourceAudit[] = [];
  const vacancies: DiscoveryVacancyAudit[] = [];
  for (const query of config.discovery.himalayasQueries) {
    let requests = 0;
    let listings = 0;
    let status: DiscoverySourceAudit['status'] = 'success';
    let errorMessage: string | null = null;
    let lastUrl = 'https://himalayas.app/jobs/api/search';
    try {
      for (let page = 1; page <= config.discovery.himalayasMaxPagesPerQuery; page += 1) {
        const url = new URL('https://himalayas.app/jobs/api/search');
        url.searchParams.set('q', query);
        if (config.discovery.himalayasCountry) {
          url.searchParams.set('country', config.discovery.himalayasCountry);
        }
        url.searchParams.set('sort', 'salaryDesc');
        url.searchParams.set('page', String(page));
        lastUrl = url.toString();
        const root = parsedRoot(await http.get(lastUrl), 'himalayas');
        requests += 1;
        if (!Array.isArray(root.jobs)) throw new AtsResponseError('himalayas', 'jobs is not an array');
        for (const raw of root.jobs) {
          const job = record(raw);
          if (job === null) continue;
          const title = stringValue(job.title);
          const company = stringValue(job.companyName);
          // httpUrl, not stringValue: every other discovery adapter in this package constrains a
          // vacancy URL to http(s), and this one must too. The value is third-party feed data that
          // the desktop app renders as a clickable link, so a `file:`/custom-scheme string reaching
          // `shell.openExternal` would be an OS-level action driven by a scraped job posting.
          const urlValue = httpUrl(job.applicationLink) ?? httpUrl(job.guid);
          if (title === null || company === null || urlValue === null) continue;
          vacancies.push(discoveryAudit({
            key: `himalayas:${stringValue(job.guid) ?? `${company}:${title}`}`,
            provider: 'himalayas',
            company,
            title,
            url: urlValue,
            location: locations(job.locationRestrictions),
            employmentType: stringValue(job.employmentType),
            currency: stringValue(job.currency)?.toUpperCase() ?? null,
            salaryPeriod: stringValue(job.salaryPeriod),
            advertisedMinimum: numberValue(job.minSalary),
            raw,
            minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
          }));
          listings += 1;
        }
        const total = numberValue(root.totalCount);
        if (root.jobs.length === 0 || (total !== null && page * 20 >= total)) break;
        if (page === config.discovery.himalayasMaxPagesPerQuery) status = 'partial';
      }
    } catch (error) {
      const failure = sourceFailure(error);
      status = requests > 0 ? 'partial' : failure.status;
      errorMessage = failure.error;
    }
    sources.push({
      id: `himalayas:${query}`,
      provider: 'himalayas',
      url: lastUrl,
      requests,
      listings,
      status,
      error: errorMessage,
    });
  }
  return { sources, vacancies };
}

async function discoverJobicy(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const url = `https://jobicy.com/api/v2/remote-jobs?count=${config.discovery.jobicyCount}&tag=frontend`;
  try {
    const root = parsedRoot(await http.get(url), 'jobicy');
    if (!Array.isArray(root.jobs)) throw new AtsResponseError('jobicy', 'jobs is not an array');
    const vacancies = root.jobs.flatMap((raw): DiscoveryVacancyAudit[] => {
      const job = record(raw);
      const title = stringValue(job?.jobTitle);
      const company = stringValue(job?.companyName);
      const urlValue = httpUrl(job?.url); // http(s) only (see discoverHimalayas above)
      if (job === null || title === null || company === null || urlValue === null) return [];
      return [discoveryAudit({
        key: `jobicy:${identifier(job.id, urlValue)}`,
        provider: 'jobicy',
        company,
        title,
        url: urlValue,
        location: stringValue(job.jobGeo) ?? 'Unknown',
        employmentType: Array.isArray(job.jobType)
          ? job.jobType.filter((value): value is string => typeof value === 'string').join(', ')
          : stringValue(job.jobType),
        currency: stringValue(job.salaryCurrency)?.toUpperCase() ?? null,
        salaryPeriod: stringValue(job.salaryPeriod),
        advertisedMinimum: numberValue(job.salaryMin),
        raw,
        minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
      })];
    });
    return {
      sources: [{ id: 'jobicy:frontend', provider: 'jobicy', url, requests: 1, listings: vacancies.length, status: 'success', error: null }],
      vacancies,
    };
  } catch (error) {
    return {
      sources: [{ id: 'jobicy:frontend', provider: 'jobicy', url, requests: 0, listings: 0, ...sourceFailure(error) }],
      vacancies: [],
    };
  }
}

export async function runGlobalRemoteDiscovery(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const [himalayas, jobicy, structured, feeds, jobtech, additional, keyed] = await Promise.all([
    discoverHimalayas(http, config),
    discoverJobicy(http, config),
    runStructuredDiscovery(http, config),
    runFeedDiscovery(http, config),
    runJobtechDiscovery(http, config),
    runAdditionalDiscovery(http, config),
    runKeyedDiscovery(http, config),
  ]);
  return {
    sources: [
      ...himalayas.sources,
      ...jobicy.sources,
      ...structured.sources,
      ...feeds.sources,
      ...jobtech.sources,
      ...additional.sources,
      ...keyed.sources,
    ],
    vacancies: [
      ...himalayas.vacancies,
      ...jobicy.vacancies,
      ...structured.vacancies,
      ...feeds.vacancies,
      ...jobtech.vacancies,
      ...additional.vacancies,
      ...keyed.vacancies,
    ],
  };
}
