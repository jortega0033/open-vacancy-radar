import {
  isUnspecifiedCountry,
  type AiSearchIntentProvenance,
  type SalaryFilterCriteria,
  type SearchPlanSnapshot,
} from '@open-vacancy-radar/vacancy-engine';
import type { ParsedVacancyScanRequest } from './vacancy-scan-query.js';

/**
 * Issue #684 -- one immutable description of what a single scan run was asked to look for.
 *
 * It is captured once from the already-validated request when the run starts, and every branch of
 * that run (the optional AI web search and the deterministic sources) reads its criteria from this
 * object, never from the saved search profile, which a person may edit while the run is active.
 * The saved profile can add background context to the AI prompt; it can never change a criterion.
 */
export const VACANCY_RUN_INTENT_VERSION = 1;

/** The engine caps the role phrase it matches locally at this length (`resolveRoleQuery`); capturing
 * it here keeps both branches on the same text. */
const MAX_ROLE_QUERY_CHARS = 200;

export interface VacancyRunIntent {
  readonly version: typeof VACANCY_RUN_INTENT_VERSION;
  readonly scanId: string;
  readonly capturedAt: string;
  /** `browse_all` is an explicit mode: it has no role phrase and never inherits a saved target role. */
  readonly mode: 'query' | 'browse_all';
  readonly query: string | null;
  readonly country: string | null;
  readonly employment: string | null;
  readonly salary: Readonly<SalaryFilterCriteria> | null;
  readonly aiWebDiscovery: boolean;
  /**
   * Issue #686: the reviewed search plan this run searches besides the typed query, as the frozen copy
   * taken when the run started; null for a literal single-query run. Editing or removing a title in the
   * saved plan afterwards changes the next run, never this one.
   */
  readonly searchPlan: SearchPlanSnapshot | null;
}

export function captureVacancyRunIntent(
  scanId: string,
  request: ParsedVacancyScanRequest,
  capturedAt: Date = new Date(),
  searchPlan: SearchPlanSnapshot | null = null,
): VacancyRunIntent {
  const base = {
    version: VACANCY_RUN_INTENT_VERSION,
    scanId,
    capturedAt: capturedAt.toISOString(),
    aiWebDiscovery: request.aiWebDiscovery === true,
  } as const;
  if (request.mode === 'browse_all') {
    return Object.freeze({
      ...base,
      mode: 'browse_all',
      query: null,
      country: null,
      employment: null,
      salary: null,
      searchPlan: null,
    });
  }
  return Object.freeze({
    ...base,
    mode: 'query',
    query: request.query.trim().slice(0, MAX_ROLE_QUERY_CHARS),
    country: request.country ?? null,
    employment: request.employment ?? null,
    salary: request.salary ? Object.freeze({ ...request.salary }) : null,
    // Only a run that asked for the plan carries one, and only the already-frozen snapshot is kept.
    searchPlan: request.useSearchPlan === true ? searchPlan : null,
  });
}

/** Criteria for `runGlobalRemoteScan`, derived from the snapshot so both branches see one intent. */
export function deterministicScanCriteria(
  intent: VacancyRunIntent,
  browseAllResultCap: number,
):
  | { query: string; country?: string; employment?: string; salary?: SalaryFilterCriteria; searchPlan?: SearchPlanSnapshot }
  | { query: ''; browseAll: true; browseAllResultCap: number } {
  if (intent.mode === 'browse_all') return { query: '', browseAll: true, browseAllResultCap };
  return {
    query: intent.query ?? '',
    ...(intent.searchPlan ? { searchPlan: intent.searchPlan } : {}),
    ...(intent.country ? { country: intent.country } : {}),
    ...(intent.employment ? { employment: intent.employment } : {}),
    ...(intent.salary ? { salary: { ...intent.salary } } : {}),
  };
}

function formatSalary(salary: Readonly<SalaryFilterCriteria>): string {
  return `${salary.currency} ${salary.minimumAnnual.toLocaleString('en-US')}`;
}

/** The criteria a person actually submitted, as short labelled parts. Empty parts are left out so an
 * unspecified criterion is never shown as if it had a value. */
export function describeVacancyRunIntentParts(intent: VacancyRunIntent): string[] {
  if (intent.mode === 'browse_all') return ['Browse all roles'];
  return [
    `Role: ${intent.query}`,
    ...(intent.country ? [`Country: ${intent.country}`] : []),
    ...(intent.employment ? [`Employment: ${intent.employment}`] : []),
    ...(intent.salary
      ? [`Minimum salary: ${formatSalary(intent.salary)} a year${intent.salary.includeUnknown ? '' : ', unknown salaries hidden'}`]
      : []),
    ...(intent.searchPlan
      ? [`Search plan: ${intent.searchPlan.variants.length} approved ${intent.searchPlan.variants.length === 1 ? 'title' : 'titles'} (revision ${intent.searchPlan.revision})`]
      : []),
  ];
}

/** Compact one-line description shown while the run is active and in diagnostics. */
export function describeVacancyRunIntent(intent: VacancyRunIntent): string {
  return describeVacancyRunIntentParts(intent).join(' · ');
}

export interface AiIntentContextUsed {
  skillCount: number;
  experienceYearsIncluded: boolean;
  homeCountryIncluded: boolean;
}

/**
 * The Search page's "Unspecified location" choice is not a country: the shared filter keeps only
 * vacancies whose location names no identifiable country. Same trim/case rule as that filter.
 */
export function isUnspecifiedCountryIntent(intent: VacancyRunIntent): boolean {
  return intent.country !== null && isUnspecifiedCountry(intent.country);
}

/**
 * What the AI branch was told about this run, for the source audit and the log. Web search can take
 * a role, country and employment type as wording in its queries; it has no way to filter by salary
 * or to search for "no country", so those are recorded as unsupported there and left to the shared
 * local filter. Holds search terms only: no CV text, no skill names, no prompt.
 */
export function buildAiIntentProvenance(
  intent: VacancyRunIntent,
  context: AiIntentContextUsed,
): AiSearchIntentProvenance {
  const criterion = (
    value: string | null,
    pushdown: 'prompt_guidance' | 'unsupported',
  ): AiSearchIntentProvenance['criteria']['role'] =>
    value === null
      ? { requested: false, value: null, pushdown: 'not_requested', enforcedLocally: false }
      : { requested: true, value, pushdown, enforcedLocally: true };
  return {
    intentVersion: intent.version,
    scanId: intent.scanId,
    mode: intent.mode,
    criteria: {
      role: criterion(intent.query, 'prompt_guidance'),
      country: criterion(intent.country, isUnspecifiedCountryIntent(intent) ? 'unsupported' : 'prompt_guidance'),
      employment: criterion(intent.employment, 'prompt_guidance'),
      salary: criterion(
        intent.salary
          ? `${formatSalary(intent.salary)}${intent.salary.includeUnknown ? '; unknown salaries kept' : '; unknown salaries hidden'}`
          : null,
        'unsupported',
      ),
    },
    candidateContext: { ...context, savedTargetRolesSearched: false },
  };
}
