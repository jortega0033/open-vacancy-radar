/**
 * One routable provider/model pairing, as the caller describes it to the router (issue #284).
 *
 * Every field here is supplied by the caller rather than looked up inside this package, for the
 * same reason `resolveModelSelection`'s `catalog` argument is (see model-select.ts): the router
 * must be provider-agnostic and testable against fixture catalogs, and whoever holds a live
 * `ProviderStatus` plus a live model catalog is the only component that can honestly say what a
 * pairing is today.
 *
 * The honesty rules this file exists to make un-bypassable:
 *
 * - **Price is a union, not a nullable number.** `{ kind: 'unknown' }` is a first-class value with
 *   a reason attached. There is no default price, no "assume zero", and no per-provider table
 *   hidden anywhere in this package. A price only exists here because a caller measured or
 *   configured it and said where it came from.
 * - **Tier carries its own evidence.** `tierEvidence` travels with `tier` everywhere, so a
 *   `'capable'` label typed into a settings file can never be read back as a measured finding.
 */
import type { AuthStatus, ProviderCapabilities, ProviderId } from '@agent-dock/shared';
import type { ModelTier, TierEvidence } from './stages.js';

/**
 * What one token of this model costs, or an explicit, reasoned absence.
 *
 * `source` on the known variant is required and free-form on purpose: a number with no provenance
 * is indistinguishable from a guess three months later, and this package's whole cost story rests
 * on being able to say where a figure came from.
 */
export type CandidatePrice =
  | {
      kind: 'unknown';
      /**
       * Why there is no price. `not_published` means the provider does not publish one for this
       * pairing at all (a CLI billed against a subscription, for instance); `not_configured` means
       * one may exist but this installation has not been told it. Both stay `unknown` downstream --
       * the distinction is for a human reading a report, never for arithmetic.
       */
      reason: 'not_published' | 'not_configured';
    }
  | {
      kind: 'known';
      usdPerMillionInputTokens: number;
      usdPerMillionOutputTokens: number;
      /** Where these numbers came from, e.g. a dated provider pricing page or a local override. */
      source: string;
    };

export const PRICE_NOT_PUBLISHED: CandidatePrice = Object.freeze({ kind: 'unknown', reason: 'not_published' });
export const PRICE_NOT_CONFIGURED: CandidatePrice = Object.freeze({ kind: 'unknown', reason: 'not_configured' });

export interface RoutingCandidate {
  readonly providerId: ProviderId;
  /**
   * A provider-native model id from that provider's own catalog, or absent to mean "whatever this
   * provider's CLI defaults to". Absent is not a wildcard: it is routed and recorded as the real
   * thing it is, and the routing record says `model: undefined` rather than inventing a name for
   * a model this repo never chose.
   */
  readonly model?: string;
  /** The adapter's own declared capabilities, straight off `ProviderStatus.capabilities`. */
  readonly capabilities: ProviderCapabilities;
  readonly tier: ModelTier;
  readonly tierEvidence: TierEvidence;
  readonly price: CandidatePrice;
  readonly installed: boolean;
  readonly authenticated: AuthStatus;
}

/** A pairing named by identity alone, for comparing a preference or a benchmark row against a candidate. */
export interface CandidateRef {
  readonly providerId: ProviderId;
  readonly model?: string;
}

/**
 * Identity comparison for a provider/model pairing, with "no model named" treated as its own
 * distinct value rather than as a match-anything wildcard.
 *
 * A preference for `{ providerId: 'claude' }` therefore matches only the candidate that also names
 * no model -- the provider's default -- and never silently binds to whichever dated model id
 * happened to be first in today's catalog. Model identity participates in continuation safety
 * (ADI-03's own note on `resolveModelSelection`), and a wildcard here would quietly reintroduce
 * exactly the drift that resolver was written to prevent.
 */
export function sameCandidate(a: CandidateRef, b: CandidateRef): boolean {
  return a.providerId === b.providerId && (a.model ?? null) === (b.model ?? null);
}

/** A stable, human-readable label for one pairing. Display and log use only; never passed to a CLI. */
export function describeCandidate(ref: CandidateRef): string {
  return ref.model ? `${ref.providerId}/${ref.model}` : `${ref.providerId} (provider default)`;
}
