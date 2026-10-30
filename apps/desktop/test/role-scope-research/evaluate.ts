import {
  assessWorkEligibility,
  candidateWorkLanguages,
  normalizeCountry,
  type CandidateProfile,
  vacancyTitleMatches,
  type DiscoveryVacancyAudit,
} from '@open-vacancy-radar/vacancy-engine';

// The evaluator is not re-exported from the package index, so it is reached through its own module's public
// export (packages/vacancy-engine/src/filtering/index.ts) and the pipeline step that calls it per row
// (applyWorldwideProfileScores, packages/vacancy-engine/src/pipeline/global-remote.ts). Same precedent as
// apps/desktop/test/vacancy-scan-run.test.ts.
import {
  RELEVANCE_THRESHOLD,
  scoreWorldwideVacancy,
  type WorldwideDeterministicScore,
} from '../../../../packages/vacancy-engine/src/filtering/index.js';
import { applyWorldwideProfileScores } from '../../../../packages/vacancy-engine/src/pipeline/global-remote.js';
// The discovery pre-classification (`role_mismatch` and friends), a separate, title-only gate.
import { classifyDiscoveryVacancy } from '../../../../packages/vacancy-engine/src/global-remote/evaluation.js';

import { sortResults, toPartialResults } from '../../src/components/search/results.js';
import { compareRoleFamily, COMPARATOR_VERSION, EXPLANATION_SCHEMA_VERSION, SPARSE_WORDS, verdictTier, type RoleFamilyExplanation } from './comparator.js';
import {
  AS_OF,
  CORPUS,
  CORPUS_VERSION,
  LABEL_KIND,
  OUTCOME_NOISE,
  POSTED_AT,
  PROFILES,
  type CorpusCase,
  type Grade,
  type Tag,
} from './fixtures.js';
import { compilePlan, matchingQueries, PLANS, type PlanId } from './plans.js';

/**
 * #694 evaluation. Pure and deterministic: fixed clock, no randomness, no network, no model, no file I/O.
 * `docs/research/role-scope/694-evaluation.json` is exactly `runEvaluation()`; evaluation.test.ts fails when a
 * fresh run differs from the committed bytes.
 *
 * Three things are kept apart throughout, because a ranker cannot recover a job that was never discovered:
 *   1. scorer      every in-corpus case scored AS IF retrieved (correctness of the role/technical call).
 *   2. retrieval   which cases a query plan's OR set would keep (a projection over the corpus, not live sources).
 *   3. ranking     the order of only the cases a plan retrieved (top-k and labelled pairs).
 * Eligibility facts (work country, mandatory language) are reported beside them and never folded into a grade.
 */

export const EVALUATION_VERSION = '694-evaluation/1.0.0';
export const BASE_COMMIT = 'd31a4b88';

export const RESOURCE_ENVELOPE = Object.freeze({
  description:
    'Identical for both evaluators: the same synthetic profile and the same title/description text per case, one synchronous in-process call per (case, profile), no network, no model, no provider, no file I/O, no cache, no retries.',
  networkCalls: 0,
  modelCalls: 0,
  providerCalls: 0,
  tokens: 'not_applicable: no model is called',
  cost: 'not_applicable: no metered service is called',
  latency:
    'measured in evaluation.test.ts with performance.now() and written only to OVR_LATENCY_OUT when set; NOT committed, because wall-clock time is not deterministic and would break the byte comparison',
});

const GRADE_RANK: Record<Exclude<Grade, null>, number> = { relevant: 2, adjacent: 1, not_relevant: 0 };

let currentCalls = 0;
let comparatorCalls = 0;

function auditRow(item: CorpusCase): DiscoveryVacancyAudit {
  return {
    key: item.id,
    provider: 'jobicy',
    company: item.company,
    title: item.title,
    url: `https://example.invalid/role-scope/${item.id}`,
    location: item.location,
    employmentType: null,
    currency: null,
    salaryPeriod: null,
    advertisedMinimum: null,
    annualizedMinimumUsd: null,
    decision: 'official_review_candidate',
    reasons: [],
    contentHash: `synthetic-${item.id}`,
    description: item.description,
    postedAt: POSTED_AT,
    profileScore: null,
    worldwideSponsorMatch: null,
  };
}

