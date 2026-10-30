// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { app, job, key, req, score } from './builders.js';
import { COMPATIBLE_ASSESSMENT_WORKFLOW, GATES, deepFreeze } from './contract.js';
import { OUTCOME_CONTEXT_CAVEAT, buildRequirements, laneOf, normalizeRequirementText } from './requirements.js';

const OLD = '2026-08-01T00:00:00.000Z';

/** n assessed jobs, each listing the given requirements. */
function assessed(count: number, requirements: (i: number) => ReturnType<typeof req>[], over: (i: number) => Parameters<typeof job>[1] = () => ({})) {
  return Array.from({ length: count }, (_, index) =>
    job(`j${index + 1}`, { requisition: key('requisition', `ats:t:${index + 1}`), assessment: { state: 'current', requirements: requirements(index + 1) }, ...over(index + 1) }),
  );
}

describe('the lanes are never merged', () => {
  it('maps each recorded evidence class to exactly one lane, and only the person’s own statement is a recorded missing experience', () => {
    expect(laneOf(req('a', 'x', 'candidate_confirmed_gap'))).toBe('recorded_missing_experience');
    expect(laneOf(req('a', 'x', 'unsupported'))).toBe('cv_evidence_not_recorded');
    expect(laneOf(req('a', 'x', 'needs_verification'))).toBe('cv_evidence_not_recorded');
    expect(laneOf(req('a', 'x', 'direct'))).toBe('supported_by_cv');
    expect(laneOf(req('a', 'x', 'transferable'))).toBe('supported_by_cv');
    // The person has not looked at it: it is neither a gap nor evidence.
    expect(laneOf(req('a', 'x', 'unsupported', { reviewed: false }))).toBe('unreviewed');
    expect(laneOf(req('a', 'x', 'direct', { reviewed: false }))).toBe('unreviewed');
    // A person's own gap statement needs no further review.
    expect(laneOf(req('a', 'x', 'candidate_confirmed_gap', { reviewed: false }))).toBe('recorded_missing_experience');
  });

  it('counts a requirement in separate lanes for separate jobs and never adds the lanes together', () => {
    const jobs = assessed(10, (i) => [req('r', 'Kubernetes', i <= 4 ? 'unsupported' : i <= 7 ? 'candidate_confirmed_gap' : 'direct')]);
    const view = buildRequirements(jobs);
    const row = view.requirements.find((entry) => entry.key === 'kubernetes')!;
    expect(row.jobsPresent).toBe(10);
    expect(row.byLane).toEqual({ cv_evidence_not_recorded: 4, recorded_missing_experience: 3, supported_by_cv: 3, unreviewed: 0 });
    expect(row.denominators).toEqual({ assessedUsable: 10, selected: 10 });
  });

  it('lists a requirement once per job even if the job repeats it, keeping the lane that says most', () => {
    const jobs = assessed(8, () => [req('a', 'Kubernetes', 'direct'), req('b', 'kubernetes.', 'candidate_confirmed_gap')]);
    const row = buildRequirements(jobs).requirements[0]!;
    expect(row.jobsPresent).toBe(8);
    expect(row.byLane.recorded_missing_experience).toBe(8);
    expect(row.byLane.supported_by_cv).toBe(0);
  });

  it('drops requirements the person excluded', () => {
    const jobs = assessed(8, () => [req('a', 'Kubernetes', 'unsupported', { excluded: true })]);
    expect(buildRequirements(jobs).requirements).toEqual([]);
  });
});

describe('unassessed is unknown, never zero, and is never inferred', () => {
  it('reports jobs without a current assessment as not assessed, and derives nothing from titles or scores', () => {
    const jobs = [
      ...assessed(8, () => [req('a', 'Kubernetes', 'unsupported')]),
      ...Array.from({ length: 6 }, (_, index) => job(`t${index}`, { requisition: key('requisition', `ats:title:${index}`), score: score(95, 'Platform Engineer'), assessment: { state: 'none' } })),
      job('stale', { requisition: key('requisition', 'ats:stale'), assessment: { state: 'stale', requirements: [req('a', 'Kubernetes', 'candidate_confirmed_gap')] } }),
      job('partial', { requisition: key('requisition', 'ats:partial'), assessment: { state: 'partial', requirements: [req('a', 'Kubernetes', 'candidate_confirmed_gap')], coverage: 'partial' } }),
    ];
    const view = buildRequirements(jobs);
    expect(view.selected).toBe(16);
    expect(view.assessment).toMatchObject({ current: 8, usable: 8, none: 6, stale: 1, partial: 1 });
    const row = view.requirements.find((entry) => entry.key === 'kubernetes')!;
    // The stale and partial assessments' "gap" statements are not pooled in: they are not current.
    expect(row.jobsPresent).toBe(8);
    expect(row.byLane.recorded_missing_experience).toBe(0);
  });

  it('produces no requirement row at all when nothing was assessed, however high the scores', () => {
    const jobs = Array.from({ length: 12 }, (_, index) => job(`n${index}`, { requisition: key('requisition', `ats:n:${index}`), score: score(99, 'Platform Engineer') }));
    const view = buildRequirements(jobs);
    expect(view.requirements).toEqual([]);
    expect(view.verdict.verdict).toBe('no_go');
    expect(view.verdict.reasons).toEqual(expect.arrayContaining(['too_few_assessed', 'unassessed_dominate', 'no_recurring_requirement']));
  });

  it('counts a score of 0 as scored and a missing score as unscored: they are different facts', () => {
    const view = buildRequirements([job('a', { score: { state: 'scored', value: 0, roleFamily: null } }), job('b', { requisition: key('requisition', 'ats:b'), score: score(null) })]);
    expect(view.evaluatorOpinion).toMatchObject({ scored: 1, unscored: 1 });
  });
});

