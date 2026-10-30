// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { job, key, req } from './builders.js';
import { GATES, deepFreeze } from './contract.js';
import { evaluatePortfolio, run } from './evaluate.js';
import { AS_OF, PORTFOLIOS, RICH_EXPOSURE, richObservations } from './fixtures.js';
import { EMPTY_REVIEW_STATE, dismiss, partition, restore, buildSuggestions } from './suggestions.js';

const rich = () => run(richObservations(), { exposure: RICH_EXPOSURE });
const keys = (result: ReturnType<typeof run>) => result.suggestions.suggestions.map((suggestion) => `${suggestion.kind}:${suggestion.subject}`).sort();

describe('suggestions expose their evidence', () => {
  it('names the supporting jobs, the raw denominators, the window, the version class and the small-sample flag', () => {
    const { suggestions } = rich().suggestions;
    expect(suggestions.length).toBe(6);
    for (const suggestion of suggestions) {
      expect(suggestion.effect).toBe('none');
      expect(suggestion.actions).toEqual(['dismiss']);
      expect(suggestion.support.denominators.length).toBeGreaterThan(0);
      expect(suggestion.support.window.asOf).toBe(AS_OF);
      expect(suggestion.uncertainty.limits.join(' ')).toMatch(/author-declared/u);
      if (suggestion.kind !== 'review_search_variant') expect(suggestion.support.items).toHaveLength(suggestion.support.count);
    }
    const kubernetes = suggestions.find((suggestion) => suggestion.kind === 'add_cv_evidence' && suggestion.subject === 'Kubernetes')!;
    expect(kubernetes.support.count).toBe(5);
    expect(kubernetes.support.denominators).toEqual([
      { label: 'assessed jobs with a current, compatible assessment', value: 20 },
      { label: 'jobs you selected', value: 30 },
    ]);
    expect(kubernetes.support.items.map((item) => item.jobId)).toEqual(['j01', 'j02', 'j03', 'j04', 'j05']);
    expect(kubernetes.support.versionClass).toContain('application-brief-v1');
    expect(kubernetes.support.window.firstSelectedAt).not.toBeNull();
    expect(kubernetes.statement).toContain('5 of the 20 assessed jobs');
    expect(kubernetes.statement).toMatch(/you may want to add it to your CV yourself/u);
  });

  it('keeps the recorded-gap suggestion and the missing-CV-evidence suggestion for one requirement separate', () => {
    const { suggestions } = rich().suggestions;
    const evidence = suggestions.find((suggestion) => suggestion.kind === 'add_cv_evidence' && suggestion.subject === 'Kubernetes')!;
    const learning = suggestions.find((suggestion) => suggestion.kind === 'consider_learning_priority' && suggestion.subject === 'Kubernetes')!;
    expect(evidence.id).not.toBe(learning.id);
    expect(evidence.support.items.map((item) => item.jobId)).toEqual(['j01', 'j02', 'j03', 'j04', 'j05']);
    expect(learning.support.items.map((item) => item.jobId)).toEqual(['j06', 'j07', 'j08', 'j09']);
    expect(learning.statement).toMatch(/you recorded that you lack/u);
    expect(evidence.statement).not.toMatch(/you lack|missing skill|gap/iu);
  });

  it('flags a small sample and still names it, rather than hiding or rounding it up', () => {
    const onCall = rich().suggestions.suggestions.find((suggestion) => suggestion.subject === 'On-call rota')!;
    expect(onCall.support.count).toBe(GATES.minRecurrence);
    expect(onCall.uncertainty.smallSample).toBe(true);
  });

  it('presents outcomes of the supporting jobs only as labelled non-causal context', () => {
    const kubernetes = rich().suggestions.suggestions.find((suggestion) => suggestion.kind === 'add_cv_evidence' && suggestion.subject === 'Kubernetes')!;
    expect(kubernetes.outcomeContext).not.toBeNull();
    expect(kubernetes.outcomeContext!.caveat).toMatch(/not evidence that this requirement was the reason/u);
    expect(Object.values(kubernetes.outcomeContext!.byOutcome).reduce((sum, count) => sum + count, 0)).toBe(5);
  });

  it('never states a hiring chance, a probability, a weight or a ranking in what it tells the person', () => {
    // The caveat and limits sentences deny these on purpose, so they are checked separately below.
    const statements = rich().suggestions.suggestions.map((suggestion) => suggestion.statement).join(' ');
    expect(statements).not.toMatch(/probab|chance|likelihood|weight|rank|boost|penal|score/iu);
    const conflict = rich().suggestions.suggestions.find((suggestion) => suggestion.kind === 'review_preference_conflict')!;
    expect(conflict.statement).toContain('Can you work for this job from where you are?');
    expect(conflict.statement).toContain('nothing has been changed');
    for (const suggestion of rich().suggestions.suggestions) expect(suggestion.uncertainty.limits.join(' ')).toMatch(/does not say why|not statistically derived/u);
  });
});

