import { describe, expect, it } from 'vitest';
import { planNextAttempt, stageContract, type EscalationState } from '../src/index.js';

const FRESH: EscalationState = {
  stage: 'cv_tailoring',
  attemptsMade: 1,
  currentTier: 'small',
  capableTierAvailable: true,
  retrievalAttempted: false,
};

/**
 * **Acceptance check 3 of issue #284**: schema and grounding failures get a bounded retry or
 * escalation path, and a missing fact causes retrieval or a user handoff rather than expensive
 * guessing.
 *
 * The escalation-on-a-missing-fact case is the one worth writing tests against rather than trusting
 * a comment about. It is the most natural-looking wrong behavior in the whole ticket -- "the answer
 * was incomplete, try the better model" -- and what it actually buys is a more fluent invention on a
 * document the candidate then sends to an employer.
 */
describe('planNextAttempt: a missing fact never buys a bigger model (acceptance check 3)', () => {
  it('sends a missing fact to deterministic retrieval, naming exactly what to look up', () => {
    const plan = planNextAttempt(FRESH, { kind: 'missing_fact', missing: ['end date at Contoso'] });
    expect(plan).toEqual({ action: 'retrieve_missing_facts', missing: ['end date at Contoso'] });
  });

  it('hands off to the candidate once retrieval has already been tried, rather than retrying a model', () => {
    const plan = planNextAttempt(
      { ...FRESH, retrievalAttempted: true },
      { kind: 'missing_fact', missing: ['end date at Contoso'] },
    );
    expect(plan).toEqual({
      action: 'hand_off_to_user',
      reason: 'missing_facts_need_the_candidate',
      missing: ['end date at Contoso'],
    });
  });

  it('hands off immediately for a stage with nothing to retrieve from', () => {
    // A cover letter's missing fact is a claim about the candidate that their own CV does not
    // support. No store holds it.
    expect(stageContract('cover_letter').retrievalAvailable).toBe(false);
    const plan = planNextAttempt(
      { ...FRESH, stage: 'cover_letter' },
      { kind: 'missing_fact', missing: ['a security clearance'] },
    );
    expect(plan.action).toBe('hand_off_to_user');
  });

  it('never returns an escalation or a retry for a missing fact, on any tier or attempt count', () => {
    for (const attemptsMade of [0, 1, 2, 5]) {
      for (const currentTier of ['small', 'capable', 'unknown'] as const) {
        for (const retrievalAttempted of [false, true]) {
          const plan = planNextAttempt(
            { ...FRESH, attemptsMade, currentTier, retrievalAttempted },
            { kind: 'missing_fact', missing: ['a metric the CV never states'] },
          );
          expect(['retrieve_missing_facts', 'hand_off_to_user']).toContain(plan.action);
        }
      }
    }
  });

  it('hands off with no invented list when the caller could not name what was missing', () => {
    const plan = planNextAttempt({ ...FRESH, retrievalAttempted: true }, { kind: 'missing_fact' });
    expect(plan).toEqual({ action: 'hand_off_to_user', reason: 'missing_facts_need_the_candidate' });
  });
});

describe('planNextAttempt: schema and grounding failures are bounded', () => {
  it('retries a malformed answer once on the same model', () => {
    expect(planNextAttempt(FRESH, { kind: 'schema_invalid' })).toEqual({
      action: 'retry_same_model',
      attempt: 2,
      failure: 'schema_invalid',
    });
  });

  it('never spends a third attempt on the same unit of work', () => {
    const exhausted = { ...FRESH, attemptsMade: stageContract('cv_tailoring').maxAttempts };
    for (const kind of ['schema_invalid', 'grounding_unverified', 'transport_error'] as const) {
      expect(planNextAttempt(exhausted, { kind })).toEqual({
        action: 'hand_off_to_user',
        reason: 'attempt_budget_exhausted',
      });
    }
  });

  it('escalates an ungrounded answer exactly one tier, and only when a capable tier is really available', () => {
    expect(planNextAttempt(FRESH, { kind: 'grounding_unverified' })).toEqual({
      action: 'escalate_tier',
      attempt: 2,
      toTier: 'capable',
      failure: 'grounding_unverified',
    });
    expect(planNextAttempt({ ...FRESH, capableTierAvailable: false }, { kind: 'grounding_unverified' })).toEqual({
      action: 'hand_off_to_user',
      reason: 'no_capable_tier_available',
    });
  });

  it('does not escalate an answer that already ran on the capable tier', () => {
    expect(planNextAttempt({ ...FRESH, currentTier: 'capable' }, { kind: 'grounding_unverified' })).toEqual({
      action: 'hand_off_to_user',
      reason: 'grounding_unrecoverable',
    });
  });

  it('retries a dropped transport on the same model: the failure says nothing about the model', () => {
    expect(planNextAttempt(FRESH, { kind: 'transport_error' })).toEqual({
      action: 'retry_same_model',
      attempt: 2,
      failure: 'transport_error',
    });
  });

  it('terminates: repeatedly feeding the plan its own next attempt reaches a handoff', () => {
    // The property that makes "bounded" checkable rather than conventional. A caller that keeps
    // failing cannot keep being told to retry, whatever mixture of failures it reports.
    let state = { ...FRESH, attemptsMade: 0 };
    const actions: string[] = [];
    for (let guard = 0; guard < 20; guard += 1) {
      const plan = planNextAttempt(state, { kind: guard % 2 === 0 ? 'schema_invalid' : 'transport_error' });
      actions.push(plan.action);
      if (plan.action === 'hand_off_to_user') break;
      if (plan.action === 'retry_same_model' || plan.action === 'escalate_tier') {
        state = { ...state, attemptsMade: plan.attempt };
      }
    }
    expect(actions.at(-1)).toBe('hand_off_to_user');
    expect(actions.filter((action) => action === 'retry_same_model').length).toBeLessThanOrEqual(
      stageContract('cv_tailoring').maxAttempts,
    );
  });
});
