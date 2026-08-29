import { load } from 'cheerio';

import type { AtsHttpClient, AtsHttpResponse } from '../ats/http.js';
import { AtsResponseError, requireSuccessfulResponse } from '../ats/http.js';
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

type Provider = DiscoveryVacancyAudit['provider'];

type RssItem = {
  title: string;
  link: string;
  guid: string;
  description: string;
  fields: Record<string, string[]>;
};

function decodedText(html: string): string {
  return load(html).text().replace(/\s+/gu, ' ').trim();
}

function parseRss(response: AtsHttpResponse, provider: Provider): RssItem[] {
  requireSuccessfulResponse(provider, response);
  const $ = load(response.body, { xmlMode: true });
  const items: RssItem[] = [];
  $('item').each((_index, element) => {
    const fields: Record<string, string[]> = {};
    $(element).children().each((_childIndex, child) => {
      if (!('tagName' in child)) return;
      const name = child.tagName.toLowerCase();
      const value = $(child).text().trim();
      if (value.length === 0) return;
      (fields[name] ??= []).push(value);
    });
    const title = fields.title?.[0];
    const link = httpUrl(fields.link?.[0]);
    if (title === undefined || link === null) return;
    items.push({
      title,
      link,
      guid: fields.guid?.[0] ?? link,
      description: decodedText(fields.description?.[0] ?? fields['content:encoded']?.[0] ?? ''),
      fields,
    });
  });
  if ($('channel').length === 0) {
    throw new AtsResponseError(provider, 'invalid RSS document');
  }
  return items;
}

function companyColonTitle(value: string): { company: string; title: string } {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator >= value.length - 1) {
    return { company: 'Unspecified employer', title: value.trim() };
  }
  return {
    company: value.slice(0, separator).trim(),
    title: value.slice(separator + 1).trim(),
  };
}

function titleAtCompany(value: string): { company: string; title: string } {
  const match = /^(.*?)\s+at\s+(.+)$/iu.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) {
    return { company: 'Unspecified employer', title: value.trim() };
  }
  return { company: match[2].trim(), title: match[1].trim() };
}

function jobspressoCreator(value: string): { company: string; location: string } {
  const [companyPart, locationPart] = value.split('<br>');
  const trimmedCompany = companyPart?.trim() ?? '';
  const company = trimmedCompany.length > 0 ? trimmedCompany : 'Unspecified employer';
  const location = (locationPart ?? '')
    .replace(/⚲/gu, '')
    .replace(/&nbsp;/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim() || 'Remote (eligibility unspecified)';
  return { company, location };
}

function devItTitle(value: string): { company: string; title: string } {
  const match = /^(.*?)\s+@\s+(.+?)(?:\s+\[[^\]]+\])?$/u.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) {
    return { company: 'Unspecified employer', title: value.trim() };
  }
  return { company: match[2].trim(), title: match[1].trim() };
}

async function discoverRss(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
  options: {
    provider: Provider;
    id: string;
    url: string;
    normalize(item: RssItem): DiscoveryVacancyAudit | null;
  },
): Promise<DiscoveryRun> {
  try {
    const items = parseRss(await http.get(options.url), options.provider);
    const vacancies = items.flatMap((item) => {
      const normalized = options.normalize(item);
      return normalized === null ? [] : [normalized];
    });
    return {
      sources: [{
        id: options.id,
        provider: options.provider,
        url: options.url,
        requests: 1,
        listings: vacancies.length,
        status: 'success',
        error: null,
      }],
      vacancies,
    };
  } catch (error) {
    return {
      sources: [{
        id: options.id,
        provider: options.provider,
        url: options.url,
        requests: 1,
        listings: 0,
        ...sourceFailure(error),
      }],
      vacancies: [],
    };
  }
}

