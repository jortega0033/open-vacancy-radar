import {
  isSearchPlanUsable,
  parseMinimumAnnualSalary,
  type CandidateProfile,
  type SalaryFilterCriteria,
  type SearchPlan,
} from '@open-vacancy-radar/vacancy-engine';

export type VacancyScanRequest =
  | {
      mode: 'query';
      query: string;
      country?: string;
      employment?: string;
      salary?: { minimumAnnual: string; currency: string; includeUnknown?: boolean };
      /** Issue #398 Phase 1: opt in to an additional, on-demand AI-web-search discovery pass for
       * this run only. Omitted/false is a true no-op -- see `runVacancyScan` in `main.ts`, which
       * never even looks at this field's absence differently from `false`. */
      aiWebDiscovery?: boolean;
      /** Issue #686: also search the person's approved search-plan titles in this run. The plan itself
       * is never sent from the page: the main process reads the saved one when the run starts. */
      useSearchPlan?: boolean;
    }
  | { mode: 'browse_all'; aiWebDiscovery?: boolean };

export type ParsedVacancyScanRequest =
  | {
      mode: 'query';
      query: string;
      country?: string;
      employment?: string;
      salary?: SalaryFilterCriteria;
      aiWebDiscovery?: boolean;
      useSearchPlan?: boolean;
      /**
       * Issue #686, main process only (the IPC parser below never sets it): a background run takes its
       * query from the plan snapshot the run itself captures -- the first approved title -- so the plan
       * is read once per run. `query` is then only the fallback (the saved role or skill) used when the
       * plan turns out empty or unreadable at start, which the run reports.
       */
      queryFromSearchPlan?: boolean;
    }
  | { mode: 'browse_all'; aiWebDiscovery?: boolean };

export function requiredScanQuery(query: unknown): string {
  const trimmed = typeof query === 'string' ? query.trim() : '';
  if (!trimmed) {
    throw new Error('Add a role or keyword before starting a new worldwide scan.');
  }
  return trimmed;
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean.`);
  return value;
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
    const request = value as {
      mode?: unknown;
      query?: unknown;
      country?: unknown;
      employment?: unknown;
      salary?: unknown;
      aiWebDiscovery?: unknown;
      useSearchPlan?: unknown;
    };
    if (request.mode === 'query') {
      const country = optionalFocusedCriterion(request.country, 'Country');
      const employment = optionalFocusedCriterion(request.employment, 'Employment type');
      const salary = parseSalaryFilter(request.salary);
      const aiWebDiscovery = optionalBoolean(request.aiWebDiscovery, 'AI web discovery');
      const useSearchPlan = optionalBoolean(request.useSearchPlan, 'Search plan');
      return {
        mode: 'query',
        query: requiredScanQuery(request.query),
        ...(country ? { country } : {}),
        ...(employment ? { employment } : {}),
        ...(salary ? { salary } : {}),
        ...(aiWebDiscovery !== undefined ? { aiWebDiscovery } : {}),
        // Only an explicit true is kept, so a literal request stays byte-identical to before #686.
        ...(useSearchPlan === true ? { useSearchPlan } : {}),
      };
    }
    if (request.mode === 'browse_all') {
      const aiWebDiscovery = optionalBoolean(request.aiWebDiscovery, 'AI web discovery');
      return { mode: 'browse_all', ...(aiWebDiscovery !== undefined ? { aiWebDiscovery } : {}) };
    }
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

/**
 * What the unattended scan and the background source scout search for (#686).
 *
 * With an approved search plan the answer is ONE scan carrying the plan, so the run uses the person's
 * reviewed titles under one shared allowance instead of scanning each saved role on its own. The run
 * itself takes its query from the plan snapshot it captures (`queryFromSearchPlan`); `fallbackQuery` is
 * what it searches if the plan is empty or unreadable by then. An unreadable plan still asks for the
 * plan, so the run records and reports why it fell back instead of silently searching the role.
 * Without a plan it is the first saved role or skill, as before. Suggestions are never part of a plan.
 *
 * `query` is the first approved title when there is one (the source scout, which has no plan budget,
 * searches that one title literally), else the saved role or skill.
 */
export function selectBackgroundScan(
  profile: CandidateProfile,
  plan: Pick<SearchPlan, 'variants'> | 'unreadable' | null,
): { query: string; fallbackQuery: string; useSearchPlan: boolean } | null {
  const legacy = scheduledScanQueryFromProfile(profile);
  if (plan === 'unreadable') {
    return legacy === null ? null : { query: legacy, fallbackQuery: legacy, useSearchPlan: true };
  }
  if (plan !== null && isSearchPlanUsable(plan)) {
    const first = plan.variants.map((variant) => variant.title.trim()).find((title) => title.length > 0);
    if (first) return { query: first, fallbackQuery: legacy ?? first, useSearchPlan: true };
  }
  return legacy === null ? null : { query: legacy, fallbackQuery: legacy, useSearchPlan: false };
}
