import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LEDGER_CAPACITY,
  StageRoutingLedger,
  USAGE_CAPABILITY_ABSENT,
  USAGE_NOT_REPORTED,
  computeStageCost,
  recordStageRun,
  routeStage,
  type StageRunFacts,
} from '../src/index.js';
import { candidate, priced, tiered } from './support/stage-candidates.js';

const BASE: StageRunFacts = {
  stage: 'cv_tailoring',
  providerId: 'claude',
  model: 'sonnet',
  tier: 'capable',
  tierEvidence: 'operator_declared',
  attempt: 1,
  outcome: 'validated',
  startedAt: 1_000,
  finishedAt: 3_400,
  usage: { kind: 'reported', metrics: { inputTokens: 20_000, outputTokens: 4_000, totalTokens: 24_000 } },
  price: priced(3, 15),
};

/**
 * **Acceptance check 2 of issue #284**: routing records the actual provider/model used, the stage,
 * the fallback reason if any, timing, and available usage metrics.
 */
describe('recordStageRun (acceptance check 2)', () => {
  it('records the pairing that actually ran, the stage, the attempt and the outcome', () => {
    const record = recordStageRun(BASE);
    expect(record).toMatchObject({
      stage: 'cv_tailoring',
      providerId: 'claude',
      model: 'sonnet',
      tier: 'capable',
      tierEvidence: 'operator_declared',
      attempt: 1,
      outcome: 'validated',
    });
  });

  it('derives the duration from its own timestamps rather than accepting one', () => {
    expect(recordStageRun(BASE).durationMs).toBe(2_400);
    expect(recordStageRun({ ...BASE, startedAt: 3_400, finishedAt: 1_000 }).durationMs).toBe(0);
  });

  it('carries the fallback reason from the decision that produced the run', () => {
    const decision = routeStage({
      stage: 'application_field_map',
      preferred: { providerId: 'codex' },
      candidates: [
        candidate({ providerId: 'codex', capabilities: { hardenedNoNetwork: false } }),
        candidate({ providerId: 'claude', model: 'sonnet' }),
      ],
    });
    if (decision.outcome !== 'routed') throw new Error('expected a routed decision');
    const record = recordStageRun({
      ...BASE,
      stage: decision.stage,
      providerId: decision.providerId,
      ...(decision.model === undefined ? {} : { model: decision.model }),
      ...(decision.fallbackReason === undefined ? {} : { fallbackReason: decision.fallbackReason }),
    });
    expect(record.fallbackReason).toBe('preferred_candidate_missing_capability');
  });

  it('omits the fallback reason entirely when nothing was degraded', () => {
    expect(recordStageRun(BASE).fallbackReason).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(recordStageRun(BASE), 'fallbackReason')).toBe(false);
  });

  it('records a provider-default model as absent rather than inventing a name for it', () => {
    const { model: _dropped, ...withoutModel } = BASE;
    const record = recordStageRun(withoutModel);
    expect(record.model).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(record, 'model')).toBe(false);
  });
});

describe('usage and cost stay honest when the numbers are not there', () => {
  it('computes a cost only when both a price and both token counts were measured', () => {
    expect(computeStageCost(priced(3, 15), BASE.usage)).toEqual({
      kind: 'measured',
      usd: (20_000 / 1_000_000) * 3 + (4_000 / 1_000_000) * 15,
      priceSource: 'fixture pricing table',
    });
  });

  it('reports price_unknown rather than assuming a rate', () => {
    expect(computeStageCost({ kind: 'unknown', reason: 'not_published' }, BASE.usage)).toEqual({
      kind: 'unknown',
      reason: 'price_unknown',
    });
  });

  it('reports usage_unavailable rather than treating no usage as zero tokens', () => {
    expect(computeStageCost(priced(3, 15), USAGE_NOT_REPORTED)).toEqual({ kind: 'unknown', reason: 'usage_unavailable' });
    expect(computeStageCost(priced(3, 15), USAGE_CAPABILITY_ABSENT)).toEqual({
      kind: 'unknown',
      reason: 'usage_unavailable',
    });
  });

  it('refuses to split a bare total into input and output at an assumed ratio', () => {
    const totalOnly = { kind: 'reported', metrics: { totalTokens: 24_000 } } as const;
    expect(computeStageCost(priced(3, 15), totalOnly)).toEqual({ kind: 'unknown', reason: 'token_counts_incomplete' });
  });

  it('keeps "this adapter reports no usage" apart from "this run reported none"', () => {
    // Different fixes: one is a provider capability gap, the other is a run that produced nothing.
    expect(USAGE_CAPABILITY_ABSENT).not.toEqual(USAGE_NOT_REPORTED);
  });
});

describe('StageRoutingLedger', () => {
  it('keeps records in order and filters by stage', () => {
    const ledger = new StageRoutingLedger();
    ledger.record(BASE);
    ledger.record({ ...BASE, stage: 'cv_field_extraction', model: 'haiku', tier: 'small' });
    expect(ledger.all()).toHaveLength(2);
    expect(ledger.forStage('cv_field_extraction').map((entry) => entry.model)).toEqual(['haiku']);
  });

  it('is bounded, so a long-lived daemon cannot grow one without limit', () => {
    const ledger = new StageRoutingLedger(3);
    for (let attempt = 1; attempt <= 10; attempt += 1) ledger.record({ ...BASE, attempt });
    expect(ledger.all().map((entry) => entry.attempt)).toEqual([8, 9, 10]);
  });

  it('hands out a copy, so a reader cannot mutate the ledger through it', () => {
    const ledger = new StageRoutingLedger();
    ledger.record(BASE);
    const snapshot = ledger.all() as ReturnType<StageRoutingLedger['all']>[number][];
    snapshot.length = 0;
    expect(ledger.all()).toHaveLength(1);
  });

  it('refuses a nonsensical capacity rather than silently behaving like a different one', () => {
    expect(() => new StageRoutingLedger(0)).toThrow(RangeError);
    expect(() => new StageRoutingLedger(1.5)).toThrow(RangeError);
    expect(DEFAULT_LEDGER_CAPACITY).toBeGreaterThan(0);
  });
});

describe('a routed decision carries everything a record needs', () => {
  it('round-trips a decision into a record with no field invented in between', () => {
    const decision = routeStage({
      stage: 'cv_field_extraction',
      candidates: [candidate({ providerId: 'claude', model: 'haiku', ...tiered('small'), price: priced(0.8, 4) })],
    });
    if (decision.outcome !== 'routed') throw new Error('expected a routed decision');
    const record = recordStageRun({
      stage: decision.stage,
      providerId: decision.providerId,
      ...(decision.model === undefined ? {} : { model: decision.model }),
      tier: decision.tier,
      tierEvidence: decision.tierEvidence,
      attempt: 1,
      outcome: 'validated',
      startedAt: 0,
      finishedAt: 1_500,
      usage: { kind: 'reported', metrics: { inputTokens: 1_000, outputTokens: 200 } },
      price: decision.price,
    });
    expect(record.cost.kind).toBe('measured');
    expect(record.durationMs).toBe(1_500);
    expect(record.tierEvidence).toBe('operator_declared');
  });
});