async function discoverWeWorkRemotely(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const url = 'https://weworkremotely.com/categories/remote-front-end-programming-jobs.rss';
  return discoverRss(http, config, {
    provider: 'we_work_remotely',
    id: 'we_work_remotely:front-end-programming',
    url,
    normalize(item) {
      const parsedTitle = companyColonTitle(item.title);
      const salary = parseSalaryText(`${item.title} ${item.description}`);
      return discoveryAudit({
        key: `we_work_remotely:${item.guid}`,
        provider: 'we_work_remotely',
        company: parsedTitle.company,
        title: parsedTitle.title,
        url: item.link,
        location: item.fields.region?.[0]
          ?? item.fields.country?.[0]
          ?? 'Remote (eligibility unspecified)',
        employmentType: item.fields.type?.[0] ?? null,
        currency: salary.currency,
        salaryPeriod: salary.period,
        advertisedMinimum: salary.minimum,
        description: item.description,
        raw: item,
        minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
      });
    },
  });
}

async function discoverStartupJobs(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const url = 'https://startup.jobs/feeds/jobs?role=engineering&workplace=remote';
  return discoverRss(http, config, {
    provider: 'startup_jobs',
    id: 'startup_jobs:engineering-remote',
    url,
    normalize(item) {
      const parsedTitle = titleAtCompany(item.title);
      const salary = parseSalaryText(`${item.title} ${item.description}`);
      return discoveryAudit({
        key: `startup_jobs:${item.guid}`,
        provider: 'startup_jobs',
        company: parsedTitle.company,
        title: parsedTitle.title,
        url: item.link,
        location: 'Remote (eligibility unspecified)',
        employmentType: null,
        currency: salary.currency,
        salaryPeriod: salary.period,
        advertisedMinimum: salary.minimum,
        description: item.description,
        raw: item,
        minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
      });
    },
  });
}

async function discoverJobsCollider(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const url = 'https://jobscollider.com/remote-jobs.rss';
  return discoverRss(http, config, {
    provider: 'jobs_collider',
    id: 'jobs_collider:remote-jobs',
    url,
    normalize(item) {
      const parsedTitle = titleAtCompany(item.title);
      const salary = parseSalaryText(`${item.title} ${item.description}`);
      return discoveryAudit({
        key: `jobs_collider:${item.guid}`,
        provider: 'jobs_collider',
        company: parsedTitle.company,
        title: parsedTitle.title,
        url: item.link,
        location: 'Remote (eligibility unspecified)',
        employmentType: null,
        currency: salary.currency,
        salaryPeriod: salary.period,
        advertisedMinimum: salary.minimum,
        description: item.description,
        raw: item,
        minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
      });
    },
  });
}

async function discoverDevItJobsNl(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const url = 'https://devitjobs.nl/rss';
  return discoverRss(http, config, {
    provider: 'devitjobs_nl',
    id: 'devitjobs_nl:all-jobs',
    url,
    normalize(item) {
      const parsedTitle = devItTitle(item.title);
      const salary = parseSalaryText(`${item.title} ${item.description}`);
      return discoveryAudit({
        key: `devitjobs_nl:${item.guid}`,
        provider: 'devitjobs_nl',
        company: parsedTitle.company,
        title: parsedTitle.title,
        url: item.link,
        location: 'Netherlands',
        employmentType: null,
        currency: salary.currency,
        salaryPeriod: salary.minimum === null ? null : (salary.period ?? 'annual'),
        advertisedMinimum: salary.minimum,
        description: item.description,
        raw: item,
        minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
      });
    },
  });
}

