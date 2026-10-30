// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #693 evaluation, reproducible and checked in.
 *
 * Regenerate:   OVR_EVAL_OUT=<path>/693-evaluation.json pnpm exec vitest run test/outcome-gap-research/evaluation.test.ts
 * The committed copy is docs/research/outcome-gap/693-evaluation.json; this test fails if a fresh run differs from it.
 * To refresh it after an intended change:  OVR_EVAL_OUT=../../docs/research/outcome-gap/693-evaluation.json (from apps/desktop).
 *
 * What this is NOT: a human-labelled set, a sample of real applications, a usability study, or any claim about
 * hiring outcomes, time saved or provider cost. See `unknowns` and `limits` in the output.
 */

vi.mock('electron', () => ({}));
vi.setConfig({ testTimeout: 90_000 });

const { createWorkspaceDb } = await import('../../electron/workspace/client.js');
const { buildRealWorld, AS_OF: REAL_AS_OF } = await import('./real-world.js');
const { readWorkspaceObservations } = await import('./observations.js');
const { buildFunnel } = await import('./funnel.js');
const { buildRequirements } = await import('./requirements.js');
const { buildSuggestions } = await import('./suggestions.js');
const { runEvaluation, invariances, baselines, deskComparison } = await import('./evaluate.js');
const { PORTFOLIOS } = await import('./fixtures.js');
const { evidenceOriginOf } = await import('./contract.js');
import type { WorkspaceDb } from '../../electron/workspace/client.js';

const here = dirname(fileURLToPath(import.meta.url));
const committedPath = join(here, '..', '..', '..', '..', 'docs', 'research', 'outcome-gap', '693-evaluation.json');

let dir: string;
let db: WorkspaceDb;
let closeDb: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-693-eval-'));
  ({ db, close: closeDb } = createWorkspaceDb(dir));
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

type Status = 'answerable' | 'partial' | 'not_recorded';
const statusOf = (total: number, recorded: number): Status => (recorded === 0 ? 'not_recorded' : recorded === total ? 'answerable' : 'partial');