let pipelineCalls = 0;

/** The production pipeline step that scores report rows (one scorer call per row, #367). */
function scoreRows(items: readonly CorpusCase[], profile: CandidateProfile): (DiscoveryVacancyAudit & { profileScore: number })[] {
  pipelineCalls += items.length;
  return applyWorldwideProfileScores(items.map(auditRow), profile, null).map((row) => ({ ...row, profileScore: row.profileScore! }));
}

/** The real production scorer through its public boundary, exactly as the pipeline calls it per row. */
export function currentScore(item: Pick<CorpusCase, 'title' | 'description'>, profile: CandidateProfile): WorldwideDeterministicScore | null {
  currentCalls += 1;
  // Salary is out of scope here: no advertised USD floor and no configured minimum, so no salary cap applies.
  return scoreWorldwideVacancy({ title: item.title, description: item.description, annualizedMinimumUsd: null }, profile, null);
}

export function comparator(item: Pick<CorpusCase, 'title' | 'description'>, profile: CandidateProfile): RoleFamilyExplanation {
  comparatorCalls += 1;
  return compareRoleFamily({ title: item.title, description: item.description }, profile);
}

export function eligibilityOf(item: Pick<CorpusCase, 'description' | 'location'>, profile: CandidateProfile) {
  const evidence = assessWorkEligibility(
    {
      description: item.description,
      location: item.location,
      candidateWorkCountry: normalizeCountry(profile.constraints.primaryCountry),
      candidateLanguages: candidateWorkLanguages(profile),
      candidateRelocationWilling: null,
      employerRegisterMatch: null,
      currency: null,
      salaryPeriod: null,
      advertisedMinimum: null,
      observedAt: POSTED_AT,
    },
    new Date(AS_OF),
  );
  return { candidateWorkCountry: evidence.candidateWorkCountry.answer, mandatoryLanguage: evidence.mandatoryLanguage.answer };
}

type CurrentClass = 'at_or_above_threshold' | 'below_threshold';
type Cause =
  | 'eligibility_language_cap'
  | 'sparse_description'
  | 'role_title_rule'
  | 'technical_vocabulary'
  | 'threshold_margin';

function causeOf(item: CorpusCase, score: WorldwideDeterministicScore): Cause {
  if (score.unmetMandatoryLanguages.length > 0) return 'eligibility_language_cap';
  const words = (item.description ?? '').split(/\s+/u).filter(Boolean).length;
  if (words < SPARSE_WORDS) return 'sparse_description';
  if (score.roleFit < 60) return 'role_title_rule';
  if (score.technicalFit < 50) return 'technical_vocabulary';
  return 'threshold_margin';
}

interface ScorerRow {
  id: string;
  title: string;
  tags: readonly Tag[];
  availability: CorpusCase['availability'];
  label: { grade: Grade; evidence: string };
  current: {
    score: number;
    class: CurrentClass;
    technicalFit: number;
    roleFit: number;
    seniorityFit: number;
    primaryFit: string;
    unmetMandatoryLanguages: string[];
    matchingSkills: string[];
  };
  optionB: Pick<RoleFamilyExplanation, 'verdict' | 'confidence' | 'titleFamily' | 'vacancyFamily' | 'lean' | 'evidence' | 'reasonCodes'> & {
    signals: RoleFamilyExplanation['signals'];
    ignoredPreferenceSignals: string[];
  };
}

function scorerRows(profileId: 'frontend' | 'backend_research'): ScorerRow[] {
  const profile = PROFILES[profileId];
  return CORPUS.map((item) => {
    const score = currentScore(item, profile)!;
    const b = comparator(item, profile);
    const label = item.expect[profileId];
    return {
      id: item.id,
      title: item.title,
      tags: item.tags,
      availability: item.availability,
      label: { grade: label.grade, evidence: label.evidence },
      current: {
        score: score.deterministicScore,
        class: score.relevant ? 'at_or_above_threshold' : 'below_threshold',
        technicalFit: score.technicalFit,
        roleFit: score.roleFit,
        seniorityFit: score.seniorityFit,
        primaryFit: score.primaryFit,
        unmetMandatoryLanguages: score.unmetMandatoryLanguages,
        matchingSkills: score.matchingSkills,
      },
      optionB: {
        verdict: b.verdict,
        confidence: b.confidence,
        titleFamily: b.titleFamily,
        vacancyFamily: b.vacancyFamily,
        lean: b.lean,
        evidence: b.evidence,
        reasonCodes: b.reasonCodes,
        signals: b.signals,
        ignoredPreferenceSignals: b.ignoredPreferenceSignals,
      },
    };
  });
}

