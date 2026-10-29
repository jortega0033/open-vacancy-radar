import type { AtsHttpClient } from '../ats/http.js';
import type { SearchPlanSnapshot } from '../candidate/search-plan.js';
import { discoverAiDevJobs } from './ai-dev-jobs-discovery.js';
import { runAdditionalDiscovery } from './additional-discovery.js';
import { discoverHimalayas, discoverJobicy } from './discovery.js';
import { planQueryMatchField, SOURCE_FILTER_CAPABILITIES, vacancyMatchesRole, vacancyTitleMatches } from './focused-scan.js';
import { runJobtechDiscovery } from './jobtech-discovery.js';
import { runKeyedDiscovery } from './keyed-discovery.js';
import type {
  DiscoveryProvider,
  DiscoveryRun,
  DiscoverySourceAudit,
  DiscoveryVacancyAudit,
  GlobalRemoteConfig,
  LeadQueryProvenance,
  SearchPlanCriterionTreatment,
  SearchPlanEnvelope,
  SearchPlanHandling,
  SearchPlanQueryRef,
  SearchPlanReport,
  SearchPlanSourceHandling,
  SearchPlanVariantResult,
} from './models.js';
import { discoverPhilJobNet } from './phil-jobnet-discovery.js';
import { isSearchPlanRefusalMessage, SearchPlanLedger, type SearchPlanPass, type SearchPlanRefusal } from './search-plan-ledger.js';
import { runStructuredDiscovery } from './structured-discovery.js';

/**
 * Issue #686 -- run a reviewed search plan: the literal query the person typed plus their approved
 * equivalent titles, inside ONE declared envelope.
 *
 * - One `SearchPlanLedger` (see `search-plan-ledger.ts`) holds one request counter, one deadline and
 *   one result count for the whole plan. Its unit is a physical network attempt, charged at the real
 *   transport boundary BEFORE the attempt is made, for the literal pass (every title-search source,
 *   every fixed feed, the ATS roster) and for every variant pass alike.
 * - Variant passes repeat only the sources that take a role query upstream; a feed with no role filter
 *   returns the same rows whatever the title, so its single literal fetch is matched locally instead.
 * - Each title gets a fair share of what is left; inside a pass every source that answered the literal
 *   pass gets an equal share, with the remainder rotated per title so a tight allowance does not always
 *   serve the same first source.
 * - Whatever the allowance stops is reported where it happened: per source row (sent, partly sent,
 *   deferred, not sent), per title and for the plan, with the reason. Nothing is skipped silently.
 */

/**
 * The declared default envelope for the WHOLE plan, literal pass included. An engineering default, not a
 * measured or promised coverage: 1000 physical attempts leaves room for a focused literal scan (ATS
 * roster batch of up to 200 tenants plus every title source and feed, with retries) and the titles;
 * 15 minutes equals the longest per-source ceiling the scan already has (Workable's bulk snapshot), so
 * a plan never makes a run outlast what a run could already take; 5000 matching rows equals the
 * browse-all result cap.
 */
export const DEFAULT_SEARCH_PLAN_ENVELOPE: Readonly<SearchPlanEnvelope> = Object.freeze({
  maxRequests: 1_000,
  maxDurationMs: 15 * 60_000,
  maxResults: 5_000,
});

