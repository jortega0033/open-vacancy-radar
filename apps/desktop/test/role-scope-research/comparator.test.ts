// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { compareRoleFamily, COMPARATOR_VERSION, EXPLANATION_SCHEMA_VERSION, resolveTargets, verdictTier } from './comparator.js';
import { applyWorldwideProfileScores } from '../../../../packages/vacancy-engine/src/pipeline/global-remote.js';
import { outcomeNegativeControl, runEvaluation } from './evaluate.js';
import { CORPUS, PROFILES } from './fixtures.js';
import { compilePlan, PLANS } from './plans.js';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

const byId = (id: string) => CORPUS.find((item) => item.id === id)!;

describe('research option B: role-family comparator', () => {
  it('resolves target families from target roles and lists the roles it cannot place', () => {
    expect(resolveTargets(PROFILES.frontend)).toMatchObject({ targetFamilies: ['frontend'], unsupportedTargetRoles: [] });
    expect(resolveTargets(PROFILES.backend_research)).toMatchObject({ targetFamilies: ['backend'], unsupportedTargetRoles: ['Platform Engineer'] });
    expect(resolveTargets(PROFILES.unsupported_target)).toMatchObject({
      targetFamilies: [],
      unsupportedTargetRoles: ['Data Scientist', 'Machine Learning Engineer'],
    });
  });

  it('refuses explicitly for a profile with no supported family instead of scoring it', () => {
    for (const item of CORPUS) {
      const result = compareRoleFamily(item, PROFILES.unsupported_target);
      expect(result.verdict).toBe('unsupported_family');
      expect(result.confidence).toBe('none');
      expect(result.reasonCodes).toContain('no_supported_target_family');
    }
  });

  it('abstains on a generic title with no text, and calls a known title with no text at low confidence', () => {
    expect(compareRoleFamily(byId('S03'), PROFILES.frontend)).toMatchObject({ verdict: 'uncertain', confidence: 'none', evidence: 'sparse' });
    expect(compareRoleFamily(byId('S01'), PROFILES.frontend)).toMatchObject({ verdict: 'match', confidence: 'low', evidence: 'sparse' });
    expect(verdictTier({ verdict: 'uncertain', confidence: 'none' })).toBeLessThan(verdictTier({ verdict: 'mismatch', confidence: 'normal' }));
  });

  it('ignores nice-to-have lines as family evidence and says so', () => {
    const r02 = compareRoleFamily(byId('R02'), PROFILES.frontend);
    expect(r02.signals.frontend).toEqual([]);
    expect(r02.ignoredPreferenceSignals).toEqual(expect.arrayContaining(['React', 'Angular']));
    expect(r02.reasonCodes).toContain('preference_lines_ignored');
    expect(r02.verdict).toBe('mismatch');
  });

  it('versions every explanation and carries no eligibility, score or outcome field', () => {
    const result = compareRoleFamily(byId('F01'), PROFILES.frontend);
    expect(result.schema).toBe(EXPLANATION_SCHEMA_VERSION);
    expect(result.comparator).toBe(COMPARATOR_VERSION);
    const keys = Object.keys(result).join(' ');
    expect(keys).not.toMatch(/eligib|country|language|salary|score|outcome|application/iu);
  });

  it('is pure: frozen inputs, identical repeated output', () => {
    const profile = deepFreeze(structuredClone(PROFILES.backend_research));
    for (const item of CORPUS) {
      const frozen = deepFreeze(structuredClone(item));
      expect(JSON.stringify(compareRoleFamily(frozen, profile))).toBe(JSON.stringify(compareRoleFamily(frozen, profile)));
    }
  });
});

