/**
 * Source Gap Telemetry: tracks unsupported ATS providers and discovery failures
 * to help prioritize future adapter development.
 *
 * Entirely local (never transmitted): logs are written to a local file or database
 * for discovery-time diagnostics and CI fixtures.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { DiscoverySourceAudit, FailureCategory, GapRecord, GapTelemetryReport } from './models.js';

/**
 * Redacts a URL to remove query strings and sensitive path segments.
 * Preserves the protocol, domain, and top-level path for later investigation.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove query string and fragment; keep protocol, domain, and first path segment only
    const pathSegments = parsed.pathname.split('/').filter(Boolean);
    const firstSegment = pathSegments[0] ?? '';
    parsed.pathname = firstSegment.length > 0 ? `/${firstSegment}` : '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    // If URL parsing fails, return just the origin if we can get it, else hash
    return `[redacted-${url.length}-bytes]`;
  }
}

/**
 * Classify a discovery source failure into a telemetry category.
 * Based on HTTP status and error message patterns.
 */
export function classifyFailure(
  status: 'success' | 'partial' | 'blocked' | 'error',
  httpStatus: number | null,
  errorMessage: string | null,
): FailureCategory {
  if (status === 'blocked' || (httpStatus !== null && [401, 403, 406, 407, 429, 451].includes(httpStatus))) {
    return 'blocked';
  }

  if (errorMessage === null) {
    return status === 'partial' ? 'transient' : 'transient';
  }

  const error = errorMessage.toLowerCase();

  // Detect malformed/parsing errors
  if (
    error.includes('invalid') ||
    error.includes('parse') ||
    error.includes('json') ||
    error.includes('malformed') ||
    error.includes('not an array') ||
    error.includes('not an object')
  ) {
    return 'malformed';
  }

  // Detect empty results
  if (
    error.includes('no jobs') ||
    error.includes('no listings') ||
    error.includes('empty') ||
    error.includes('no data')
  ) {
    return 'empty';
  }

  // Detect transient failures (timeouts, connection issues)
  if (
    error.includes('timeout') ||
    error.includes('econnrefused') ||
    error.includes('enotfound') ||
    error.includes('connection')
  ) {
    return 'transient';
  }

  // Default: treat as transient (network/temporary issue)
  return 'transient';
}

/**
 * Detects ATS provider names from error messages and response content.
 * Focuses on common/high-priority ATS systems mentioned in issue #9.
 */
export function detectAtsProviderFromError(
  errorMessage: string | null,
  url: string,
): string | null {
  const urlLower = url.toLowerCase();
  const error = errorMessage?.toLowerCase() ?? '';

  // Common ATS provider signatures in error messages and URLs
  const patterns: Array<[string, RegExp]> = [
    ['BambooHR', /bamboo/i],
    ['iCIMS', /icims|jibe/i],
    ['Oracle HCM', /oracle|successfactors/i],
    ['Phenom', /phenom/i],
    ['Workable', /workable/i],
    ['Greenhouse', /greenhouse/i],
    ['Lever', /lever/i],
    ['Ashby', /ashby/i],
    ['Personio', /personio/i],
    ['SmartRecruiters', /smartrecruit/i],
    ['Workday', /workday/i],
    ['Rippling', /rippling/i],
    ['TeamTailor', /teamtailor/i],
    ['Recruitee', /recruitee/i],
    ['Breezy HR', /breezy/i],
    ['Pinpoint', /pinpoint/i],
    ['Jobvite', /jobvite/i],
  ];

  // Check both error message and URL
  for (const [name, pattern] of patterns) {
    if (pattern.test(error) || pattern.test(urlLower)) {
      return name;
    }
  }

  return null;
}

/**
 * Record a gap from a discovery source audit.
 * Returns null if the source was successful (no gap to record).
 */
export function recordFromSourceAudit(audit: DiscoverySourceAudit): GapRecord | null {
  // Only record failures, not successful sources
  if (audit.status === 'success') {
    return null;
  }

  const detectedProvider = detectAtsProviderFromError(audit.error, audit.url);
  const category = detectedProvider !== null
    ? 'unsupported_ats'
    : classifyFailure(audit.status, null, audit.error);

  return {
    timestamp: new Date().toISOString(),
    category,
    detectedProvider,
    redactedUrl: redactUrl(audit.url),
    httpStatus: null,
    failureReason: audit.error ?? `Status: ${audit.status}`,
  };
}