describe('suggestions are withheld when the evidence does not support them', () => {
  it('withholds every requirement suggestion on today-shaped data and says why', () => {
    const small = PORTFOLIOS.find((portfolio) => portfolio.id === 'small_current_shape')!;
    const result = run(small.observations);
    expect(result.suggestions.suggestions).toEqual([]);
    expect(result.suggestions.withheld.requirements).toEqual(expect.arrayContaining(['too_few_assessed', 'unassessed_dominate']));
    expect(result.suggestions.withheld.searchVariants).toEqual(['no_exposure_denominator']);
  });

  it('withholds the search-variant suggestion unless leads shown were recorded for that variant, and only for a large enough, rarely selected one', () => {
    const noExposure = run(richObservations(), { exposure: null });
    expect(noExposure.suggestions.suggestions.some((suggestion) => suggestion.kind === 'review_search_variant')).toBe(false);
    expect(noExposure.suggestions.withheld.searchVariants).toEqual(['no_exposure_denominator']);
    const variant = rich().suggestions.suggestions.filter((suggestion) => suggestion.kind === 'review_search_variant');
    // Only t2-platform: 10 of 120 shown. literal is selected too often (30 of 200), and t3-sre was shown to too few leads (15 < 20).
    expect(variant.map((suggestion) => suggestion.subject)).toEqual(['t2-platform']);
    expect(variant[0]!.support.count).toBe(10);
    expect(variant[0]!.statement).toContain('You selected 10 of the 120');
  });

  it('is empty for every portfolio whose declared expectation is empty, with the declared reasons', () => {
    for (const portfolio of PORTFOLIOS.filter((entry) => entry.expected.suggestions.length === 0)) {
      const evaluated = evaluatePortfolio(portfolio);
      expect(evaluated.suggestionIds, portfolio.id).toEqual([]);
      expect(evaluated.checks.every((check) => check.mismatches.length === 0 || check.label.includes('person-confirmed alias')), portfolio.id).toBe(true);
    }
  });
});

describe('dismissal', () => {
  it('moves a suggestion out of view without changing it or its inputs, and can be undone', () => {
    const set = rich().suggestions;
    const frozen = deepFreeze(structuredClone(set));
    const target = frozen.suggestions[0]!;
    const state = dismiss(EMPTY_REVIEW_STATE, target, '2026-10-30T09:00:00.000Z');
    expect(Object.keys(EMPTY_REVIEW_STATE.dismissed)).toHaveLength(0);
    const view = partition(frozen, state);
    expect(view.visible).toHaveLength(frozen.suggestions.length - 1);
    expect(view.dismissed).toHaveLength(1);
    expect(view.dismissed[0]!.suggestion).toEqual(target);
    expect(partition(frozen, restore(state, target.id)).visible).toHaveLength(frozen.suggestions.length);
  });

  it('keeps a dismissed suggestion dismissed when more supporting jobs arrive, and only reports how many', () => {
    const set = rich().suggestions;
    const target = set.suggestions.find((suggestion) => suggestion.subject === 'Terraform')!;
    const state = dismiss(EMPTY_REVIEW_STATE, target, '2026-10-30T09:00:00.000Z');
    const later = structuredClone(set);
    later.suggestions.find((suggestion) => suggestion.id === target.id)!.support.count += 3;
    const view = partition(later, state);
    expect(view.visible.some((suggestion) => suggestion.id === target.id)).toBe(false);
    expect(view.dismissed.find((entry) => entry.suggestion.id === target.id)!.newSupportSince).toBe(3);
  });

  it('gives a suggestion the same id on every run, so a dismissal can find it again', () => {
    expect(rich().suggestions.suggestions.map((suggestion) => suggestion.id)).toEqual(rich().suggestions.suggestions.map((suggestion) => suggestion.id));
    expect(new Set(rich().suggestions.suggestions.map((suggestion) => suggestion.id)).size).toBe(6);
  });
});

describe('no mutation', () => {
  it('accepts only observations and a fixed clock: no profile, preference, plan or weight goes in or comes out', () => {
    // The exported entry points take exactly these inputs; a frozen input proves nothing is written back to it.
    const observations = deepFreeze(richObservations());
    const exposure = deepFreeze({ ...RICH_EXPOSURE });
    const result = run(observations, { exposure });
    expect(keys(result)).toHaveLength(6);
    expect(Object.keys(buildSuggestions).length).toBe(0);
    for (const suggestion of result.suggestions.suggestions) expect(Object.keys(suggestion).sort()).toEqual(['actions', 'effect', 'id', 'kind', 'outcomeContext', 'statement', 'subject', 'support', 'uncertainty']);
  });
});