describe('frequency in chosen jobs is independent of fit opinion and of outcomes', () => {
  const build = (status: 'rejected' | 'interview', fit: number | null) =>
    assessed(
      10,
      () => [req('r', 'Kubernetes', 'unsupported')],
      (i) => ({ score: score(fit), applications: [app(`a${i}`, 'user_stated', { sentAt: OLD, status })] }),
    );
  const pick = (view: ReturnType<typeof buildRequirements>) => view.requirements.map((row) => ({ key: row.key, present: row.jobsPresent, lanes: row.byLane, jobs: row.supportingJobs.map((entry) => entry.jobId) }));

  it('does not move any row or lane when every outcome flips or every score changes', () => {
    const base = pick(buildRequirements(build('rejected', 90)));
    expect(pick(buildRequirements(build('interview', 90)))).toEqual(base);
    expect(pick(buildRequirements(build('rejected', null)))).toEqual(base);
    expect(pick(buildRequirements(build('interview', 0)))).toEqual(base);
  });

  it('shows outcomes only as labelled context and carries the non-causal caveat', () => {
    const view = buildRequirements(build('rejected', 50));
    expect(view.requirements[0]!.supportingJobs.every((entry) => entry.outcome === 'rejected_recorded')).toBe(true);
    expect(view.outcomeCaveat).toBe(OUTCOME_CONTEXT_CAVEAT);
    expect(view.outcomeCaveat).toMatch(/not evidence that this requirement was the reason/u);
  });

  it('does not treat silence as a rejection: an unanswered application is context "no_recorded_outcome", not a gap', () => {
    const jobs = assessed(10, () => [req('r', 'Kubernetes', 'direct')], (i) => ({ applications: [app(`a${i}`, 'user_stated', { sentAt: OLD, status: 'applied' })] }));
    const row = buildRequirements(jobs).requirements[0]!;
    expect(row.byLane.recorded_missing_experience + row.byLane.cv_evidence_not_recorded).toBe(0);
    expect(row.supportingJobs.every((entry) => entry.outcome === 'no_recorded_outcome')).toBe(true);
  });
});

describe('version compatibility', () => {
  it('pools only assessments made under the same rules and the same CV, and reports the rest as excluded', () => {
    const jobs = assessed(12, () => [req('r', 'Kubernetes', 'unsupported')], (i) => ({ versions: { cvHash: i <= 9 ? 'cvA' : 'cvB' } }));
    const view = buildRequirements(jobs);
    expect(view.assessment.versionClasses).toEqual([
      { versionClass: `${COMPATIBLE_ASSESSMENT_WORKFLOW}|cvA`, jobs: 9, dominant: true },
      { versionClass: `${COMPATIBLE_ASSESSMENT_WORKFLOW}|cvB`, jobs: 3, dominant: false },
    ]);
    expect(view.assessment).toMatchObject({ current: 12, usable: 9, excludedIncompatible: 3 });
    expect(view.requirements[0]!.jobsPresent).toBe(9);
    expect(view.verdict.verdict).toBe('go_review');
  });

  it('refuses when incompatible versions dominate, when the dominant rule version is not the one understood, and when a version is unknown', () => {
    const mixed = assessed(12, () => [req('r', 'Kubernetes', 'unsupported')], (i) => ({ versions: { cvHash: ['cvA', 'cvB', 'cvC'][i % 3]! } }));
    expect(buildRequirements(mixed).verdict.reasons).toContain('version_incompatible_dominates');
    const old = assessed(12, () => [req('r', 'Kubernetes', 'unsupported')], () => ({ versions: { assessmentWorkflow: 'application-brief-v0' } }));
    const oldView = buildRequirements(old);
    expect(oldView.assessment.usable).toBe(0);
    expect(oldView.verdict.reasons).toEqual(expect.arrayContaining(['too_few_assessed', 'version_incompatible_dominates']));
    const unknown = assessed(12, () => [req('r', 'Kubernetes', 'unsupported')], () => ({ versions: { assessmentWorkflow: null } }));
    expect(buildRequirements(unknown).assessment.usable).toBe(0);
  });
});

