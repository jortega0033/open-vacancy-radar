import { CONTRACT_VERSION, GATES, deepFreeze, type JobObservation } from './contract.js';
import { AS_OF, PORTFOLIOS, RICH_EXPOSURE, manualSurfaces, richObservations, type Expected, type ManualSurface, type Portfolio } from './fixtures.js';
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

/** Unassessed requisitions whose own title or scorer hints satisfy the test: the cases where a rule that read them WOULD produce a gap. */
function unassessedWith(observations: readonly JobObservation[], test: (hints: JobObservation['hints']) => boolean): number {
  return observations.filter((observation) => observation.assessment.state !== 'current' && test(observation.hints)).length;
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
      savedRowsRead: f.savedRowsRead,
      savedRowsCollapsed: f.savedRowsCollapsed,
      sourceContributions: f.sourceContributions,
      aliasContributionsMerged: f.aliasContributionsMerged,
      copiesSeen: f.copiesSeen,
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
      unassessedTitledKubernetes: unassessedWith(portfolio.observations, (hints) => /kubernetes/iu.test(hints?.title ?? '')),
      unassessedWithKubernetesScorerHint: unassessedWith(portfolio.observations, (hints) => [...(hints?.scorerMatchingSkills ?? []), ...(hints?.scorerGaps ?? [])].some((hint) => /kubernetes/iu.test(hint))),
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
    suggestionIds: result.suggestions.suggestions.map((suggestion) => ({ id: suggestion.id, kind: suggestion.kind, subject: suggestion.subject, count: suggestion.support.count, byClassification: suggestion.support.byClassification, classificationMix: suggestion.support.classificationMix, smallSample: suggestion.uncertainty.smallSample })),
    requirementClassification: result.requirements.requirements.map((row) => ({ label: row.label, jobsPresent: row.jobsPresent, byLane: row.byLane, byClassification: row.byClassification })),
    queryVariantCells: result.funnels.queryVariant.cells.filter((cell) => cell.via !== null && cell.label !== '(query variant not recorded)').map((cell) => ({ label: cell.label, requisitions: cell.requisitions, via: cell.via, selectedOfExposed: cell.selectedOfExposed })),
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

/** Plant the word "Kubernetes" in every title and every scorer hint, or blank them all: neither may change anything computed. */
function withHints(observations: readonly JobObservation[], mode: 'kubernetes' | 'blank'): JobObservation[] {
  return observations.map((observation) => ({
    ...observation,
    hints: mode === 'kubernetes' ? { title: 'Kubernetes Platform Engineer', scorerMatchingSkills: ['Kubernetes'], scorerGaps: ['Kubernetes is the main skill requested'] } : { title: null, scorerMatchingSkills: [], scorerGaps: [] },
  }));
}

/** A deliberately LEAKY adapter, used only to show the invariance can fail: it turns a Kubernetes title or hint on an unassessed job into an assessment. */
function leakyFromTitlesAndHints(observations: readonly JobObservation[]): JobObservation[] {
  return observations.map((observation) => {
    const says = /kubernetes/iu.test(observation.hints?.title ?? '') || [...(observation.hints?.scorerMatchingSkills ?? []), ...(observation.hints?.scorerGaps ?? [])].some((hint) => /kubernetes/iu.test(hint));
    if (observation.assessment.state === 'current' || !says) return observation;
    return {
      ...observation,
      assessment: { state: 'current' as const, coverage: 'complete' as const, requirements: [{ requirementId: 'leak', text: 'Kubernetes', classification: 'required' as const, evidenceClass: 'unsupported' as const, reviewed: true, excluded: false, jdAnchor: '', jdRevisionId: '', quoteSpan: null, candidateAdded: false }] },
    };
  });
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
  const hintsKubernetes = run(withHints(base, 'kubernetes'), { exposure: RICH_EXPOSURE });
  const hintsBlank = run(withHints(base, 'blank'), { exposure: RICH_EXPOSURE });
  const leaky = run(leakyFromTitlesAndHints(base), { exposure: RICH_EXPOSURE });
  const titlesOnlyPortfolio = PORTFOLIOS.find((portfolio) => portfolio.id === 'titles_only_no_assessment')!;
  const titlesOnlyRun = run(titlesOnlyPortfolio.observations);
  const leakyTitlesOnly = run(leakyFromTitlesAndHints(titlesOnlyPortfolio.observations));
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
    titlesAndScorerHintsChanged: {
      claim: 'Planting "Kubernetes" in every job title and every scorer hint, or blanking them all, changes no requirement row, no lane count and no suggestion. The unassessed jobs stay unknown.',
      coreIdenticalWhenEveryTitleAndHintSaysKubernetes: JSON.stringify(core(hintsKubernetes)) === JSON.stringify(core(reference)),
      coreIdenticalWhenEveryTitleAndHintIsBlank: JSON.stringify(core(hintsBlank)) === JSON.stringify(core(reference)),
    },
    titleOnlyNegativeControl: {
      claim: 'The titles_only_no_assessment portfolio contains jobs TITLED Kubernetes with Kubernetes scorer hints and no assessment. The prototype yields no requirement row and no requirement suggestion and counts every job as not assessed; a leaky rule that read titles or hints would not.',
      jobsTitledKubernetes: titlesOnlyPortfolio.observations.filter((observation) => /kubernetes/iu.test(observation.hints?.title ?? '')).length,
      jobsWithKubernetesScorerHint: titlesOnlyPortfolio.observations.filter((observation) => [...(observation.hints?.scorerMatchingSkills ?? []), ...(observation.hints?.scorerGaps ?? [])].some((hint) => /kubernetes/iu.test(hint))).length,
      jobsNotAssessed: titlesOnlyRun.requirements.assessment.none,
      prototypeRequirementRows: titlesOnlyRun.requirements.requirements.length,
      prototypeRequirementSuggestions: titlesOnlyRun.suggestions.suggestions.filter((suggestion) => suggestion.kind === 'add_cv_evidence' || suggestion.kind === 'consider_learning_priority').length,
      leakyRuleWouldProduceRows: leakyTitlesOnly.requirements.requirements.length,
      invarianceDetectsALeakyRule: JSON.stringify(core(leaky)) !== JSON.stringify(core(reference)),
    },
    classificationMatters: classificationCheck(base),
    dismissal: dismissalCheck(reference),
  };
}