const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id);

/** Grade x prediction cells, as case-id lists. No percentages: every cell is shown with its cases. */
function scorerSummary(rows: readonly ScorerRow[], profile: CandidateProfile) {
  const byGrade = (grade: Grade) => rows.filter((row) => row.label.grade === grade);
  const currentCells = Object.fromEntries(
    (['relevant', 'adjacent', 'not_relevant'] as const).map((grade) => [
      grade,
      {
        cases: byGrade(grade).length,
        at_or_above_threshold: ids(byGrade(grade).filter((row) => row.current.class === 'at_or_above_threshold')),
        below_threshold: ids(byGrade(grade).filter((row) => row.current.class === 'below_threshold')),
      },
    ]),
  );
  const optionBCells = Object.fromEntries(
    (['relevant', 'adjacent', 'not_relevant'] as const).map((grade) => [
      grade,
      {
        cases: byGrade(grade).length,
        ...Object.fromEntries(
          (['match', 'adjacent', 'mismatch', 'uncertain', 'unsupported_family'] as const).map((verdict) => [
            verdict,
            ids(byGrade(grade).filter((row) => row.optionB.verdict === verdict)),
          ]),
        ),
      },
    ]),
  );
  const relevantBelowThreshold = byGrade('relevant')
    .filter((row) => row.current.class === 'below_threshold')
    .map((row) => {
      const item = CORPUS.find((entry) => entry.id === row.id)!;
      const cause = causeOf(item, currentScore(item, profile)!);
      return {
        id: row.id,
        title: row.title,
        score: row.current.score,
        roleFit: row.current.roleFit,
        technicalFit: row.current.technicalFit,
        primaryFit: row.current.primaryFit,
        cause,
        // For a language cap: does the fixture author also read the posting as stating a mandatory language?
        capAgreesWithFixtureReading:
          cause === 'eligibility_language_cap' ? (item.expectEligibility?.mandatoryLanguage ?? null) === 'no' : null,
      };
    });
  const notRelevantAtOrAboveThreshold = byGrade('not_relevant')
    .filter((row) => row.current.class === 'at_or_above_threshold')
    .map((row) => ({ id: row.id, title: row.title, score: row.current.score, primaryFit: row.current.primaryFit }));
  const optionBErrors = {
    relevantCalledMismatch: ids(byGrade('relevant').filter((row) => row.optionB.verdict === 'mismatch')),
    notRelevantCalledMatch: ids(byGrade('not_relevant').filter((row) => row.optionB.verdict === 'match')),
    abstained: ids(rows.filter((row) => row.optionB.verdict === 'uncertain')),
  };
  return {
    labelledCases: rows.filter((row) => row.label.grade !== null).length,
    unlabelledCases: ids(byGrade(null)),
    currentEvaluator: { threshold: RELEVANCE_THRESHOLD, cells: currentCells, relevantBelowThreshold, notRelevantAtOrAboveThreshold, unlabelled: byGrade(null).map((row) => ({ id: row.id, score: row.current.score })) },
    optionB: { cells: optionBCells, errors: optionBErrors },
  };
}