describe('suggestion wording never outranks the posting’s own class (finding: preferred vs mandatory)', () => {
  const withClasses = (classes: ('required' | 'preferred' | 'unclear')[], evidenceClass: Parameters<typeof req>[2] = 'unsupported') => {
    const jobs = Array.from({ length: 8 }, (_, index) =>
      job(`j${index + 1}`, {
        requisition: key('requisition', `ats:w:${index + 1}`),
        assessment: { state: 'current', requirements: [index < classes.length ? req('r', 'Kubernetes', evidenceClass, { classification: classes[index]!, candidateAdded: index === 0 }) : req('x', 'TypeScript', 'direct')] },
      }),
    );
    return run(jobs).suggestions.suggestions.filter((suggestion) => suggestion.subject === 'Kubernetes');
  };

  it('says "required in all N" only when every supporting job lists it as required', () => {
    const [suggestion] = withClasses(['required', 'required', 'required']);
    expect(suggestion!.support.classificationMix).toBe('all_required');
    expect(suggestion!.support.byClassification).toEqual({ required: 3, preferred: 0, unclear: 0 });
    expect(suggestion!.statement).toContain('listed as required in all 3');
  });

  it('states the required / preferred / unclear split for a mixed row, and counts the preferred appearance toward the threshold', () => {
    const [suggestion] = withClasses(['required', 'preferred', 'unclear']);
    expect(suggestion!.support.count).toBe(3);
    expect(suggestion!.support.classificationMix).toBe('mixed');
    expect(suggestion!.support.byClassification).toEqual({ required: 1, preferred: 1, unclear: 1 });
    expect(suggestion!.statement).toContain('required in 1, preferred in 1, unclear in 1');
    expect(suggestion!.statement).not.toContain('listed as required in all');
  });

  it('gives an all-preferred row no mandatory-style wording at all, for the CV-evidence and the learning suggestion alike', () => {
    for (const [evidenceClass, kind] of [['unsupported', 'add_cv_evidence'], ['candidate_confirmed_gap', 'consider_learning_priority']] as const) {
      const [suggestion] = withClasses(['preferred', 'preferred', 'preferred'], evidenceClass);
      expect(suggestion!.kind).toBe(kind);
      expect(suggestion!.support.classificationMix).toBe('all_preferred');
      expect(suggestion!.statement).toMatch(/listed only as preferred, a nice-to-have, in all 3/u);
      expect(suggestion!.statement).toMatch(/for you to judge/u);
      expect(suggestion!.statement).not.toMatch(/required|mandatory|must|essential/iu);
      expect(suggestion!.support.items.every((item) => item.detail.startsWith('preferred (not mandatory)'))).toBe(true);
    }
  });

  it('says the posting was unclear when every supporting job is unclear, never required', () => {
    const [suggestion] = withClasses(['unclear', 'unclear', 'unclear']);
    expect(suggestion!.support.classificationMix).toBe('all_unclear');
    expect(suggestion!.statement).toContain('did not make clear how much it matters');
    expect(suggestion!.statement).not.toMatch(/required in all|mandatory/iu);
  });

  it('changes the wording when the class changes (mutation check: forcing preferred to required is visible)', () => {
    const preferred = withClasses(['preferred', 'preferred', 'preferred'])[0]!;
    const required = withClasses(['required', 'required', 'required'])[0]!;
    expect(preferred.statement).not.toBe(required.statement);
    expect(preferred.id).toBe(required.id); // same subject and kind: the same suggestion, honestly re-worded
  });

  it('gives every supporting job the JD quote, revision, span and who added it, so it can be checked against the posting', () => {
    const [suggestion] = withClasses(['required', 'preferred', 'required']);
    for (const item of suggestion!.support.items) {
      expect(item.evidence).toMatchObject({ evidenceClass: 'unsupported', evidenceOrigin: 'model_proposed_person_reviewed', jdAnchor: 'Kubernetes is listed in the posting.', jdRevisionId: 'jdrev-1' });
      expect(item.evidence!.quoteSpan).toEqual({ start: 40, end: 40 + 'Kubernetes is listed in the posting.'.length });
    }
    expect(suggestion!.support.items.map((item) => item.evidence!.candidateAdded)).toEqual([true, false, false]);
    expect(suggestion!.support.items[0]!.detail).toContain('added by you');
  });

  it('keeps frequency apart from opinion: scores and outcomes still move no row while the class split is shown', () => {
    const reference = rich();
    const kubernetes = reference.suggestions.suggestions.find((suggestion) => suggestion.kind === 'add_cv_evidence' && suggestion.subject === 'Kubernetes')!;
    expect(kubernetes.support.byClassification).toEqual({ required: 3, preferred: 1, unclear: 1 });
    const onCall = reference.suggestions.suggestions.find((suggestion) => suggestion.subject === 'On-call rota')!;
    expect(onCall.support.classificationMix).toBe('all_preferred');
    expect(onCall.statement).not.toMatch(/required|mandatory/iu);
  });
});