async function discoverDevItJobsUk(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const url = 'https://devitjobs.uk/rss';
  return discoverRss(http, config, {
    provider: 'devitjobs_uk',
    id: 'devitjobs_uk:all-jobs',
    url,
    normalize(item) {
      const parsedTitle = devItTitle(item.title);
      const salary = parseSalaryText(`${item.title} ${item.description}`);
      return discoveryAudit({
        key: `devitjobs_uk:${item.guid}`,
        provider: 'devitjobs_uk',
        company: parsedTitle.company,
        title: parsedTitle.title,
        url: item.link,
        location: 'United Kingdom',
        employmentType: null,
        currency: salary.currency,
        salaryPeriod: salary.minimum === null ? null : (salary.period ?? 'annual'),
        advertisedMinimum: salary.minimum,
        description: item.description,
        raw: item,
        minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
      });
    },
  });
}

async function discoverRealWorkFromAnywhere(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const url = 'https://www.realworkfromanywhere.com/remote-frontend-jobs/rss.xml';
  return discoverRss(http, config, {
    provider: 'real_work_from_anywhere',
    id: 'real_work_from_anywhere:frontend',
    url,
    normalize(item) {
      const parsedTitle = titleAtCompany(item.title);
      return discoveryAudit({
        key: `real_work_from_anywhere:${item.guid}`,
        provider: 'real_work_from_anywhere',
        company: parsedTitle.company,
        title: parsedTitle.title,
        url: item.link,
        location: 'Worldwide',
        employmentType: null,
        currency: null,
        salaryPeriod: null,
        advertisedMinimum: null,
        description: item.description,
        raw: item,
        minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
      });
    },
  });
}

async function discoverJobspresso(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const url = 'https://jobspresso.co/?feed=job_feed';
  return discoverRss(http, config, {
    provider: 'jobspresso',
    id: 'jobspresso:all-jobs',
    url,
    normalize(item) {
      const { company, location } = jobspressoCreator(item.fields['dc:creator']?.[0] ?? '');
      const salary = parseSalaryText(`${item.title} ${item.description}`);
      return discoveryAudit({
        key: `jobspresso:${item.guid}`,
        provider: 'jobspresso',
        company,
        title: item.title,
        url: item.link,
        location,
        employmentType: null,
        currency: salary.currency,
        salaryPeriod: salary.period,
        advertisedMinimum: salary.minimum,
        description: item.description,
        raw: item,
        minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
      });
    },
  });
}

async function discoverRemoteFrontendJobs(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const url = 'https://www.remotefrontendjobs.com/feed.xml';
  return discoverRss(http, config, {
    provider: 'remote_frontend_jobs',
    id: 'remote_frontend_jobs:all-jobs',
    url,
    normalize(item) {
      const parsedTitle = titleAtCompany(item.title);
      const salary = parseSalaryText(`${item.title} ${item.description}`);
      return discoveryAudit({
        key: `remote_frontend_jobs:${item.guid}`,
        provider: 'remote_frontend_jobs',
        company: parsedTitle.company,
        title: parsedTitle.title,
        url: item.link,
        location: 'Worldwide',
        employmentType: null,
        currency: salary.currency,
        salaryPeriod: salary.period,
        advertisedMinimum: salary.minimum,
        description: item.description,
        raw: item,
        minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
      });
    },
  });
}

async function discoverWorkingNomads(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const url = 'https://www.workingnomads.com/api/exposed_jobs/';
  try {
    const response = await http.get(url);
    requireSuccessfulResponse('working_nomads', response);
    let root: unknown;
    try {
      root = JSON.parse(response.body) as unknown;
    } catch (error) {
      throw new AtsResponseError('working_nomads', 'invalid discovery JSON', response.status, { cause: error });
    }
    if (!Array.isArray(root)) throw new AtsResponseError('working_nomads', 'root is not an array');
    const vacancies = root.flatMap((raw): DiscoveryVacancyAudit[] => {
      const job = record(raw);
      const title = stringValue(job?.title);
      const company = stringValue(job?.company_name);
      const urlValue = httpUrl(job?.url);
      if (job === null || title === null || company === null || urlValue === null) return [];
      const description = decodedText(stringValue(job.description) ?? '');
      const salary = parseSalaryText(`${title} ${description}`);
      return [discoveryAudit({
        key: `working_nomads:${identifier(job.id, urlValue)}`,
        provider: 'working_nomads',
        company,
        title,
        url: urlValue,
        location: stringValue(job.location) ?? 'Remote (eligibility unspecified)',
        employmentType: null,
        currency: salary.currency,
        salaryPeriod: salary.period,
        advertisedMinimum: salary.minimum,
        description,
        raw,
        minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
      })];
    });
    return {
      sources: [{ id: 'working_nomads:public-feed', provider: 'working_nomads', url, requests: 1, listings: vacancies.length, status: 'success', error: null }],
      vacancies,
    };
  } catch (error) {
    return {
      sources: [{ id: 'working_nomads:public-feed', provider: 'working_nomads', url, requests: 1, listings: 0, ...sourceFailure(error) }],
      vacancies: [],
    };
  }
}

