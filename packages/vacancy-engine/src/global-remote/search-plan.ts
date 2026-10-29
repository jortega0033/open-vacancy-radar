import type { AtsHttpClient } from '../ats/http.js';
import type { SearchPlanSnapshot } from '../candidate/search-plan.js';
import { discoverAiDevJobs } from './ai-dev-jobs-discovery.js';
import { runAdditionalDiscovery } from './additional-discovery.js';
import { discoverHimalayas, discoverJobicy } from './discovery.js';
import { SOURCE_FILTER_CAPABILITIES, vacancyMatchesRole } from './focused-scan.js';
import { runJobtechDiscovery } from './jobtech-discovery.js';
import { runKeyedDiscovery } from './keyed-discovery.js';
import type {
  DiscoveryProvider,
  DiscoveryRun,
  DiscoverySourceAudit,
  DiscoveryVacancyAudit,
  GlobalRemoteConfig,
  LeadQueryProvenance,
  SearchPlanEnvelope,
  SearchPlanHandling,
  SearchPlanQueryRef,
  SearchPlanReport,
  SearchPlanSourceHandling,
} from './models.js';
import { discoverPhilJobNet } from './phil-jobnet-discovery.js';
import { runStructuredDiscovery } from './structured-discovery.js';

/**
 * Issue #686 -- run a reviewed search plan: the literal query the person typed plus their approved
 * equivalent titles, inside ONE declared envelope.
 *
 * How it stays inside one budget:
 * - The literal pass is the unchanged scan. It is always allowed to finish.
 * - Variant passes repeat ONLY the sources that take a role query upstream (the sources a different
 *   title can actually change). A source with no declared role filter fetches one feed whatever the
 *   title, so repeating it would only cost requests; its rows are matched locally instead.
 * - `envelope.maxRequests` counts those query-dependent requests across the literal pass and every
 *   variant. Variants share what the literal pass left over, split fairly among the variants still
 *   to run, so twelve titles cannot do twelve times the work of one. `maxDurationMs` and `maxResults`
 *   bound the variant passes in the same shared way.
 * - When the requests, time or result allowance is gone the remaining variants are DEFERRED and the
 *   report says so, per variant, with the reason. Nothing is skipped silently.
 */

/** The declared default envelope. An engineering default, not a measured or promised coverage. */
export const DEFAULT_SEARCH_PLAN_ENVELOPE: Readonly<SearchPlanEnvelope> = Object.freeze({
  maxRequests: 120,
  maxDurationMs: 120_000,
  maxResults: 1_500,
});

export const LITERAL_QUERY_ID = 'literal';