function retrievalFor(planId: PlanId) {
  const plan = PLANS.find((entry) => entry.id === planId)!;
  const { compiled, queries } = compilePlan(plan);
  const rows = CORPUS.map((item) => {
    const available = item.availability === 'in_configured_source';
    const matchedBy = available ? matchingQueries(auditRow(item), queries) : [];
    return { id: item.id, grade: item.expect[plan.profile].grade, availability: item.availability, matchedBy, retrieved: matchedBy.length > 0 };
  });
  const unavailable = rows.filter((row) => row.availability !== 'in_configured_source');
  const available = rows.filter((row) => row.availability === 'in_configured_source');
  const retrieved = available.filter((row) => row.retrieved);
  const missed = available.filter((row) => !row.retrieved);
  const gradeSplit = (list: typeof rows) => ({
    relevant: ids(list.filter((row) => row.grade === 'relevant')),
    adjacent: ids(list.filter((row) => row.grade === 'adjacent')),
    not_relevant: ids(list.filter((row) => row.grade === 'not_relevant')),
    unlabelled: ids(list.filter((row) => row.grade === null)),
  });
  return {
    plan: { ...compiled, status: plan.status, profile: plan.profile },
    corpusCases: rows.length,
    notInAnyConfiguredSource: { cases: unavailable.length, byGrade: gradeSplit(unavailable) },
    inConfiguredSource: available.length,
    retrieved: { cases: retrieved.length, byGrade: gradeSplit(retrieved) },
    availableButNotMatched: { cases: missed.length, byGrade: gradeSplit(missed) },
    perCase: rows.map(({ id, matchedBy, availability }) => ({ id, availability, matchedBy })),
    retrievedIds: ids(retrieved),
  };
}

function pairwise<T extends { id: string; grade: Grade }>(rows: readonly T[], value: (row: T) => number, higherIsBetter: boolean) {
  let pairs = 0;
  let concordant = 0;
  let tied = 0;
  const discordantPairs: string[] = [];
  const tiedPairs: string[] = [];
  const labelled = rows.filter((row) => row.grade !== null);
  for (let i = 0; i < labelled.length; i += 1) {
    for (let j = i + 1; j < labelled.length; j += 1) {
      const a = labelled[i]!;
      const b = labelled[j]!;
      if (a.grade === b.grade) continue;
      pairs += 1;
      const [hi, lo] = GRADE_RANK[a.grade!] > GRADE_RANK[b.grade!] ? [a, b] : [b, a];
      const diff = higherIsBetter ? value(hi) - value(lo) : value(lo) - value(hi);
      if (diff > 0) concordant += 1;
      else if (diff === 0) {
        tied += 1;
        tiedPairs.push(`${hi.id}>${lo.id}`);
      } else discordantPairs.push(`${hi.id}>${lo.id}`);
    }
  }
  return { labelledPairsWithDifferentGrades: pairs, concordant, tied, discordant: discordantPairs.length, discordantPairs, tiedPairs };
}

function topK(order: readonly string[], gradeOf: (id: string) => Grade, k: number) {
  const top = order.slice(0, k);
  return {
    k,
    ids: top,
    relevant: top.filter((id) => gradeOf(id) === 'relevant').length,
    adjacent: top.filter((id) => gradeOf(id) === 'adjacent').length,
    not_relevant: top.filter((id) => gradeOf(id) === 'not_relevant').length,
    unlabelled: top.filter((id) => gradeOf(id) === null).length,
  };
}