async function discoverRemoteFirstJobs(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const vacancies: DiscoveryVacancyAudit[] = [];
  let requests = 0;
  let successfulRequests = 0;
  let status: DiscoverySourceAudit['status'] = 'success';
  let errorMessage: string | null = null;
  let lastUrl = 'https://remotefirstjobs.com/api/search-jobs?query=frontend&page=0';
  try {
    for (let page = 0; page < config.discovery.remoteFirstMaxPages; page += 1) {
      const url = new URL('https://remotefirstjobs.com/api/search-jobs');
      url.searchParams.set('query', 'frontend');
      url.searchParams.set('page', String(page));
      lastUrl = url.toString();
      requests += 1;
      const root = parsedRoot(await http.get(lastUrl), 'remote_first_jobs');
      successfulRequests += 1;
      if (!Array.isArray(root.jobs)) {
        throw new AtsResponseError('remote_first_jobs', 'jobs is not an array');
      }
      for (const raw of root.jobs) {
        const job = record(raw);
        const title = stringValue(job?.title);
        const company = stringValue(job?.company_name);
        const urlValue = httpUrl(job?.url);
        if (job === null || title === null || company === null || urlValue === null) continue;
        const minimum = numberValue(job.salary_min);
        vacancies.push(discoveryAudit({
          key: `remote_first_jobs:${identifier(job.id, urlValue)}`,
          provider: 'remote_first_jobs',
          company,
          title,
          url: urlValue,
          location: locations(job.locations, 'Remote (eligibility unspecified)'),
          employmentType: null,
          currency: minimum !== null && minimum > 0 ? 'USD' : null,
          salaryPeriod: minimum !== null && minimum > 0 ? 'annual' : null,
          advertisedMinimum: minimum !== null && minimum > 0 ? minimum : null,
          description: stringValue(job.description),
          raw,
          minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
        }));
      }
      if (root.jobs.length < 100) break;
      if (page + 1 === config.discovery.remoteFirstMaxPages) {
        status = 'partial';
        errorMessage = `Stopped at the configured ${config.discovery.remoteFirstMaxPages}-page limit.`;
      }
    }
  } catch (error) {
    const failure = sourceFailure(error);
    status = successfulRequests > 0 ? 'partial' : failure.status;
    errorMessage = failure.error;
  }
  return {
    sources: [{
      id: 'remote_first_jobs:frontend',
      provider: 'remote_first_jobs',
      url: lastUrl,
      requests,
      listings: vacancies.length,
      status,
      error: errorMessage,
    }],
    vacancies,
  };
}

