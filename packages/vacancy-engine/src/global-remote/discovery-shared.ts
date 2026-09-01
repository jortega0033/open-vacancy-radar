import { createHash } from 'node:crypto';

import type { AtsHttpResponse } from '../ats/http.js';
import { AtsResponseError, requireSuccessfulResponse } from '../ats/http.js';
import { annualizedMinimumUsd, classifyDiscoveryVacancy } from './evaluation.js';
import type {
  DiscoverySourceAudit,
  DiscoveryVacancyAudit,
} from './models.js';

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function booleanValue(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

export function identifier(value: unknown, fallback: string): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
}

export function parsedRoot(response: AtsHttpResponse, provider: string): Record<string, unknown> {
  requireSuccessfulResponse(provider, response);
  try {
    const root = record(JSON.parse(response.body) as unknown);
    if (root === null) throw new TypeError('root is not an object');
    return root;
  } catch (error) {
    throw new AtsResponseError(provider, 'invalid discovery JSON', response.status, { cause: error });
  }
}

export function locations(value: unknown, emptyFallback = 'Worldwide'): string {
  if (!Array.isArray(value) || value.length === 0) return emptyFallback;
  const names = value.flatMap((item) => {
    if (typeof item === 'string') return [item];
    const itemRecord = record(item);
    return [stringValue(itemRecord?.name) ?? stringValue(itemRecord?.slug)].filter(
      (name): name is string => name !== null,
    );
  });
  return names.length === 0 ? emptyFallback : names.join(', ');
}

export function discoveryAudit(
  input: Omit<
    DiscoveryVacancyAudit,
    'decision' | 'reasons' | 'annualizedMinimumUsd' | 'contentHash' | 'description' | 'postedAt'
  > & {
    raw: unknown;
    minimumAnnualBaseUsd: number | null;
    description?: string | null;
    postedAt?: string | null;
  },
): DiscoveryVacancyAudit {
  const annualized = annualizedMinimumUsd(
    input.advertisedMinimum,
    input.currency,
    input.salaryPeriod,
    input.employmentType,
  );
  const classification = classifyDiscoveryVacancy({
    title: input.title,
    location: input.location,
    annualizedMinimumUsd: annualized,
    minimumAnnualBaseUsd: input.minimumAnnualBaseUsd,
    ...(input.description === undefined ? {} : { description: input.description }),
  });
  return {
    key: input.key,
    provider: input.provider,
    company: input.company,
    title: input.title,
    url: input.url,
    location: input.location,
    employmentType: input.employmentType,
    currency: input.currency,
    salaryPeriod: input.salaryPeriod,
    advertisedMinimum: input.advertisedMinimum,
    annualizedMinimumUsd: annualized,
    decision: classification.decision,
    reasons: classification.reasons,
    contentHash: createHash('sha256').update(JSON.stringify(input.raw)).digest('hex'),
    description: input.description ?? null,
    postedAt: input.postedAt ?? null,
  };
}

export function sourceFailure(error: unknown): Pick<DiscoverySourceAudit, 'status' | 'error'> {
  const status = error instanceof AtsResponseError ? error.status : null;
  const blocked = status !== null && [401, 403, 406, 407, 429, 451].includes(status);
  return {
    status: blocked ? 'blocked' : 'error',
    error: error instanceof Error ? error.message : String(error),
  };
}

export type ParsedSalary = {
  minimum: number | null;
  currency: string | null;
  period: string | null;
};

export function parseSalaryText(value: string | null): ParsedSalary {
  if (value === null) return { minimum: null, currency: null, period: null };
  const currency = /\bUSD\b|\$/iu.test(value)
    ? 'USD'
    : /\bEUR\b|€/iu.test(value)
      ? 'EUR'
      : /\bGBP\b|£/iu.test(value)
        ? 'GBP'
        : null;
  const match = /(?:\b(?:USD|EUR|GBP)\b|[$€£])?\s*(\d+(?:[,.]\d+)*)\s*([kK])?/u.exec(value);
  if (match?.[1] === undefined) return { minimum: null, currency, period: null };
  const normalized = match[1].replaceAll(',', '');
  const numeric = Number(normalized);
  if (!Number.isFinite(numeric)) return { minimum: null, currency, period: null };
  const minimum = numeric * (match[2] === undefined ? 1 : 1_000);
  const period = /\b(?:hour|hourly|hr)\b|\/\s*h\b/iu.test(value)
    ? 'hourly'
    : /\b(?:month|monthly|mo)\b/iu.test(value)
      ? 'monthly'
      : /\b(?:week|weekly|wk)\b/iu.test(value)
        ? 'weekly'
        : /\b(?:year|yearly|annual|annually|yr)\b/iu.test(value)
          ? 'annual'
          : null;
  return { minimum, currency, period };
}

