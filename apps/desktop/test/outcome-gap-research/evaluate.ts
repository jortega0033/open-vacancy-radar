import { CONTRACT_VERSION, GATES, deepFreeze, type JobObservation } from './contract.js';
import { AS_OF, PORTFOLIOS, RICH_EXPOSURE, manualSurfaces, richObservations, type Expected, type Portfolio } from './fixtures.js';
import { buildFunnel, cellLabelsOf, sentApplicationsOf, type FunnelView } from './funnel.js';
import { buildRequirements, laneOf, type RequirementsView } from './requirements.js';
import { buildSuggestions, dismiss, partition, EMPTY_REVIEW_STATE, type SuggestionSet } from './suggestions.js';

/**
 * The reproducible evaluation. Pure and deterministic: fixed clock, no randomness, no I/O. `docs/research/
 * outcome-gap/693-evaluation.json` is this object (plus the real-database lane the test adds), and a test fails
 * if the committed file differs from a fresh run.
 *
 * What each part is, so nothing is mistaken for something stronger:
 *   - portfolios        EXECUTED: the prototype run on constructed inputs against author-declared expectations.
 *   - invariances       EXECUTED: properties that must hold when something that must not matter is changed.
 *   - baselines         EXECUTED but CONSTRUCTED: four simpler rules scored on the same inputs to show what the
 *                       distinctions prevent. They are not shipped behaviour and not a competitor product.
 *   - deskComparison    SOURCE READING for the manual side (file citations); EXECUTED for the prototype side;
 *                       counted operations only. No human did anything, no time was measured.
 */

interface Run {
  funnels: { source: FunnelView; queryVariant: FunnelView; roleFamily: FunnelView };
  requirements: RequirementsView;
  suggestions: SuggestionSet;
}

function selectedAtByJob(observations: readonly JobObservation[]): Record<string, string | null> {
  return Object.fromEntries(observations.map((observation) => [observation.id, observation.selectedAt]));
}

export function run(observations: readonly JobObservation[], options: { exposure?: Record<string, number> | null; aliasGroups?: Portfolio['aliasGroups'] } = {}): Run {
  const funnels = {
    source: buildFunnel(observations, { dimension: 'source', asOf: AS_OF }),
    queryVariant: buildFunnel(observations, { dimension: 'queryVariant', asOf: AS_OF, exposure: options.exposure ?? null }),
    roleFamily: buildFunnel(observations, { dimension: 'roleFamily', asOf: AS_OF }),
  };
  const requirements = buildRequirements(observations, options.aliasGroups ? { aliasGroups: options.aliasGroups } : {});
  const suggestions = buildSuggestions({ asOf: AS_OF, requirements, variantFunnel: funnels.queryVariant, selectedAtByJob: selectedAtByJob(observations) });
  return { funnels, requirements, suggestions };
}

const suggestionKeys = (set: SuggestionSet): string[] => set.suggestions.map((suggestion) => `${suggestion.kind}:${suggestion.subject}`).sort();

function compare(label: string, observed: { funnelOutcome: string; funnelReasons: string[]; requirements: string; requirementReasons: string[]; suggestions: string[] }, expected: Expected): { label: string; mismatches: string[] } {
  const mismatches: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (observed.funnelOutcome !== expected.funnelOutcome) mismatches.push(`funnel outcome verdict ${observed.funnelOutcome} != ${expected.funnelOutcome}`);
  if (!same([...observed.funnelReasons].sort(), [...expected.funnelOutcomeReasons].sort())) mismatches.push(`funnel reasons ${JSON.stringify(observed.funnelReasons)} != ${JSON.stringify(expected.funnelOutcomeReasons)}`);
  if (observed.requirements !== expected.requirements) mismatches.push(`requirements verdict ${observed.requirements} != ${expected.requirements}`);
  if (!same([...observed.requirementReasons].sort(), [...expected.requirementReasons].sort())) mismatches.push(`requirement reasons ${JSON.stringify(observed.requirementReasons)} != ${JSON.stringify(expected.requirementReasons)}`);
  if (!same(observed.suggestions, [...expected.suggestions].sort())) mismatches.push(`suggestions ${JSON.stringify(observed.suggestions)} != ${JSON.stringify([...expected.suggestions].sort())}`);
  return { label, mismatches };
}

