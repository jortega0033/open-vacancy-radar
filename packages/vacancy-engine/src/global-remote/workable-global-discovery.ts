import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { SafeHttpClient } from '../crawler/http-client.js';
import { CrawlerHttpError, isCrawlerHttpError } from '../crawler/errors.js';
import { discoveryAudit } from './discovery-shared.js';
import type {
  DiscoveryRun,
  DiscoverySourceAudit,
  DiscoveryVacancyAudit,
  GlobalRemoteConfig,
} from './models.js';
import {
  createWorkableFeedParser,
  loadWorkableFeedSnapshot,
  WORKABLE_ALL_CUSTOMER_FEED_URL,
  WorkableFeedParseError,
  type WorkableFeedParseResult,
  type WorkableFeedRecord,
  type WorkableFeedSnapshot,
  writeWorkableFeedSnapshot,
} from './workable-feed.js';

export const WORKABLE_GLOBAL_REFRESH_INTERVAL_MS = 60 * 60 * 1_000;
export const WORKABLE_GLOBAL_MAX_STALE_AGE_MS = 24 * 60 * 60 * 1_000;
export const WORKABLE_GLOBAL_TIMEOUT_MS = 15 * 60 * 1_000;
export const WORKABLE_GLOBAL_MAX_RESPONSE_BYTES = 2 * 1024 * 1024 * 1024;
export const WORKABLE_GLOBAL_MAX_RETAINED_RECORDS = 5_000;
const MINIMUM_REPLACEMENT_JOB_RATIO = 0.5;
const MAXIMUM_INVALID_JOB_RATIO = 0.5;
const ATTEMPT_STATE_VERSION = 1;
const ATTEMPT_STATE_MAX_BYTES = 4 * 1024;
const MAXIMUM_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;

type WorkableStreamClient = Pick<SafeHttpClient, 'streamGet'>;

type WorkableAttemptState = Readonly<{
  version: 1;
  attemptedAt: string;
  nextAllowedAt: string;
  error: string;
  blockedStatus: number | null;
}>;

export type WorkableGlobalDiscoveryOptions = {
  now?: () => Date;
  snapshotPath?: string;
  refreshIntervalMs?: number;
  maxStaleAgeMs?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRetainedRecords?: number;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function snapshotPath(projectRoot: string): string {
  return path.resolve(projectRoot, '.data', 'global-remote', 'workable-global-v1.json');
}

function attemptPath(snapshotFile: string): string {
  return `${snapshotFile}.attempt.json`;
}

function safeAttemptError(value: string): string {
  const sanitized = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
  }).join('');
  return sanitized.trim().slice(0, 1_024) || 'request failed';
}

async function loadAttemptState(snapshotFile: string): Promise<WorkableAttemptState | null> {
  const filePath = attemptPath(snapshotFile);
  try {
    const info = await stat(filePath);
    if (info.size < 1 || info.size > ATTEMPT_STATE_MAX_BYTES) return null;
    const value = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).some(
        (key) => !['version', 'attemptedAt', 'nextAllowedAt', 'error', 'blockedStatus'].includes(key),
      ) ||
      record.version !== ATTEMPT_STATE_VERSION ||
      typeof record.attemptedAt !== 'string' ||
      typeof record.nextAllowedAt !== 'string' ||
      typeof record.error !== 'string' ||
      !(
        record.blockedStatus === null ||
        (typeof record.blockedStatus === 'number' &&
          Number.isInteger(record.blockedStatus) &&
          record.blockedStatus >= 400 &&
          record.blockedStatus <= 599)
      ) ||
      record.error.length < 1 ||
      record.error.length > 1_024
    ) {
      return null;
    }
    const attemptedAt = Date.parse(record.attemptedAt);
    const nextAllowedAt = Date.parse(record.nextAllowedAt);
    if (
      !Number.isFinite(attemptedAt) ||
      !Number.isFinite(nextAllowedAt) ||
      nextAllowedAt < attemptedAt
    ) {
      return null;
    }
    return {
      version: 1,
      attemptedAt: new Date(attemptedAt).toISOString(),
      nextAllowedAt: new Date(nextAllowedAt).toISOString(),
      error: safeAttemptError(record.error),
      blockedStatus: record.blockedStatus,
    };
  } catch {
    return null;
  }
}