describe('recurrence is by exact wording unless the person confirms an alias', () => {
  const jobs = assessed(10, (i) => [req('r', i <= 2 ? 'Kubernetes' : i <= 4 ? 'K8s' : i === 5 ? 'Kube' : 'TypeScript', 'unsupported')]);

  it('does not merge similar wordings on its own, and says it may under-count', () => {
    const view = buildRequirements(jobs);
    expect(view.requirements.filter((row) => ['kubernetes', 'k8s', 'kube'].includes(row.key)).map((row) => row.jobsPresent).sort()).toEqual([1, 2, 2]);
    expect(view.notes.join(' ')).toContain('under-counted');
  });

  it('merges them once the person confirms the alias', () => {
    const view = buildRequirements(jobs, { aliasGroups: [{ label: 'Kubernetes', members: ['K8s', 'Kube'] }] });
    const row = view.requirements.find((entry) => entry.key === 'kubernetes')!;
    expect(row.jobsPresent).toBe(5);
    expect(row.label).toBe('Kubernetes');
    expect(view.requirements.some((entry) => entry.key === 'k8s')).toBe(false);
  });

  it('normalises case, accents and punctuation only', () => {
    expect(normalizeRequirementText('  Kubernetes. ')).toBe('kubernetes');
    expect(normalizeRequirementText('Café-ops')).toBe('cafe ops');
    expect(normalizeRequirementText('C++ / C#')).toBe('c++ c#');
  });
});

describe('preference and eligibility mismatches come from recorded answers only', () => {
  it('counts a known mismatch, reports unknown answers separately and never turns unknown into a mismatch', () => {
    const jobs = Array.from({ length: 10 }, (_, index) =>
      job(`e${index}`, {
        requisition: key('requisition', `ats:e:${index}`),
        eligibility:
          index === 9
            ? []
            : [{ key: 'candidateWorkCountry', answer: index < 4 ? 'no' : index < 6 ? 'unknown' : 'yes', classification: index < 4 ? 'known_mismatch' : index < 6 ? 'uncertain' : 'consistent', source: 'vacancy_text' }],
      }),
    );
    const row = buildRequirements(jobs).eligibility[0]!;
    expect(row).toMatchObject({ key: 'candidateWorkCountry', jobsKnownMismatch: 4, jobsAnswered: 7, jobsUnknown: 2 });
    expect(row.denominators).toEqual({ selected: 10 });
  });
});

describe('purity', () => {
  it('does not mutate its input', () => {
    const input = deepFreeze(assessed(8, () => [req('r', 'Kubernetes', 'unsupported')]));
    expect(() => buildRequirements(input, { aliasGroups: [{ label: 'a', members: ['b'] }] })).not.toThrow();
    expect(GATES.minAssessed).toBeGreaterThan(0);
  });
});