describe('#694 invariances that must always hold', () => {
  const result = runEvaluation();

  it('never turns an application, rejection, no-response or interview into role truth', () => {
    const control = result.invariances.outcomesNeverBecomeRoleTruth;
    expect(control.noised.length).toBeGreaterThan(0);
    // The noise really crossed the boundary: it is on the Search rows and in the comparator's argument.
    expect(control.noiseReachedSearchRows).toBe(true);
    expect(control.noiseReachedComparator).toBe(true);
    for (const entry of control.perProfile) {
      expect(entry.rowsCompared, entry.profile).toBe(CORPUS.length);
      expect(entry, entry.profile).toMatchObject({ changedScores: [], changedProfileMatch: [], searchOrderUnchanged: true, changedOptionB: [] });
    }
    expect(control).toMatchObject({ scoresUnchanged: true, profileMatchUnchanged: true, searchOrderUnchanged: true, optionBUnchanged: true, labelsUnchanged: true, changedLabels: [] });
  });

  describe('the outcome negative control can fail (injected faults)', () => {
    type Row = Parameters<typeof applyWorldwideProfileScores>[0][number] & { outcome?: string };

    it('reports a score step that reads an outcome off the row', () => {
      const control = outcomeNegativeControl({
        scoreStep: (rows, profile, minimum) =>
          applyWorldwideProfileScores(rows, profile, minimum).map((row) =>
            (row as Row).outcome === 'rejected' && row.profileScore !== null ? { ...row, profileScore: row.profileScore - 40 } : row,
          ),
      });
      expect(control.scoresUnchanged).toBe(false);
      expect(control.searchOrderUnchanged).toBe(false);
      expect(control.perProfile[0]!.changedScores).toEqual(expect.arrayContaining(['F01', 'S01']));
      expect(control.labelsUnchanged).toBe(true);
    });

    it('reports a score step that folds an outcome into the breakdown', () => {
      const control = outcomeNegativeControl({
        scoreStep: (rows, profile, minimum) =>
          applyWorldwideProfileScores(rows, profile, minimum).map((row) =>
            (row as Row).outcome !== undefined && row.profileMatch ? { ...row, profileMatch: { ...row.profileMatch, matchingSkills: [] } } : row,
          ),
      });
      expect(control.profileMatchUnchanged).toBe(false);
    });

    it('reports a comparator that reads an outcome from its input', () => {
      const control = outcomeNegativeControl({
        compare: (vacancy, profile) => {
          const explanation = compareRoleFamily(vacancy, profile);
          return 'outcome' in vacancy && vacancy.outcome === 'interview' ? { ...explanation, verdict: 'match' } : explanation;
        },
      });
      expect(control.optionBUnchanged).toBe(false);
      expect(control.perProfile.flatMap((entry) => entry.changedOptionB)).toContain('M01');
    });

    it('reports a label written from an outcome, against the snapshot taken before noise', () => {
      const corpus = structuredClone(CORPUS) as unknown as typeof CORPUS;
      const control = outcomeNegativeControl({
        corpus,
        compare: (vacancy, profile) => {
          if ('outcome' in vacancy && vacancy.outcome === 'rejected' && 'expect' in vacancy) {
            (vacancy.expect as { frontend: { grade: string } }).frontend.grade = 'not_relevant';
          }
          return compareRoleFamily(vacancy, profile);
        },
      });
      expect(control.labelsUnchanged).toBe(false);
      expect(control.changedLabels).toEqual(expect.arrayContaining(['F01', 'S01']));
      // The shared fixture itself is untouched: the fault ran on a clone.
      expect(byId('F01').expect.frontend.grade).toBe('relevant');
    });
  });

  it('never lets an unapproved suggestion reach a query', () => {
    expect(result.invariances.unapprovedSuggestionsNeverQueried).toBe(true);
    const reviewed = compilePlan(PLANS.find((plan) => plan.id === 'P1_frontend_reviewed_686')!).compiled;
    expect(reviewed.queries.map((query) => query.query)).not.toContain('Full-Stack Engineer');
  });

  it('keeps unknown eligibility unknown: no candidate country or language means no yes, no no and no cap', () => {
    expect(result.invariances.workCountryAnswersWithNoCandidateCountry).toEqual(['unknown']);
    expect(result.invariances.mandatoryLanguageAnswersWithNoCandidateLanguage).toEqual(['unknown']);
    expect(result.invariances.languageCapsWithNoCandidateLanguage).toEqual([]);
  });

  it('never ranks by work country: a known mismatch, an unknown and an accepted country score alike', () => {
    const [mismatch, unknown, accepted] = result.invariances.currentScoresForCountryCasesE01E02E03;
    expect(mismatch).toBe(unknown);
    expect(accepted).toBe(unknown);
  });

  it('never caps a merely preferred language', () => {
    const l02 = result.scorer.frontend.rows.find((row) => row.id === 'L02')!;
    expect(l02.current.unmetMandatoryLanguages).toEqual([]);
  });

  it('keeps retrieval misses apart from ranking: an undiscovered case appears in no ranking', () => {
    for (const plan of PLANS) {
      const absent = CORPUS.filter((item) => item.availability === 'not_in_any_configured_source').map((item) => item.id);
      const ranked = result.ranking[plan.id]!.current.order.map((row) => row.id);
      expect(ranked.filter((id) => absent.includes(id))).toEqual([]);
    }
  });
});
