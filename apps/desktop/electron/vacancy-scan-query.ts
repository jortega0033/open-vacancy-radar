import {
  parseMinimumAnnualSalary,
  type CandidateProfile,
  type SalaryFilterCriteria,
} from '@open-vacancy-radar/vacancy-engine';

export type VacancyScanRequest =
  | {
      mode: 'query';
      query: string;
      country?: string;
      employment?: string;
      salary?: { minimumAnnual: string; currency: string; includeUnknown?: boolean };
    }
  | { mode: 'browse_all' };

export type ParsedVacancyScanRequest =
  | { mode: 'query'; query: string; country?: string; employment?: string; salary?: SalaryFilterCriteria }
  | { mode: 'browse_all' };

export function requiredScanQuery(query: unknown): string {
  const trimmed = typeof query === 'string' ? query.trim() : '';
  if (!trimmed) {
    throw new Error('Add a role or keyword before starting a new worldwide scan.');
  }
  return trimmed;
}

function optionalFocusedCriterion(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > 100) throw new Error(`${name} is too long.`);
  return normalized;
}

function parseSalaryFilter(value: unknown): SalaryFilterCriteria | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') throw new Error('Salary must be an object.');
  const salary = value as { minimumAnnual?: unknown; currency?: unknown; includeUnknown?: unknown };
  if (salary.minimumAnnual === undefined || typeof salary.minimumAnnual !== 'string') {
    throw new Error('Minimum annual salary must be a string.');
  }
  const minimumAnnual = parseMinimumAnnualSalary(salary.minimumAnnual);
  if (minimumAnnual === null) return undefined;
  if (typeof salary.currency !== 'string' || !/^[A-Za-z]{3}$/u.test(salary.currency.trim())) {
    throw new Error('Salary currency must be a three-letter code.');
  }
  if (salary.includeUnknown !== undefined && typeof salary.includeUnknown !== 'boolean') {
    throw new Error('Include-unknown salary setting must be a boolean.');
  }
  return {
    minimumAnnual,
    currency: salary.currency.trim().toUpperCase(),
    includeUnknown: salary.includeUnknown ?? true,
  };
}

export function parseVacancyScanRequest(value: unknown): ParsedVacancyScanRequest {
  if (typeof value === 'string') return { mode: 'query', query: requiredScanQuery(value) };
  if (value && typeof value === 'object') {
    const request = value as { mode?: unknown; query?: unknown; country?: unknown; employment?: unknown; salary?: unknown };
    if (request.mode === 'query') {
      const country = optionalFocusedCriterion(request.country, 'Country');
      const employment = optionalFocusedCriterion(request.employment, 'Employment type');
      const salary = parseSalaryFilter(request.salary);
      return {
        mode: 'query',
        query: requiredScanQuery(request.query),
        ...(country ? { country } : {}),
        ...(employment ? { employment } : {}),
        ...(salary ? { salary } : {}),
      };
    }
    if (request.mode === 'browse_all') return { mode: 'browse_all' };
  }
  throw new Error('Unsupported vacancy scan request.');
}

function firstNonBlank(values: readonly string[]): string | null {
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

export function scheduledScanQueryFromProfile(profile: CandidateProfile): string | null {
  return firstNonBlank(profile.targetRoles) ?? firstNonBlank(profile.strongestSkills);
}