async function realContractLane() {
  await buildRealWorld(db);
  const read = readWorkspaceObservations(db);
  const observations = [...read.observations].sort((a, b) => a.requisition.key.localeCompare(b.requisition.key));
  const n = observations.length;
  const count = (predicate: (o: (typeof observations)[number]) => boolean) => observations.filter(predicate).length;
  const funnels = {
    source: buildFunnel(observations, { dimension: 'source', asOf: REAL_AS_OF }),
    queryVariant: buildFunnel(observations, { dimension: 'queryVariant', asOf: REAL_AS_OF }),
    roleFamily: buildFunnel(observations, { dimension: 'roleFamily', asOf: REAL_AS_OF }),
  };
  const requirements = buildRequirements(observations);
  const suggestions = buildSuggestions({ asOf: REAL_AS_OF, requirements, variantFunnel: funnels.queryVariant, selectedAtByJob: {} });
  // Negative control: unassessed jobs whose title / scorer hints say Kubernetes must change no requirement row.
  const unassessedTitled = observations.filter((o) => o.assessment.state === 'none' && /kubernetes/iu.test(o.hints?.title ?? ''));
  const withoutTitled = buildRequirements(observations.filter((o) => !unassessedTitled.includes(o)));
  const rowShape = (view: ReturnType<typeof buildRequirements>) => JSON.stringify(view.requirements.map((r) => ({ key: r.key, jobsPresent: r.jobsPresent, byLane: r.byLane, byClassification: r.byClassification, jobs: r.supportingJobs.map((j) => j.requisitionKey) })));
  const negativeControl = {
    titledJobs: unassessedTitled.length,
    jobs: unassessedTitled.map((o) => ({ key: o.requisition.key, title: o.hints?.title ?? null, scorerMatchingSkills: o.hints?.scorerMatchingSkills ?? [], scorerGaps: o.hints?.scorerGaps ?? [], score: o.score, assessmentState: o.assessment.state, requirements: o.assessment.requirements.length, applications: o.applications.length })),
    requirementRowsIdentical: rowShape(requirements) === rowShape(withoutTitled),
    selectedWithJobs: requirements.selected,
    selectedWithoutJobs: withoutTitled.selected,
    notAssessedWithJobs: requirements.assessment.none,
    notAssessedWithoutJobs: withoutTitled.assessment.none,
    requirementSuggestions: suggestions.suggestions.filter((entry) => entry.kind === 'add_cv_evidence' || entry.kind === 'consider_learning_priority').length,
  };
  const sentApps = observations.flatMap((o) => o.applications).filter((a) => a.submission === 'receipt_backed' || a.submission === 'user_reported' || a.submission === 'user_stated');

  const answerability: { question: string; status: Status; evidence: string; code: string }[] = [
    { question: 'How many distinct requisitions did the person select?', status: 'answerable', evidence: `${n} requisitions from ${read.sourceRows.savedJobs} saved jobs and ${read.sourceRows.applications} application rows (${read.sourceRows.briefs} briefs)`, code: 'application_briefs.identity_key + application_brief_aliases (#688)' },
    { question: 'Which saved copies are the same requisition?', status: statusOf(n, count((o) => o.requisition.origin === 'brief_identity')), evidence: `${count((o) => o.requisition.origin === 'brief_identity')} of ${n} keyed by a stored brief identity; ${count((o) => o.savedRows > 1)} had more than one saved copy`, code: 'brief aliases (saved:<id>, attempt:<id>, source copies)' },
    { question: 'Which provider returned each copy?', status: statusOf(n, count((o) => o.contributions.some((c) => c.provider !== null))), evidence: `${count((o) => o.contributions.some((c) => c.provider !== null))} of ${n} have at least one provider recorded (a hand-entered job has a link but no provider)`, code: 'application_brief_aliases.provider' },
    { question: 'Which query variant found it?', status: statusOf(n, count((o) => o.availability.queryAttribution === 'recorded')), evidence: `${count((o) => o.availability.queryAttribution === 'recorded')} of ${n}: #686 queryProvenance reached the scan rows but no workspace table or brief column stores it`, code: 'not stored (LeadQueryProvenance lives in the scan report JSON only)' },
    { question: 'What role family is it?', status: statusOf(n, count((o) => o.score.roleFamily !== null)), evidence: `${count((o) => o.score.roleFamily !== null)} of ${n}: only a scored job has the deterministic scorer’s primary fit; unscored jobs stay unclassified`, code: 'application_briefs.source_facts.match.primaryFit' },
    { question: 'Was it sent, and on what evidence?', status: 'answerable', evidence: `${sentApps.length} sent application rows: ${sentApps.filter((a) => a.evidence === 'receipt_observed').length} receipt-observed, ${sentApps.filter((a) => a.evidence === 'user_reported').length} user-reported, ${sentApps.filter((a) => a.evidence === 'user_stated').length} user-stated`, code: 'classifySubmission (#692) over applications + application_attempts' },
    { question: 'When was it sent?', status: statusOf(sentApps.length, sentApps.filter((a) => a.sentAt !== null).length), evidence: `${sentApps.filter((a) => a.sentAt !== null).length} of ${sentApps.length} sent rows have a date`, code: 'applications.applied_at / application_attempts.submitted_at' },
    { question: 'What happened to it, and when did that change?', status: 'partial', evidence: 'the current status only: no change time, no source, no reason; "applied" with nothing later is an unobserved outcome, not a recorded one', code: 'applications.status (one mutable value)' },
    { question: 'Were interviews held?', status: 'answerable', evidence: `${observations.flatMap((o) => o.applications).filter((a) => a.heldRounds > 0).length} application row(s) with a held round recorded`, code: 'application_interview_rounds (#691)' },
    { question: 'What requirements did the posting list, and how does the CV evidence each?', status: statusOf(n, count((o) => o.assessment.state === 'current')), evidence: `${count((o) => o.assessment.state === 'current')} of ${n} have a current assessment; ${count((o) => o.assessment.state === 'none')} have none`, code: 'cv_evidence_overlays.requirements (only where "Compare with my CV" was run)' },
    { question: 'Did the person record that they lack an experience?', status: 'partial', evidence: `answerable only where assessed: ${observations.flatMap((o) => o.assessment.requirements).filter((r) => r.evidenceClass === 'candidate_confirmed_gap').length} candidate_confirmed_gap requirement(s)`, code: 'CvRequirementMapping.evidenceClass = candidate_confirmed_gap' },
    { question: 'Does the job conflict with a stated preference or eligibility?', status: statusOf(n, count((o) => o.eligibility.length > 0)), evidence: `${count((o) => o.eligibility.length > 0)} of ${n} carry scan eligibility answers; ${observations.flatMap((o) => o.eligibility).filter((e) => e.classification === 'known_mismatch').length} known mismatch(es)`, code: 'application_briefs.source_facts.eligibility + classifyEligibility' },
    { question: 'Which JD, CV and rule version was an assessment made under?', status: 'partial', evidence: 'hashes only (JD hash, reviewed-CV hash, brief workflow version); no CV or JD text history, so compatibility is hash equality', code: 'cv_evidence_overlays hashes; assessment.inputs.workflowVersion' },
    { question: 'How many leads were shown but not selected?', status: 'not_recorded', evidence: 'no table stores leads that were not saved', code: 'not stored' },
    { question: 'Which jobs did the person drop?', status: 'not_recorded', evidence: 'deleting a saved job removes it unless an application row still keeps the requisition (applications.saved_job_id is set to null); deleting the application too removes it. What the person dropped is invisible, so the data describes the jobs and applications the person kept', code: 'not stored' },
    { question: 'Which JD wording and revision was each requirement read from, and did the person add it?', status: statusOf(observations.flatMap((o) => o.assessment.requirements).length, observations.flatMap((o) => o.assessment.requirements).filter((r) => r.jdAnchor !== '').length), evidence: `${observations.flatMap((o) => o.assessment.requirements).filter((r) => r.jdAnchor !== '').length} of ${observations.flatMap((o) => o.assessment.requirements).length} requirements carry their verbatim JD quote; ${observations.flatMap((o) => o.assessment.requirements).filter((r) => r.candidateAdded).length} were added by the person; classes direct / transferable / unsupported / needs_verification are model-proposed and person-reviewed, candidate_confirmed_gap is the person's own statement`, code: 'cv_evidence_overlays.requirements jdAnchor / jdRevisionId / quoteStart / candidateAdded' },
    { question: 'Is the title or a scorer hint on an unassessed job ever read as a requirement?', status: 'answerable', evidence: `no: ${negativeControl.titledJobs} unassessed job(s) carry a Kubernetes title, posting text and scorer hint; requirement rows, lane totals and requirement suggestions are identical with and without them (${negativeControl.requirementRowsIdentical})`, code: 'workspace-contract.test.ts negative control' },
  ];

  return {
    kind: 'synthetic data written through the app’s real writers into a migrated SQLite database, read by the read-only adapter; deterministic fields only',
    asOf: REAL_AS_OF,
    sourceRows: read.sourceRows,
    requisitions: observations.map((o) => ({
      key: o.requisition.key,
      tier: o.requisition.tier,
      keyOrigin: o.requisition.origin,
      savedCopies: o.savedRows,
      sourceContributions: o.contributions.length,
      displayTitle: o.hints?.title ?? null,
      scorerHints: { matchingSkills: o.hints?.scorerMatchingSkills ?? [], gaps: o.hints?.scorerGaps ?? [] },
      providers: o.contributions.map((c) => c.provider).sort(),
      queryRefs: [...new Set(o.contributions.map((c) => (c.queryRefs === 'not_recorded' ? 'not_recorded' : 'recorded')))],
      score: o.score,
      applications: o.applications.map((a) => ({ submission: a.submission, evidence: a.evidence, sentAt: a.sentAt, status: a.status, heldRounds: a.heldRounds, isReapplication: a.reapplicationOf !== null, statusHistory: a.statusHistory })),
      assessment: {
        state: o.assessment.state,
        requirements: o.assessment.requirements.map((r) => `${r.text}:${r.evidenceClass}`),
        requirementEvidence: o.assessment.requirements.map((r) => ({ text: r.text, classification: r.classification, evidenceClass: r.evidenceClass, evidenceOrigin: evidenceOriginOf(r), reviewed: r.reviewed, candidateAdded: r.candidateAdded, jdAnchor: r.jdAnchor, jdRevisionRecorded: r.jdRevisionId !== '', quoteSpan: r.quoteSpan })),
      },
      eligibilityKnownMismatch: o.eligibility.filter((e) => e.classification === 'known_mismatch').map((e) => e.key),
    })),
    funnel: {
      totals: funnels.source.totals,
      verdicts: { source: funnels.source.metrics, queryVariant: funnels.queryVariant.metrics },
      cellsBySource: funnels.source.cells.map((c) => ({ label: c.label, requisitions: c.requisitions, sent: c.sent, matureSent: c.matureSent, censoredSent: c.censoredSent, undatedSent: c.undatedSent })),
      cellsByQueryVariant: funnels.queryVariant.cells.map((c) => ({ label: c.label, requisitions: c.requisitions })),
      cellsByRoleFamily: funnels.roleFamily.cells.map((c) => ({ label: c.label, requisitions: c.requisitions })),
    },
    // The reviewed-CV hash changes on every run (the writer stamps a review time into the CV source), so it is reported as a
    // stable label per distinct hash instead of the hash itself.
    requirements: { selected: requirements.selected, assessment: { ...requirements.assessment, versionClasses: requirements.assessment.versionClasses.map((entry, index) => ({ ...entry, versionClass: entry.versionClass.replace(/\|[0-9a-f]{64}$/u, `|cv-version-${index + 1}`) })) }, verdict: requirements.verdict, rows: requirements.requirements.map((r) => ({ label: r.label, jobsPresent: r.jobsPresent, byLane: r.byLane, byClassification: r.byClassification })), eligibility: requirements.eligibility.map((r) => ({ key: r.key, jobsKnownMismatch: r.jobsKnownMismatch })) },
    suggestions: { produced: suggestions.suggestions.length, withheld: suggestions.withheld },
    negativeControl,
    answerability,
    unrecoverable: read.unrecoverable,
  };
}

