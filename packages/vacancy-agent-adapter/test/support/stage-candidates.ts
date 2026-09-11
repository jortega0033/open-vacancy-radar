import type { ProviderCapabilities } from '@agent-dock/shared';
import {
  PRICE_NOT_PUBLISHED,
  type CandidatePrice,
  type ModelTier,
  type RoutingCandidate,
} from '../../src/index.js';

/**
 * Fixture candidate builder for the stage-routing suites.
 *
 * Deliberately does **not** import `CLAUDE_CAPABILITIES` / `CODEX_CAPABILITIES` from
 * `@agent-dock/agent-runtime`: this package does not depend on that one (dependencies flow
 * shared -> agent-runtime, never sideways), and the router is provider-agnostic by design, so its
 * tests describe capability sets directly rather than borrowing a real adapter's. The agent-runtime
 * suite is where the real adapters' declarations are pinned.
 *
 * Defaults are the *permissive* ones -- installed, authenticated, every capability true -- so that
 * a test asserting a refusal has to state the one fact it is about, and cannot pass by accident
 * because some unrelated default happened to be restrictive.
 */
export function candidate(overrides: Partial<RoutingCandidate> & Pick<RoutingCandidate, 'providerId'>): RoutingCandidate {
  const capabilities: ProviderCapabilities = {
    resume: true,
    cancellation: true,
    tools: true,
    usage: true,
    thinking: true,
    hardenedNoNetwork: true,
    ...overrides.capabilities,
  };
  return {
    installed: true,
    authenticated: 'authenticated',
    tier: 'capable',
    tierEvidence: 'operator_declared',
    price: PRICE_NOT_PUBLISHED,
    ...overrides,
    capabilities,
  };
}

export function priced(usdPerMillionInputTokens: number, usdPerMillionOutputTokens: number): CandidatePrice {
  return { kind: 'known', usdPerMillionInputTokens, usdPerMillionOutputTokens, source: 'fixture pricing table' };
}

export function tiered(tier: ModelTier): Pick<RoutingCandidate, 'tier' | 'tierEvidence'> {
  return { tier, tierEvidence: 'operator_declared' };
}
