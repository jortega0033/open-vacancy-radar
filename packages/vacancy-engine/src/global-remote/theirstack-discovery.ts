import type { AtsHttpClient, AtsHttpResponse } from '../ats/http.js';
import { AtsResponseError } from '../ats/http.js';
import { isCrawlerHttpError } from '../crawler/errors.js';
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
  numberValue,
  record,
  stringValue,
} from './discovery-shared.js';
import type {
  DiscoveryRun,
  DiscoverySourceAudit,
  DiscoveryVacancyAudit,
  GlobalRemoteConfig,
} from './models.js';

/**
 * TheirStack Jobs API (https://api.theirstack.com/openapi), a PAID, key-required commercial
 * source (issue #49). `POST /v1/jobs/search` costs one API credit per job returned, so this
 * adapter is deliberately conservative:
 *
 * - It is inert unless the caller (see `theirstackConfigured` in `source-registry.ts`) saw BOTH an
 *   explicit enablement flag and a user-supplied local key. This function re-checks both and makes
 *   zero requests otherwise, so a mis-wired caller still cannot spend credits.
 * - It needs a role search: an unfiltered paid query would buy an arbitrary slice of the corpus.
 *   No role means no request and a guided message, never a default role.
 * - Every run is bounded by a credit ceiling (`theirstackMaxCredits`) and a request ceiling
 *   (`theirstackMaxPages`). Both are enforced BEFORE each request: the next page's `limit` is
 *   shrunk to the remaining credit budget, and no page is requested once either ceiling is hit.
 *   Pagination is offset based, so shrinking `limit` never skews later pages.
 * - Only open jobs are requested (`is_closed: false`) so closed postings are never paid for; any
 *   job that still arrives with a `closed_at` is dropped, so the next scan reflects a closure.
 * - It never retries: a 429 stops the run at once (the shared client is told `maxRetries: 0`),
 *   because a retry would only risk more credits against a limit already hit. Requests are paced
 *   to the documented 4 requests/second, and a `RateLimit-Remaining: 0` header ends the run
 *   rather than spending a request that is known to fail.
 * - The API key is only ever placed in the `Authorization` header. Every diagnostic string passes
 *   through `redactKey`, and the key never reaches a fingerprint, a vacancy, or a report.
 *
 * Terms (https://theirstack.com/en/docs/legal/terms-and-conditions) allow displaying postings but
 * forbid redistributing the dataset in a reconstructable form; this adapter only returns the
 * bounded, user-searched slice into the user's own scan, with no export path. See
 * docs/job-source-evidence.md for the evidence and retention notes.
 */
export const THEIRSTACK_ORIGIN = 'https://api.theirstack.com';
export const THEIRSTACK_SEARCH_URL = `${THEIRSTACK_ORIGIN}/v1/jobs/search`;

export const THEIRSTACK_DEFAULT_MAX_CREDITS = 50;
export const THEIRSTACK_DEFAULT_MAX_PAGES = 4;
export const THEIRSTACK_DEFAULT_POSTED_WITHIN_DAYS = 7;
/** Largest page requested; the real `limit` is also capped by the remaining credit budget. */
export const THEIRSTACK_PAGE_SIZE = 25;
/** Documented API plans allow 4 requests per second. */
export const THEIRSTACK_MIN_REQUEST_INTERVAL_MS = 250;
/** Longest wait on a `RateLimit-Reset` header before the run stops instead. */
const MAX_RATE_LIMIT_WAIT_MS = 5_000;