function rankingFor(planId: PlanId, retrievedIds: readonly string[]) {
  const plan = PLANS.find((entry) => entry.id === planId)!;
  const profile = PROFILES[plan.profile];
  const items = CORPUS.filter((item) => retrievedIds.includes(item.id));
  const gradeOf = (id: string) => CORPUS.find((item) => item.id === id)!.expect[plan.profile].grade;
  const scored = scoreRows(items, profile);
  // The real Search ordering (#367/#395/#464): scored rows by profile score, ties by date, then title, then key.
  const currentOrder = sortResults(toPartialResults(scored), plan.literal).map((result) => result.key);
  const scoreOf = new Map(scored.map((row) => [row.key, row.profileScore]));
  const languageCapped = new Set(scored.filter((row) => (row.profileMatch?.unmetMandatoryLanguages.length ?? 0) > 0).map((row) => row.key));
  const tierOf = new Map(items.map((item) => [item.id, verdictTier(comparator(item, profile))]));
  const fsignals = new Map(items.map((item) => [item.id, comparator(item, profile).signals[plan.profile === 'frontend' ? 'frontend' : 'backend'].length]));
  const optionBOrder = [...items]
    .sort((a, b) => tierOf.get(a.id)! - tierOf.get(b.id)! || fsignals.get(b.id)! - fsignals.get(a.id)! || a.id.localeCompare(b.id))
    .map((item) => item.id);
  const rows = items.map((item) => ({ id: item.id, grade: gradeOf(item.id) }));
  const relevantRetrieved = rows.filter((row) => row.grade === 'relevant').length;
  return {
    retrievedCases: items.length,
    relevantRetrieved,
    current: {
      order: currentOrder.map((id) => ({ id, score: scoreOf.get(id)!, grade: gradeOf(id) })),
      topK: [3, 5, 10, 20].map((k) => topK(currentOrder, gradeOf, k)),
      pairwise: pairwise(rows, (row) => scoreOf.get(row.id)!, true),
      // The same pairs without rows the mandatory-language gate capped: role/technical ordering on its own.
      pairwiseExcludingLanguageCapped: pairwise(
        rows.filter((row) => !languageCapped.has(row.id)),
        (row) => scoreOf.get(row.id)!,
        true,
      ),
      languageCapped: [...languageCapped],
    },
    optionB: {
      order: optionBOrder.map((id) => ({ id, tier: tierOf.get(id)!, grade: gradeOf(id) })),
      topK: [3, 5, 10, 20].map((k) => topK(optionBOrder, gradeOf, k)),
      pairwise: pairwise(rows, (row) => tierOf.get(row.id)!, false),
    },
  };
}

function slices(rows: readonly ScorerRow[]) {
  const profile = PROFILES.frontend;
  const pick = (tags: readonly Tag[]) =>
    rows
      .filter((row) => row.tags.some((tag) => tags.includes(tag)))
      .map((row) => {
        const item = CORPUS.find((entry) => entry.id === row.id)!;
        const eligibility = eligibilityOf(item, profile);
        return {
          id: row.id,
          tags: row.tags.filter((tag) => tags.includes(tag)),
          label: row.label.grade,
          labelEvidence: row.label.evidence,
          current: { score: row.current.score, class: row.current.class, roleFit: row.current.roleFit, unmetMandatoryLanguages: row.current.unmetMandatoryLanguages },
          optionB: { verdict: row.optionB.verdict, confidence: row.optionB.confidence, ignoredPreferenceSignals: row.optionB.ignoredPreferenceSignals },
          eligibility,
          expectedEligibility: item.expectEligibility ?? null,
          eligibilityAsExpected:
            item.expectEligibility === undefined
              ? null
              : Object.entries(item.expectEligibility).every(([key, value]) => eligibility[key as keyof typeof eligibility] === value),
        };
      });
  return {
    sparse: pick(['sparse']),
    language: pick(['language_mandatory', 'language_preferred', 'language_unclear', 'language_unstated']),
    workCountry: pick(['country_known_mismatch', 'country_unknown', 'country_accepted']),
    preferredVsMandatory: pick(['preferred_vs_mandatory']),
    mixedAndAmbiguous: pick(['mixed_full_stack', 'ambiguous_platform_product']),
    equivalentTitles: pick(['equivalent_title', 'non_english_title']),
    outOfScope: pick(['out_of_scope']),
  };
}

/**
 * The discovery pre-classification, run the way discovery runs it (no candidate languages: the language gate is
 * re-applied after discovery), and with #686's approved-title override for P1. Reported for the ROLE gate only:
 * the location and salary gates that follow are out of scope here. In Search this decision is shown in the detail
 * pane and counted in report statistics; it neither hides nor reorders a row.
 */
