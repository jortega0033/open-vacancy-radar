import type { AtsHttpClient } from '../ats/http.js';
import { AtsResponseError } from '../ats/http.js';
import { discoverAiDevJobs } from './ai-dev-jobs-discovery.js';
import { runAdditionalDiscovery } from './additional-discovery.js';
import { runAtsRosterDiscovery } from './ats-roster-discovery.js';
import type { AtsRosterEntry } from '../companies/ats-roster-source.js';
import {
  attributeNetworkRequests,
  networkAttemptFields,
  newNetworkAttemptCounters,
} from './discovery-attribution.js';
import { runFeedDiscovery } from './feed-discovery.js';
import { writeGapTelemetryReport } from './gap-report.js';
import { runJobtechDiscovery } from './jobtech-discovery.js';
import { runKeyedDiscovery } from './keyed-discovery.js';
import { recordDiscoveryGapTelemetry } from './source-gap-telemetry.js';
import { discoverTaiwanJobs } from './taiwan-jobs-discovery.js';
import {
  completeAudit,
  discoveryAudit,
  httpUrl,
  identifier,
  incompleteAudit,
  isoPostedAt,
  isoPostedAtFromUnixSeconds,
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
  ScanProgressCallback,
} from './models.js';

export async function discoverHimalayas(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const sources: DiscoverySourceAudit[] = [];
  const vacancies: DiscoveryVacancyAudit[] = [];
  // No configured query terms means "no role bias" (the default), not "skip this source
  // entirely": run one broad, unfiltered query rather than let the loop below never execute and
  // silently disable Himalayas forever.
  const queries = config.discovery.himalayasQueries.length > 0 ? config.discovery.himalayasQueries : [''];
  for (const query of queries) {
    // One `NetworkAttemptCounters` per query, not per call to this function: each query is its own
    // `DiscoverySourceAudit` row (`id` below is keyed by `query`), so attempts made walking one
    // query's pages must never bleed into another query's row even though both run inside the same
    // `for` loop over the same shared `http`.
    const counters = newNetworkAttemptCounters();
    const queryHttp = attributeNetworkRequests(http, counters);
    let requests = 0;
    let listings = 0;
    let status: DiscoverySourceAudit['status'] = 'success';
    let errorMessage: string | null = null;
    let complete = true;
    let continuationCursor: string | null = null;
    let lastUrl = 'https://himalayas.app/jobs/api/search';
    try {
      for (let page = 1; page <= config.discovery.himalayasMaxPagesPerQuery; page += 1) {
        const url = new URL('https://himalayas.app/jobs/api/search');
        if (query) url.searchParams.set('q', query);
        if (config.discovery.himalayasCountry) {
          url.searchParams.set('country', config.discovery.himalayasCountry);
        }
        if (config.discovery.himalayasEmploymentType) {
          url.searchParams.set('employment_type', config.discovery.himalayasEmploymentType);
        }
        url.searchParams.set('sort', 'salaryDesc');
        url.searchParams.set('page', String(page));
        lastUrl = url.toString();
        const root = parsedRoot(await queryHttp.get(lastUrl), 'himalayas');
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
            salaryProvenance: 'reviewed_structured',
            postedAt: isoPostedAtFromUnixSeconds(numberValue(job.pubDate)),
            raw,
            minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
          }));
          listings += 1;
        }
        const total = numberValue(root.totalCount);
        if (root.jobs.length === 0 || (total !== null && page * 20 >= total)) break;
        if (page === config.discovery.himalayasMaxPagesPerQuery) {
          status = 'partial';
          complete = false;
          continuationCursor = String(page + 1);
          errorMessage = `Stopped at the configured ${config.discovery.himalayasMaxPagesPerQuery}-page limit for this query.`;
        }
      }
    } catch (error) {
      const failure = sourceFailure(error);
      status = requests > 0 ? 'partial' : failure.status;
      errorMessage = failure.error;
      complete = false;
      continuationCursor = null;
    }
    sources.push({
      id: `himalayas:${query || 'all-jobs'}`,
      provider: 'himalayas',
      url: lastUrl,
      requests,
      listings,
      status,
      error: errorMessage,
      ...networkAttemptFields(counters),
      ...(complete ? completeAudit() : incompleteAudit(errorMessage ?? 'incomplete', continuationCursor)),
    });
  }
  return { sources, vacancies };
}

