/**
 * What a routed stage actually did (issue #284, acceptance check 2): the provider and model that
 * really ran, the stage, the fallback reason if there was one, timing, and whatever usage the
 * provider reported.
 *
 * "Actually" is the load-bearing word. A record is built from a finished run, never from the
 * decision alone, because the decision says what was chosen and only the run says what happened --
 * a provider CLI is free to answer on a different model than the one `--model` named, and a record
 * that quietly restated the request would be the one place in the system guaranteed to agree with
 * itself and disagree with reality.
 *
 * Every number here is either present and measured, or explicitly absent with a reason. There is no
 * zero standing in for "we did not get one": a cost of `0` and a cost nobody reported are different
 * facts, and only one of them is a saving.
 */
import type { CandidatePrice } from './candidates.js';
import type { StageFallbackReason } from './router.js';
import type { GenerationStage, ModelTier, TierEvidence } from './stages.js';

export interface StageUsageMetrics {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

/**
 * Token accounting for one run, or a reasoned absence.
 *
 * `capability_absent` and `provider_reported_none` are kept apart because they have different
 * fixes: the first means this adapter does not normalize usage at all (`ProviderCapabilities.usage`
 * is false, so no `usage` event will ever arrive), and the second means it does and this particular
 * run produced none. Collapsing them would make a broken run look like an unsupported provider.
 */
export type StageUsage =
  | { readonly kind: 'reported'; readonly metrics: StageUsageMetrics }
  | { readonly kind: 'unavailable'; readonly reason: 'capability_absent' | 'provider_reported_none' };

export const USAGE_CAPABILITY_ABSENT: StageUsage = Object.freeze({ kind: 'unavailable', reason: 'capability_absent' });
export const USAGE_NOT_REPORTED: StageUsage = Object.freeze({ kind: 'unavailable', reason: 'provider_reported_none' });

/**
 * What one run cost, or why that is unknown. Only ever produced by `computeStageCost`, which needs
 * both a known price and reported token counts and refuses to estimate from one of them.
 */
export type StageCost =
  | { readonly kind: 'measured'; readonly usd: number; readonly priceSource: string }
  | { readonly kind: 'unknown'; readonly reason: 'price_unknown' | 'usage_unavailable' | 'token_counts_incomplete' };

/** How a stage run ended, in the terms the router and the escalation planner both use. */
export type StageRunOutcome = 'validated' | 'schema_rejected' | 'grounding_rejected' | 'failed' | 'handed_off';

export interface StageRoutingRecord {
  readonly stage: GenerationStage;
  /** The provider that actually ran, as reported by the session, not as requested. */
  readonly providerId: string;
  /** The model that actually ran, absent when the provider ran its own default and named none. */
  readonly model?: string;
  readonly tier: ModelTier;
  readonly tierEvidence: TierEvidence;
  readonly fallbackReason?: StageFallbackReason;
  /** 1 for the first try at this unit of work; incremented by `escalation.ts`'s bounded planner. */
  readonly attempt: number;
  readonly outcome: StageRunOutcome;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly durationMs: number;
  readonly usage: StageUsage;
  readonly cost: StageCost;
}

export interface StageRunFacts {
  readonly stage: GenerationStage;
  readonly providerId: string;
  readonly model?: string;
  readonly tier: ModelTier;
  readonly tierEvidence: TierEvidence;
  readonly fallbackReason?: StageFallbackReason;
  readonly attempt: number;
  readonly outcome: StageRunOutcome;
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly usage: StageUsage;
  readonly price: CandidatePrice;
}

/**
 * Dollars for one run, or the specific reason there is no number.
 *
 * Both inputs are required and neither is defaulted. A price with no usage cannot be multiplied by
 * anything, and usage with no price cannot be multiplied *into* anything -- in both cases the
 * honest output is `unknown`, and a package that guessed a rate here would poison every downstream
 * comparison with a figure that looks measured.
 */
export function computeStageCost(price: CandidatePrice, usage: StageUsage): StageCost {
  if (price.kind !== 'known') return { kind: 'unknown', reason: 'price_unknown' };
  if (usage.kind !== 'reported') return { kind: 'unknown', reason: 'usage_unavailable' };
  const { inputTokens, outputTokens } = usage.metrics;
  // `totalTokens` alone is deliberately not enough: input and output are priced differently, and
  // splitting a total by an assumed ratio is an invented number wearing a measurement's clothes.
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number') {
    return { kind: 'unknown', reason: 'token_counts_incomplete' };
  }
  const usd =
    (inputTokens / 1_000_000) * price.usdPerMillionInputTokens +
    (outputTokens / 1_000_000) * price.usdPerMillionOutputTokens;
  return { kind: 'measured', usd, priceSource: price.source };
}

/** Builds one record from a finished run. `durationMs` is derived here rather than accepted, so a
 * caller cannot file a duration that disagrees with its own timestamps. */
export function recordStageRun(facts: StageRunFacts): StageRoutingRecord {
  return {
    stage: facts.stage,
    providerId: facts.providerId,
    ...(facts.model === undefined ? {} : { model: facts.model }),
    tier: facts.tier,
    tierEvidence: facts.tierEvidence,
    ...(facts.fallbackReason === undefined ? {} : { fallbackReason: facts.fallbackReason }),
    attempt: facts.attempt,
    outcome: facts.outcome,
    startedAt: facts.startedAt,
    finishedAt: facts.finishedAt,
    durationMs: Math.max(0, facts.finishedAt - facts.startedAt),
    usage: facts.usage,
    cost: computeStageCost(facts.price, facts.usage),
  };
}

/** Default ring size. Large enough to cover a long working session's worth of stage runs, small
 * enough that an in-memory ledger can never become a memory leak in a long-lived daemon. */
export const DEFAULT_LEDGER_CAPACITY = 500;

/**
 * A bounded, in-memory ring of routing records.
 *
 * In-memory and bounded on purpose: these records name a provider, a model and a token count, never
 * CV text, a job description, a mailbox or a path, but they are still operational telemetry with no
 * retention story, and this repo's durable stores have a standing rule that no free-form text
 * reaches disk (see `v2-sessions-create.ts`'s note on `unavailableOptional`). Nothing here is
 * persisted, and a process restart legitimately starts the ledger empty.
 */
export class StageRoutingLedger {
  private readonly records: StageRoutingRecord[] = [];

  constructor(private readonly capacity: number = DEFAULT_LEDGER_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError('StageRoutingLedger capacity must be a positive integer');
    }
  }

  record(facts: StageRunFacts): StageRoutingRecord {
    const entry = recordStageRun(facts);
    this.records.push(entry);
    if (this.records.length > this.capacity) this.records.splice(0, this.records.length - this.capacity);
    return entry;
  }

  all(): readonly StageRoutingRecord[] {
    return [...this.records];
  }

  forStage(stage: GenerationStage): readonly StageRoutingRecord[] {
    return this.records.filter((entry) => entry.stage === stage);
  }

  clear(): void {
    this.records.length = 0;
  }
}