function preClassification() {
  const plan = PLANS.find((entry) => entry.id === 'P1_frontend_reviewed_686')!;
  const approved = plan.approvedTitles.map((title) => title.title);
  const roleGate = (decision: string) => (decision === 'role_mismatch' ? 'role_mismatch' : decision === 'non_vacancy' ? 'non_vacancy' : 'passed_role_gate');
  const rows = CORPUS.map((item) => {
    const base = { title: item.title, location: item.location, annualizedMinimumUsd: null, minimumAnnualBaseUsd: null, description: item.description };
    const withoutPlan = classifyDiscoveryVacancy(base).decision;
    const approvedTitle = withoutPlan === 'role_mismatch' ? approved.find((title) => vacancyTitleMatches({ title: item.title }, title)) : undefined;
    const withPlan = approvedTitle === undefined ? withoutPlan : classifyDiscoveryVacancy({ ...base, approvedTitle }).decision;
    return { id: item.id, grade: item.expect.frontend.grade, withoutPlan: roleGate(withoutPlan), withReviewedPlan: roleGate(withPlan), approvedTitle: approvedTitle ?? null };
  });
  const pick = (grade: Grade, key: 'withoutPlan' | 'withReviewedPlan', gate: string) => ids(rows.filter((row) => row.grade === grade && row[key] === gate));
  return {
    note: 'Title-only discovery gate (packages/vacancy-engine/src/global-remote/evaluation.ts). Shown as "Discovery decision" in the detail pane and counted in report statistics; Search neither hides nor reorders role_mismatch rows.',
    relevantMarkedRoleMismatch: { withoutPlan: pick('relevant', 'withoutPlan', 'role_mismatch'), withReviewedPlan: pick('relevant', 'withReviewedPlan', 'role_mismatch') },
    notRelevantPassingRoleGate: { withoutPlan: pick('not_relevant', 'withoutPlan', 'passed_role_gate'), withReviewedPlan: pick('not_relevant', 'withReviewedPlan', 'passed_role_gate') },
    adjacentMarkedRoleMismatch: { withoutPlan: pick('adjacent', 'withoutPlan', 'role_mismatch'), withReviewedPlan: pick('adjacent', 'withReviewedPlan', 'role_mismatch') },
    rows,
  };
}

/** What today's evaluator does with targets outside frontend: the core coherence gap of #694. */
function unsupportedFamilyBehaviour() {
  const available = CORPUS.filter((item) => item.availability === 'in_configured_source');
  const sortedByCurrent = (profile: CandidateProfile) =>
    sortResults(toPartialResults(scoreRows(available, profile)), '').map((result) => result.key);
  const backend = PROFILES.backend_research;
  const backendRelevant = available.filter((item) => item.expect.backend_research.grade === 'relevant');
  const currentForBackend = backendRelevant.map((item) => {
    const score = currentScore(item, backend)!;
    return { id: item.id, title: item.title, score: score.deterministicScore, roleFit: score.roleFit, primaryFit: score.primaryFit };
  });
  const backendTop5 = sortedByCurrent(backend).slice(0, 5).map((id) => ({ id, grade: CORPUS.find((item) => item.id === id)!.expect.backend_research.grade, score: currentScore(CORPUS.find((item) => item.id === id)!, backend)!.deterministicScore }));
  const unsupported = PROFILES.unsupported_target;
  const unsupportedTop5 = sortedByCurrent(unsupported).slice(0, 5).map((id) => ({ id, score: currentScore(CORPUS.find((item) => item.id === id)!, unsupported)!.deterministicScore }));
  const unsupportedVerdicts = [...new Set(available.map((item) => comparator(item, unsupported).verdict))];
  // targetRoles is read by the current evaluator only through isCandidateProfileConfigured: swapping the
  // target roles of the frontend profile for backend ones leaves every score identical.
  const swapped: CandidateProfile = { ...PROFILES.frontend, targetRoles: [...backend.targetRoles] };
  const identicalWhenTargetRolesSwapped = CORPUS.every(
    (item) => JSON.stringify(currentScore(item, PROFILES.frontend)) === JSON.stringify(currentScore(item, swapped)),
  );
  return {
    targetRolesChangeCurrentScores: !identicalWhenTargetRolesSwapped,
    backendResearchProfile: {
      backendRelevantCasesInConfiguredSources: backendRelevant.length,
      currentScoresForBackendRelevant: currentForBackend,
      currentTop5ForBackendProfile: backendTop5,
      optionBUnsupportedTargetRoles: comparator(CORPUS[0]!, backend).unsupportedTargetRoles,
    },
    unsupportedTargetProfile: {
      targetRoles: unsupported.targetRoles,
      currentTop5: unsupportedTop5,
      optionBVerdicts: unsupportedVerdicts,
    },
  };
}

