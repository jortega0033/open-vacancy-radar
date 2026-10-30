import {
  addSearchPlanSuggestions,
  approveSearchPlanDraft,
  captureSearchPlanSnapshot,
  compileSearchPlanQueries,
  EMPTY_SEARCH_PLAN,
  LITERAL_QUERY_ID,
  parseSearchPlanDraft,
  vacancyMatchesRole,
  vacancyTitleMatches,
  type DiscoveryVacancyAudit,
} from '@open-vacancy-radar/vacancy-engine';

import { AS_OF } from './fixtures.js';

type PlanQuery = ReturnType<typeof compileSearchPlanQueries>['queries'][number];

/**
 * Query plans for the retrieval PROJECTION. Built through #686's real functions (approve -> snapshot ->
 * compile), and matched with the real shared local filter (`vacancyMatchesRole` for the typed query,
 * `vacancyTitleMatches` for an approved title). This projects which in-corpus rows a plan's OR set would keep.
 * It is not live source coverage: it does not model which sources take a role query upstream, pagination,
 * caps or a source returning nothing.
 *
 * Plans P1 and P3 are written as if a person reviewed and approved them (origin `user`). That is a fixture
 * premise, not a person's action. Their approved titles were chosen by the fixture author knowing the corpus
 * titles (F05 "Web Platform Engineer" is P1's one deliberate miss), so their retrieval counts are true by
 * construction: they show the approved-title/shared-filter mechanism and are an upper bound on this corpus, not an
 * estimate of real reviewed-plan coverage. P3 is research only: no backend plan ships or is suggested by this work.
 */

export type PlanId = 'P0_frontend_literal' | 'P1_frontend_reviewed_686' | 'P2_backend_literal' | 'P3_backend_research';

export interface ResearchPlan {
  id: PlanId;
  profile: 'frontend' | 'backend_research';
  status: 'mirrors_current_default' | 'reviewed_686_plan' | 'research_only_not_shipped';
  literal: string;
  approvedTitles: readonly { title: string; language: string }[];
  /** Suggestions present in the saved plan but NOT approved: they must never reach a query. */
  pendingSuggestions: readonly string[];
}

export const PLANS: readonly ResearchPlan[] = [
  {
    id: 'P0_frontend_literal',
    profile: 'frontend',
    status: 'mirrors_current_default',
    // `scheduledScanQueryFromProfile` takes the first target role (apps/desktop/electron/vacancy-scan-query.ts).
    literal: 'Senior Frontend Engineer',
    approvedTitles: [],
    pendingSuggestions: [],
  },
  {
    id: 'P1_frontend_reviewed_686',
    profile: 'frontend',
    status: 'reviewed_686_plan',
    literal: 'Senior Frontend Engineer',
    approvedTitles: [
      { title: 'Frontend Engineer', language: 'English' },
      { title: 'Frontend Developer', language: 'English' },
      { title: 'UI Engineer', language: 'English' },
      { title: 'UI Developer', language: 'English' },
      { title: 'Web Engineer', language: 'English' },
      { title: 'Vue.js Developer', language: 'English' },
      { title: 'Client-side Engineer', language: 'English' },
      { title: 'Design Systems Engineer', language: 'English' },
      { title: 'Frontend ontwikkelaar', language: 'Dutch' },
      { title: 'Frontend-Entwickler', language: 'German' },
    ],
    // A Resume Toolkit style suggestion the person has not approved.
    pendingSuggestions: ['Full-Stack Engineer'],
  },
  {
    id: 'P2_backend_literal',
    profile: 'backend_research',
    status: 'research_only_not_shipped',
    literal: 'Senior Backend Engineer',
    approvedTitles: [],
    pendingSuggestions: [],
  },
  {
    id: 'P3_backend_research',
    profile: 'backend_research',
    status: 'research_only_not_shipped',
    literal: 'Senior Backend Engineer',
    approvedTitles: [
      { title: 'Backend Engineer', language: 'English' },
      { title: 'Backend Developer', language: 'English' },
      { title: 'Go Engineer', language: 'English' },
      { title: 'Node.js Engineer', language: 'English' },
      { title: 'Platform Engineer', language: 'English' },
    ],
    pendingSuggestions: [],
  },
];

export interface CompiledPlan {
  id: PlanId;
  queries: { variantId: string; query: string; language: string | null; rule: 'title_or_description' | 'title_only' }[];
  coveredByEarlier: { query: string; coveredBy: string }[];
  pendingSuggestionsReachedQueries: boolean;
}

/** Runs the plan through #686's real approve -> suggest -> snapshot -> compile path. */
export function compilePlan(plan: ResearchPlan): { compiled: CompiledPlan; queries: PlanQuery[] } {
  const now = new Date(AS_OF);
  const draft = parseSearchPlanDraft({
    primaryFunction: plan.profile === 'frontend' ? 'Frontend engineering' : 'Backend engineering (research only)',
    variants: plan.approvedTitles.map((title) => ({ ...title, origin: 'user' })),
    markets: [],
  });
  let saved = approveSearchPlanDraft(EMPTY_SEARCH_PLAN, draft, now);
  if (plan.pendingSuggestions.length > 0) saved = addSearchPlanSuggestions(
      saved,
      'toolkit',
      plan.pendingSuggestions.map((title) => ({ title, language: '' })),
      now,
    );
  const snapshot = captureSearchPlanSnapshot(saved);
  const { queries, covered } = compileSearchPlanQueries(plan.literal, snapshot);
  const lowered = new Set(queries.map((query) => query.query.toLowerCase()));
  return {
    queries,
    compiled: {
      id: plan.id,
      queries: queries.map((query) => ({
        variantId: query.variantId === LITERAL_QUERY_ID ? LITERAL_QUERY_ID : `variant:${query.query}`,
        query: query.query,
        language: query.language,
        rule: query.variantId === LITERAL_QUERY_ID ? 'title_or_description' : 'title_only',
      })),
      coveredByEarlier: covered.map((entry) => ({ query: entry.query, coveredBy: entry.coveredBy })),
      pendingSuggestionsReachedQueries: plan.pendingSuggestions.some((title) => lowered.has(title.toLowerCase())),
    },
  };
}

/** Which query of the plan's OR set would keep this row, with the same rule the run applies. */
export function matchingQueries(row: DiscoveryVacancyAudit, queries: readonly PlanQuery[]): string[] {
  return queries
    .filter((query) => (query.variantId === LITERAL_QUERY_ID ? vacancyMatchesRole(row, query.query) : vacancyTitleMatches(row, query.query)))
    .map((query) => query.query);
}