describe('preferred and mandatory stay explicit (finding: preferred vs mandatory)', () => {
  const classed = (classes: ('required' | 'preferred' | 'unclear')[], evidenceClass: Parameters<typeof req>[2] = 'unsupported') =>
    assessed(8, (i) => (i <= classes.length ? [req('r', 'Kubernetes', evidenceClass, { classification: classes[i - 1]! })] : [req('x', 'TypeScript', 'direct')]));

  it('splits a row by the posting’s own class, never into one pooled "required" count, and the split sums to the jobs present', () => {
    const row = buildRequirements(classed(['required', 'required', 'preferred', 'unclear'])).requirements.find((entry) => entry.key === 'kubernetes')!;
    expect(row.jobsPresent).toBe(4);
    expect(row.byClassification).toEqual({ required: 2, preferred: 1, unclear: 1 });
    expect(row.supportingJobs.map((entry) => entry.classification)).toEqual(['required', 'required', 'preferred', 'unclear']);
    expect(Object.values(row.byClassification).reduce((a, b) => a + b, 0)).toBe(row.jobsPresent);
  });

  it('keeps an all-preferred row all-preferred, and an all-unclear row all-unclear', () => {
    const preferred = buildRequirements(classed(['preferred', 'preferred', 'preferred'])).requirements.find((entry) => entry.key === 'kubernetes')!;
    expect(preferred.byClassification).toEqual({ required: 0, preferred: 3, unclear: 0 });
    const unclear = buildRequirements(classed(['unclear', 'unclear', 'unclear'])).requirements.find((entry) => entry.key === 'kubernetes')!;
    expect(unclear.byClassification).toEqual({ required: 0, preferred: 0, unclear: 3 });
  });

  it('counts a preferred appearance toward recurrence (documented decision) while still reporting it as preferred', () => {
    // One required + two preferred reach the threshold of 3 together; the row says exactly that instead of calling all three mandatory.
    const row = buildRequirements(classed(['required', 'preferred', 'preferred'])).requirements.find((entry) => entry.key === 'kubernetes')!;
    expect(row.jobsPresent).toBe(GATES.minRecurrence);
    expect(row.smallSample).toBe(false);
    expect(row.byClassification).toEqual({ required: 1, preferred: 2, unclear: 0 });
  });

  it('keeps the stronger posting class when one job lists the same requirement twice in the same lane', () => {
    const jobs = assessed(8, () => [req('a', 'Kubernetes', 'unsupported', { classification: 'preferred' }), req('b', 'kubernetes.', 'unsupported', { classification: 'required' })]);
    const row = buildRequirements(jobs).requirements[0]!;
    expect(row.jobsPresent).toBe(8);
    expect(row.byClassification).toEqual({ required: 8, preferred: 0, unclear: 0 });
  });

  it('is independent of the class for lanes and presence: forcing every class to required moves no row and no lane', () => {
    const mixed = classed(['required', 'preferred', 'unclear', 'preferred']);
    const forced = mixed.map((observation) => ({ ...observation, assessment: { ...observation.assessment, requirements: observation.assessment.requirements.map((entry) => ({ ...entry, classification: 'required' as const })) } }));
    const shape = (view: ReturnType<typeof buildRequirements>) => view.requirements.map((row) => ({ key: row.key, present: row.jobsPresent, lanes: row.byLane }));
    expect(shape(buildRequirements(forced))).toEqual(shape(buildRequirements(mixed)));
    expect(buildRequirements(forced).requirements.find((row) => row.key === 'kubernetes')!.byClassification).not.toEqual(buildRequirements(mixed).requirements.find((row) => row.key === 'kubernetes')!.byClassification);
  });
});

describe('a title or a scorer hint is never a requirement (finding: vacuous negative)', () => {
  const unassessed = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      job(`t${index}`, { requisition: key('requisition', `ats:titled:${index}`), title: 'Kubernetes Platform Engineer', scorerMatchingSkills: ['Kubernetes'], scorerGaps: ['No Kubernetes production experience listed'], score: score(95, 'Platform Engineer'), assessment: { state: 'none' } }),
    );

  it('produces no row, lane count or suggestion from Kubernetes titles and Kubernetes scorer hints on unassessed jobs, and counts them as not assessed', () => {
    const jobs = [...assessed(8, () => [req('a', 'TypeScript', 'direct')]), ...unassessed(10)];
    const view = buildRequirements(jobs);
    expect(view.requirements.map((row) => row.key)).toEqual(['typescript']);
    expect(view.assessment).toMatchObject({ current: 8, none: 10 });
    expect(view.selected).toBe(18);
  });

  it('is unmoved when every title and hint is rewritten to say Kubernetes, or blanked', () => {
    const base = assessed(8, () => [req('a', 'Kubernetes', 'unsupported')]);
    const plant = (mode: 'say' | 'blank') => base.map((observation) => ({ ...observation, hints: mode === 'say' ? { title: 'Kubernetes Platform Engineer', scorerMatchingSkills: ['Kubernetes'], scorerGaps: ['Kubernetes'] } : { title: null, scorerMatchingSkills: [], scorerGaps: [] } }));
    const pick = (view: ReturnType<typeof buildRequirements>) => JSON.stringify(view);
    expect(pick(buildRequirements(plant('say')))).toBe(pick(buildRequirements(plant('blank'))));
  });

  it('would catch a leaky rule: the same comparison FAILS when a title is allowed to become a requirement (mutation check)', () => {
    const jobs = [...assessed(8, () => [req('a', 'TypeScript', 'direct')]), ...unassessed(4)];
    const leaky = jobs.map((observation) =>
      observation.assessment.state === 'current' || !/kubernetes/iu.test(observation.hints?.title ?? '')
        ? observation
        : { ...observation, assessment: { state: 'current' as const, coverage: 'complete' as const, requirements: [req('leak', 'Kubernetes', 'unsupported')] } },
    );
    const keys = (view: ReturnType<typeof buildRequirements>) => view.requirements.map((row) => row.key);
    expect(keys(buildRequirements(leaky))).not.toEqual(keys(buildRequirements(jobs)));
  });
});