function invariances() {
  // 1. Outcomes never become role truth: rows carrying application outcomes score and classify identically.
  const outcomeRows = Object.keys(OUTCOME_NOISE).map((id) => {
    const item = CORPUS.find((entry) => entry.id === id)!;
    const noisy = { ...item, outcome: OUTCOME_NOISE[id], applicationStatus: OUTCOME_NOISE[id] } as CorpusCase & { outcome: string };
    const sameCurrent = (['frontend', 'backend_research'] as const).every(
      (profileId) => JSON.stringify(currentScore(item, PROFILES[profileId])) === JSON.stringify(currentScore(noisy, PROFILES[profileId])),
    );
    const sameB = (['frontend', 'backend_research'] as const).every(
      (profileId) => JSON.stringify(comparator(item, PROFILES[profileId])) === JSON.stringify(comparator(noisy, PROFILES[profileId])),
    );
    return { id, outcome: OUTCOME_NOISE[id], currentUnchanged: sameCurrent, optionBUnchanged: sameB, labelUnchanged: JSON.stringify(item.expect) === JSON.stringify(CORPUS.find((entry) => entry.id === id)!.expect) };
  });
  // 2. An unapproved suggestion never reaches a query.
  const pendingNeverQueried = PLANS.every((plan) => !compilePlan(plan).compiled.pendingSuggestionsReachedQueries);
  // 3. No candidate country configured: every work-country answer stays unknown, never yes or no.
  const noCountry: CandidateProfile = { ...PROFILES.frontend, constraints: { ...PROFILES.frontend.constraints, primaryCountry: '' } };
  const countryAnswersWithoutCountry = [...new Set(CORPUS.map((item) => eligibilityOf(item, noCountry).candidateWorkCountry))];
  // 4. No candidate language configured: every mandatory-language answer stays unknown and no cap applies.
  const noLanguage: CandidateProfile = { ...PROFILES.frontend, constraints: { ...PROFILES.frontend.constraints, professionalLanguage: '' } };
  const languageAnswersWithoutLanguage = [...new Set(CORPUS.map((item) => eligibilityOf(item, noLanguage).mandatoryLanguage))];
  const capsWithoutLanguage = CORPUS.filter((item) => currentScore(item, noLanguage)!.unmetMandatoryLanguages.length > 0).map((item) => item.id);
  // 5. Work country never changes a score: the US-only and accepted-country cases score as their base text does.
  const countryNeutral = ['E01', 'E02', 'E03'].map((id) => currentScore(CORPUS.find((item) => item.id === id)!, PROFILES.frontend)!.deterministicScore);
  return {
    outcomesNeverBecomeRoleTruth: outcomeRows,
    unapprovedSuggestionsNeverQueried: pendingNeverQueried,
    workCountryAnswersWithNoCandidateCountry: countryAnswersWithoutCountry,
    mandatoryLanguageAnswersWithNoCandidateLanguage: languageAnswersWithoutLanguage,
    languageCapsWithNoCandidateLanguage: capsWithoutLanguage,
    currentScoresForCountryCasesE01E02E03: countryNeutral,
  };
}