export function evaluatePortfolio(portfolio: Portfolio) {
  const frozen = deepFreeze(structuredClone(portfolio.observations));
  const before = JSON.stringify(frozen);
  const result = run(frozen, { exposure: portfolio.exposure ?? null });
  const observed = {
    funnelOutcome: result.funnels.source.metrics.outcomeDistribution.verdict,
    funnelReasons: result.funnels.source.metrics.outcomeDistribution.reasons,
    requirements: result.requirements.verdict.verdict,
    requirementReasons: result.requirements.verdict.reasons,
    suggestions: suggestionKeys(result.suggestions),
  };
  const checks = [compare(`${portfolio.id} (no alias)`, observed, portfolio.expected)];
  if (portfolio.aliasGroups && portfolio.expectedWithAliases) {
    const withAliases = run(frozen, { exposure: portfolio.exposure ?? null, aliasGroups: portfolio.aliasGroups });
    checks.push(
      compare(
        `${portfolio.id} (person-confirmed alias)`,
        {
          funnelOutcome: withAliases.funnels.source.metrics.outcomeDistribution.verdict,
          funnelReasons: withAliases.funnels.source.metrics.outcomeDistribution.reasons,
          requirements: withAliases.requirements.verdict.verdict,
          requirementReasons: withAliases.requirements.verdict.reasons,
          suggestions: suggestionKeys(withAliases.suggestions),
        },
        portfolio.expectedWithAliases,
      ),
    );
  }
  const f = result.funnels.source.totals;
  const a = result.requirements.assessment;
  return {
    id: portfolio.id,
    lane: portfolio.lane,
    title: portfolio.title,
    what: portfolio.what,
    rawCounts: {
      requisitions: f.distinctRequisitions,
      sourceRowsRead: f.sourceRowsRead,
      copiesCollapsed: f.copiesCollapsed,
      sourceCellOverlap: f.overlap,
      weakKeyRequisitions: f.weakKeyRequisitions,
      sentRequisitions: f.sentRequisitions,
      matureSent: f.matureSent,
      censoredSent: f.censoredSent,
      undatedSent: f.undatedSent,
      unknownOutcomes: f.unknownOutcomes,
      reapplicationRows: f.reapplicationRows,
      selected: result.requirements.selected,
      assessmentCurrent: a.current,
      assessmentUsable: a.usable,
      assessmentPartial: a.partial,
      assessmentStale: a.stale,
      assessmentNone: a.none,
      excludedIncompatible: a.excludedIncompatible,
      requirementRows: result.requirements.requirements.length,
      eligibilityMismatchRows: result.requirements.eligibility.length,
      suggestions: result.suggestions.suggestions.length,
    },
    verdicts: {
      funnel: result.funnels.source.metrics,
      requirements: result.requirements.verdict,
      suggestionsWithheld: result.suggestions.withheld,
    },
    suggestionIds: result.suggestions.suggestions.map((suggestion) => ({ id: suggestion.id, kind: suggestion.kind, subject: suggestion.subject, count: suggestion.support.count, smallSample: suggestion.uncertainty.smallSample })),
    expected: portfolio.expected,
    expectedWithAliases: portfolio.expectedWithAliases ?? null,
    checks,
    inputUnchanged: JSON.stringify(frozen) === before,
  };
}

// ---------------------------------------------------------------------------------------------- invariances

function withOutcome(observations: readonly JobObservation[], status: 'rejected' | 'interview'): JobObservation[] {
  return observations.map((observation) => ({
    ...observation,
    applications: observation.applications.map((application) => ({ ...application, status: application.submission === 'prepared' || application.submission === 'not_recorded' ? application.status : status, heldRounds: 0 })),
  }));
}

function withScores(observations: readonly JobObservation[], value: number | null): JobObservation[] {
  return observations.map((observation) => ({
    ...observation,
    score: value === null ? { state: 'unscored' as const, value: null, roleFamily: null } : { state: 'scored' as const, value, roleFamily: observation.score.roleFamily },
  }));
}

function withoutAssessments(observations: readonly JobObservation[]): JobObservation[] {
  return observations.map((observation) => ({ ...observation, assessment: { state: 'none' as const, requirements: [], coverage: 'not_run' as const } }));
}

