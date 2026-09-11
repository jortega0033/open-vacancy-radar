/**
 * The stage router (issue #284): given one stage and the pairings actually available right now,
 * which provider and model should draft or extract.
 *
 * ## What it is not allowed to do
 *
 * It picks a model. It does not change what happens once a model is picked: fetching, identity
 * checks, rendering, hashing and state transitions all stay exactly where they are and stay
 * deterministic. And it never approves, authorizes or triggers an application submission -- that
 * decision lives in `packages/application-executor` behind `resolveSubmitControl` and the
 * executor's own handoff rules, and nothing in this package can reach it. See
 * `stage-routing.submission-boundary.test.ts`, which fails if that ever stops being structurally
 * true rather than merely currently true.
 *
 * ## Order of operations, and why it is this order
 *
 * Eligibility is resolved **before** anything comparative happens -- before tier, before price,
 * before a caller's stated preference. A candidate that fails a stage's capability contract is not
 * ranked last, it is removed and recorded in `rejected`, so there is no ordering, weighting or
 * configuration under which a cheaper ineligible pairing can win. That is acceptance check 1 of
 * #284, and it is enforced by the shape of this function rather than by a comparison that could be
 * tuned: price never enters the same array as an ineligible candidate.
 *
 * ## Fallback is recorded, never silent
 *
 * Every outcome that is not "the caller's preference, honored exactly" carries a
 * `StageFallbackReason`. A decision with no reason means no degradation happened; there is no third
 * state where something was substituted and nobody was told.
 */
import type { ProviderCapabilities } from '@agent-dock/shared';
import { modelSelectValueSchema } from '../model-select.js';
import {
  describeCandidate,
  sameCandidate,
  type CandidatePrice,
  type CandidateRef,
  type RoutingCandidate,
} from './candidates.js';
import {
  STAGE_TIER_PREFERENCE,
  stageContract,
  type GenerationStage,
  type ModelTier,
  type TierEvidence,
} from './stages.js';

/** Why a pairing the caller offered was not eligible for this stage. */
export type CandidateRejectionReason =
  | 'missing_capability'
  | 'not_installed'
  | 'not_authenticated'
  | 'invalid_model_id';

export interface RejectedCandidate {
  readonly providerId: RoutingCandidate['providerId'];
  readonly model?: string;
  readonly reason: CandidateRejectionReason;
  /**
   * The capability keys this pairing was missing, present only for `missing_capability`. Named
   * individually rather than summarized so a routing record can say *which* contract was unmet
   * without a reader re-deriving it from the stage table.
   */
  readonly missingCapabilities?: readonly string[];
}

/** Why the routed pairing is not the one the stage would have preferred. Absent means no degradation. */
export type StageFallbackReason =
  /** The caller named a preference that this stage's capability contract rules out. */
  | 'preferred_candidate_missing_capability'
  /** The caller named a preference that is not installed, not authenticated, or not offered at all. */
  | 'preferred_candidate_unavailable'
  /** No preference was named (or it was honored in provider but not tier), and the stage's first-choice tier had no eligible pairing. */
  | 'no_preferred_tier_available';

export interface StageRoutingRequest {
  readonly stage: GenerationStage;
  /**
   * Every pairing the caller is willing to run right now. Typically built from
   * `ProviderRegistry.detectAll()` crossed with each provider's live model catalog (ADI-22a), but
   * deliberately caller-supplied: this package never probes a provider itself.
   */
  readonly candidates: readonly RoutingCandidate[];
  /**
   * The operator's own configured choice -- in this app, the persisted `default_provider` setting
   * that every AI feature already reads (see CvDrawer's own note on it). Honored verbatim whenever
   * it is eligible, including when a cheaper or higher-tier pairing is available: the router exists
   * to stop an ineligible selection, not to overrule a user who made one.
   */
  readonly preferred?: CandidateRef;
  /**
   * Break ties within one tier by known price, cheapest first. Off by default, and ignored for any
   * tier in which even one candidate has an unknown price: sorting a known price against an unknown
   * one silently ranks "we have no idea" as either cheap or expensive, and both are claims nobody
   * measured.
   */
  readonly preferCheaperWithinTier?: boolean;
}