/** Preferred stays preferred: the same rows with every class forced to required read differently, and an all-preferred row never gets mandatory wording. */
function classificationCheck(base: readonly JobObservation[]) {
  const reference = run(base, { exposure: RICH_EXPOSURE });
  const forced = run(
    base.map((observation) => ({ ...observation, assessment: { ...observation.assessment, requirements: observation.assessment.requirements.map((requirement) => ({ ...requirement, classification: 'required' as const })) } })),
    { exposure: RICH_EXPOSURE },
  );
  const onCall = reference.suggestions.suggestions.find((suggestion) => suggestion.subject === 'On-call rota');
  const kubernetes = reference.suggestions.suggestions.find((suggestion) => suggestion.kind === 'add_cv_evidence' && suggestion.subject === 'Kubernetes');
  return {
    claim: 'The recurrence threshold counts every assessed appearance whatever its class; every row and suggestion states the required / preferred / unclear split; a row that is only preferred never gets mandatory wording; the split is a posting-side fact and moves no row, lane or threshold when changed.',
    thresholdCountsAllClasses: onCall !== undefined && onCall.support.count === GATES.minRecurrence && onCall.support.byClassification?.required === 0,
    allPreferredRow: onCall ? { subject: onCall.subject, byClassification: onCall.support.byClassification, classificationMix: onCall.support.classificationMix, statement: onCall.statement, statementUsesMandatoryWording: /required|mandatory|must/iu.test(onCall.statement) } : null,
    mixedRow: kubernetes ? { subject: kubernetes.subject, byClassification: kubernetes.support.byClassification, classificationMix: kubernetes.support.classificationMix, statement: kubernetes.statement } : null,
    forcingEveryClassToRequiredChangesTheWording: JSON.stringify(forced.suggestions.suggestions.map((suggestion) => suggestion.statement)) !== JSON.stringify(reference.suggestions.suggestions.map((suggestion) => suggestion.statement)),
    forcingEveryClassToRequiredChangesNoRowCountOrLane: JSON.stringify(core(forced)) === JSON.stringify(core(reference)),
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
  // (2) Title-keyword gap: call "Kubernetes" a gap for every UNASSESSED job whose own title mentions it (titles are the fixture's real ones).
  const unassessedJobs = base.filter((observation) => observation.assessment.state !== 'current');
  const titled = unassessedJobs.filter((observation) => /kubernetes/iu.test(observation.hints?.title ?? ''));
  // (2b) Scorer-hint gap: treat a Kubernetes mention in the scorer's matching skills or "gaps" of an unassessed job as a requirement gap.
  const hinted = unassessedJobs.filter((observation) => [...(observation.hints?.scorerMatchingSkills ?? []), ...(observation.hints?.scorerGaps ?? [])].some((hint) => /kubernetes/iu.test(hint)));
  // (3) Cells summed as if they partitioned the jobs.
  const naiveSum = src.cells.reduce((sum, cell) => sum + cell.requisitions, 0);
  // (4) Counting copies as jobs.
  const rowsRead = src.totals.copiesSeen;
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
    titleKeywordGap: { unassessedJobs: unassessedJobs.length, ofWhichTitleSaysKubernetes: titled.length, gapsAttributedByRule: titled.length, gapsAttributedByPrototype: 0, note: 'Computed from the fixture titles: only unassessed jobs whose own title says Kubernetes. Unassessed jobs with other titles are unknown, not title-derived.' },
    scorerHintGap: { unassessedJobs: unassessedJobs.length, ofWhichScorerHintMentionsKubernetes: hinted.length, gapsAttributedByRule: hinted.length, gapsAttributedByPrototype: 0, note: 'The scorer’s matching skills and "gaps" compare a job with the person’s stated profile and preferences; they are not skill gaps and are never read as requirements.' },
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

/** Real surfaces a person has today (each path exists in the repo at this head; the manual side is SOURCE READING of them). */
const SOURCES = {
  savedJobDrawer:
    'apps/desktop/src/components/saved/SavedJobDrawer.tsx: ONE drawer per saved job shows the kept "Fit check" free text AND the brief panel (requirement evidence, recorded-gap vs open-question lists capped at BRIEF_LIST_CAP = 5, eligibility, "Where this came from"). Opening it once answers Q1, Q2, Q3 and the source half of Q4.',
  brief: 'apps/desktop/src/components/brief/ApplicationBriefPanel.tsx (the brief panel inside that drawer)',
  gapAnalysis:
    'apps/desktop/src/components/cv/GapAnalysis.tsx + gap-analysis-store.ts (saveGapAnalysis): the CV-assistant flow that PRODUCES the kept Fit check. It runs the person’s own CLI/model once per job and "Save analysis" stores the free text on the saved job, with no posting or CV version. That run is the origin of the kept Fit check and is not counted below; the prototype runs no model.',
  table: 'apps/desktop/src/components/applications/ApplicationsTable.tsx (ONE screen lists every application with its status and Next step)',
  applicationDrawer: 'apps/desktop/src/components/applications/ApplicationDrawer.tsx (notes, next step, contact; one drawer per application)',
  interviewRounds: 'apps/desktop/src/components/applications/InterviewRoundsPanel.tsx, shown in InterviewPrepDrawer.tsx (#691): per-round state, feedback and open topics, free text',
  followUps: 'apps/desktop/src/components/applications/FollowUpsDrawer.tsx and FollowUpDraftCard.tsx (#692): dated follow-up actions (title, note) and drafts, free text',
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
  const keptJobs = observations.filter((observation) => surfaces[observation.id]?.keptFitCheck);
  const keptAmbiguous = assessed.filter((observation) => surfaces[observation.id]?.keptFitCheck);
  const text = (observation: JobObservation, field: keyof ManualSurface) => ((surfaces[observation.id]?.[field] as string | null | undefined) ?? '') !== '';
  const notesJobs = observations.filter((observation) => text(observation, 'notes') || text(observation, 'nextStep'));
  const roundJobs = observations.filter((observation) => text(observation, 'roundNotes'));
  const followUpJobs = observations.filter((observation) => text(observation, 'followUpText'));

  // DISTINCT RECORDS a person opens by hand. One saved-job drawer serves Q1-Q3 and the source half of Q4, so it is ONE record, not three.
  const drawer = (observation: JobObservation) => `saved-job-drawer:${observation.id}`;
  const forQuestion = {
    q1: observations.map(drawer),
    q2: observations.map(drawer),
    q3: observations.map(drawer),
    q4: ['applications-table', ...sent.map(drawer)],
    q5: [...notesJobs.map((observation) => `application-drawer:${observation.id}`), ...roundJobs.map((observation) => `interview-rounds:${observation.id}`), ...followUpJobs.map((observation) => `follow-ups:${observation.id}`)],
  };
  const union = new Set(Object.values(forQuestion).flat());
  const naiveSum = Object.values(forQuestion).reduce((total, records) => total + records.length, 0);

  return {
    method: [
      'Fixture: the rich_projected portfolio (30 requisitions) with invented free text on some jobs (kept Fit check, next step, notes, #691 round notes, #692 follow-up text).',
      'MANUAL side = SOURCE READING of what the current screens show (file citations below). Nothing was executed on the manual side and no person was observed.',
      'PROTOTYPE side = EXECUTED: one run of the views on the same fixture.',
      'Unit = DISTINCT RECORDS a person would open or screens they would read. A record is counted once however many questions it answers (a saved-job drawer opened once answers Q1, Q2 and Q3); per-question counts are shown separately and are NOT added into a headline. It is not time, effort, accuracy or a usability result. No human labels were collected; the "better" column is the fixture author’s reading.',
      'Like-for-like: the prototype can only answer a question for a job that was ALREADY assessed ("Compare with my CV"); the structured part of the brief needs the same prerequisite. The assessments, and the model run behind each kept Fit check, are not counted on either side. The prototype therefore saves no assessment work and these counts are not a time or usability saving.',
      'The rich portfolio is projected data. Where the answer needs a field production does not record, the row says so and the comparison is of design capability, not of what the app does today.',
    ],
    surfaces: SOURCES,
    questions: [
      {
        id: 'q1_recurring_requirements',
        question: 'Which requirements recur across the jobs I chose, and how often?',
        manual: {
          distinctRecords: new Set(forQuestion.q1).size,
          opensWhat: 'each saved job’s drawer (opened once, shared with Q2 and Q3): the brief’s requirement evidence and lists plus any kept Fit check',
          jobsWithStructuredAnswer: assessed.length,
          jobsOnlyAnsweredByFreeTextFitCheck: freeTextOnly.length,
          jobsWithNoAnswerAtAll: observations.length - assessed.length - freeTextOnly.length,
          aggregationDone: 'by the person, by hand: nothing counts across jobs',
          listCapExercised: false,
        },
        prototype: {
          runs: 1,
          requirementRows: result.requirements.requirements.length,
          topRows: result.requirements.requirements.slice(0, 4).map((row) => ({ label: row.label, jobsPresent: row.jobsPresent, of: row.denominators.assessedUsable, byClassification: row.byClassification })),
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
          distinctRecords: new Set(forQuestion.q2).size,
          opensWhat: 'the same saved-job drawers as Q1 (no additional record)',
          perJobDistinctionExists: 'yes: the brief lists "gaps" and "open questions" separately for an assessed job',
          jobsWhereOnlyFreeTextFitCheckExists: keptJobs.length,
          freeTextFitCheckDistinguishesRecordedGapFromMissingEvidence: false,
          jobsWithKeptFitCheckAndAssessment: keptAmbiguous.length,
          aggregationDone: 'by the person, by hand',
        },
        prototype: {
          runs: 1,
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
          distinctRecords: new Set(forQuestion.q3).size,
          opensWhat: 'the same saved-job drawers as Q1 (no additional record)',
          jobsWithAnEligibilityAnswer: withEligibility.length,
          aggregationDone: 'by the person, by hand',
        },
        prototype: {
          runs: 1,
          rows: result.requirements.eligibility.map((row) => ({ key: row.key, jobsKnownMismatch: row.jobsKnownMismatch, ofAnswered: row.jobsAnswered, unknown: row.jobsUnknown, of: row.denominators.selected })),
        },
        betterForCountingAcrossJobs: 'prototype',
        betterForPerJobDetail: 'tie',
      },
      {
        id: 'q4_source_and_variant_outcomes',
        question: 'Which source or search variant do my sent applications come from, and what happened to them?',
        manual: {
          distinctRecords: new Set(forQuestion.q4).size,
          opensWhat: `the applications table once (status for every application) plus the saved-job drawer of each of the ${sent.length} sent applications for “Where this came from” (those drawers are the ones already opened for Q1-Q3, so they add no new record)`,
          sourceReadable: 'yes per job (brief: provider and link of each copy)',
          queryVariantReadable: 'no for a saved job: "Found with" appears only on a lead in the latest scan report and the variant is not stored with the saved job (proved in workspace-contract.test.ts)',
          outcomeReadable: 'status only: no date, source or reason',
          aggregationDone: 'by the person, by hand',
        },
        prototype: {
          runs: 1,
          requiresProjectedFields: ['query attribution carried into the brief (follow-up B)', 'dated status events (follow-up A)', 'lead exposure digest (not filed)'],
          sourceCells: result.funnels.source.cells.map((cell) => ({ label: cell.label, requisitions: cell.requisitions, matureSent: cell.matureSent, unknown: cell.outcomes.no_recorded_outcome })),
          outcomeVerdict: result.funnels.source.metrics.outcomeDistribution,
          onTodaysData: 'no_go: query variant not recorded, too few mature sends (see the real-contract lane)',
        },
        betterForCountingAcrossJobs: 'prototype, only if the projected fields exist; on today’s data neither side can name the variant',
        betterForPerJobDetail: 'manual for source; neither for variant',
      },
      {
        id: 'q5_context_only_in_free_text',
        question: 'What did a recruiter, interviewer or contact say that bears on my search?',
        manual: {
          distinctRecords: new Set(forQuestion.q5).size,
          opensWhat: 'per application with text: its drawer (notes, next step), its interview rounds (#691 feedback and open topics) and its follow-up actions and drafts (#692)',
          applicationDrawersWithText: notesJobs.length,
          interviewRoundPanelsWithText: roundJobs.length,
          followUpDrawersWithText: followUpJobs.length,
        },
        prototype: { runs: 0, answer: 'none: notes, next-step, round feedback and follow-up text are deliberately not read, parsed or aggregated', blindSpot: `${new Set(forQuestion.q5).size} record(s) hold context only in free text` },
        betterForCountingAcrossJobs: 'manual (the prototype cannot see it by design)',
        betterForPerJobDetail: 'manual',
      },
    ],
    totals: {
      distinctRecordsOpenedByHand: union.size,
      distinctRecordsByKind: {
        savedJobDrawers: [...union].filter((record) => record.startsWith('saved-job-drawer:')).length,
        applicationsTableScreens: [...union].filter((record) => record === 'applications-table').length,
        applicationDrawers: [...union].filter((record) => record.startsWith('application-drawer:')).length,
        interviewRoundPanels: [...union].filter((record) => record.startsWith('interview-rounds:')).length,
        followUpDrawers: [...union].filter((record) => record.startsWith('follow-ups:')).length,
      },
      perQuestionDistinctRecords: Object.fromEntries(Object.entries(forQuestion).map(([question, records]) => [question, new Set(records).size])),
      overlapIfPerQuestionCountsWereAdded: { naiveSum, distinctUnion: union.size, doubleCounted: naiveSum - union.size },
      prototypeRuns: 1,
      prototypeViewsRead: ['funnel by source', 'funnel by query variant', 'requirements and eligibility rows', 'suggestions'],
      prototypeQuestionsNotAnswered: ['q5_context_only_in_free_text'],
      prerequisiteForPrototype: `${assessed.length} of ${observations.length} jobs had to be assessed ("Compare with my CV") first; ${unassessed.length} are reported as unknown`,
      note: 'Distinct records and screens, not time. A prototype run reads data that must already exist, so on today’s data q4 is a no-go and q1-q3 depend on how many jobs the person assessed. These counts are not a time or usability saving and no single "N by hand versus M by prototype" ratio is offered.',
    },
    limits: [
      'No human did any of this; the manual side is a reading of the source, the prototype side is a run on constructed data.',
      'A person with 3 saved jobs does not need an aggregate: the counted advantage only appears as the number of jobs grows.',
      'Free text (notes, next step, round feedback, follow-up text, the kept Fit check) can carry the decisive fact. The prototype ignores it on purpose, so it is complementary to manual review, not a replacement.',
      'The assessments the prototype needs, and the model run behind each kept Fit check, are real work that this comparison does not count on either side.',
      'No claim is made about decision quality, time saved, hiring outcomes or user preference.',
    ],
    cases: {
      jobsInFixture: observations.length,
      assessed: assessed.length,
      withKeptFitCheck: keptJobs.length,
      withFreeTextContext: new Set(forQuestion.q5.map((record) => record.split(':')[1])).size,
      sentApplications: sent.length,
    },
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
      'Executed, constructed: five simpler rules scored on the same fixture (baselines).',
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
      'Selected jobs are survivorship-filtered: the aggregate describes the jobs and applications the person KEPT. Deleting a saved job removes it only when no application row still keeps the requisition; deleting the application as well removes it entirely.',
      'The recurrence threshold counts required, preferred and unclear appearances alike; the split is always shown, but a posting-side class is still the extraction’s reading of the posting, not a verified fact.',
      'Evidence classes direct / transferable / unsupported / needs_verification are model-proposed and then person-reviewed (the record does not say whether the person changed the class); only candidate_confirmed_gap is the person’s own statement.',
      'Correlation between a requirement and an outcome is never presented as cause; outcomes are context only.',
      'A requirement a CV cannot evidence is not a missing skill.',
      'The conclusion is about whether automated calibration is supportable (it is not), not about hiring outcomes.',
    ],
  };
}