/** The requirement rows and suggestions with every outcome-derived and score-derived field blanked, to compare what must not move. */
function core(result: Run): unknown {
  return {
    rows: result.requirements.requirements.map((row) => ({ key: row.key, jobsPresent: row.jobsPresent, byLane: row.byLane, jobs: row.supportingJobs.map((entry) => `${entry.jobId}:${entry.lane}`) })),
    eligibility: result.requirements.eligibility.map((row) => ({ key: row.key, jobs: row.supportingJobs.map((entry) => entry.jobId) })),
    suggestions: result.suggestions.suggestions.map((suggestion) => ({ id: suggestion.id, count: suggestion.support.count, items: suggestion.support.items.map((item) => item.jobId) })),
    verdict: result.requirements.verdict,
  };
}

export function invariances() {
  const base = richObservations();
  const reference = run(base, { exposure: RICH_EXPOSURE });
  const rejectedEverywhere = run(withOutcome(base, 'rejected'), { exposure: RICH_EXPOSURE });
  const interviewEverywhere = run(withOutcome(base, 'interview'), { exposure: RICH_EXPOSURE });
  const contextOf = (result: Run) => result.suggestions.suggestions.filter((suggestion) => suggestion.outcomeContext).map((suggestion) => suggestion.outcomeContext!.byOutcome);
  const scoresNull = run(withScores(base, null), { exposure: RICH_EXPOSURE });
  const scoresZero = run(withScores(base, 0), { exposure: RICH_EXPOSURE });
  const scoresHigh = run(withScores(base, 99), { exposure: RICH_EXPOSURE });
  const noAssessment = run(withoutAssessments(base), { exposure: RICH_EXPOSURE });
  return {
    outcomesFlipped: {
      claim: 'Making every sent application rejected, or every one an interview, changes no requirement row, no lane count, no eligibility row and no suggestion; only the labelled outcome context moves.',
      coreIdenticalAcrossRejectedInterviewAndActual: JSON.stringify(core(rejectedEverywhere)) === JSON.stringify(core(reference)) && JSON.stringify(core(interviewEverywhere)) === JSON.stringify(core(reference)),
      outcomeContextDiffers: JSON.stringify(contextOf(rejectedEverywhere)) !== JSON.stringify(contextOf(interviewEverywhere)),
      rejectedEverywhereSuggestionKeys: suggestionKeys(rejectedEverywhere.suggestions),
    },
    scoresChanged: {
      claim: 'Setting every fit score to missing, to 0, or to 99 changes no requirement row and no suggestion. A score of 0 is a recorded score and is counted as scored; missing is counted as unscored.',
      coreIdenticalAcrossNullZeroHigh: [scoresNull, scoresZero, scoresHigh].every((result) => JSON.stringify(core(result)) === JSON.stringify(core(reference))),
      evaluatorOpinionCounts: { actual: reference.requirements.evaluatorOpinion, allMissing: scoresNull.requirements.evaluatorOpinion, allZero: scoresZero.requirements.evaluatorOpinion },
    },
    noAssessmentMeansNoRequirements: {
      claim: 'Removing every assessment leaves the same job titles, scores and outcomes but no requirement row and no requirement suggestion; nothing is inferred from the rest.',
      requirementRows: noAssessment.requirements.requirements.length,
      requirementSuggestions: noAssessment.suggestions.suggestions.filter((suggestion) => suggestion.kind === 'add_cv_evidence' || suggestion.kind === 'consider_learning_priority').length,
      verdict: noAssessment.requirements.verdict,
    },
    dismissal: dismissalCheck(reference),
  };
}