export type TheirStackDependencies = {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Test seam: smaller page so pagination can be exercised with small fixtures. */
  pageSize?: number;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Removes the key value and any bearer token from text that may reach a log or a report. */
export function redactTheirStackKey(text: string, apiKey: string): string {
  const trimmed = apiKey.trim();
  const withoutKey = trimmed.length === 0 ? text : text.split(trimmed).join('[redacted]');
  return withoutKey.replace(/Bearer\s+[^\s"',;]+/giu, 'Bearer [redacted]');
}

function statusOfError(error: unknown): number | null {
  if (error instanceof AtsResponseError) return error.status;
  if (isCrawlerHttpError(error)) return error.status ?? null;
  return null;
}

/** Guided, user-facing explanation for an upstream status. Never contains the key. */
export function theirStackGuidance(status: number): string {
  if (status === 401 || status === 403) {
    return 'TheirStack rejected the API key. Check the key in your settings; no credits were used.';
  }
  if (status === 402) {
    return 'TheirStack credits or plan limit reached. Add credits or change the plan in your TheirStack account, or lower the per-scan credit ceiling.';
  }
  if (status === 429) {
    return 'TheirStack rate limit reached. Wait a moment and scan again; no retry was made so no extra credits were spent.';
  }
  if (status === 400 || status === 422) {
    return `TheirStack rejected the search filters (HTTP ${status}). Adjust the role or date window.`;
  }
  return `TheirStack request failed (HTTP ${status}).`;
}

function locationFor(job: Record<string, unknown>): string {
  const place = stringValue(job.short_location) ?? stringValue(job.location);
  const country = stringValue(job.country);
  const remote = job.remote === true ? 'Remote' : null;
  const parts = [remote, place, country].filter((part): part is string => part !== null);
  const unique = parts.filter(
    (part, index) => parts.findIndex((other) => other.toLowerCase() === part.toLowerCase()) === index,
  );
  return unique.length === 0 ? 'Remote (eligibility unspecified)' : unique.join(', ');
}

function employmentFor(job: Record<string, unknown>): string | null {
  const statuses = Array.isArray(job.employment_statuses) ? job.employment_statuses : [];
  const first = statuses.map((value) => stringValue(value)).find((value) => value !== null);
  return first === undefined ? null : first.replaceAll('_', ' ');
}

/** Stable fingerprint input: job content only, never anything account- or request-specific. */
function safeFingerprint(job: Record<string, unknown>, url: string): Record<string, unknown> {
  return {
    id: job.id,
    title: job.job_title,
    url,
    company: job.company,
    location: job.location,
    country_code: job.country_code,
    date_posted: job.date_posted,
    closed_at: job.closed_at ?? null,
    employment_statuses: job.employment_statuses,
    min_annual_salary: job.min_annual_salary,
    salary_currency: job.salary_currency,
  };
}

type Normalized =
  | { kind: 'vacancy'; vacancy: DiscoveryVacancyAudit }
  | { kind: 'closed' }
  | { kind: 'skipped' };

function normalizeJob(raw: unknown, minimumAnnualBaseUsd: number | null): Normalized {
  const job = record(raw);
  if (job === null) return { kind: 'skipped' };
  // A job TheirStack itself saw close is dropped, so a closure shows up on the next scan.
  if (stringValue(job.closed_at) !== null) return { kind: 'closed' };

  const id = job.id;
  const title = stringValue(job.job_title);
  const company = stringValue(job.company) ?? stringValue(record(job.company_object)?.name);
  const originalUrl = httpUrl(job.url);
  // Prefer the employer's own career-page link: it is the canonical apply URL and lets the shared
  // identity logic deduplicate against direct ATS sources. The aggregator URL stays as provenance.
  const finalUrl = httpUrl(job.final_url);
  const primaryUrl = finalUrl ?? originalUrl;
  if ((typeof id !== 'number' && typeof id !== 'string') || title === null || company === null || primaryUrl === null) {
    return { kind: 'skipped' };
  }

  const salary = numberValue(job.min_annual_salary);
  const body = stringValue(job.description);
  const provenance = [
    'Provider: TheirStack',
    originalUrl !== null && originalUrl !== primaryUrl ? `Original posting: ${originalUrl}` : null,
  ].filter((line): line is string => line !== null).join('\n');

  return {
    kind: 'vacancy',
    vacancy: discoveryAudit({
      key: `theirstack:${String(id)}`,
      provider: 'theirstack',
      company,
      title,
      url: primaryUrl,
      location: locationFor(job),
      employmentType: employmentFor(job),
      currency: salary !== null && salary > 0 ? stringValue(job.salary_currency) : null,
      salaryPeriod: salary !== null && salary > 0 ? 'annual' : null,
      advertisedMinimum: salary !== null && salary > 0 ? salary : null,
      description: [provenance, body].filter((value): value is string => value !== null && value.length > 0).join('\n'),
      postedAt: isoPostedAt(stringValue(job.date_posted)),
      raw: safeFingerprint(job, primaryUrl),
      minimumAnnualBaseUsd,
    }),
  };
}

function parseResponse(response: AtsHttpResponse): { data: unknown[]; truncated: number } {
  let root: unknown;
  try {
    root = JSON.parse(response.body) as unknown;
  } catch (error) {
    throw new AtsResponseError('theirstack', 'invalid search JSON', response.status, { cause: error });
  }
  const parsed = record(root);
  if (parsed === null) throw new AtsResponseError('theirstack', 'response is not an object', response.status);
  if (!Array.isArray(parsed.data)) throw new AtsResponseError('theirstack', 'data is not an array', response.status);
  const truncated = numberValue(record(parsed.metadata)?.truncated_results) ?? 0;
  return { data: parsed.data, truncated };
}

function headerValue(response: AtsHttpResponse, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(response.headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

export function inertTheirStackRun(): DiscoveryRun {
  return { sources: [], vacancies: [] };
}

export async function discoverTheirStack(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
  dependencies: TheirStackDependencies = {},
): Promise<DiscoveryRun> {
  const apiKey = (config.discovery.theirstackApiKey ?? '').trim();
  // Zero requests without BOTH explicit enablement and a local key.
  if (config.discovery.theirstackEnabled !== true || apiKey.length === 0) return inertTheirStackRun();

  const sleep = dependencies.sleep ?? defaultSleep;
  const now = dependencies.now ?? Date.now;
  const creditCeiling = config.discovery.theirstackMaxCredits ?? THEIRSTACK_DEFAULT_MAX_CREDITS;
  const pageCeiling = config.discovery.theirstackMaxPages ?? THEIRSTACK_DEFAULT_MAX_PAGES;
  const windowDays = config.discovery.theirstackPostedWithinDays ?? THEIRSTACK_DEFAULT_POSTED_WITHIN_DAYS;
  const role = config.discovery.roleQuery.trim();

  const counters = newNetworkAttemptCounters();
  const client = attributeNetworkRequests(http, counters);
  const vacancies: DiscoveryVacancyAudit[] = [];
  let requests = 0;
  let creditsUsed = 0;
  let status: DiscoverySourceAudit['status'] = 'success';
  let message: string | null = null;
  let continuationCursor: string | null = null;
  let lastRequestAt: number | null = null;
  const seenKeys = new Set<string>();

  const audit = (): DiscoveryRun => ({
    sources: [{
      id: 'theirstack:jobs-search',
      provider: 'theirstack',
      url: THEIRSTACK_SEARCH_URL,
      requests,
      listings: vacancies.length,
      status,
      error: message === null ? null : redactTheirStackKey(message, apiKey),
      ...networkAttemptFields(counters),
      ...(status === 'success'
        ? completeAudit()
        : incompleteAudit(redactTheirStackKey(message ?? status, apiKey), continuationCursor)),
      creditsUsed,
      creditCeiling,
    }],
    vacancies,
  });

  if (role.length === 0) {
    // Intentional error row: the audit status union has no skipped / not-applicable value, and a
    // silent no-op would hide why an enabled paid source returns nothing on every scan.
    status = 'error';
    message = 'TheirStack needs a role search. Enter a role so credits are only spent on relevant jobs.';
    return audit();
  }

  try {
    for (;;) {
      const remaining = creditCeiling - creditsUsed;
      if (remaining <= 0 || requests >= pageCeiling) {
        status = 'partial';
        continuationCursor = String(creditsUsed);
        message = remaining <= 0
          ? `Stopped at the configured ceiling of ${creditCeiling} credits.`
          : `Stopped at the configured limit of ${pageCeiling} requests.`;
        break;
      }

      // Pace to the documented 4 requests/second.
      if (lastRequestAt !== null) {
        const wait = THEIRSTACK_MIN_REQUEST_INTERVAL_MS - (now() - lastRequestAt);
        if (wait > 0) await sleep(wait);
      }
      const limit = Math.min(dependencies.pageSize ?? THEIRSTACK_PAGE_SIZE, remaining);
      lastRequestAt = now();
      requests += 1;
      const response = await client.postJson(
        THEIRSTACK_SEARCH_URL,
        {
          job_title_or: [role],
          posted_at_max_age_days: windowDays,
          is_closed: false,
          order_by: [{ field: 'date_posted', desc: true }],
          limit,
          offset: creditsUsed,
          include_total_results: false,
        },
        {
          allowedOrigins: [THEIRSTACK_ORIGIN],
          headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
          cache: 'no-store',
          // Never retry a paid call: a retry after a 429 or timeout risks double-spending credits.
          maxRetries: 0,
        },
      );
      if (response.status < 200 || response.status >= 300) {
        throw new AtsResponseError('theirstack', theirStackGuidance(response.status), response.status);
      }

      const { data, truncated } = parseResponse(response);
      creditsUsed += data.length;
      for (const raw of data) {
        const outcome = normalizeJob(raw, config.minimumAnnualBaseUsd);
        // Offset pagination can repeat a job across pages; keep one row per job id per run.
        if (outcome.kind === 'vacancy' && !seenKeys.has(outcome.vacancy.key)) {
          seenKeys.add(outcome.vacancy.key);
          vacancies.push(outcome.vacancy);
        }
      }

      if (truncated > 0) {
        status = 'partial';
        message = theirStackGuidance(402);
        break;
      }
      // A short page means the filtered result set is exhausted.
      if (data.length < limit) break;

      const rateRemaining = headerValue(response, 'ratelimit-remaining');
      if (rateRemaining !== null && Number(rateRemaining) <= 0) {
        // A missing or non-numeric reset is unknown, so stop rather than spend on a likely failure.
        const resetHeader = headerValue(response, 'ratelimit-reset')?.trim() ?? '';
        const resetSeconds = resetHeader.length === 0 ? Number.NaN : Number(resetHeader);
        const resetMs = Number.isFinite(resetSeconds) && resetSeconds >= 0
          ? resetSeconds * 1000
          : Number.POSITIVE_INFINITY;
        if (resetMs > MAX_RATE_LIMIT_WAIT_MS) {
          status = 'partial';
          message = theirStackGuidance(429);
          break;
        }
        await sleep(resetMs);
      }
    }
  } catch (error) {
    const upstream = statusOfError(error);
    const text = upstream === null || upstream < 300
      ? (error instanceof Error ? error.message : String(error))
      : theirStackGuidance(upstream);
    status = creditsUsed > 0 || vacancies.length > 0
      ? 'partial'
      : upstream !== null && [401, 403, 429].includes(upstream) ? 'blocked' : 'error';
    // A non-4xx failure (5xx, timeout, transport) may follow a billed response we never saw.
    const maybeBilled = upstream === null || upstream < 300 || upstream >= 500;
    message = maybeBilled ? `${text} Credits used may be higher than reported.` : text;
    continuationCursor = null;
  }
  return audit();
}