function squashed(value: string): string {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

/**
 * Providers that spend metered credits. They already run once, on the literal query, within their own
 * configured ceiling; repeating them per title would multiply paid spend, so they never join a pass.
 */
const NOT_REPEATED_PER_VARIANT: Readonly<Partial<Record<DiscoveryProvider, string>>> = {
  theirstack: 'Metered credits are spent once per run, on the literal query; extra titles are matched locally.',
};

/** Providers a variant pass repeats: those with a declared role filter, minus the metered ones. */
const STRUCTURED_PASS = new Set(['freehire', 'job_opportunities', 'jobgether']);
const ADDITIONAL_PASS = new Set(['dice']);
const KEYED_PASS = new Set(['adzuna', 'jooble', 'reed', 'jobspipe']);
const DIRECT_PASS = ['himalayas', 'jobicy', 'ai_dev_jobs', 'phil_jobnet', 'jobtech_sweden'] as const;

export const SEARCH_PLAN_PASS_PROVIDERS: ReadonlySet<DiscoveryProvider> = new Set<DiscoveryProvider>([
  ...(DIRECT_PASS as readonly DiscoveryProvider[]),
  ...(STRUCTURED_PASS as ReadonlySet<DiscoveryProvider>),
  ...(ADDITIONAL_PASS as ReadonlySet<DiscoveryProvider>),
  ...(KEYED_PASS as ReadonlySet<DiscoveryProvider>),
]);

/** Providers whose reviewed capability declares an upstream role filter. */
export function roleFilteredProviders(): DiscoveryProvider[] {
  return (Object.entries(SOURCE_FILTER_CAPABILITIES) as [DiscoveryProvider, (typeof SOURCE_FILTER_CAPABILITIES)[DiscoveryProvider]][])
    .filter(([, capability]) => capability.role !== undefined)
    .map(([provider]) => provider);
}

export interface PlanQuery extends SearchPlanQueryRef {
  order: number;
}

/**
 * The OR set of a run: the literal query first, then the approved titles in the person's order.
 * A title that normalizes to a query already in the set is not asked twice upstream; it stays listed
 * (as `covered_by_earlier_query`) so the plan is reported as the person wrote it.
 */
export function compileSearchPlanQueries(
  literal: string,
  snapshot: SearchPlanSnapshot,
): { queries: PlanQuery[]; covered: (SearchPlanQueryRef & { coveredBy: string })[] } {
  const queries: PlanQuery[] = [];
  const covered: (SearchPlanQueryRef & { coveredBy: string })[] = [];
  const seen = new Map<string, string>();
  const add = (ref: SearchPlanQueryRef) => {
    const key = squashed(ref.query);
    if (!key) return;
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      covered.push({ ...ref, coveredBy: earlier });
      return;
    }
    seen.set(key, ref.variantId);
    queries.push({ ...ref, order: queries.length });
  };
  add({ variantId: LITERAL_QUERY_ID, query: literal.trim(), language: null });
  for (const variant of snapshot.variants) {
    add({ variantId: variant.id, query: variant.title, language: variant.language || null });
  }
  return { queries, covered };
}

const REQUEST_REFUSED_MESSAGE = 'The search plan used all of its shared request allowance.';
const TIME_REFUSED_MESSAGE = 'The search plan used all of its shared time allowance.';

export class SearchPlanBudgetError extends Error {
  public constructor(public readonly kind: 'request' | 'time') {
    super(kind === 'request' ? REQUEST_REFUSED_MESSAGE : TIME_REFUSED_MESSAGE);
    this.name = 'SearchPlanBudgetError';
  }
}

interface PassBudget {
  used: number;
  readonly limit: number;
  readonly deadlineAt: number;
  readonly now: () => number;
  refused: 'request' | 'time' | null;
}

const COUNTED_CALLS = new Set(['get', 'postJson', 'postForm']);