function dismissalCheck(reference: Run) {
  const set = reference.suggestions;
  const target = set.suggestions[0]!;
  const frozenState = deepFreeze({ dismissed: {} as Record<string, { at: string; supportAtDismissal: number }> });
  const dismissed = dismiss(frozenState, target, '2026-10-30T09:00:00.000Z');
  const shown = partition(set, dismissed);
  const grown = structuredClone(set);
  grown.suggestions.find((suggestion) => suggestion.id === target.id)!.support.count += 2;
  const afterGrowth = partition(grown, dismissed);
  return {
    claim: 'A dismissed suggestion leaves the visible list, stays inspectable, does not return when more supporting jobs arrive (it reports how many newer ones), and dismissing changes no suggestion and no input.',
    startedWith: set.suggestions.length,
    visibleAfterDismiss: shown.visible.length,
    stillListedAsDismissed: shown.dismissed.length,
    stateChanged: Object.keys(dismissed.dismissed).length === 1 && Object.keys(frozenState.dismissed).length === 0,
    staysDismissedAfterTwoMoreSupportingJobs: afterGrowth.visible.every((suggestion) => suggestion.id !== target.id),
    newSupportReported: afterGrowth.dismissed.find((entry) => entry.suggestion.id === target.id)?.newSupportSince ?? null,
    allEffectsNone: set.suggestions.every((suggestion) => suggestion.effect === 'none' && suggestion.actions.length === 1 && suggestion.actions[0] === 'dismiss'),
    everySuggestionCarriesEvidence: set.suggestions.every((suggestion) => suggestion.support.denominators.length > 0 && typeof suggestion.support.window.asOf === 'string' && suggestion.uncertainty.limits.length > 0),
    everyRequirementSuggestionNamesItsJobs: set.suggestions.filter((suggestion) => suggestion.kind !== 'review_search_variant').every((suggestion) => suggestion.support.items.length === suggestion.support.count),
    emptyStateIsStillEmpty: EMPTY_REVIEW_STATE.dismissed && Object.keys(EMPTY_REVIEW_STATE.dismissed).length === 0,
  };
}

// ----------------------------------------------------------------------------------------- constructed baselines

export function baselines() {
  const base = richObservations();
  const view = run(base, { exposure: RICH_EXPOSURE });
  const src = view.funnels.source;

  // (1) Rejection-as-gap: every requirement of a job whose application was rejected is called a missing skill.
  let pairs = 0;
  let wronglyCalledGap = 0;
  for (const observation of base) {
    const sent = sentApplicationsOf(observation);
    const rejected = sent.length > 0 && sent[sent.length - 1]!.status === 'rejected';
    if (!rejected) continue;
    for (const requirement of observation.assessment.requirements) {
      pairs += 1;
      if (laneOf(requirement) === 'supported_by_cv') wronglyCalledGap += 1;
    }
  }
  // (2) Title-keyword gap: call "Kubernetes" a gap for every job whose title mentions it and that was not assessed.
  const titled = base.filter((observation) => observation.assessment.state === 'none');
  // (3) Cells summed as if they partitioned the jobs.
  const naiveSum = src.cells.reduce((sum, cell) => sum + cell.requisitions, 0);
  // (4) Counting copies as jobs.
  const rowsRead = src.totals.sourceRowsRead;
  // (5) Rate among known outcomes only.
  const distinctMature = src.totals.matureSent;
  const uniqueProgressed = base.filter((observation) => {
    const sent = sentApplicationsOf(observation);
    const last = sent[sent.length - 1];
    return last && last.sentAt === '2026-08-01T00:00:00.000Z' && (last.status === 'interview' || last.status === 'recruiter_screen' || last.status === 'offer');
  }).length;
  const knownOnly = base.filter((observation) => {
    const sent = sentApplicationsOf(observation);
    const last = sent[sent.length - 1];
    return last && last.sentAt === '2026-08-01T00:00:00.000Z' && last.status !== 'applied';
  }).length;
  return {
    note: 'Constructed comparisons on the rich_projected portfolio only. Each is a simpler rule someone might write; none is shipped behaviour.',
    rejectionAsGap: { requirementJobPairsInRejectedApplications: pairs, calledGapButSupportedByCv: wronglyCalledGap, prototypeAttributionsFromRejection: 0 },
    titleKeywordGap: { jobsWithNoAssessment: titled.length, gapsAttributedByRule: titled.length, gapsAttributedByPrototype: 0 },
    cellsSummedAsPartition: { distinctRequisitions: src.totals.distinctRequisitions, sumOfSourceCells: naiveSum, impossibleExcess: naiveSum - src.totals.distinctRequisitions },
    copiesCountedAsJobs: { jobsCountedByRule: rowsRead, distinctRequisitions: src.totals.distinctRequisitions },
    rateAmongKnownOutcomesOnly: {
      matureSent: distinctMature,
      progressed: uniqueProgressed,
      unknown: distinctMature - knownOnly,
      ruleRate: knownOnly === 0 ? null : Number((uniqueProgressed / knownOnly).toFixed(3)),
      prototypeBounds: { lower: Number((uniqueProgressed / distinctMature).toFixed(3)), upper: Number(((uniqueProgressed + (distinctMature - knownOnly)) / distinctMature).toFixed(3)) },
    },
  };
}

