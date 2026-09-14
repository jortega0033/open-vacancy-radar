import type { AtsHttpClient } from '../ats/http.js';
import { AtsResponseError, requireSuccessfulResponse } from '../ats/http.js';
import {
  attributeNetworkRequests,
  networkAttemptFields,
  newNetworkAttemptCounters,
} from './discovery-attribution.js';
import {
  completeAudit,
  discoveryAudit,
  httpUrl,
  incompleteAudit,
  isoPostedAt,
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
 * NAV Arbeidsplassen (https://arbeidsplassen.nav.no) -- the Norwegian Labour and Welfare
 * Administration's official public feed of nationwide job vacancies (pam-stilling-feed). The
 * service is free but consumer-registered: a bearer token must be requested through NAV's own
 * onboarding process (https://github.com/navikt/pam-stilling-feed/blob/main/README.md); there is
 * no anonymous read path. Terms: https://arbeidsplassen.nav.no/vilkar-api.
 *
 * The feed is a JSON-Feed-shaped append log (`Feed.items[]`, each with a lightweight
 * `_feed_entry.status`), not a search endpoint -- there is no query/role/remote parameter to send,
 * so this adapter (like every other `full_ingestion` source in this package) ingests broadly and
 * lets `classifyDiscoveryVacancy` apply the pipeline's own role/location/salary gates afterward.
 *
 * This pipeline (`runGlobalRemoteScan`) is a stateless one-shot CLI scan with no persisted
 * cross-run cursor. A fully incremental consumer of this feed would store the last-seen page id
 * (`next_id`) between runs and resume from it; without that, this adapter instead walks the feed
 * from its first page each run, bounded by `config.discovery.navArbeidsplassenMaxPages` --
 * mirroring the bounded-page-budget convention every other paginated adapter here already uses
 * (`aiDevJobsMaxPages`, `adzunaMaxPages`, etc.). Every ad seen as `ACTIVE` within that window is
 * re-normalized from scratch on every run, and any ad whose status has moved away from `ACTIVE`
 * (or that simply is not observed active in this run's window) is left out of the result -- so an
 * update or deletion is reflected in the very next successful run without any adapter-side
 * bookkeeping. A future iteration could add a persisted cursor for full incremental coverage.
 */
export const NAV_ARBEIDSPLASSEN_ORIGIN = 'https://pam-stilling-feed.nav.no';
export const NAV_ARBEIDSPLASSEN_FEED_URL = `${NAV_ARBEIDSPLASSEN_ORIGIN}/api/v1/feed`;

export function navArbeidsplassenEntryUrl(uuid: string): string {
  return `${NAV_ARBEIDSPLASSEN_ORIGIN}/api/v1/feedentry/${encodeURIComponent(uuid)}`;
}

function bearerHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
}

/**
 * Builds the location string from `workLocations` the same way `jobtech-discovery.ts`'s
 * `locationFor` does for Sweden: joins the distinct, present address parts and appends `, Europe`
 * so the result passes this pipeline's generic `ELIGIBLE_LOCATION` gate (see
 * `evaluation.ts`), which otherwise only recognizes worldwide/Europe/Netherlands-style text.
 */
function locationFor(workLocations: unknown): string {
  const locationsArray = Array.isArray(workLocations) ? workLocations : [];
  const parts = locationsArray.flatMap((raw) => {
    const location = record(raw);
    if (location === null) return [];
    return [
      stringValue(location.city),
      stringValue(location.municipal),
      stringValue(location.county),
      stringValue(location.country),
    ].filter((part): part is string => part !== null);
  });
  const uniqueParts = parts.filter(
    (part, index) =>
      parts.findIndex((candidate) => candidate.toLowerCase() === part.toLowerCase()) === index,
  );
  const workplace = uniqueParts.length === 0 ? 'Norway' : uniqueParts.join(', ');
  return `${workplace}, Europe`;
}

/**
 * Strips `contactList` (named contact persons, personal emails, personal phone numbers) before the
 * value is used for anything -- normalized output or the `contentHash` fingerprint input -- per the
 * ticket's privacy requirement. Mirrors `jobtech-discovery.ts`'s `safeFingerprint`: an unrelated
 * change to a private contact field must never look like a changed listing, and the raw contact
 * data must never be serialized anywhere this adapter touches, including a hash input.
 */
function safeFingerprint(ad: Record<string, unknown>, url: string): Record<string, unknown> {
  return {
    uuid: ad.uuid,
    title: ad.title,
    url,
    employer: record(ad.employer)?.name,
    workLocations: ad.workLocations,
    published: ad.published,
    updated: ad.updated,
    expires: ad.expires,
    engagementtype: ad.engagementtype,
    extent: ad.extent,
    sector: ad.sector,
  };
}

function isExpired(value: unknown): boolean {
  const raw = stringValue(value);
  if (raw === null) return false;
  const parsed = Date.parse(raw);
  return !Number.isNaN(parsed) && parsed < Date.now();
}

/**
 * Normalizes one `FeedEntryContent` (the `/api/v1/feedentry/{uuid}` response) into the shared
 * discovery shape, or `null` when it must not be surfaced as a live vacancy: a non-`ACTIVE` status
 * (`INACTIVE`/`STOPPED`/`REJECTED`/`DELETED`/anything else), a missing `ad_content` (NAV's own
 * "removed" representation), a past `expires` date, or a contract violation on a required field.
 * Returning `null` rather than throwing matches every other discovery adapter in this package: one
 * bad or removed row must not fail the page it came from.
 */
function normalizeNavAd(
  raw: unknown,
  minimumAnnualBaseUsd: number | null,
): DiscoveryVacancyAudit | null {
  const entryContent = record(raw);
  if (entryContent === null) return null;
  const status = stringValue(entryContent.status);
  if (status === null || status.toUpperCase() !== 'ACTIVE') return null;

  const ad = record(entryContent.ad_content);
  if (ad === null) return null;
  if (isExpired(ad.expires)) return null;

  const uuid = stringValue(ad.uuid);
  const title = stringValue(ad.title) ?? stringValue(ad.jobtitle);
  const company = stringValue(record(ad.employer)?.name);
  const canonicalUrl = httpUrl(ad.link);
  const applyUrl = httpUrl(ad.applicationUrl);
  const primaryUrl = applyUrl ?? canonicalUrl;
  if (uuid === null || title === null || company === null || canonicalUrl === null || primaryUrl === null) {
    return null;
  }

  const descriptionBody = stringValue(ad.description);
  const description = [
    `NAV Arbeidsplassen listing: ${canonicalUrl}`,
    descriptionBody,
  ]
    .filter((value): value is string => value !== null && value.length > 0)
    .join('\n');

  return discoveryAudit({
    key: `nav_arbeidsplassen:${uuid}`,
    provider: 'nav_arbeidsplassen',
    company,
    title,
    url: primaryUrl,
    location: locationFor(ad.workLocations),
    employmentType: stringValue(ad.engagementtype) ?? stringValue(ad.extent),
    // FeedAd carries no salary field at all (confirmed against the published OpenAPI schema), so
    // this source never advertises a base-pay floor -- not a "no salary bias" workaround, just an
    // honestly absent value, same as `remoote`/`jobspipe`/`workable_global` above.
    currency: null,
    salaryPeriod: null,
    advertisedMinimum: null,
    description,
    postedAt: isoPostedAt(stringValue(ad.published)) ?? isoPostedAt(stringValue(ad.updated)),
    raw: safeFingerprint(ad, primaryUrl),
    minimumAnnualBaseUsd,
  });
}

type FeedFetchOutcome =
  | { kind: 'page'; items: unknown[]; nextUrl: string | null }
  | { kind: 'empty' };

/**
 * Fetches one feed page. A `304` means "empty, or unchanged since a conditional header we did not
 * send" per the documented contract -- treated as an empty page (zero items, no further pages)
 * rather than an error, exactly like `fetchAiDevJobDetail`'s `404` special-case in
 * `ai-dev-jobs-discovery.ts`.
 */
async function fetchFeedPage(
  http: AtsHttpClient,
  url: string,
  apiKey: string,
): Promise<FeedFetchOutcome> {
  const response = await http.get(url, {
    allowedOrigins: [NAV_ARBEIDSPLASSEN_ORIGIN],
    headers: bearerHeaders(apiKey),
    cache: 'no-store',
  });
  if (response.status === 304) return { kind: 'empty' };
  requireSuccessfulResponse('nav_arbeidsplassen', response);
  let root: unknown;
  try {
    root = JSON.parse(response.body) as unknown;
  } catch (error) {
    throw new AtsResponseError('nav_arbeidsplassen', 'invalid feed JSON', response.status, { cause: error });
  }
  const feed = record(root);
  if (feed === null) throw new AtsResponseError('nav_arbeidsplassen', 'feed response is not an object', response.status);
  if (!Array.isArray(feed.items)) throw new AtsResponseError('nav_arbeidsplassen', 'items is not an array');
  return { kind: 'page', items: feed.items, nextUrl: httpUrl(feed.next_url) };
}

export async function runNavArbeidsplassenDiscovery(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
): Promise<DiscoveryRun> {
  const counters = newNetworkAttemptCounters();
  http = attributeNetworkRequests(http, counters);
  const apiKey = config.discovery.navArbeidsplassenApiKey;
  const vacancies: DiscoveryVacancyAudit[] = [];
  let requests = 0;
  let successfulRequests = 0;
  let detailFailures = 0;
  let status: DiscoverySourceAudit['status'] = 'success';
  let errorMessage: string | null = null;
  // The feed's own `next_url`, carried through so a capped run leaves a real continuation marker
  // rather than a synthesized page number -- this source paginates by opaque cursor, not page index.
  let continuationCursor: string | null = null;
  let lastUrl = NAV_ARBEIDSPLASSEN_FEED_URL;
  try {
    let pageUrl: string | null = NAV_ARBEIDSPLASSEN_FEED_URL;
    for (let page = 1; page <= config.discovery.navArbeidsplassenMaxPages && pageUrl !== null; page += 1) {
      lastUrl = pageUrl;
      requests += 1;
      const outcome = await fetchFeedPage(http, pageUrl, apiKey);
      successfulRequests += 1;
      if (outcome.kind === 'empty') break;

      const activeUuids: string[] = [];
      for (const rawLine of outcome.items) {
        const line = record(rawLine);
        const entry = record(line?._feed_entry);
        const entryStatus = stringValue(entry?.status);
        const uuid = stringValue(entry?.uuid);
        // Only an `ACTIVE` line is worth a detail round trip: NAV's own contract only returns
        // `ad_content` for an active entry, so a detail fetch for anything else would just
        // reconfirm what the lightweight list entry already told us for free.
        if (entryStatus !== null && entryStatus.toUpperCase() === 'ACTIVE' && uuid !== null) {
          activeUuids.push(uuid);
        }
      }

      for (const uuid of activeUuids) {
        requests += 1;
        try {
          const detailResponse = await http.get(navArbeidsplassenEntryUrl(uuid), {
            allowedOrigins: [NAV_ARBEIDSPLASSEN_ORIGIN],
            headers: bearerHeaders(apiKey),
            cache: 'no-store',
          });
          requireSuccessfulResponse('nav_arbeidsplassen', detailResponse);
          let detailRoot: unknown;
          try {
            detailRoot = JSON.parse(detailResponse.body) as unknown;
          } catch (error) {
            throw new AtsResponseError('nav_arbeidsplassen', 'invalid detail JSON', detailResponse.status, { cause: error });
          }
          successfulRequests += 1;
          const vacancy = normalizeNavAd(detailRoot, config.minimumAnnualBaseUsd);
          if (vacancy !== null) vacancies.push(vacancy);
        } catch (error) {
          // One bad or unreachable ad detail must not fail the whole page -- see the module
          // doc comment's "reconciliation" note; the failure is still counted and reported so a
          // systematic problem (as opposed to one flaky ad) stays visible.
          detailFailures += 1;
          if (error instanceof AtsResponseError && error.status !== null && [401, 403, 406, 407, 429, 451].includes(error.status)) {
            throw error;
          }
        }
      }

      if (page === config.discovery.navArbeidsplassenMaxPages && outcome.nextUrl !== null) {
        status = 'partial';
        continuationCursor = outcome.nextUrl;
        errorMessage = `Stopped at the configured ${config.discovery.navArbeidsplassenMaxPages}-page limit.`;
      }
      pageUrl = outcome.nextUrl;
    }
    if (detailFailures > 0 && status === 'success') {
      status = 'partial';
      errorMessage = `${detailFailures} ad detail lookup(s) failed and were skipped.`;
    }
  } catch (error) {
    const failure = sourceFailure(error);
    status = successfulRequests > 0 ? 'partial' : failure.status;
    errorMessage = failure.error;
    continuationCursor = null;
  }
  return {
    sources: [{
      id: 'nav_arbeidsplassen:feed',
      provider: 'nav_arbeidsplassen',
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