export async function discoverJobicy(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const counters = newNetworkAttemptCounters();
  http = attributeNetworkRequests(http, counters);
  const tagParam = config.discovery.roleQuery ? `&tag=${encodeURIComponent(config.discovery.roleQuery)}` : '';
  const url = `https://jobicy.com/api/v2/remote-jobs?count=${config.discovery.jobicyCount}${tagParam}`;
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
        salaryProvenance: 'reviewed_structured',
        postedAt: isoPostedAt(stringValue(job.pubDate)),
        raw,
        minimumAnnualBaseUsd: config.minimumAnnualBaseUsd,
      })];
    });
    return {
      sources: [{
        id: 'jobicy:frontend',
        provider: 'jobicy',
        url,
        requests: 1,
        listings: vacancies.length,
        status: 'success',
        error: null,
        ...networkAttemptFields(counters),
        ...completeAudit(),
      }],
      vacancies,
    };
  } catch (error) {
    return {
      sources: [{
        id: 'jobicy:frontend',
        provider: 'jobicy',
        url,
        requests: 0,
        listings: 0,
        ...sourceFailure(error),
        ...networkAttemptFields(counters),
      }],
      vacancies: [],
    };
  }
}

/**
 * `.then`-wraps a sub-source's own promise so `onProgress` fires the instant *that* branch of the
 * `Promise.all` below resolves, not only once every branch has -- a plumbing change over the
 * existing parallel discovery, not new discovery logic. `run` itself is returned unchanged, so the
 * aggregation below sees exactly what it always did.
 */
function withProgress(
  sourceId: string,
  run: Promise<DiscoveryRun>,
  onProgress: ScanProgressCallback | undefined,
): Promise<DiscoveryRun> {
  if (!onProgress) return run;
  return run.then((result) => {
    onProgress({ sourceId, vacancies: result.vacancies });
    return result;
  });
}

/**
 * @param projectRoot When given, this run's per-source failures are fed into source-gap telemetry
 *   (`recordDiscoveryGapTelemetry`) and the aggregated report is written to disk
 *   (`writeGapTelemetryReport`) under this run's `reports/global-remote` directory -- issue #9's
 *   "during discovery" requirement. Omitted by tests that exercise this function directly against a
 *   `FixtureHttpClient` with no real project directory to write into, and by any other caller that
 *   only wants this run's `DiscoveryRun` without touching disk.
 *
 *   Telemetry persistence is best-effort: a disk error here (a read-only `reports/` directory, for
 *   instance) must never fail the discovery run itself over a diagnostics side-channel, so failures
 *   are swallowed rather than propagated -- the same tolerance `applyWorldwideSponsorMatches` in
 *   pipeline/global-remote.ts applies to its own best-effort enrichment.
 */
export async function runGlobalRemoteDiscovery(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
  atsRoster: readonly AtsRosterEntry[] = [],
  projectRoot?: string,
  onProgress?: ScanProgressCallback,
): Promise<DiscoveryRun> {
  const [himalayas, jobicy, aiDevJobs, taiwanJobs, structured, feeds, jobtech, additional, keyed, atsRosterScan] =
    await Promise.all([
      withProgress('himalayas', discoverHimalayas(http, config), onProgress),
      withProgress('jobicy', discoverJobicy(http, config), onProgress),
      withProgress('ai_dev_jobs', discoverAiDevJobs(http, config), onProgress),
      withProgress('taiwan_jobs', discoverTaiwanJobs(http, config), onProgress),
      withProgress('structured', runStructuredDiscovery(http, config), onProgress),
      withProgress('feeds', runFeedDiscovery(http, config), onProgress),
      withProgress('jobtech', runJobtechDiscovery(http, config), onProgress),
      withProgress('additional', runAdditionalDiscovery(http, config), onProgress),
      withProgress('keyed', runKeyedDiscovery(http, config), onProgress),
      withProgress('ats_roster', runAtsRosterDiscovery(http, config, atsRoster), onProgress),
    ]);
  const sources = [
    ...himalayas.sources,
    ...jobicy.sources,
    ...aiDevJobs.sources,
    ...taiwanJobs.sources,
    ...structured.sources,
    ...feeds.sources,
    ...jobtech.sources,
    ...additional.sources,
    ...keyed.sources,
    ...atsRosterScan.sources,
  ];
  const vacancies = [
    ...himalayas.vacancies,
    ...jobicy.vacancies,
    ...aiDevJobs.vacancies,
    ...taiwanJobs.vacancies,
    ...structured.vacancies,
    ...feeds.vacancies,
    ...jobtech.vacancies,
    ...additional.vacancies,
    ...keyed.vacancies,
    ...atsRosterScan.vacancies,
  ];
  if (projectRoot !== undefined) {
    try {
      const gapReport = await recordDiscoveryGapTelemetry(sources, projectRoot);
      await writeGapTelemetryReport(gapReport, projectRoot);
    } catch {
      // Best-effort local diagnostics -- see the `projectRoot` doc comment above.
    }
  }
  return { sources, vacancies };
}