async function discoverJobRemotely(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const vacancies: DiscoveryVacancyAudit[] = [];
  let requests = 0;
  let successfulRequests = 0;
  let status: DiscoverySourceAudit['status'] = 'success';
  let errorMessage: string | null = null;
  let lastUrl = 'https://jobremotely.io/api/v1/jobs';
  const pageSize = 50;
  try {
    for (let page = 1; page <= config.discovery.jobRemotelyMaxPages; page += 1) {
      const url = new URL('https://jobremotely.io/api/v1/jobs');
      url.searchParams.set('search', 'frontend');
      url.searchParams.set('salaryMin', String(config.minimumAnnualBaseUsd));
      url.searchParams.set('sort', 'newest');
      url.searchParams.set('page', String(page));
      url.searchParams.set('limit', String(pageSize));
      lastUrl = url.toString();
      requests += 1;
      const root = parsedRoot(await http.get(lastUrl), 'job_remotely');
      successfulRequests += 1;
      const data = record(root.data);
      if (!Array.isArray(data?.jobs)) {
        throw new AtsResponseError('job_remotely', 'data.jobs is not an array');
      }
      for (const raw of data.jobs) {
        const job = record(raw);
        const title = stringValue(job?.title);
        const urlValue = httpUrl(job?.url);
        if (job === null || title === null || urlValue === null) continue;
        const salary = record(job.salary);
        vacancies.push(discoveryAudit({
          key: `job_remotely:${identifier(job.id, urlValue)}`,
          provider: 'job_remotely',
          company: 'Unspecified employer (JobRemotely)',
          title,
          url: urlValue,
          location: stringValue(job.location) ?? 'Remote (eligibility unspecified)',
          employmentType: stringValue(job.jobType),
          currency: stringValue(salary?.currency)?.toUpperCase() ?? null,
          salaryPeriod: numberValue(salary?.min) === null ? null : 'annual',
          advertisedMinimum: numberValue(salary?.min),
          description: Array.isArray(job.skillsRequired)
            ? job.skillsRequired.filter((value): value is string => typeof value === 'string').join(' ')
            : null,
          raw,
          minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
        }));
      }
      const pages = numberValue(data.pages);
      if (data.jobs.length < pageSize || (pages !== null && page >= pages)) break;
      if (page === config.discovery.jobRemotelyMaxPages) {
        status = 'partial';
        errorMessage = `Stopped at the configured ${config.discovery.jobRemotelyMaxPages}-page limit.`;
      }
    }
  } catch (error) {
    const failure = sourceFailure(error);
    status = successfulRequests > 0 ? 'partial' : failure.status;
    errorMessage = failure.error;
  }
  return {
    sources: [{
      id: 'job_remotely:frontend-100k',
      provider: 'job_remotely',
      url: lastUrl,
      requests,
      listings: vacancies.length,
      status,
      error: errorMessage,
    }],
    vacancies,
  };
}

async function discoverRemoteOk(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const url = 'https://remoteok.com/api';
  try {
    const response = await http.get(url);
    requireSuccessfulResponse('remote_ok', response);
    let root: unknown;
    try {
      root = JSON.parse(response.body) as unknown;
    } catch (error) {
      throw new AtsResponseError('remote_ok', 'invalid discovery JSON', response.status, { cause: error });
    }
    if (!Array.isArray(root)) throw new AtsResponseError('remote_ok', 'root is not an array');
    const vacancies = root.flatMap((raw): DiscoveryVacancyAudit[] => {
      const job = record(raw);
      const title = stringValue(job?.position);
      const company = stringValue(job?.company);
      const urlValue = httpUrl(job?.apply_url) ?? httpUrl(job?.url);
      if (job === null || title === null || company === null || urlValue === null) return [];
      const minimum = numberValue(job.salary_min);
      return [discoveryAudit({
        key: `remote_ok:${identifier(job.id, urlValue)}`,
        provider: 'remote_ok',
        company,
        title,
        url: urlValue,
        location: stringValue(job.location) ?? 'Remote (eligibility unspecified)',
        employmentType: null,
        currency: minimum !== null && minimum > 0 ? 'USD' : null,
        salaryPeriod: minimum !== null && minimum > 0 ? 'annual' : null,
        advertisedMinimum: minimum !== null && minimum > 0 ? minimum : null,
        description: stringValue(job.description),
        raw,
        minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
      })];
    });
    return {
      sources: [{
        id: 'remote_ok:public-api',
        provider: 'remote_ok',
        url,
        requests: 1,
        listings: vacancies.length,
        status: 'success',
        error: null,
      }],
      vacancies,
    };
  } catch (error) {
    return {
      sources: [{
        id: 'remote_ok:public-api',
        provider: 'remote_ok',
        url,
        requests: 1,
        listings: 0,
        ...sourceFailure(error),
      }],
      vacancies: [],
    };
  }
}