export function runEvaluation() {
  currentCalls = 0;
  comparatorCalls = 0;
  pipelineCalls = 0;
  const frontendRows = scorerRows('frontend');
  const backendRows = scorerRows('backend_research');
  const retrieval = Object.fromEntries(PLANS.map((plan) => [plan.id, retrievalFor(plan.id)])) as Record<PlanId, ReturnType<typeof retrievalFor>>;
  const ranking = Object.fromEntries(PLANS.map((plan) => [plan.id, rankingFor(plan.id, retrieval[plan.id].retrievedIds)])) as Record<
    PlanId,
    ReturnType<typeof rankingFor>
  >;
  const result = {
    evaluation: EVALUATION_VERSION,
    issue: 694,
    method:
      'Fixed synthetic corpus scored by the production evaluator through its public boundary (scoreWorldwideVacancy), ordered by the production Search sort (sortResults), retrieved through #686 plans compiled by the production functions and matched by the production shared local filter, with eligibility from the production assessor; compared with a research-only deterministic role-family comparator (option B) under the same envelope. No AI comparator was run (see limits).',
    labels: {
      kind: LABEL_KIND,
      meaning: 'Fixture-author expectations written from the synthetic profile and posting text. Not human-reviewed labels, not a panel, not hiring truth.',
      grades: 'relevant > adjacent > not_relevant; null = author could not label (reported, excluded from graded counts)',
    },
    pins: {
      baseCommit: BASE_COMMIT,
      corpus: CORPUS_VERSION,
      cases: CORPUS.length,
      profiles: Object.fromEntries(Object.entries(PROFILES).map(([id, profile]) => [id, profile.profileVersion])),
      currentEvaluator: {
        function: 'scoreWorldwideVacancy',
        file: 'packages/vacancy-engine/src/filtering/relevance.ts',
        threshold: RELEVANCE_THRESHOLD,
        versionConstant: 'none exists in the evaluator; pinned by base commit plus the byte-compared outputs below',
      },
      ranking: { function: 'sortResults', file: 'apps/desktop/src/components/search/results.ts' },
      queryPlans: { compile: 'compileSearchPlanQueries', match: ['vacancyMatchesRole (typed query)', 'vacancyTitleMatches (approved title)'] },
      eligibility: { function: 'assessWorkEligibility', asOf: AS_OF },
      optionB: { comparator: COMPARATOR_VERSION, explanation: EXPLANATION_SCHEMA_VERSION, sparseWords: SPARSE_WORDS },
      model: 'none',
    },
    resourceEnvelope: RESOURCE_ENVELOPE,
    corpus: CORPUS.map((item) => ({
      id: item.id,
      title: item.title,
      tags: item.tags,
      availability: item.availability,
      descriptionWords: (item.description ?? '').split(/\s+/u).filter(Boolean).length,
      expect: item.expect,
      expectEligibility: item.expectEligibility ?? null,
    })),
    scorer: {
      note: 'Every case scored AS IF retrieved. This isolates the role/technical call from discovery.',
      frontend: { summary: scorerSummary(frontendRows, PROFILES.frontend), rows: frontendRows },
      backend_research: { summary: scorerSummary(backendRows, PROFILES.backend_research), rows: backendRows },
    },
    retrieval: {
      note: 'Projection over the in-corpus rows with the production plan compiler and shared local filter. Not live source coverage: no source capability, pagination, cap, failure or upstream ranking is modelled.',
      ...retrieval,
    },
    ranking: {
      note: 'Only the rows each plan retrieved. Ties in the current evaluator are real score ties; the production sort breaks them by date (all equal here), then title, then key.',
      ...ranking,
    },
    preClassification: preClassification(),
    slices: slices(frontendRows),
    unsupportedFamily: unsupportedFamilyBehaviour(),
    invariances: invariances(),
    usage: { currentEvaluatorCalls: 0, pipelineScoredRows: 0, comparatorCalls: 0, networkCalls: 0, modelCalls: 0, tokens: RESOURCE_ENVELOPE.tokens },
  };
  result.usage.currentEvaluatorCalls = currentCalls;
  result.usage.comparatorCalls = comparatorCalls;
  result.usage.pipelineScoredRows = pipelineCalls;
  return result;
}

const NL = '\n';
const isPlain = (value: unknown) => value === null || ['string', 'number', 'boolean'].includes(typeof value);

function formatValue(value: unknown, pad: string): string {
  const inner = `${pad}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every(isPlain)) return `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
    const items = value.map((item) => `${inner}${formatValue(item, inner)}`);
    return `[${NL}${items.join(`,${NL}`)}${NL}${pad}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    if (entries.length === 0) return '{}';
    const items = entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${formatValue(item, inner)}`);
    return `{${NL}${items.join(`,${NL}`)}${NL}${pad}}`;
  }
  return JSON.stringify(value);
}

/** The committed bytes: 2-space JSON with arrays of plain values kept on one line, plus a final newline. */
export function formatEvaluation(value: unknown): string {
  return `${formatValue(value, '')}${NL}`;
}