/**
 * Aggregate gap records into a telemetry report.
 * Bounds the records collection at 1000 for local storage efficiency.
 */
export function aggregateGapRecords(records: GapRecord[]): GapTelemetryReport {
  const maxRecords = 1000;
  const cappedRecords = records.slice(-maxRecords);

  const aggregatedByProvider: Record<string, number> = {};
  const aggregatedByCategory: Record<FailureCategory, number> = {
    unsupported_ats: 0,
    blocked: 0,
    malformed: 0,
    empty: 0,
    transient: 0,
  };

  for (const record of cappedRecords) {
    // Aggregate by provider
    if (record.detectedProvider !== null) {
      aggregatedByProvider[record.detectedProvider] =
        (aggregatedByProvider[record.detectedProvider] ?? 0) + 1;
    }

    // Aggregate by category
    aggregatedByCategory[record.category] += 1;
  }

  return {
    generatedAt: new Date().toISOString(),
    totalRecords: records.length,
    records: cappedRecords,
    aggregatedByProvider: Object.fromEntries(
      Object.entries(aggregatedByProvider)
        .sort(([, a], [, b]) => b - a) // Sort by count descending
        .slice(0, 50), // Top 50 providers
    ),
    aggregatedByCategory,
  };
}

/**
 * Where accumulated gap records persist between scans, mirroring the `reports/global-remote`
 * convention `report.ts` already uses for the rest of a scan's local diagnostic output -- this is
 * the same directory `writeGlobalRemoteReport` writes `latest.json`/`latest.html` into, so a single
 * `.gitignore`d output directory holds all of a scan's local diagnostics.
 */
function gapTelemetryRecordsFile(projectRoot: string): string {
  const output = path.resolve(projectRoot, 'reports', 'global-remote');
  const relative = path.relative(projectRoot, output);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Gap telemetry path must remain inside the project root');
  }
  return path.join(output, 'gap-telemetry.json');
}

/**
 * Reads back whatever `saveGapRecords` last persisted. Returns an empty array for every failure
 * mode (no telemetry has ever been recorded yet, the file was deleted, the JSON is truncated or
 * corrupt) -- all three mean "no prior gap history", which a first scan or a freshly cleaned
 * `reports/` directory hits as an expected, not exceptional, case (mirrors `readGlobalRemoteReport`
 * in report.ts).
 */
export async function loadGapRecords(projectRoot: string): Promise<GapRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(gapTelemetryRecordsFile(projectRoot), 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as GapRecord[]) : [];
  } catch {
    return [];
  }
}

/** Atomic write (temp file + rename), matching the pattern `report.ts`'s `writeGlobalRemoteReport` uses. */
export async function saveGapRecords(projectRoot: string, records: readonly GapRecord[]): Promise<void> {
  const file = gapTelemetryRecordsFile(projectRoot);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Wires source-gap telemetry into a live discovery run. Turns this run's non-`success`
 * `DiscoverySourceAudit` entries into `GapRecord`s (`recordFromSourceAudit`), merges them with
 * whatever `gap-telemetry.json` already holds from prior scans -- so gaps aggregate "across
 * repeated scans" per issue #9 rather than resetting every run -- bounds and persists the merged
 * set (`aggregateGapRecords` already caps storage at 1000 records), and returns the up-to-date
 * aggregated report so a caller can render it (see `gap-report.ts`) without a second disk read.
 *
 * Call this with the sources from a real discovery run (`runGlobalRemoteDiscovery`), never with
 * sources reused from a previous report's cached discovery (`loadPreviousDiscovery` in
 * pipeline/global-remote.ts) -- those didn't make a new request, so replaying them here would
 * double-count the same historical failure on every offline/official-only rerun.
 */
export async function recordDiscoveryGapTelemetry(
  sources: readonly DiscoverySourceAudit[],
  projectRoot: string,
): Promise<GapTelemetryReport> {
  const newRecords = sources
    .map((source) => recordFromSourceAudit(source))
    .filter((gapRecord): gapRecord is GapRecord => gapRecord !== null);
  const previousRecords = await loadGapRecords(projectRoot);
  const report = aggregateGapRecords([...previousRecords, ...newRecords]);
  await saveGapRecords(projectRoot, report.records);
  return report;
}