/** Counts every upstream call and refuses new ones once the pass limit or the shared deadline is hit. */
function budgeted(client: AtsHttpClient, budget: PassBudget): AtsHttpClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string' || !COUNTED_CALLS.has(property)) return value;
      return (...args: unknown[]) => {
        if (budget.now() >= budget.deadlineAt) {
          budget.refused ??= 'time';
          throw new SearchPlanBudgetError('time');
        }
        if (budget.used >= budget.limit) {
          budget.refused ??= 'request';
          throw new SearchPlanBudgetError('request');
        }
        budget.used += 1;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** One pass of every role-filtered source for a single title. Same adapters and credential checks as the literal scan. */
async function runRoleFilteredPass(
  http: AtsHttpClient,
  config: GlobalRemoteConfig,
  query: string,
): Promise<DiscoveryRun> {
  const passConfig: GlobalRemoteConfig = {
    ...config,
    discovery: { ...config.discovery, roleQuery: query, himalayasQueries: [query] },
  };
  const runs = await Promise.all([
    discoverHimalayas(http, passConfig),
    discoverJobicy(http, passConfig),
    discoverAiDevJobs(http, passConfig),
    discoverPhilJobNet(http, passConfig),
    runJobtechDiscovery(http, passConfig),
    runStructuredDiscovery(http, passConfig, STRUCTURED_PASS),
    runAdditionalDiscovery(http, passConfig, ADDITIONAL_PASS),
    runKeyedDiscovery(http, passConfig, KEYED_PASS),
  ]);
  return {
    sources: runs.flatMap((run) => run.sources),
    vacancies: runs.flatMap((run) => run.vacancies),
  };
}

function provenanceFor(
  revision: number,
  fetchedBy: LeadQueryProvenance['fetchedBy'],
): LeadQueryProvenance {
  return { planRevision: revision, fetchedBy, matchedLocally: [] };
}

function tagRows(
  vacancies: readonly DiscoveryVacancyAudit[],
  revision: number,
  ref: SearchPlanQueryRef | null,
): DiscoveryVacancyAudit[] {
  return vacancies.map((vacancy) => ({
    ...vacancy,
    queryProvenance: provenanceFor(
      revision,
      ref !== null && SOURCE_FILTER_CAPABILITIES[vacancy.provider].role !== undefined
        ? [{ ...ref, provider: vacancy.provider }]
        : [],
    ),
  }));
}

export interface SearchPlanRunInput {
  http: AtsHttpClient;
  config: GlobalRemoteConfig;
  literal: string;
  snapshot: SearchPlanSnapshot;
  /** The completed literal pass. It is never re-run. */
  literalRun: DiscoveryRun;
  envelope?: Partial<SearchPlanEnvelope>;
  /**
   * When the time allowance starts counting. Defaults to the start of the variant passes: the literal
   * pass is the unchanged scan and runs under its own timeouts, so a long full scan cannot use up the
   * time the approved titles were given.
   */
  startedAt?: number;
  now?: () => number;
  signal?: AbortSignal;
}

export interface SearchPlanRunResult {
  run: DiscoveryRun;
  report: SearchPlanReport;
  /** Source-row id -> the variant that produced it, for the rows added by variant passes. */
  variantRows: Record<string, string>;
}

function sanitizedEnvelope(input: Partial<SearchPlanEnvelope> | undefined): SearchPlanEnvelope {
  const pick = (value: number | undefined, fallback: number) =>
    value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
  return {
    maxRequests: pick(input?.maxRequests, DEFAULT_SEARCH_PLAN_ENVELOPE.maxRequests),
    maxDurationMs: pick(input?.maxDurationMs, DEFAULT_SEARCH_PLAN_ENVELOPE.maxDurationMs),
    maxResults: pick(input?.maxResults, DEFAULT_SEARCH_PLAN_ENVELOPE.maxResults),
  };
}

/**
 * Query-dependent requests the literal pass already spent: only role-filtered sources count. A source
 * that was asked and failed still spent its attempt, so each row counts at least one; real network
 * attempts (retries included) win when they are higher. This errs toward overstating the literal
 * spend, which leaves the variants slightly less, never more, than the envelope.
 */
export function literalQueryDependentRequests(literalRun: DiscoveryRun): number {
  return literalRun.sources
    .filter((source) => SOURCE_FILTER_CAPABILITIES[source.provider].role !== undefined)
    .reduce((sum, source) => sum + Math.max(1, source.requests, source.networkAttempts), 0);
}

const DEFERRED_REASON: Record<'request' | 'time' | 'result', { handling: SearchPlanHandling; reason: string }> = {
  request: {
    handling: 'deferred_request_budget',
    reason: 'The plan used its whole shared request allowance before this title was reached.',
  },
  time: {
    handling: 'deferred_time_budget',
    reason: 'The plan used its whole shared time allowance before this title was reached.',
  },
  result: {
    handling: 'deferred_result_cap',
    reason: 'The plan reached its shared result allowance before this title was reached.',
  },
};

/**
 * A source the shared allowance stopped from asking is not a broken source: it is coverage the plan
 * chose not to spend. It is reported as partial coverage with the reason, not as a failure.
 */
function asPlanCoverage(source: DiscoverySourceAudit): DiscoverySourceAudit {
  const refused = source.error === REQUEST_REFUSED_MESSAGE || source.error === TIME_REFUSED_MESSAGE;
  if (!refused || (source.status !== 'error' && source.status !== 'partial')) return source;
  return {
    ...source,
    status: 'partial',
    complete: false,
    completenessReason: `Not fully asked for this title: ${source.error}`,
  };
}

export async function runSearchPlanVariantPasses(input: SearchPlanRunInput): Promise<SearchPlanRunResult> {
  const now = input.now ?? Date.now;
  const startedAt = input.startedAt ?? now();
  const envelope = sanitizedEnvelope(input.envelope);
  const revision = input.snapshot.revision;
  const { queries, covered } = compileSearchPlanQueries(input.literal, input.snapshot);
  const literalQuery = queries[0];
  const literalRef: SearchPlanQueryRef | null = literalQuery
    ? { variantId: literalQuery.variantId, query: literalQuery.query, language: literalQuery.language }
    : null;
  const literalRequests = literalQueryDependentRequests(input.literalRun);

  const sources: DiscoverySourceAudit[] = [...input.literalRun.sources];
  const vacancies: DiscoveryVacancyAudit[] = tagRows(input.literalRun.vacancies, revision, literalRef);
  const variantRows: Record<string, string> = {};
  const results: SearchPlanReport['variants'] = [];

  let variantRequests = 0;
  let addedRows = 0;
  let stop: 'request' | 'time' | 'result' | null = null;
  const variants = queries.slice(1);
  const deadlineAt = startedAt + envelope.maxDurationMs;

  for (const [index, query] of variants.entries()) {
    const ref: SearchPlanQueryRef = { variantId: query.variantId, query: query.query, language: query.language };
    const remaining = envelope.maxRequests - literalRequests - variantRequests;
    if (stop === null) {
      if (input.signal?.aborted) stop = 'time';
      else if (now() >= deadlineAt) stop = 'time';
      else if (remaining <= 0) stop = 'request';
      else if (addedRows >= envelope.maxResults) stop = 'result';
    }
    if (stop !== null) {
      results.push({ ...ref, ...DEFERRED_REASON[stop], requests: 0, providersQueried: [] });
      continue;
    }

    const variantsLeft = variants.length - index;
    const budget: PassBudget = {
      used: 0,
      limit: Math.max(1, Math.floor(remaining / variantsLeft)),
      deadlineAt,
      now,
      refused: null,
    };
    const pass = await runRoleFilteredPass(budgeted(input.http, budget), input.config, query.query);
    variantRequests += budget.used;

    const room = Math.max(0, envelope.maxResults - addedRows);
    const trimmed = pass.vacancies.length > room;
    const kept = trimmed ? pass.vacancies.slice(0, room) : pass.vacancies;
    addedRows += kept.length;
    vacancies.push(...tagRows(kept, revision, ref));
    for (const source of pass.sources) {
      const id = `${source.id}::plan:${query.variantId}`;
      variantRows[id] = query.variantId;
      sources.push({ ...asPlanCoverage(source), id });
    }

    const providersQueried = [...new Set(pass.sources.map((source) => source.provider))];
    const refusal = budget.refused ?? (trimmed ? 'result' : null);
    results.push({
      ...ref,
      handling: refusal === null ? 'sent_upstream' : 'partial',
      reason:
        refusal === null
          ? null
          : refusal === 'result'
            ? 'Some rows were left out because the plan reached its shared result allowance.'
            : refusal === 'time'
              ? 'Some sources were not asked because the plan used its shared time allowance.'
              : 'Some sources were not asked because this title used its fair share of the shared request allowance.',
      requests: budget.used,
      providersQueried,
    });
    if (trimmed) stop = 'result';
  }

  const variantResults: SearchPlanReport['variants'] = [
    ...results,
    ...covered.map((entry) => ({
      variantId: entry.variantId,
      query: entry.query,
      language: entry.language,
      handling: 'covered_by_earlier_query' as const,
      reason: `Same words as the earlier query "${entry.coveredBy}", so it was not asked twice.`,
      requests: 0,
      providersQueried: [],
    })),
  ];
  const incomplete = variantResults.filter(
    (entry) => entry.handling !== 'sent_upstream' && entry.handling !== 'covered_by_earlier_query',
  );
  const report: SearchPlanReport = {
    planRevision: revision,
    primaryFunction: input.snapshot.primaryFunction,
    markets: [...input.snapshot.markets],
    workingLanguages: [...input.snapshot.workingLanguages],
    queries: queries.map(({ variantId, query, language }) => ({ variantId, query, language })),
    variants: variantResults,
    envelope,
    usage: { literalRequests, variantRequests, elapsedMs: Math.max(0, now() - startedAt), variantRows: addedRows },
    coverage: incomplete.length === 0 ? 'complete' : 'partial',
    coverageReason:
      incomplete.length === 0
        ? null
        : `${incomplete.length} of ${variantResults.length} approved ${variantResults.length === 1 ? 'title was' : 'titles were'} not fully searched upstream within the shared allowance; matching them locally against the rows that were fetched.`,
  };
  return { run: { sources, vacancies }, report, variantRows };
}

/** What one source row did with each query of the plan, for the per-source audit. */
export function searchPlanHandlingForSource(
  source: Pick<DiscoverySourceAudit, 'id' | 'provider'>,
  report: SearchPlanReport,
  variantRows: Readonly<Record<string, string>>,
): SearchPlanSourceHandling[] {
  const ownVariant = variantRows[source.id];
  const hasRoleFilter = SOURCE_FILTER_CAPABILITIES[source.provider].role !== undefined;
  const localOnly = (query: SearchPlanQueryRef): SearchPlanSourceHandling => ({
    ...query,
    handling: 'local_only',
    reason: hasRoleFilter
      ? (NOT_REPEATED_PER_VARIANT[source.provider] ?? 'Not repeated for this title.')
      : source.provider === 'ai_web_search'
        ? 'The AI web search is given the typed query only, as wording; the shared filter matches the approved titles locally.'
        : 'This source declares no role filter: it returns one feed whatever the title, and the shared filter matches the title locally.',
  });
  if (ownVariant !== undefined) {
    const own = report.variants.find((entry) => entry.variantId === ownVariant);
    return own ? [{ variantId: own.variantId, query: own.query, language: own.language, handling: 'sent_upstream', reason: null }] : [];
  }
  return report.queries.map((query) => {
    if (!hasRoleFilter || NOT_REPEATED_PER_VARIANT[source.provider] !== undefined) {
      return query.variantId === LITERAL_QUERY_ID && hasRoleFilter
        ? { ...query, handling: 'sent_upstream' as const, reason: null }
        : localOnly(query);
    }
    if (query.variantId === LITERAL_QUERY_ID) return { ...query, handling: 'sent_upstream' as const, reason: null };
    const variant = report.variants.find((entry) => entry.variantId === query.variantId);
    if (!variant || variant.handling === 'sent_upstream') {
      return { ...query, handling: 'sent_upstream' as const, reason: null };
    }
    return { ...query, handling: variant.handling, reason: variant.reason };
  });
}

/**
 * Fills each retained lead's `matchedLocally` with every query of the OR set the shared filter finds in
 * its text. Run after the filter, so what a lead says about its origin is what the filter decided.
 */
export function finalizeLeadProvenance(
  vacancies: readonly DiscoveryVacancyAudit[],
  report: Pick<SearchPlanReport, 'planRevision' | 'queries'>,
): DiscoveryVacancyAudit[] {
  return vacancies.map((vacancy) => ({
    ...vacancy,
    queryProvenance: {
      planRevision: report.planRevision,
      fetchedBy: vacancy.queryProvenance?.fetchedBy ?? [],
      matchedLocally: report.queries
        .filter((query) => vacancyMatchesRole(vacancy, query.query))
        .map(({ variantId, query, language }) => ({ variantId, query, language })),
    },
  }));
}

/** Union of the provenance of rows merged into one requisition: every query that found it is kept. */
export function mergeQueryProvenance(
  provenances: readonly (LeadQueryProvenance | undefined)[],
): LeadQueryProvenance | undefined {
  const present = provenances.filter((entry): entry is LeadQueryProvenance => entry !== undefined);
  if (present.length === 0) return undefined;
  const fetchedBy = new Map<string, LeadQueryProvenance['fetchedBy'][number]>();
  for (const entry of present) {
    for (const origin of entry.fetchedBy) fetchedBy.set(`${origin.variantId}::${origin.provider}`, origin);
  }
  return { planRevision: present[0]!.planRevision, fetchedBy: [...fetchedBy.values()], matchedLocally: [] };
}