// ----------------------------------------------------------------------------------------------- desk comparison

const SOURCES = {
  fitCheck: 'apps/desktop/src/components/saved/SavedJobDrawer.tsx ("Fit check": job.gapAnalysis, free text, saved by the person)',
  brief: 'apps/desktop/src/components/brief/ApplicationBriefPanel.tsx (strengths / gaps / open questions, capped at BRIEF_LIST_CAP = 5 per list; eligibility; "Where this came from")',
  table: 'apps/desktop/src/components/applications/ApplicationsTable.tsx (status, Next step column)',
  drawer: 'apps/desktop/src/components/applications/ApplicationDrawer.tsx (notes, next step, contact)',
  found: 'apps/desktop/src/components/search/VacancyDetail.tsx ("Found with": queries, shown only for a lead in the latest scan report)',
};

export function deskComparison() {
  const observations = richObservations();
  const surfaces = manualSurfaces();
  const result = run(observations, { exposure: RICH_EXPOSURE });
  const assessed = observations.filter((observation) => observation.assessment.state === 'current');
  const unassessed = observations.filter((observation) => observation.assessment.state !== 'current');
  const freeTextOnly = unassessed.filter((observation) => surfaces[observation.id]?.keptFitCheck);
  const sent = observations.filter((observation) => sentApplicationsOf(observation).length > 0);
  const withEligibility = observations.filter((observation) => observation.eligibility.length > 0);
  const notesJobs = observations.filter((observation) => (surfaces[observation.id]?.notes ?? '') !== '' || (surfaces[observation.id]?.nextStep ?? '') !== '');
  const keptJobs = observations.filter((observation) => surfaces[observation.id]?.keptFitCheck);
  const keptAmbiguous = assessed.filter((observation) => surfaces[observation.id]?.keptFitCheck);

  return {
    method: [
      'Fixture: the rich_projected portfolio (30 requisitions) with invented free text on some jobs (Fit check, next step, notes).',
      'MANUAL side = SOURCE READING of what the current screens show (file citations below). Nothing was executed on the manual side and no person was observed.',
      'PROTOTYPE side = EXECUTED: the views run on the same fixture.',
      'Unit = counted operations (one job record opened = 1). It is not time, effort, accuracy or a usability result. No human labels were collected; the "better" column is the fixture author’s reading.',
      'The rich portfolio is projected data. Where the answer needs a field production does not record, the row says so and the comparison is of design capability, not of what the app does today.',
    ],
    surfaces: SOURCES,
    questions: [
      {
        id: 'q1_recurring_requirements',
        question: 'Which requirements recur across the jobs I chose, and how often?',
        manual: {
          operations: observations.length,
          opensWhat: 'each saved job’s drawer: the brief’s strengths/gaps/open-questions lists plus any kept Fit check',
          jobsWithStructuredAnswer: assessed.length,
          jobsOnlyAnsweredByFreeTextFitCheck: freeTextOnly.length,
          jobsWithNoAnswerAtAll: observations.length - assessed.length - freeTextOnly.length,
          aggregationDone: 'by the person, by hand: nothing counts across jobs',
          listCapExercised: false,
        },
        prototype: {
          operations: 1,
          requirementRows: result.requirements.requirements.length,
          topRows: result.requirements.requirements.slice(0, 4).map((row) => ({ label: row.label, jobsPresent: row.jobsPresent, of: row.denominators.assessedUsable })),
          notAssessedReportedAsUnknown: unassessed.length,
          traceableToJobs: true,
          blindSpot: `${freeTextOnly.length} job(s) have the finding only as kept free text ("Terraform"), which the structured view cannot read; they are reported as not assessed, not guessed.`,
        },
        betterForCountingAcrossJobs: 'prototype',
        betterForPerJobDetail: 'manual (the brief shows that job’s requirement text and CV evidence label; the aggregate shows rows and links)',
      },
      {
        id: 'q2_gap_versus_missing_evidence',
        question: 'Is a recurring missing item a gap I recorded, or just something my CV does not show?',
        manual: {
          operations: observations.length,
          perJobDistinctionExists: 'yes: the brief lists "gaps" and "open questions" separately for an assessed job',
          jobsWhereOnlyFreeTextFitCheckExists: keptJobs.length,
          freeTextFitCheckDistinguishesRecordedGapFromMissingEvidence: false,
          jobsWithKeptFitCheckAndAssessment: keptAmbiguous.length,
          aggregationDone: 'by the person, by hand',
        },
        prototype: {
          operations: 1,
          lanesNeverMerged: ['recorded_missing_experience', 'cv_evidence_not_recorded', 'supported_by_cv', 'unreviewed'],
          example: result.requirements.requirements.find((row) => row.key === 'kubernetes')?.byLane ?? null,
        },
        betterForCountingAcrossJobs: 'prototype',
        betterForPerJobDetail: 'tie (both separate the two for one job)',
      },
      {
        id: 'q3_preference_conflicts',
        question: 'Do the jobs I chose repeatedly conflict with something I said I need?',
        manual: {
          operations: observations.length,
          jobsWithAnEligibilityAnswer: withEligibility.length,
          aggregationDone: 'by the person, by hand',
        },
        prototype: {
          operations: 1,
          rows: result.requirements.eligibility.map((row) => ({ key: row.key, jobsKnownMismatch: row.jobsKnownMismatch, ofAnswered: row.jobsAnswered, unknown: row.jobsUnknown, of: row.denominators.selected })),
        },
        betterForCountingAcrossJobs: 'prototype',
        betterForPerJobDetail: 'tie',
      },
      {
        id: 'q4_source_and_variant_outcomes',
        question: 'Which source or search variant do my sent applications come from, and what happened to them?',
        manual: {
          operations: sent.length * 2,
          opensWhat: 'each sent application’s row (status) and its saved-job drawer (“Where this came from”)',
          sourceReadable: 'yes per job (brief: provider and link of each copy)',
          queryVariantReadable: 'no for a saved job: "Found with" appears only on a lead in the latest scan report and the variant is not stored with the saved job (proved in workspace-contract.test.ts)',
          outcomeReadable: 'status only: no date, source or reason',
          aggregationDone: 'by the person, by hand',
        },
        prototype: {
          operations: 1,
          requiresProjectedFields: ['query attribution carried into the brief (follow-up B)', 'dated status events (follow-up A)', 'lead exposure digest (not filed)'],
          sourceCells: result.funnels.source.cells.map((cell) => ({ label: cell.label, requisitions: cell.requisitions, matureSent: cell.matureSent, unknown: cell.outcomes.no_recorded_outcome })),
          outcomeVerdict: result.funnels.source.metrics.outcomeDistribution,
          onTodaysData: 'no_go: query variant not recorded, too few mature sends (see the real-contract lane)',
        },
        betterForCountingAcrossJobs: 'prototype, only if the projected fields exist; on today’s data neither side can name the variant',
        betterForPerJobDetail: 'manual for source; neither for variant',
      },
      {
        id: 'q5_context_only_in_notes',
        question: 'What did a recruiter or contact say that bears on my search?',
        manual: { operations: notesJobs.length, opensWhat: 'the application’s next step (table) and notes (drawer)', jobsWithSuchText: notesJobs.length },
        prototype: { operations: 1, answer: 'none: notes and next-step text are deliberately not read, parsed or aggregated', blindSpot: `${notesJobs.length} job(s) hold context only in free text` },
        betterForCountingAcrossJobs: 'manual (the prototype cannot see it by design)',
        betterForPerJobDetail: 'manual',
      },
    ],
    totals: {
      manualOperationsAcrossQuestions: observations.length * 3 + sent.length * 2 + notesJobs.length,
      prototypeOperationsAcrossQuestions: 5,
      note: 'Counted record opens, not time. The prototype also needs the underlying data to exist; on today’s data q4 is a no-go and q1–q3 depend on how many jobs the person assessed.',
    },
    limits: [
      'No human did any of this; the manual side is a reading of the source, the prototype side is a run on constructed data.',
      'A person with 3 saved jobs does not need an aggregate: the counted advantage only appears as the number of jobs grows.',
      'Free text can carry the decisive fact. The prototype ignores it on purpose, so it is complementary to manual review, not a replacement.',
      'No claim is made about decision quality, time saved, hiring outcomes or user preference.',
    ],
    cases: { jobsInFixture: observations.length, assessed: assessed.length, withKeptFitCheck: keptJobs.length, withFreeTextContext: notesJobs.length, sentApplications: sent.length },
  };
}