export interface RoutedStage {
  readonly outcome: 'routed';
  readonly stage: GenerationStage;
  readonly providerId: RoutingCandidate['providerId'];
  readonly model?: string;
  readonly tier: ModelTier;
  readonly tierEvidence: TierEvidence;
  readonly price: CandidatePrice;
  readonly fallbackReason?: StageFallbackReason;
  readonly rejected: readonly RejectedCandidate[];
}

export interface UnroutableStage {
  readonly outcome: 'no_eligible_candidate';
  readonly stage: GenerationStage;
  readonly requiredCapabilities: readonly string[];
  readonly rejected: readonly RejectedCandidate[];
}

export type StageRoutingDecision = RoutedStage | UnroutableStage;

function missingCapabilities(
  capabilities: ProviderCapabilities,
  required: readonly string[],
): readonly string[] {
  // `=== true` rather than a truthiness test, matching `AuthStatus`'s own rule in
  // packages/shared/src/provider.ts: absent and `false` both mean unsupported, and a capability
  // map arriving with a non-boolean value for a key must never read as support.
  return required.filter((key) => capabilities[key] !== true);
}

function rejectionFor(
  candidate: RoutingCandidate,
  required: readonly string[],
): RejectedCandidate | undefined {
  if (!candidate.installed) {
    return { providerId: candidate.providerId, ...modelPart(candidate), reason: 'not_installed' };
  }
  // Only `'authenticated'` passes. `'unknown'` means the daemon could not determine auth state, and
  // treating that as usable is the exact mistake `AuthStatus` was made a string union to prevent.
  if (candidate.authenticated !== 'authenticated') {
    return { providerId: candidate.providerId, ...modelPart(candidate), reason: 'not_authenticated' };
  }
  if (candidate.model !== undefined && !modelSelectValueSchema.safeParse({ model: candidate.model }).success) {
    // The routed model id is destined for a provider CLI's own argv. `modelSelectValueSchema` is
    // already this repo's reviewed answer for what is safe to put there (a leading `-` would be
    // read as a flag, control bytes are refused outright), so it is reused rather than re-derived.
    return { providerId: candidate.providerId, ...modelPart(candidate), reason: 'invalid_model_id' };
  }
  const missing = missingCapabilities(candidate.capabilities, required);
  if (missing.length > 0) {
    return {
      providerId: candidate.providerId,
      ...modelPart(candidate),
      reason: 'missing_capability',
      missingCapabilities: missing,
    };
  }
  return undefined;
}

function modelPart(ref: CandidateRef): { model?: string } {
  return ref.model === undefined ? {} : { model: ref.model };
}

function allPricesKnown(candidates: readonly RoutingCandidate[]): boolean {
  return candidates.every((candidate) => candidate.price.kind === 'known');
}

function totalKnownPrice(price: CandidatePrice): number {
  return price.kind === 'known' ? price.usdPerMillionInputTokens + price.usdPerMillionOutputTokens : 0;
}

function routedFrom(
  stage: GenerationStage,
  candidate: RoutingCandidate,
  rejected: readonly RejectedCandidate[],
  fallbackReason?: StageFallbackReason,
): RoutedStage {
  return {
    outcome: 'routed',
    stage,
    providerId: candidate.providerId,
    ...modelPart(candidate),
    tier: candidate.tier,
    tierEvidence: candidate.tierEvidence,
    price: candidate.price,
    ...(fallbackReason === undefined ? {} : { fallbackReason }),
    rejected,
  };
}

/**
 * Picks the provider/model for one stage.
 *
 * Returns `no_eligible_candidate` rather than relaxing anything when nothing clears the stage's
 * contract. There is deliberately no "best effort" branch: for `application_field_map` a best-effort
 * pick would be a session with none of the tool restrictions the stage exists to guarantee, and a
 * router that degrades that quietly is worse than one that refuses loudly. The caller's answer to a
 * refusal is to tell the user which capability is missing (`requiredCapabilities` says which), not
 * to retry with a weaker request.
 */