export const SEARCH_PLAN_BUDGET_SCOPE: SearchPlanReport['budgetScope'] = Object.freeze({
  unit: 'network_attempt' as const,
  includes:
    'Every physical network attempt (first attempts, retries and redirect hops) of the literal pass -- every title-search source, every fixed feed and the ATS roster -- and of every approved-title pass, under one deadline that starts with the literal pass.',
  excludes:
    'Work that is identical with or without a plan and has its own documented ceilings: the Workable and MPSV bulk snapshots, official employer checks, sponsor-registry lookups and per-lead detail fetches. Their attempts are reported, not charged.',
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

type PassTask = (http: AtsHttpClient, config: GlobalRemoteConfig) => Promise<DiscoveryRun>;

/**
 * Providers a variant pass repeats -- those with a declared role filter, minus the metered ones -- in a
 * fixed order. Each is called on its own client so the ledger can give each a fair share.
 */
const PASS_TASKS: readonly (readonly [DiscoveryProvider, PassTask])[] = [
  ['himalayas', discoverHimalayas],
  ['jobicy', discoverJobicy],
  ['ai_dev_jobs', discoverAiDevJobs],
  ['phil_jobnet', discoverPhilJobNet],
  ['jobtech_sweden', runJobtechDiscovery],
  ['freehire', (http, config) => runStructuredDiscovery(http, config, new Set(['freehire']))],
  ['job_opportunities', (http, config) => runStructuredDiscovery(http, config, new Set(['job_opportunities']))],
  ['jobgether', (http, config) => runStructuredDiscovery(http, config, new Set(['jobgether']))],
  ['dice', (http, config) => runAdditionalDiscovery(http, config, new Set(['dice']))],
  ['adzuna', (http, config) => runKeyedDiscovery(http, config, new Set(['adzuna']))],
  ['jooble', (http, config) => runKeyedDiscovery(http, config, new Set(['jooble']))],
  ['reed', (http, config) => runKeyedDiscovery(http, config, new Set(['reed']))],
  ['jobspipe', (http, config) => runKeyedDiscovery(http, config, new Set(['jobspipe']))],
];

export const SEARCH_PLAN_PASS_PROVIDERS: ReadonlySet<DiscoveryProvider> = new Set<DiscoveryProvider>(
  PASS_TASKS.map(([provider]) => provider),
);

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
    seen.set(key, ref.query);
    queries.push({ ...ref, order: queries.length });
  };
  add({ variantId: LITERAL_QUERY_ID, query: literal.trim(), language: null });
  for (const variant of snapshot.variants) {
    add({ variantId: variant.id, query: variant.title, language: variant.language || null });
  }
  return { queries, covered };
}

function provenanceFor(revision: number, fetchedBy: LeadQueryProvenance['fetchedBy']): LeadQueryProvenance {
  return { planRevision: revision, fetchedBy, matchedLocally: [] };
}