// --------------------------------------------------------------------------------------------------- the report

export function runEvaluation() {
  const portfolios = PORTFOLIOS.map(evaluatePortfolio);
  const allChecks = portfolios.flatMap((portfolio) => portfolio.checks);
  const mismatches = allChecks.filter((check) => check.mismatches.length > 0);
  const labels = (observation: JobObservation) => cellLabelsOf(observation, 'source').length;
  return {
    issue: 693,
    contractVersion: CONTRACT_VERSION,
    asOf: AS_OF,
    kind: 'constructed synthetic portfolios with fixture-author expectations; no human labels',
    method: [
      'Executed: the prototype functions in apps/desktop/test/outcome-gap-research run on the portfolios in fixtures.ts. Expected verdicts, reasons and suggestion sets were declared by the fixture author from the written rules before the code was run.',
      'Executed: invariances (what must not change when outcomes, scores or assessments change) and a dismissal check.',
      'Executed, constructed: four simpler rules scored on the same fixture (baselines).',
      'Source reading: the manual-review side of the desk comparison.',
      'Real-contract lane (added by evaluation.test.ts): synthetic data written through the app’s real writers into a migrated database and read back by the read-only adapter.',
      'Review gates are author-declared and not statistically derived (GATES in contract.ts). No inference is made about any real person.',
    ],
    gates: GATES,
    portfolios,
    summary: {
      portfolios: portfolios.length,
      checks: allChecks.length,
      checksWithMismatch: mismatches.length,
      mismatchDetail: mismatches,
      noGoPortfolios: portfolios.filter((portfolio) => portfolio.verdicts.requirements.verdict === 'no_go' && portfolio.verdicts.funnel.outcomeDistribution.verdict === 'no_go').map((portfolio) => portfolio.id),
      goReviewPortfolios: portfolios.filter((portfolio) => portfolio.verdicts.requirements.verdict === 'go_review' || portfolio.verdicts.funnel.outcomeDistribution.verdict === 'go_review').map((portfolio) => portfolio.id),
      portfoliosWithMultiSourceRequisitions: portfolios.filter((portfolio) => PORTFOLIOS.find((entry) => entry.id === portfolio.id)!.observations.some((observation) => labels(observation) > 1)).map((portfolio) => portfolio.id),
    },
    invariances: invariances(),
    baselines: baselines(),
    deskComparison: deskComparison(),
    unknowns: [
      'No human labels: every expected value was written by the implementer. Nothing here is human validated.',
      'No real job search was used. The portfolios say nothing about how often these patterns occur for a real person, employer or ATS.',
      'Nothing is known about whether any suggestion would be useful, understood or acted on; no usability study was run.',
      'The rich portfolio relies on fields production does not record (query attribution, status events, exposure counts); its go_review verdicts describe the contract, not the app.',
      'The review gates (counts and shares) are author-declared. They were not tuned or validated on data and could be wrong in either direction.',
      'Maturity (28 days) has no empirical basis; employers answer on very different time scales and many never answer.',
      'Exact-text recurrence under-counts spelling variants; person-confirmed aliases fix that only for wordings the person notices.',
      'No provider, token, latency or cost telemetry was collected or is claimed: nothing in the prototype calls a model.',
    ],
    limits: [
      'Selected jobs are survivorship-filtered: deleted saved jobs are gone.',
      'Correlation between a requirement and an outcome is never presented as cause; outcomes are context only.',
      'A requirement a CV cannot evidence is not a missing skill.',
      'The conclusion is about whether automated calibration is supportable (it is not), not about hiring outcomes.',
    ],
  };
}
