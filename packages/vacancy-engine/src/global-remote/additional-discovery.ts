import { load } from 'cheerio';

import type { AtsHttpClient, AtsHttpResponse } from '../ats/http.js';
import { AtsResponseError, requireSuccessfulResponse } from '../ats/http.js';
import {
  discoveryAudit,
  httpUrl,
  identifier,
  locations,
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
import { discoverRemoote } from './remoote-discovery.js';

function decodedText(html: string): string {
  return load(html).text().replace(/\s+/gu, ' ').trim();
}

function diceStructuredContent(response: AtsHttpResponse): Record<string, unknown> {
  requireSuccessfulResponse('dice', response);
  const payloads = response.body
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((line) => line.length > 0);
  if (payloads.length === 0 && response.body.trim().startsWith('{')) {
    payloads.push(response.body.trim());
  }
  for (const payload of payloads) {
    let message: Record<string, unknown> | null;
    try {
      message = record(JSON.parse(payload) as unknown);
    } catch {
      continue;
    }
    const result = record(message?.result);
    const structured = record(result?.structuredContent);
    if (structured !== null) return structured;
    if (Array.isArray(result?.content)) {
      for (const raw of result.content) {
        const content = record(raw);
        const text = stringValue(content?.text);
        if (text === null) continue;
        try {
          const parsed = record(JSON.parse(text) as unknown);
          if (parsed !== null) return parsed;
        } catch {
          // Ignore non-JSON content blocks and keep looking for structured data.
        }
      }
    }
  }
  throw new AtsResponseError('dice', 'MCP response did not contain structured job data', response.status);
}

async function discoverDice(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const url = 'https://mcp.dice.com/mcp';
  const vacancies: DiscoveryVacancyAudit[] = [];
  let requests = 0;
  let successfulRequests = 0;
  let status: DiscoverySourceAudit['status'] = 'success';
  let errorMessage: string | null = null;
  try {
    for (let page = 1; page <= config.discovery.diceMaxPages; page += 1) {
      requests += 1;
      const response = await http.postJson(url, {
        jsonrpc: '2.0',
        id: `dice-frontend-${page}`,
        method: 'tools/call',
        params: {
          name: 'search_jobs',
          arguments: {
            keyword: 'frontend developer',
            jobs_per_page: 100,
            page_number: page,
            sort: 'relevance',
            posted_date: 'SEVEN',
            workplace_types: ['Remote'],
          },
        },
      }, {
        allowedOrigins: ['https://mcp.dice.com'],
        headers: {
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-06-18',
        },
      });
      const structured = diceStructuredContent(response);
      successfulRequests += 1;
      if (!Array.isArray(structured.data)) {
        throw new AtsResponseError('dice', 'structuredContent.data is not an array', response.status);
      }
      for (const raw of structured.data) {
        const job = record(raw);
        const title = stringValue(job?.title);
        const company = stringValue(job?.companyName);
        const urlValue = httpUrl(job?.detailsPageUrl);
        if (job === null || title === null || company === null || urlValue === null) continue;
        const summary = stringValue(job.summary) ?? '';
        const salary = parseSalaryText(`${stringValue(job.salary) ?? ''} ${summary}`);
        const jobLocation = record(job.jobLocation);
        const workplaceTypes = Array.isArray(job.workplaceTypes)
          ? job.workplaceTypes.filter((value): value is string => typeof value === 'string')
          : [];
        vacancies.push(discoveryAudit({
          key: `dice:${identifier(job.guid, urlValue)}`,
          provider: 'dice',
          company,
          title,
          url: urlValue,
          location: stringValue(jobLocation?.displayName)
            ?? (workplaceTypes.includes('Remote') ? 'Remote (eligibility unspecified)' : 'Unknown'),
          employmentType: Array.isArray(job.employmentType)
            ? job.employmentType.filter((value): value is string => typeof value === 'string').join(', ') || null
            : stringValue(job.employmentType),
          currency: salary.currency,
          salaryPeriod: salary.period,
          advertisedMinimum: salary.minimum,
          description: summary,
          raw,
          minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
        }));
      }
      if (structured.data.length < 100) break;
      if (page === config.discovery.diceMaxPages) {
        status = 'partial';
        errorMessage = `Stopped at the configured ${config.discovery.diceMaxPages}-page limit.`;
      }
    }
  } catch (error) {
    const failure = sourceFailure(error);
    status = successfulRequests > 0 ? 'partial' : failure.status;
    errorMessage = failure.error;
  }
  return {
    sources: [{
      id: 'dice:frontend-remote',
      provider: 'dice',
      url,
      requests,
      listings: vacancies.length,
      status,
      error: errorMessage,
    }],
    vacancies,
  };
}

async function discoverTheMuse(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const vacancies: DiscoveryVacancyAudit[] = [];
  let requests = 0;
  let successfulRequests = 0;
  let status: DiscoverySourceAudit['status'] = 'success';
  let errorMessage: string | null = null;
  let lastUrl = 'https://www.themuse.com/api/public/jobs';
  try {
    for (let page = 1; page <= config.discovery.museMaxPages; page += 1) {
      const url = new URL('https://www.themuse.com/api/public/jobs');
      url.searchParams.set('page', String(page));
      url.searchParams.set('category', 'Computer and IT');
      url.searchParams.set('location', 'Remote');
      lastUrl = url.toString();
      requests += 1;
      const root = parsedRoot(await http.get(lastUrl), 'the_muse');
      successfulRequests += 1;
      if (!Array.isArray(root.results)) {
        throw new AtsResponseError('the_muse', 'results is not an array');
      }
      for (const raw of root.results) {
        const job = record(raw);
        const companyRecord = record(job?.company);
        const refs = record(job?.refs);
        const title = stringValue(job?.name);
        const company = stringValue(companyRecord?.name);
        const urlValue = httpUrl(refs?.landing_page);
        if (job === null || title === null || company === null || urlValue === null) continue;
        const description = decodedText(stringValue(job.contents) ?? '');
        const salary = parseSalaryText(description);
        vacancies.push(discoveryAudit({
          key: `the_muse:${identifier(job.id, urlValue)}`,
          provider: 'the_muse',
          company,
          title,
          url: urlValue,
          location: locations(job.locations, 'Remote (eligibility unspecified)'),
          employmentType: null,
          currency: salary.currency,
          salaryPeriod: salary.period,
          advertisedMinimum: salary.minimum,
          description,
          raw,
          minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
        }));
      }
      const pageCount = typeof root.page_count === 'number' ? root.page_count : null;
      if (root.results.length === 0 || (pageCount !== null && page >= pageCount)) break;
      if (page === config.discovery.museMaxPages) {
        status = 'partial';
        errorMessage = `Stopped at the configured ${config.discovery.museMaxPages}-page limit.`;
      }
    }
  } catch (error) {
    const failure = sourceFailure(error);
    status = successfulRequests > 0 ? 'partial' : failure.status;
    errorMessage = failure.error;
  }
  return {
    sources: [{
      id: 'the_muse:computer-it-remote',
      provider: 'the_muse',
      url: lastUrl,
      requests,
      listings: vacancies.length,
      status,
      error: errorMessage,
    }],
    vacancies,
  };
}

export async function runAdditionalDiscovery(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const runs = await Promise.all([
    discoverDice(http, config),
    discoverRemoote(http, config),
    ...(config.discovery.museEnabled ? [discoverTheMuse(http, config)] : []),
  ]);
  return {
    sources: runs.flatMap((run) => run.sources),
    vacancies: runs.flatMap((run) => run.vacancies),
  };
}