async function fullReport() {
  return { ...runEvaluation(), realContractLane: await realContractLane() };
}

describe('#693 evaluation', () => {
  it('has no mismatch between the fixture-author expectations and what the prototype reports', () => {
    const report = runEvaluation();
    expect(report.summary.checksWithMismatch, JSON.stringify(report.summary.mismatchDetail, null, 1)).toBe(0);
    expect(report.summary.portfolios).toBe(PORTFOLIOS.length);
    expect(report.summary.checks).toBeGreaterThanOrEqual(PORTFOLIOS.length + 1);
    expect(report.portfolios.every((portfolio) => portfolio.inputUnchanged)).toBe(true);
  });

  it('demonstrates go and no-go, including every named no-go condition', () => {
    const report = runEvaluation();
    expect(report.summary.goReviewPortfolios).toContain('rich_projected');
    const reasons = new Set(report.portfolios.flatMap((p) => [...p.verdicts.funnel.outcomeDistribution.reasons, ...p.verdicts.requirements.reasons]));
    for (const reason of ['too_few_mature_sent', 'unknown_outcomes_dominate', 'weak_identity_dominates', 'duplicate_copies_dominate', 'too_few_assessed', 'unassessed_dominate', 'version_incompatible_dominates', 'no_recurring_requirement']) {
      expect(reasons.has(reason as never), reason).toBe(true);
    }
    // Every portfolio that is not the rich projected one is a no-go for at least one view: only invented, instrumented data passes.
    expect(report.summary.noGoPortfolios.length).toBeGreaterThanOrEqual(PORTFOLIOS.length - 1);
  });

  it('holds the invariances: rejection, silence and fit opinion do not change a requirement, a lane or a suggestion', () => {
    const result = invariances();
    expect(result.outcomesFlipped.coreIdenticalAcrossRejectedInterviewAndActual).toBe(true);
    expect(result.outcomesFlipped.outcomeContextDiffers).toBe(true);
    expect(result.scoresChanged.coreIdenticalAcrossNullZeroHigh).toBe(true);
    expect(result.scoresChanged.evaluatorOpinionCounts.allMissing).toMatchObject({ scored: 0, unscored: 30 });
    expect(result.scoresChanged.evaluatorOpinionCounts.allZero).toMatchObject({ scored: 30, unscored: 0 });
    expect(result.noAssessmentMeansNoRequirements).toMatchObject({ requirementRows: 0, requirementSuggestions: 0 });
    // Non-vacuous negative control: the portfolio really contains Kubernetes titles and hints, and still yields nothing.
    expect(result.titleOnlyNegativeControl).toMatchObject({ jobsTitledKubernetes: 8, jobsWithKubernetesScorerHint: 8, jobsNotAssessed: 12, prototypeRequirementRows: 0, prototypeRequirementSuggestions: 0, invarianceDetectsALeakyRule: true });
    expect(result.titleOnlyNegativeControl.leakyRuleWouldProduceRows).toBeGreaterThan(0);
    expect(result.titlesAndScorerHintsChanged).toMatchObject({ coreIdenticalWhenEveryTitleAndHintSaysKubernetes: true, coreIdenticalWhenEveryTitleAndHintIsBlank: true });
    // Preferred stays preferred.
    expect(result.classificationMatters).toMatchObject({ thresholdCountsAllClasses: true, forcingEveryClassToRequiredChangesTheWording: true, forcingEveryClassToRequiredChangesNoRowCountOrLane: true });
    expect(result.classificationMatters.allPreferredRow).toMatchObject({ subject: 'On-call rota', classificationMix: 'all_preferred', statementUsesMandatoryWording: false });
    expect(result.classificationMatters.mixedRow).toMatchObject({ classificationMix: 'mixed', byClassification: { required: 3, preferred: 1, unclear: 1 } });
    expect(result.dismissal).toMatchObject({ startedWith: 6, visibleAfterDismiss: 5, stillListedAsDismissed: 1, stateChanged: true, staysDismissedAfterTwoMoreSupportingJobs: true, newSupportReported: 2, allEffectsNone: true, everySuggestionCarriesEvidence: true, everyRequirementSuggestionNamesItsJobs: true });
  });

  it('shows what the simpler rules get wrong on the same fixture', () => {
    const result = baselines();
    expect(result.rejectionAsGap.calledGapButSupportedByCv).toBeGreaterThan(0);
    // Derived from the fixture's own titles, not from "every unassessed job".
    expect(result.titleKeywordGap.gapsAttributedByRule).toBe(result.titleKeywordGap.ofWhichTitleSaysKubernetes);
    expect(result.titleKeywordGap.ofWhichTitleSaysKubernetes).toBeGreaterThan(0);
    expect(result.titleKeywordGap.ofWhichTitleSaysKubernetes).toBeLessThan(result.titleKeywordGap.unassessedJobs);
    expect(result.titleKeywordGap.gapsAttributedByPrototype).toBe(0);
    expect(result.scorerHintGap.gapsAttributedByRule).toBe(result.scorerHintGap.ofWhichScorerHintMentionsKubernetes);
    expect(result.scorerHintGap.ofWhichScorerHintMentionsKubernetes).toBeLessThan(result.scorerHintGap.unassessedJobs);
    expect(result.scorerHintGap.gapsAttributedByPrototype).toBe(0);
    expect(result.cellsSummedAsPartition.impossibleExcess).toBeGreaterThan(0);
    expect(result.copiesCountedAsJobs.jobsCountedByRule).toBeGreaterThan(result.copiesCountedAsJobs.distinctRequisitions);
    expect(result.rateAmongKnownOutcomesOnly.ruleRate).not.toBeNull();
    expect(result.rateAmongKnownOutcomesOnly.prototypeBounds.upper).toBeGreaterThan(result.rateAmongKnownOutcomesOnly.prototypeBounds.lower);
  });

  it('labels the desk comparison honestly: counted operations, source-read manual side, a case where manual review is better', () => {
    const desk = deskComparison();
    expect(desk.method.join(' ')).toMatch(/SOURCE READING/u);
    expect(desk.method.join(' ')).toMatch(/not time/iu);
    expect(desk.questions.some((q) => /manual/u.test(q.betterForPerJobDetail) || /manual/u.test(q.betterForCountingAcrossJobs))).toBe(true);
    expect(desk.questions.find((q) => q.id === 'q5_context_only_in_free_text')!.betterForCountingAcrossJobs).toMatch(/^manual/u);
    expect(desk.limits.join(' ')).toMatch(/No human did any of this/u);
    expect(JSON.stringify(desk)).not.toMatch(/human.validated|participants|user study found/iu);
  });

  it('counts the manual side by distinct records: one saved-job drawer answers Q1-Q3 and is counted once, with no headline that multiplies it', () => {
    const desk = deskComparison();
    const perQuestion = desk.totals.perQuestionDistinctRecords;
    // The same 30 drawers serve Q1, Q2 and Q3.
    expect(perQuestion.q1).toBe(30);
    expect(perQuestion.q2).toBe(30);
    expect(perQuestion.q3).toBe(30);
    // Q4 adds the applications table once; its sent-application drawers are the ones already opened.
    expect(perQuestion.q4).toBe(1 + desk.cases.sentApplications);
    // The union is smaller than the per-question sum: the overlap is reported, never summed into a headline.
    expect(desk.totals.overlapIfPerQuestionCountsWereAdded.distinctUnion).toBe(desk.totals.distinctRecordsOpenedByHand);
    expect(desk.totals.overlapIfPerQuestionCountsWereAdded.naiveSum).toBeGreaterThan(desk.totals.distinctRecordsOpenedByHand);
    expect(desk.totals.overlapIfPerQuestionCountsWereAdded.doubleCounted).toBe(desk.totals.overlapIfPerQuestionCountsWereAdded.naiveSum - desk.totals.distinctRecordsOpenedByHand);
    const kinds = desk.totals.distinctRecordsByKind;
    expect(kinds.savedJobDrawers).toBe(30);
    expect(Object.values(kinds).reduce((sum, value) => sum + value, 0)).toBe(desk.totals.distinctRecordsOpenedByHand);
    // The old inflated headline is gone, and no ratio of hand-opens to prototype runs is offered.
    const text = JSON.stringify(desk);
    expect(text).not.toMatch(/manualOperationsAcrossQuestions|prototypeOperationsAcrossQuestions|\b143\b/u);
    expect(desk.totals.prototypeRuns).toBe(1);
    expect(desk.totals.prerequisiteForPrototype).toMatch(/had to be assessed/u);
    expect(desk.totals.note).toMatch(/not a time or usability saving/u);
    expect(desk.method.join(' ')).toMatch(/saves no assessment work/u);
  });

  it('lists the surfaces the first version left out: #691 round notes, #692 follow-ups and drafts, and the GapAnalysis origin of the Fit check', () => {
    const desk = deskComparison();
    expect(desk.surfaces.interviewRounds).toMatch(/InterviewRoundsPanel.*#691/u);
    expect(desk.surfaces.followUps).toMatch(/FollowUpsDrawer.*FollowUpDraftCard.*#692/u);
    expect(desk.surfaces.gapAnalysis).toMatch(/GapAnalysis\.tsx.*saveGapAnalysis.*PRODUCES the kept Fit check/u);
    const q5 = desk.questions.find((q) => q.id === 'q5_context_only_in_free_text')!;
    expect(q5.manual).toMatchObject({ applicationDrawersWithText: 3, interviewRoundPanelsWithText: 2, followUpDrawersWithText: 2, distinctRecords: 7 });
    expect(q5.prototype.runs).toBe(0);
    expect(desk.totals.prototypeQuestionsNotAnswered).toEqual(['q5_context_only_in_free_text']);
  });

  it('matches the checked-in evaluation byte for byte, and can regenerate it', async () => {
    const report = await fullReport();
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (process.env.OVR_EVAL_OUT) writeFileSync(process.env.OVR_EVAL_OUT, text, 'utf8');
    // The real-contract lane must show the same limits the contract test proves.
    expect(report.realContractLane.funnel.verdicts.queryVariant.perCellOutcomeComparison.reasons).toContain('no_query_attribution');
    expect(report.realContractLane.answerability.filter((entry) => entry.status === 'not_recorded').map((entry) => entry.question)).toEqual(
      expect.arrayContaining(['Which query variant found it?', 'How many leads were shown but not selected?', 'Which jobs did the person drop?']),
    );
    expect(report.realContractLane.suggestions.produced).toBe(0);
    // The real-database negative control: an unassessed job titled, worded and hinted Kubernetes changes nothing.
    expect(report.realContractLane.negativeControl).toMatchObject({ titledJobs: 1, requirementRowsIdentical: true, requirementSuggestions: 0 });
    expect(report.realContractLane.negativeControl.selectedWithJobs - report.realContractLane.negativeControl.selectedWithoutJobs).toBe(1);
    expect(report.realContractLane.negativeControl.notAssessedWithJobs - report.realContractLane.negativeControl.notAssessedWithoutJobs).toBe(1);
    expect(report.realContractLane.negativeControl.jobs[0]).toMatchObject({ assessmentState: 'none', requirements: 0, applications: 0 });
    expect(existsSync(committedPath), `the evaluation is not checked in at ${committedPath}; run with OVR_EVAL_OUT to create it`).toBe(true);
    expect(readFileSync(committedPath, 'utf8').replace(/\r\n/gu, '\n')).toBe(text);
  });
});