function tagRows(
  vacancies: readonly DiscoveryVacancyAudit[],
  revision: number,
  ref: SearchPlanQueryRef,
): DiscoveryVacancyAudit[] {
  return vacancies.map((vacancy) => ({
    ...vacancy,
    queryProvenance: provenanceFor(
      revision,
      SOURCE_FILTER_CAPABILITIES[vacancy.provider].role !== undefined ? [{ ...ref, provider: vacancy.provider }] : [],
    ),
  }));
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

/** A row matches the plan's OR set: the typed query by its long-standing rule, a title by the title. */
function matchesPlan(vacancy: DiscoveryVacancyAudit, queries: readonly PlanQuery[]): boolean {
  return queries.some((query) =>
    query.variantId === LITERAL_QUERY_ID ? vacancyMatchesRole(vacancy, query.query) : vacancyTitleMatches(vacancy, query.query),
  );
}

/**
 * The shared result allowance: rows that match the plan's OR set are counted, across every pass, and
 * those beyond the allowance are left out. Rows that match nothing are dropped by the shared filter
 * anyway, so they are neither counted nor trimmed here.
 */
function withinResultAllowance(
  vacancies: readonly DiscoveryVacancyAudit[],
  queries: readonly PlanQuery[],
  ledger: SearchPlanLedger,
): { kept: DiscoveryVacancyAudit[]; trimmed: number } {
  const kept: DiscoveryVacancyAudit[] = [];
  let trimmed = 0;
  for (const vacancy of vacancies) {
    if (!matchesPlan(vacancy, queries)) {
      kept.push(vacancy);
      continue;
    }
    if (ledger.remainingResults() <= 0) {
      trimmed += 1;
      continue;
    }
    ledger.matchingRows += 1;
    kept.push(vacancy);
  }
  ledger.trimmedRows += trimmed;
  return { kept, trimmed };
}

const REFUSAL_WORDS: Record<SearchPlanRefusal, string> = {
  request: 'the shared request allowance was used up',
  time: 'the shared time allowance was used up',
};

const DEFERRED: Record<SearchPlanRefusal | 'result', { handling: SearchPlanHandling; reason: string }> = {
  request: {
    handling: 'deferred_request_budget',
    reason: 'Not searched at the sources: the plan had used its whole shared request allowance before this title was reached.',
  },
  time: {
    handling: 'deferred_time_budget',
    reason: 'Not searched at the sources: the plan had used its whole shared time allowance before this title was reached.',
  },
  result: {
    handling: 'deferred_result_cap',
    reason: 'Not searched at the sources: the plan had reached its shared result allowance before this title was reached.',
  },
};

function admissionOf(source: DiscoverySourceAudit) {
  return source.searchPlanAdmission ?? { sentCalls: 0, refusedCalls: 0, refusedFollowUps: 0, refusal: null };
}

/**
 * Makes a planned run's source row say only what really happened: a call the plan refused before any
 * network contact is not a request, and a row the plan stopped is coverage it did not spend, not a
 * broken source.
 */
function truthfulRow(source: DiscoverySourceAudit): DiscoverySourceAudit {
  const admission = source.searchPlanAdmission;
  const sent = admission?.sentCalls ?? 0;
  // Every call of a planned run passes the ledger; a row with no record and no attempt sent nothing.
  const requests = admission !== undefined || source.networkAttempts === 0 ? Math.min(source.requests, sent) : source.requests;
  const refusedOnly = isSearchPlanRefusalMessage(source.error);
  if (!refusedOnly) return requests === source.requests ? source : { ...source, requests };
  return {
    ...source,
    requests,
    status: 'partial',
    complete: false,
    completenessReason: sent > 0 ? `Only partly asked: ${source.error}` : source.error,
  };
}

function outcomeOf(source: DiscoverySourceAudit): { handling: SearchPlanHandling; reason: string | null } {
  const admission = admissionOf(source);
  const refused = admission.refusedCalls + admission.refusedFollowUps;
  const refusal = admission.refusal ?? 'request';
  if (admission.sentCalls > 0 && refused === 0) return { handling: 'sent_upstream', reason: null };
  if (admission.sentCalls > 0) {
    return { handling: 'partial', reason: `Only partly searched at this source: ${REFUSAL_WORDS[refusal]}.` };
  }
  if (refused > 0) return { handling: DEFERRED[refusal].handling, reason: `Not asked at this source: ${REFUSAL_WORDS[refusal]}.` };
  return {
    handling: 'not_sent',
    reason: source.error
      ? `No request reached this source for this query: ${source.error}`
      : 'No request reached this source for this query in this run (not configured, disabled or skipped).',
  };
}

export interface SearchPlanRunInput {
  /** The scan's admission-bound transport (`SafeHttpClient` wired with `admitSearchPlanAttempt`). */
  http: AtsHttpClient;
  config: GlobalRemoteConfig;
  literal: string;
  snapshot: SearchPlanSnapshot;
  envelope?: Partial<SearchPlanEnvelope>;
  now?: () => number;
  signal?: AbortSignal;
  /**
   * Runs the unchanged literal pass with the plan-charged client it is given. `requestsWereRefused`
   * tells it whether the shared allowance refused anything (a refusal says nothing about a source).
   */
  runLiteral(http: AtsHttpClient, plan: { requestsWereRefused(): boolean }): Promise<DiscoveryRun>;
}

export interface SearchPlanRunResult {
  run: DiscoveryRun;
  report: SearchPlanReport;
  /** Source-row id -> the variant that produced it, for the rows added by variant passes. */
  variantRows: Record<string, string>;
  /** The approved titles, as frozen in the snapshot (for the approved-title classification, #686). */
  approvedTitles: readonly string[];
  minimumAnnualBaseUsd: number | null;
}

function rotated<T>(values: readonly T[], by: number): T[] {
  if (values.length === 0) return [];
  const shift = by % values.length;
  return [...values.slice(shift), ...values.slice(0, shift)];
}

async function runRoleFilteredPass(
  ledger: SearchPlanLedger,
  http: AtsHttpClient,
  pass: SearchPlanPass,
  config: GlobalRemoteConfig,
  query: string,
): Promise<DiscoveryRun> {
  const passConfig: GlobalRemoteConfig = {
    ...config,
    discovery: { ...config.discovery, roleQuery: query, himalayasQueries: [query] },
  };
  const runs = await Promise.all(
    PASS_TASKS.map(([provider, task]) =>
      task(ledger.client(http, pass, provider), passConfig).finally(() => ledger.finishProvider(pass, provider)),
    ),
  );
  return { sources: runs.flatMap((run) => run.sources), vacancies: runs.flatMap((run) => run.vacancies) };
}

/** What the run did with each plan field that is not a title: said, never silently ignored. */
export function searchPlanCriteria(snapshot: Pick<SearchPlanSnapshot, 'markets' | 'primaryFunction' | 'workingLanguages'>): SearchPlanCriterionTreatment[] {
  return [
    ...(snapshot.primaryFunction
      ? [{
          criterion: 'primary_function' as const,
          value: snapshot.primaryFunction,
          treatment: 'not_applied' as const,
          reason: 'The primary function names the plan; only the approved titles are searched and matched.',
        }]
      : []),
    ...snapshot.markets.map((market) => ({
      criterion: 'markets' as const,
      value: market,
      treatment: 'not_applied' as const,
      reason:
        'Plan markets are kept with the plan but do not filter searches. Set Country on the Search page to narrow a search; an explicit Country is always sent to sources that support it and applied locally.',
    })),
    ...snapshot.workingLanguages.map((language) => ({
      criterion: 'working_language' as const,
      value: language,
      treatment: 'title_text_only' as const,
      reason:
        'Titles in this language are searched as written. No source filters by language, and the language an advert is written in is never treated as a requirement.',
    })),
  ];
}

/** The same treatment as seen by one source, with that source's own capability stated. */
export function searchPlanCriteriaForSource(
  provider: DiscoveryProvider,
  criteria: readonly SearchPlanCriterionTreatment[],
): SearchPlanCriterionTreatment[] {
  const capability = SOURCE_FILTER_CAPABILITIES[provider];
  return criteria.map((entry) => {
    if (entry.criterion === 'markets') {
      return {
        ...entry,
        reason:
          capability.country !== undefined
            ? `Not applied: this source can filter by country (${capability.country.parameter}), but plan markets are not sent. Use the Country filter to narrow a search.`
            : 'Not applied: this source declares no country filter, and plan markets are not applied locally. Use the Country filter to narrow a search.',
      };
    }
    if (entry.criterion === 'working_language') {
      return {
        ...entry,
        reason:
          capability.role !== undefined
            ? 'This source declares no language filter; titles in this language are sent as written.'
            : 'This source declares no language or role filter; titles in this language are matched locally as written.',
      };
    }
    return { ...entry, reason: 'Not sent to this source; only the approved titles are searched.' };
  });
}

/**
 * Runs the whole plan -- literal pass and approved titles -- inside one ledger. The literal pass is the
 * unchanged scan, run through the plan-charged client it is handed; the titles share what it leaves.
 */
export async function runSearchPlan(input: SearchPlanRunInput): Promise<SearchPlanRunResult> {
  const envelope = sanitizedEnvelope(input.envelope);
  const ledger = new SearchPlanLedger(envelope, input.now ? { now: input.now } : {});
  try {
    return await runInLedger(input, ledger, envelope);
  } finally {
    ledger.dispose();
  }
}

async function runInLedger(
  input: SearchPlanRunInput,
  ledger: SearchPlanLedger,
  envelope: SearchPlanEnvelope,
): Promise<SearchPlanRunResult> {
  const revision = input.snapshot.revision;
  const { queries, covered } = compileSearchPlanQueries(input.literal, input.snapshot);
  const literalQuery = queries[0] ?? { variantId: LITERAL_QUERY_ID, query: input.literal.trim(), language: null, order: 0 };
  const literalRef: SearchPlanQueryRef = { variantId: literalQuery.variantId, query: literalQuery.query, language: literalQuery.language };

  const literalRun = await input.runLiteral(ledger.client(input.http, ledger.literalPass(), null), {
    requestsWereRefused: () => ledger.refusedCalls + ledger.refusedFollowUps > 0,
  });
  const literalRows = literalRun.sources.map(truthfulRow);
  const literalKept = withinResultAllowance(literalRun.vacancies, queries, ledger);

  const sources: DiscoverySourceAudit[] = [...literalRows];
  const vacancies: DiscoveryVacancyAudit[] = tagRows(literalKept.kept, revision, literalRef);
  const variantRows: Record<string, string> = {};
  const results: SearchPlanVariantResult[] = [];

  // Sources that really answered the literal pass are the ones a title can be sent to; each gets a share.
  const eligible = PASS_TASKS.map(([provider]) => provider).filter((provider) =>
    literalRows.some((row) => row.provider === provider && admissionOf(row).sentCalls > 0),
  );
  const askedForAnyTitle = new Set<DiscoveryProvider>();
  let stop: SearchPlanRefusal | 'result' | null = literalKept.trimmed > 0 ? 'result' : null;
  const variants = queries.slice(1);

  for (const [index, query] of variants.entries()) {
    const ref: SearchPlanQueryRef = { variantId: query.variantId, query: query.query, language: query.language };
    if (stop === null) {
      if (input.signal?.aborted || ledger.timeExhausted()) stop = 'time';
      else if (ledger.remainingRequests() <= 0) stop = 'request';
      else if (ledger.remainingResults() <= 0) stop = 'result';
    }
    if (stop !== null) {
      results.push({ ...ref, ...DEFERRED[stop], attempts: 0, providersQueried: [], providersNotAsked: [...eligible] });
      continue;
    }

    const share = Math.max(1, Math.floor(ledger.remainingRequests() / (variants.length - index)));
    const pass = ledger.variantPass(query.variantId, share, rotated(eligible, index));
    const passRun = await runRoleFilteredPass(ledger, input.http, pass, input.config, query.query);
    const passRows = passRun.sources.map(truthfulRow);
    const kept = withinResultAllowance(passRun.vacancies, queries, ledger);
    vacancies.push(...tagRows(kept.kept, revision, ref));
    for (const source of passRows) {
      const id = `${source.id}::plan:${query.variantId}`;
      variantRows[id] = query.variantId;
      sources.push({ ...source, id });
    }

    const providersQueried = [...new Set(passRows.filter((row) => admissionOf(row).sentCalls > 0).map((row) => row.provider))];
    for (const provider of providersQueried) askedForAnyTitle.add(provider);
    const providersNotAsked = eligible.filter((provider) => !providersQueried.includes(provider));
    const refusal = pass.refused;
    let handling: SearchPlanHandling = 'sent_upstream';
    let reason: string | null = null;
    if (providersQueried.length === 0 && refusal !== null) {
      ({ handling, reason } = DEFERRED[refusal]);
    } else if (refusal !== null || kept.trimmed > 0) {
      handling = 'partial';
      const parts = [
        ...(refusal !== null
          ? [`${providersNotAsked.length > 0 ? `not asked at ${providersNotAsked.length} of ${eligible.length} sources` : 'some requests were not made'} because ${REFUSAL_WORDS[refusal]}`]
          : []),
        ...(kept.trimmed > 0 ? [`${kept.trimmed} matching rows were left out by the shared result allowance`] : []),
      ];
      reason = `Only partly searched: ${parts.join('; ')}.`;
    }
    results.push({ ...ref, handling, reason, attempts: pass.used, providersQueried, providersNotAsked });
    if (kept.trimmed > 0) stop = 'result';
  }

  const literalProvidersQueried = [...new Set(literalRows.filter((row) => admissionOf(row).sentCalls > 0).map((row) => row.provider))];
  const literalNotAsked = [
    ...new Set(
      literalRows
        .filter((row) => admissionOf(row).sentCalls === 0 && admissionOf(row).refusedCalls > 0)
        .map((row) => row.provider),
    ),
  ];
  const literalRefused = literalRows.some((row) => admissionOf(row).refusedCalls + admissionOf(row).refusedFollowUps > 0);
  const literalRefusal = literalRows.map((row) => admissionOf(row).refusal).find((value) => value !== null) ?? null;
  const literalParts = [
    ...(literalRefused ? [`some sources were not fully asked because ${REFUSAL_WORDS[literalRefusal ?? 'request']}`] : []),
    ...(literalKept.trimmed > 0 ? [`${literalKept.trimmed} matching rows were left out by the shared result allowance`] : []),
  ];
  const literal: SearchPlanReport['literal'] = {
    handling: literalParts.length === 0 ? 'sent_upstream' : 'partial',
    reason: literalParts.length === 0 ? null : `The typed query was only partly searched: ${literalParts.join('; ')}.`,
    attempts: ledger.literalAttempts,
    providersQueried: literalProvidersQueried,
    providersNotAsked: literalNotAsked,
  };

  const variantResults: SearchPlanVariantResult[] = [
    ...results,
    ...covered.map((entry) => ({
      variantId: entry.variantId,
      query: entry.query,
      language: entry.language,
      handling: 'covered_by_earlier_query' as const,
      reason: `Same words as the earlier query "${entry.coveredBy}", so it was not asked twice.`,
      attempts: 0,
      providersQueried: [],
      providersNotAsked: [],
    })),
  ];
  const incomplete = variantResults.filter(
    (entry) => entry.handling !== 'sent_upstream' && entry.handling !== 'covered_by_earlier_query',
  );
  const coverageParts = [
    ...(literal.handling === 'partial' ? ['the typed query was only partly searched'] : []),
    ...(incomplete.length > 0
      ? [
          `${incomplete.length} of ${variantResults.length} approved ${variantResults.length === 1 ? 'title was' : 'titles were'} not fully searched at the sources`,
        ]
      : []),
  ];
  const providersNeverAsked = variantResults.some((entry) => entry.handling !== 'covered_by_earlier_query')
    ? eligible.filter((provider) => !askedForAnyTitle.has(provider))
    : [];
  const report: SearchPlanReport = {
    planRevision: revision,
    primaryFunction: input.snapshot.primaryFunction,
    markets: [...input.snapshot.markets],
    workingLanguages: [...input.snapshot.workingLanguages],
    queries: queries.map(({ variantId, query, language }) => ({ variantId, query, language })),
    literal,
    variants: variantResults,
    envelope,
    budgetScope: { ...SEARCH_PLAN_BUDGET_SCOPE },
    usage: {
      attempts: ledger.attempts,
      literalAttempts: ledger.literalAttempts,
      variantAttempts: ledger.variantAttempts,
      refusedCalls: ledger.refusedCalls,
      refusedFollowUps: ledger.refusedFollowUps,
      elapsedMs: ledger.elapsedMs(),
      matchingRows: ledger.matchingRows,
      trimmedRows: ledger.trimmedRows,
      outsideEnvelopeAttempts: 0,
    },
    criteria: searchPlanCriteria(input.snapshot),
    providersNeverAsked,
    coverage: coverageParts.length === 0 ? 'complete' : 'partial',
    coverageReason:
      coverageParts.length === 0
        ? null
        : `${coverageParts.join('; ')} within the shared allowance. Every approved title is still matched locally against the rows that were fetched.`,
  };
  return {
    run: { sources, vacancies },
    report,
    variantRows,
    approvedTitles: input.snapshot.variants.map((variant) => variant.title),
    minimumAnnualBaseUsd: input.config.minimumAnnualBaseUsd,
  };
}

/** Discovery sources a planned run still runs once, outside the plan's envelope (`SEARCH_PLAN_BUDGET_SCOPE`). */
export const OUTSIDE_ENVELOPE_PROVIDERS: ReadonlySet<DiscoveryProvider> = new Set<DiscoveryProvider>(['workable_global', 'mpsv_cz']);

const AI_LOCAL_REASON = 'The AI web search is given the typed query only, as wording; the shared filter matches the approved titles locally.';
const FEED_LOCAL_REASON = 'This source declares no role filter: it returns one feed whatever the title, and the shared filter matches each title locally.';

/**
 * What one source row did with the plan's queries, from what really happened on that row. A row only
 * speaks for itself: a title's pass row reports that title; a literal-pass row reports the typed query,
 * and -- when it is a feed matched locally or a metered source that is not repeated -- the titles it
 * could only match locally. Rows outside the plan's envelope say so.
 */
export function searchPlanHandlingForSource(
  source: Pick<DiscoverySourceAudit, 'id' | 'provider' | 'error' | 'status' | 'networkAttempts' | 'searchPlanAdmission'>,
  report: SearchPlanReport,
  variantRows: Readonly<Record<string, string>>,
): SearchPlanSourceHandling[] {
  const ownVariant = variantRows[source.id];
  if (ownVariant !== undefined) {
    const own = report.queries.find((entry) => entry.variantId === ownVariant);
    return own ? [{ ...own, ...outcomeOf(source as DiscoverySourceAudit) }] : [];
  }
  const capability = SOURCE_FILTER_CAPABILITIES[source.provider];
  const literal = report.queries[0];
  const titles = report.queries.slice(1);
  if (source.provider === 'ai_web_search' || OUTSIDE_ENVELOPE_PROVIDERS.has(source.provider)) {
    // Not charged to the plan: the AI branch, or bulk snapshots outside the envelope.
    const fetched = source.status !== 'error' && source.status !== 'blocked';
    const reason = source.provider === 'ai_web_search'
      ? AI_LOCAL_REASON
      : `${FEED_LOCAL_REASON} Fetched outside the plan's allowance (see the plan's budget scope).`;
    return report.queries.map((query) =>
      fetched
        ? { ...query, handling: 'local_only' as const, reason }
        : { ...query, handling: 'not_sent' as const, reason: `This source returned no rows to match: ${source.error ?? source.status}.` },
    );
  }
  const outcome = outcomeOf(source as DiscoverySourceAudit);
  const fetched = admissionOf(source as DiscoverySourceAudit).sentCalls > 0;
  const metered = NOT_REPEATED_PER_VARIANT[source.provider];
  if (capability.role !== undefined) {
    const literalEntry = literal ? [{ ...literal, ...outcome }] : [];
    if (metered === undefined) return literalEntry;
    return [
      ...literalEntry,
      ...titles.map((query) =>
        fetched
          ? { ...query, handling: 'local_only' as const, reason: metered }
          : { ...query, handling: outcome.handling, reason: `Not matched here: this source was not asked. ${outcome.reason ?? ''}`.trim() },
      ),
    ];
  }
  return report.queries.map((query) =>
    fetched
      ? {
          ...query,
          handling: 'local_only' as const,
          reason: outcome.handling === 'partial' ? `${FEED_LOCAL_REASON} ${outcome.reason ?? ''}`.trim() : FEED_LOCAL_REASON,
        }
      : { ...query, handling: outcome.handling, reason: `The feed was not fetched, so nothing could be matched here. ${outcome.reason ?? ''}`.trim() },
  );
}

/**
 * Fills each retained lead's `matchedLocally` with every query of the OR set the shared filter finds in
 * it, and where (title or, for the typed query only, description). Run after the filter, so what a lead
 * says about its origin is what the filter decided.
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
      matchedLocally: report.queries.flatMap(({ variantId, query, language }) => {
        const field = planQueryMatchField(vacancy, query, variantId === LITERAL_QUERY_ID);
        return field === null ? [] : [{ variantId, query, language, field }];
      }),
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