async function discoverArbeitnow(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const vacancies: DiscoveryVacancyAudit[] = [];
  let requests = 0;
  let successfulRequests = 0;
  let status: DiscoverySourceAudit['status'] = 'success';
  let errorMessage: string | null = null;
  let lastUrl = 'https://www.arbeitnow.com/api/job-board-api?page=1';
  try {
    for (let page = 1; page <= config.discovery.arbeitnowMaxPages; page += 1) {
      const url = new URL('https://www.arbeitnow.com/api/job-board-api');
      url.searchParams.set('page', String(page));
      lastUrl = url.toString();
      requests += 1;
      const root = parsedRoot(await http.get(lastUrl), 'arbeitnow');
      successfulRequests += 1;
      if (!Array.isArray(root.data)) throw new AtsResponseError('arbeitnow', 'data is not an array');
      for (const raw of root.data) {
        const job = record(raw);
        const title = stringValue(job?.title);
        const company = stringValue(job?.company_name);
        const urlValue = httpUrl(job?.url);
        if (
          job === null
          || title === null
          || company === null
          || urlValue === null
          || booleanValue(job.remote) !== true
        ) continue;
        const description = decodedText(stringValue(job.description) ?? '');
        const salary = parseSalaryText(description);
        vacancies.push(discoveryAudit({
          key: `arbeitnow:${identifier(job.slug, urlValue)}`,
          provider: 'arbeitnow',
          company,
          title,
          url: urlValue,
          location: stringValue(job.location) ?? 'Remote (eligibility unspecified)',
          employmentType: Array.isArray(job.job_types)
            ? job.job_types.filter((value): value is string => typeof value === 'string').join(', ') || null
            : null,
          currency: salary.currency,
          salaryPeriod: salary.period,
          advertisedMinimum: salary.minimum,
          description,
          raw,
          minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
        }));
      }
      const links = record(root.links);
      if (httpUrl(links?.next) === null) break;
      if (page === config.discovery.arbeitnowMaxPages) {
        status = 'partial';
        errorMessage = `Stopped at the configured ${config.discovery.arbeitnowMaxPages}-page limit.`;
      }
    }
  } catch (error) {
    const failure = sourceFailure(error);
    status = successfulRequests > 0 ? 'partial' : failure.status;
    errorMessage = failure.error;
  }
  return {
    sources: [{
      id: 'arbeitnow:remote-jobs',
      provider: 'arbeitnow',
      url: lastUrl,
      requests,
      listings: vacancies.length,
      status,
      error: errorMessage,
    }],
    vacancies,
  };
}

export async function runFeedDiscovery(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const runs = await Promise.all([
    discoverWeWorkRemotely(http, config),
    discoverRemoteFirstJobs(http, config),
    discoverJobRemotely(http, config),
    discoverRemoteOk(http, config),
    discoverArbeitnow(http, config),
    discoverStartupJobs(http, config),
    discoverDevItJobsNl(http, config),
    discoverJobsCollider(http, config),
    discoverWorkingNomads(http, config),
    discoverRealWorkFromAnywhere(http, config),
    discoverDevItJobsUk(http, config),
    discoverJobspresso(http, config),
    discoverRemoteFrontendJobs(http, config),
  ]);
  return {
    sources: runs.flatMap((run) => run.sources),
    vacancies: runs.flatMap((run) => run.vacancies),
  };
}
