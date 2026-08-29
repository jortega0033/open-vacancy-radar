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
    'decision' | 'reasons' | 'annualizedMinimumUsd' | 'contentHash'
  > & {
    raw: unknown;
    minimumAnnualBaseUsd: number;
    description?: string | null;
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