export function routeStage(request: StageRoutingRequest): StageRoutingDecision {
  const contract = stageContract(request.stage);
  const required = contract.requiredCapabilities;

  const eligible: RoutingCandidate[] = [];
  const rejected: RejectedCandidate[] = [];
  for (const candidate of request.candidates) {
    const rejection = rejectionFor(candidate, required);
    if (rejection) rejected.push(rejection);
    else eligible.push(candidate);
  }

  const firstEligible = eligible[0];
  if (firstEligible === undefined) {
    return {
      outcome: 'no_eligible_candidate',
      stage: request.stage,
      requiredCapabilities: required,
      rejected,
    };
  }

  const preference = STAGE_TIER_PREFERENCE[contract.workload];
  const best = bestByTier(eligible, preference, request.preferCheaperWithinTier === true) ?? firstEligible;

  const preferred = request.preferred;
  if (preferred) {
    const preferredMatch = eligible.find((candidate) => sameCandidate(candidate, preferred));
    if (preferredMatch) {
      // Honored exactly, with no fallback reason even when a higher-tier pairing was available: the
      // configured default is a decision the operator already made, and quietly overruling it here
      // is the same class of bug as the hardcoded provider #268 had to remove from CvDrawer.
      return routedFrom(request.stage, preferredMatch, rejected);
    }
    const preferredRejection = rejected.find((entry) => sameCandidate(entry, preferred));
    const reason: StageFallbackReason =
      preferredRejection?.reason === 'missing_capability'
        ? 'preferred_candidate_missing_capability'
        : 'preferred_candidate_unavailable';
    return routedFrom(request.stage, best, rejected, reason);
  }

  const fellBack = best.tier !== preference[0];
  return routedFrom(request.stage, best, rejected, fellBack ? 'no_preferred_tier_available' : undefined);
}

/**
 * First eligible candidate in the stage's tier order, with an optional cheapest-first tie-break
 * *within* one tier.
 *
 * The tie-break is scoped to a single tier on purpose. Comparing prices across tiers would let a
 * cheap small model outrank a capable one for a grounded document on price alone, which is a
 * quality claim -- "the cheaper one is good enough here" -- that nothing in this package has
 * measured. Within one declared tier the pairings are, by the operator's own statement,
 * interchangeable, so price is the only distinguishing fact left.
 */
function bestByTier(
  eligible: readonly RoutingCandidate[],
  preference: readonly ModelTier[],
  preferCheaper: boolean,
): RoutingCandidate | undefined {
  for (const tier of preference) {
    const inTier = eligible.filter((candidate) => candidate.tier === tier);
    const head = inTier[0];
    if (head === undefined) continue;
    if (preferCheaper && inTier.length > 1 && allPricesKnown(inTier)) {
      // A stable sort (ES2019+ guarantees it) so equal prices keep the caller's own order rather
      // than an arbitrary one that could differ between runs.
      return [...inTier].sort((a, b) => totalKnownPrice(a.price) - totalKnownPrice(b.price))[0] ?? head;
    }
    return head;
  }
  return undefined;
}

/**
 * A one-line, log-safe summary of a decision. Deliberately states the fallback reason and the
 * tier's evidence, and deliberately states no saving, ranking, or superlative: everything it can
 * say is a fact the decision already carries.
 */
export function describeStageDecision(decision: StageRoutingDecision): string {
  if (decision.outcome === 'no_eligible_candidate') {
    return `${decision.stage}: no eligible provider (requires ${decision.requiredCapabilities.join(', ') || 'nothing'})`;
  }
  const pairing = describeCandidate(decision);
  const tier = `tier ${decision.tier} (${decision.tierEvidence})`;
  return decision.fallbackReason
    ? `${decision.stage}: ${pairing}, ${tier}, fallback: ${decision.fallbackReason}`
    : `${decision.stage}: ${pairing}, ${tier}`;
}
