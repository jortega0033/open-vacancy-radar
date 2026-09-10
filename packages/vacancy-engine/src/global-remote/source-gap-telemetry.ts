/**
 * Source Gap Telemetry: tracks unsupported ATS providers and discovery failures
 * to help prioritize future adapter development.
 *
 * Entirely local (never transmitted): logs are written to a local file or database
 * for discovery-time diagnostics and CI fixtures.
 */

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