/**
 * Normalizes a source's raw posting-date string to ISO-8601. Handles every format actually seen
 * across worldwide sources: RFC 822 (`Thu, 27 Aug 2026 14:36:09 GMT`) and offset-bearing ISO parse
 * correctly as-is; a date-only string (`2026-08-31`) is UTC per spec already. The one real
 * ambiguity is a date-TIME string with no timezone marker at all (e.g. JobTech Sweden's
 * `publication_date`), which JS otherwise treats as the *local* machine's timezone -- appending
 * `Z` pins it to UTC instead, so the same raw value renders the same date for every user
 * regardless of their machine's timezone. A few sources report their own local time this way
 * (JobTech Sweden is Europe/Stockholm), so the exact hour can be off by that source's UTC offset;
 * this only matters for day-level display and a 30-day staleness check, where an hour or two never
 * changes the answer.
 */
export function isoPostedAt(value: string | null): string | null {
  if (value === null) return null;
  // A space-separated date-time (e.g. Jooble's `2026-08-31 14:05:00`) is normalized to the
  // standard `T` separator before the timezone check below, rather than left to whatever a given
  // JS engine happens to do with the non-standard form.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/u.test(value) ? value.replace(' ', 'T') : value;
  const hasTimezoneMarker = /(?:Z|[+-]\d{2}:?\d{2})$/u.test(normalized);
  const isOffsetlessDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u.test(normalized) && !hasTimezoneMarker;
  const parsed = new Date(isOffsetlessDateTime ? `${normalized}Z` : normalized);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

/**
 * For sources reporting the posting date as `dd/mm/yyyy` (e.g. Reed) rather than any ISO variant.
 * Parses the three numeric parts explicitly instead of handing the ambiguous string to `new
 * Date()`, which would silently read it as the wrong calendar date (US month-first order) on some
 * inputs rather than failing loudly.
 */
export function isoPostedAtFromDdMmYyyy(value: string | null): string | null {
  if (value === null) return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/u.exec(value);
  if (match === null) return null;
  const [, dayText, monthText, year] = match;
  const day = Number(dayText);
  const month = Number(monthText);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const parsed = new Date(Date.UTC(Number(year), month - 1, day));
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

/** For sources reporting the posting date as a unix timestamp in seconds (e.g. arbeitnow, himalayas). */
export function isoPostedAtFromUnixSeconds(value: number | null): string | null {
  if (value === null) return null;
  const parsed = new Date(value * 1000);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

/**
 * For a source reporting `mm/dd/yyyy` (US month-first order, e.g. UN Careers) at the start of an
 * otherwise free-text value (UN Careers' "Posted Date" metadata also carries a local time-of-day
 * and timezone label after the date, e.g. "08/15/2026 10:00:00 AM"). Only the leading date is
 * used -- the time-of-day is dropped rather than guessed at, since converting a named local
 * timezone to UTC correctly requires knowing its DST rules for that date, which is unnecessary
 * precision for a day-level display and a 30-day staleness check.
 */
export function isoPostedAtFromMmDdYyyyPrefix(value: string | null): string | null {
  if (value === null) return null;
  const match = /^(\d{2})\/(\d{2})\/(\d{4})\b/u.exec(value);
  if (match === null) return null;
  const [, monthText, dayText, year] = match;
  const month = Number(monthText);
  const day = Number(dayText);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const parsed = new Date(Date.UTC(Number(year), month - 1, day));
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

export function httpUrl(value: unknown): string | null {
  const raw = stringValue(value);
  if (raw === null) return null;
  try {
    const parsed = new URL(raw);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString() : null;
  } catch {
    return null;
  }
}