async function persistAttemptState(
  snapshotFile: string,
  attemptedAt: Date,
  nextAllowedAt: Date,
  error: string,
  blockedStatus: number | null = null,
): Promise<boolean> {
  const filePath = attemptPath(snapshotFile);
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      temporary,
      `${JSON.stringify({
        version: ATTEMPT_STATE_VERSION,
        attemptedAt: attemptedAt.toISOString(),
        nextAllowedAt: nextAllowedAt.toISOString(),
        error: safeAttemptError(error),
        blockedStatus,
      })}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    await rename(temporary, filePath);
    return true;
  } catch {
    return false;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function clearAttemptState(snapshotFile: string): Promise<void> {
  await rm(attemptPath(snapshotFile), { force: true }).catch(() => undefined);
}

function nonEmptyHeader(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function validLastModified(value: string | undefined): string | undefined {
  const header = nonEmptyHeader(value);
  return header !== undefined && Number.isFinite(Date.parse(header)) ? header : undefined;
}

function location(record: WorkableFeedRecord): string {
  const values = [
    ...(record.remote ? ['Remote'] : []),
    record.city,
    record.state,
    record.country,
    record.postalCode,
  ].filter((value, index, all) => value.length > 0 && all.indexOf(value) === index);
  return values.join(', ') || 'Unknown';
}

function vacancy(record: WorkableFeedRecord, minimumAnnualBaseUsd: number | null): DiscoveryVacancyAudit {
  return discoveryAudit({
    key: `workable_global:${record.shortcode}`,
    provider: 'workable_global',
    company: record.company,
    title: record.title,
    url: record.url,
    location: location(record),
    employmentType: record.employmentType || null,
    currency: null,
    salaryPeriod: null,
    advertisedMinimum: null,
    raw: record,
    minimumAnnualBaseUsd,
  });
}

function resultWarnings(result: WorkableFeedParseResult): string[] {
  const warnings: string[] = [];
  if (result.invalidJobs > 0) warnings.push(`${result.invalidJobs} invalid jobs skipped`);
  if (result.limitDroppedJobs > 0) {
    warnings.push(`${result.limitDroppedJobs} frontend jobs exceeded the retained-record limit`);
  }
  return warnings;
}

function discoveryRun(
  result: WorkableFeedParseResult,
  minimumAnnualBaseUsd: number | null,
  requests: number,
  extraWarnings: readonly string[] = [],
): DiscoveryRun {
  const warnings = [...resultWarnings(result), ...extraWarnings];
  const source: DiscoverySourceAudit = {
    id: 'workable_global:all-customers',
    provider: 'workable_global',
    url: WORKABLE_ALL_CUSTOMER_FEED_URL,
    requests,
    listings: result.records.length,
    status: warnings.length === 0 ? 'success' : 'partial',
    error: warnings.length === 0 ? null : warnings.join('; '),
  };
  return {
    sources: [source],
    vacancies: result.records.map((record) => vacancy(record, minimumAnnualBaseUsd)),
  };
}

function failureMessage(error: unknown): string {
  if (isCrawlerHttpError(error)) return `${error.code}: ${error.message}`;
  if (error instanceof WorkableFeedParseError) return error.message;
  return 'Workable feed retrieval failed';
}

function failedRun(
  error: unknown,
  errorMessage = failureMessage(error),
  requests = 1,
): DiscoveryRun {
  const blocked = isCrawlerHttpError(error) && ['blocked', 'rate_limited'].includes(error.category);
  return {
    sources: [
      {
        id: 'workable_global:all-customers',
        provider: 'workable_global',
        url: WORKABLE_ALL_CUSTOMER_FEED_URL,
        requests,
        listings: 0,
        status: blocked ? 'blocked' : 'error',
        error: errorMessage,
      },
    ],
    vacancies: [],
  };
}

function isFresh(snapshot: WorkableFeedSnapshot, now: Date, refreshIntervalMs: number): boolean {
  const ageMs = now.getTime() - Date.parse(snapshot.fetchedAt);
  return ageMs >= 0 && ageMs < refreshIntervalMs;
}

function isUsableStale(snapshot: WorkableFeedSnapshot, now: Date, maxStaleAgeMs: number): boolean {
  const ageMs = now.getTime() - Date.parse(snapshot.fetchedAt);
  return ageMs >= 0 && ageMs <= maxStaleAgeMs;
}

function assertCompleteReplacement(
  result: WorkableFeedParseResult,
  previous: WorkableFeedSnapshot | null,
): void {
  if (result.totalJobs === 0) {
    throw new WorkableFeedParseError('complete XML contained no jobs');
  }
  if (result.records.length === 0) {
    throw new WorkableFeedParseError('complete XML contained no usable remote frontend jobs');
  }
  if (result.invalidJobs >= result.totalJobs * MAXIMUM_INVALID_JOB_RATIO) {
    throw new WorkableFeedParseError(
      `complete XML rejected ${result.invalidJobs} of ${result.totalJobs} jobs as invalid`,
    );
  }
  if (
    previous !== null &&
    result.totalJobs < previous.result.totalJobs * MINIMUM_REPLACEMENT_JOB_RATIO
  ) {
    throw new WorkableFeedParseError(
      `complete XML shrank from ${previous.result.totalJobs} to ${result.totalJobs} jobs`,
    );
  }
  if (
    previous !== null &&
    result.records.length < previous.result.records.length * MINIMUM_REPLACEMENT_JOB_RATIO
  ) {
    throw new WorkableFeedParseError(
      `usable remote frontend rows shrank from ${previous.result.records.length} to ${result.records.length}`,
    );
  }
}

function conditionalHeaders(snapshot: WorkableFeedSnapshot | null): Headers {
  const headers = new Headers({ accept: 'application/xml,text/xml;q=0.9' });
  if (snapshot?.etag !== undefined) headers.set('if-none-match', snapshot.etag);
  if (snapshot?.lastModified !== undefined) {
    headers.set('if-modified-since', snapshot.lastModified);
  }
  return headers;
}

async function persistSnapshot(
  filePath: string,
  snapshot: Omit<WorkableFeedSnapshot, 'version' | 'feedUrl' | 'fetchedAt'> & { fetchedAt: Date },
  maxRetainedRecords: number,
): Promise<boolean> {
  try {
    await writeWorkableFeedSnapshot(filePath, snapshot, { maxRecords: maxRetainedRecords });
    return true;
  } catch {
    return false;
  }
}

/**
 * Streams Workable's official all-customer feed into compact discovery rows. The parsed snapshot
 * is the cache boundary: raw XML is never buffered or written to the normal SQLite HTTP cache.
 */
export async function runWorkableGlobalDiscovery(
  http: WorkableStreamClient,
  config: Pick<GlobalRemoteConfig, 'minimumAnnualBaseUsd'>,
  projectRoot = process.cwd(),
  options: WorkableGlobalDiscoveryOptions = {},
): Promise<DiscoveryRun> {
  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new RangeError('now must return a valid Date');
  const refreshIntervalMs = positiveInteger(
    options.refreshIntervalMs ?? WORKABLE_GLOBAL_REFRESH_INTERVAL_MS,
    'refreshIntervalMs',
  );
  const maxStaleAgeMs = positiveInteger(
    options.maxStaleAgeMs ?? WORKABLE_GLOBAL_MAX_STALE_AGE_MS,
    'maxStaleAgeMs',
  );
  const timeoutMs = positiveInteger(options.timeoutMs ?? WORKABLE_GLOBAL_TIMEOUT_MS, 'timeoutMs');
  const maxResponseBytes = positiveInteger(
    options.maxResponseBytes ?? WORKABLE_GLOBAL_MAX_RESPONSE_BYTES,
    'maxResponseBytes',
  );
  const maxRetainedRecords = positiveInteger(
    options.maxRetainedRecords ?? WORKABLE_GLOBAL_MAX_RETAINED_RECORDS,
    'maxRetainedRecords',
  );
  const filePath = options.snapshotPath ?? snapshotPath(projectRoot);
  const previous = await loadWorkableFeedSnapshot(filePath, { maxRecords: maxRetainedRecords });
  if (previous !== null && isFresh(previous, now, refreshIntervalMs)) {
    return discoveryRun(previous.result, config.minimumAnnualBaseUsd, 0);
  }

  const priorAttempt = await loadAttemptState(filePath);
  if (priorAttempt !== null && Date.parse(priorAttempt.nextAllowedAt) > now.getTime()) {
    const message = `Workable retry deferred until ${priorAttempt.nextAllowedAt} after ${priorAttempt.error}`;
    if (
      priorAttempt.blockedStatus !== 451 &&
      previous !== null &&
      isUsableStale(previous, now, maxStaleAgeMs)
    ) {
      return discoveryRun(previous.result, config.minimumAnnualBaseUsd, 0, [message]);
    }
    const guardError =
      priorAttempt.blockedStatus !== null
        ? new CrawlerHttpError({
            category: 'blocked',
            code: 'blocked_status',
            url: WORKABLE_ALL_CUSTOMER_FEED_URL,
            detail:
              priorAttempt.blockedStatus === 451
                ? 'Legal access block remains active'
                : 'Remote access block remains active',
            status: priorAttempt.blockedStatus,
          })
        : new WorkableFeedParseError(message);
    return failedRun(guardError, message, 0);
  }

  const attemptGuardPersisted = await persistAttemptState(
    filePath,
    now,
    new Date(now.getTime() + refreshIntervalMs),
    'prior attempt did not complete successfully',
    priorAttempt?.blockedStatus ?? null,
  );

  const parser = createWorkableFeedParser({ maxRetainedRecords });
  try {
    const response = await http.streamGet(WORKABLE_ALL_CUSTOMER_FEED_URL, {
      headers: conditionalHeaders(previous),
      allowedOrigins: ['https://www.workable.com'],
      timeoutMs,
      maxResponseBytes,
      maxRetries: 0,
      onChunk(chunk) {
        parser.write(chunk);
      },
    });

    if (response.status === 304) {
      if (previous === null) {
        throw new WorkableFeedParseError('received 304 without a parsed snapshot');
      }
      const etag = nonEmptyHeader(response.headers.etag) ?? previous.etag;
      const lastModified =
        validLastModified(response.headers['last-modified']) ?? previous.lastModified;
      const persisted = await persistSnapshot(
        filePath,
        {
          ...(etag === undefined ? {} : { etag }),
          ...(lastModified === undefined ? {} : { lastModified }),
          fetchedAt: now,
          result: previous.result,
        },
        maxRetainedRecords,
      );
      if (persisted) await clearAttemptState(filePath);
      return discoveryRun(
        previous.result,
        config.minimumAnnualBaseUsd,
        1,
        persisted ? [] : ['parsed snapshot refresh could not be persisted'],
      );
    }

    if (response.status !== 200) {
      throw new WorkableFeedParseError(`unexpected successful HTTP status ${response.status}`);
    }
    const contentType = response.headers['content-type']?.toLowerCase() ?? '';
    if (!contentType.includes('xml')) {
      throw new WorkableFeedParseError('response is not XML');
    }
    const result = parser.finish();
    assertCompleteReplacement(
      result,
      previous !== null && isUsableStale(previous, now, maxStaleAgeMs) ? previous : null,
    );
    const etag = nonEmptyHeader(response.headers.etag);
    const lastModified = validLastModified(response.headers['last-modified']);
    const persisted = await persistSnapshot(
      filePath,
      {
        ...(etag === undefined ? {} : { etag }),
        ...(lastModified === undefined ? {} : { lastModified }),
        fetchedAt: now,
        result,
      },
      maxRetainedRecords,
    );
    if (persisted) await clearAttemptState(filePath);
    return discoveryRun(
      result,
      config.minimumAnnualBaseUsd,
      1,
      persisted ? [] : ['parsed snapshot could not be persisted'],
    );
  } catch (error) {
    const serverRetryAfterMs = isCrawlerHttpError(error) ? error.retryAfterMs : undefined;
    const maximumRepresentableDelayMs = Math.max(0, MAXIMUM_DATE_TIMESTAMP_MS - now.getTime());
    const validatedServerRetryAfterMs =
      serverRetryAfterMs !== undefined &&
      Number.isSafeInteger(serverRetryAfterMs) &&
      serverRetryAfterMs >= 0
        ? Math.min(serverRetryAfterMs, maximumRepresentableDelayMs)
        : 0;
    const cooldownMs = Math.max(refreshIntervalMs, validatedServerRetryAfterMs);
    const blockedStatus =
      isCrawlerHttpError(error) && error.category === 'blocked'
        ? (error.status ?? 403)
        : (priorAttempt?.blockedStatus ?? null);
    const legalBlocked = blockedStatus === 451;
    const updatedGuard = await persistAttemptState(
      filePath,
      now,
      new Date(now.getTime() + cooldownMs),
      failureMessage(error),
      blockedStatus,
    );
    const guardProtected =
      updatedGuard || (attemptGuardPersisted && cooldownMs === refreshIntervalMs);
    const guardWarning = guardProtected ? [] : ['hourly retry guard could not be persisted'];
    if (legalBlocked) {
      return failedRun(
        error,
        [failureMessage(error), 'stale vacancies withheld after legal access block', ...guardWarning].join(
          '; ',
        ),
      );
    }
    if (previous !== null && isUsableStale(previous, now, maxStaleAgeMs)) {
      return discoveryRun(previous.result, config.minimumAnnualBaseUsd, 1, [
        `stale parsed snapshot reused from ${previous.fetchedAt} after ${failureMessage(error)}`,
        ...guardWarning,
      ]);
    }
    if (previous !== null) {
      return failedRun(
        error,
        [
          `parsed snapshot from ${previous.fetchedAt} exceeded the stale limit after ${failureMessage(error)}`,
          ...guardWarning,
        ].join('; '),
      );
    }
    return failedRun(error, [failureMessage(error), ...guardWarning].join('; '));
  }
}
