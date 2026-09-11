import { describe, expect, it } from 'vitest';
import {
  STAGE_CONTRACTS,
  describeStageDecision,
  routeStage,
  stageContract,
  type RoutingCandidate,
  type StageRoutingDecision,
} from '../src/index.js';
import { candidate, priced, tiered } from './support/stage-candidates.js';

function routed(decision: StageRoutingDecision) {
  if (decision.outcome !== 'routed') throw new Error(`expected a routed decision, got ${decision.outcome}`);
  return decision;
}

/**
 * **Acceptance check 1 of issue #284**, and the one that is a real safety regression if it slips.
 *
 * `application_field_map` reasons over a scraped job description with the `'no-network'` hardening
 * profile applied. Only an adapter that declares `hardenedNoNetwork` actually applies it --
 * `buildCodexArgs` never reads `opts.hardened` at all -- so routing that stage to a provider without
 * the declaration would produce a session with `WebFetch`/`WebSearch` still allowed while every log
 * line said "hardened".
 *
 * These tests exist to make that unreachable through *selection*, whatever the price incentive. The
 * daemon route's own literal provider check is the independent second layer and is pinned by
 * `apps/daemon/test/stage-routing.field-map.test.ts`; neither layer is allowed to be the only one.
 */
describe('routeStage: a stage capability contract outranks price (acceptance check 1)', () => {
  it('refuses a free provider that does not declare the hardening capability, and says what was missing', () => {
    const decision = routeStage({
      stage: 'application_field_map',
      candidates: [
        candidate({
          providerId: 'codex',
          model: 'cheap-model',
          capabilities: { hardenedNoNetwork: false },
          price: priced(0, 0),
          ...tiered('capable'),
        }),
      ],
    });

    expect(decision.outcome).toBe('no_eligible_candidate');
    if (decision.outcome !== 'no_eligible_candidate') throw new Error('unreachable');
    expect(decision.requiredCapabilities).toEqual(['hardenedNoNetwork']);
    expect(decision.rejected).toEqual([
      {
        providerId: 'codex',
        model: 'cheap-model',
        reason: 'missing_capability',
        missingCapabilities: ['hardenedNoNetwork'],
      },
    ]);
  });

  it('routes to the far more expensive eligible provider rather than the ineligible cheap one', () => {
    const decision = routed(
      routeStage({
        stage: 'application_field_map',
        preferCheaperWithinTier: true,
        candidates: [
          candidate({
            providerId: 'codex',
            model: 'cheap-model',
            capabilities: { hardenedNoNetwork: false },
            price: priced(0.01, 0.02),
            ...tiered('capable'),
          }),
          candidate({
            providerId: 'claude',
            model: 'opus',
            price: priced(15, 75),
            ...tiered('capable'),
          }),
        ],
      }),
    );

    expect(decision.providerId).toBe('claude');
    expect(decision.model).toBe('opus');
    expect(decision.rejected.map((entry) => entry.providerId)).toEqual(['codex']);
  });

  it('treats an absent capability key exactly like false: absence is never support', () => {
    // `ProviderCapabilities` documents "absent means unsupported, exactly like false" (AD-15), and
    // Codex's real capabilities object omits `hardenedNoNetwork` rather than setting it false. A
    // truthiness test here would read `undefined` as unsupported too, but a `!== false` test would
    // not -- this pins the direction.
    const capabilities = { resume: true, cancellation: true, tools: true, usage: true, thinking: true };
    const decision = routeStage({
      stage: 'application_field_map',
      candidates: [{ ...candidate({ providerId: 'codex' }), capabilities }],
    });
    expect(decision.outcome).toBe('no_eligible_candidate');
  });

  it('does not honor a caller preference that fails the stage contract, and records why', () => {
    const decision = routed(
      routeStage({
        stage: 'application_field_map',
        preferred: { providerId: 'codex', model: 'cheap-model' },
        candidates: [
          candidate({
            providerId: 'codex',
            model: 'cheap-model',
            capabilities: { hardenedNoNetwork: false },
            price: priced(0, 0),
          }),
          candidate({ providerId: 'claude', model: 'sonnet', price: priced(3, 15) }),
        ],
      }),
    );

    expect(decision.providerId).toBe('claude');
    expect(decision.fallbackReason).toBe('preferred_candidate_missing_capability');
  });

  it('keeps the requirement attached to the stage, not to the provider: the same provider is eligible elsewhere', () => {
    const codexWithoutHardening = candidate({
      providerId: 'codex',
      model: 'cheap-model',
      capabilities: { hardenedNoNetwork: false },
      ...tiered('small'),
    });

    expect(routeStage({ stage: 'application_field_map', candidates: [codexWithoutHardening] }).outcome).toBe(
      'no_eligible_candidate',
    );
    // The very same pairing routes fine for a stage whose contract does not require the profile,
    // which is what makes this a capability gate rather than a provider ban.
    expect(routed(routeStage({ stage: 'cv_field_extraction', candidates: [codexWithoutHardening] })).providerId).toBe(
      'codex',
    );
  });

  it('never selects a provider that is not installed or not authenticated, at any price', () => {
    const decision = routeStage({
      stage: 'cv_field_extraction',
      candidates: [
        candidate({ providerId: 'codex', installed: false, price: priced(0, 0) }),
        candidate({ providerId: 'claude', authenticated: 'unknown', price: priced(0, 0) }),
      ],
    });
    expect(decision.outcome).toBe('no_eligible_candidate');
    expect(decision.rejected.map((entry) => entry.reason)).toEqual(['not_installed', 'not_authenticated']);
  });

  it('refuses a model id that would not be safe to hand to a provider CLI', () => {
    const decision = routeStage({
      stage: 'cv_field_extraction',
      candidates: [candidate({ providerId: 'claude', model: '--dangerously-skip-permissions' })],
    });
    expect(decision.outcome).toBe('no_eligible_candidate');
    expect(decision.rejected[0]?.reason).toBe('invalid_model_id');
  });
});

describe('routeStage: workload decides tier preference', () => {
  const small = candidate({ providerId: 'claude', model: 'haiku', ...tiered('small') });
  const capable = candidate({ providerId: 'claude', model: 'opus', ...tiered('capable') });

  it('prefers a small eligible model for bounded extraction', () => {
    const decision = routed(routeStage({ stage: 'cv_field_extraction', candidates: [capable, small] }));
    expect(decision.model).toBe('haiku');
    expect(decision.fallbackReason).toBeUndefined();
  });

  it('prefers a capable model for a grounded document', () => {
    const decision = routed(routeStage({ stage: 'cv_tailoring', candidates: [small, capable] }));
    expect(decision.model).toBe('opus');
    expect(decision.fallbackReason).toBeUndefined();
  });

  it('records a fallback reason when the preferred tier has no eligible pairing, rather than degrading silently', () => {
    const decision = routed(routeStage({ stage: 'cover_letter', candidates: [small] }));
    expect(decision.model).toBe('haiku');
    expect(decision.fallbackReason).toBe('no_preferred_tier_available');
  });

  it('sorts an unknown tier last rather than treating it as either extreme', () => {
    const unknown = candidate({ providerId: 'codex', model: 'unlabelled', ...tiered('unknown') });
    expect(routed(routeStage({ stage: 'cv_field_extraction', candidates: [unknown, capable] })).model).toBe('opus');
    expect(routed(routeStage({ stage: 'cv_tailoring', candidates: [unknown, small] })).model).toBe('haiku');
  });
});

describe('routeStage: the operator preference and price ordering', () => {
  it('honors the configured default verbatim when it is eligible, even against a higher tier', () => {
    // The convention #268 had to restore in CvDrawer: the persisted `default_provider` decides which
    // CLI runs, and a router that quietly overruled it would reintroduce the same class of bug.
    const decision = routed(
      routeStage({
        stage: 'cv_tailoring',
        preferred: { providerId: 'codex' },
        candidates: [
          candidate({ providerId: 'claude', model: 'opus', ...tiered('capable') }),
          candidate({ providerId: 'codex', ...tiered('small') }),
        ],
      }),
    );
    expect(decision.providerId).toBe('codex');
    expect(decision.model).toBeUndefined();
    expect(decision.fallbackReason).toBeUndefined();
  });

  it('does not treat a preference naming no model as a wildcard over that provider catalog', () => {
    const decision = routed(
      routeStage({
        stage: 'cv_tailoring',
        preferred: { providerId: 'claude' },
        candidates: [candidate({ providerId: 'claude', model: 'opus' })],
      }),
    );
    // The preference asked for the provider's own default model; the only offer names `opus`. That
    // is a different pairing, so it is a recorded fallback rather than a silent bind.
    expect(decision.fallbackReason).toBe('preferred_candidate_unavailable');
  });

  it('breaks a within-tier tie by known price only when every price in that tier is known', () => {
    const dear = candidate({ providerId: 'claude', model: 'opus', ...tiered('capable'), price: priced(15, 75) });
    const cheap = candidate({ providerId: 'claude', model: 'sonnet', ...tiered('capable'), price: priced(3, 15) });
    expect(
      routed(routeStage({ stage: 'cv_tailoring', candidates: [dear, cheap], preferCheaperWithinTier: true })).model,
    ).toBe('sonnet');

    const unpriced = candidate({ providerId: 'codex', model: 'unpriced', ...tiered('capable') });
    // One unknown price in the tier disables the ordering entirely: ranking a known price against an
    // unknown one is a claim about the unknown one.
    expect(
      routed(routeStage({ stage: 'cv_tailoring', candidates: [dear, unpriced, cheap], preferCheaperWithinTier: true }))
        .model,
    ).toBe('opus');
  });

  it('never compares price across tiers, so a cheap small model cannot outrank a capable one', () => {
    const cheapSmall = candidate({ providerId: 'codex', model: 'tiny', ...tiered('small'), price: priced(0.1, 0.2) });
    const dearCapable = candidate({ providerId: 'claude', model: 'opus', ...tiered('capable'), price: priced(15, 75) });
    const decision = routed(
      routeStage({ stage: 'cover_letter', candidates: [cheapSmall, dearCapable], preferCheaperWithinTier: true }),
    );
    expect(decision.model).toBe('opus');
  });
});

describe('stage contracts', () => {
  it('names a capability requirement for the field-map stage and for no other stage today', () => {
    const withRequirements = Object.values(STAGE_CONTRACTS)
      .filter((contract) => contract.requiredCapabilities.length > 0)
      .map((contract) => contract.stage);
    expect(withRequirements).toEqual(['application_field_map']);
  });

  it('bounds every stage to at most two model attempts', () => {
    for (const contract of Object.values(STAGE_CONTRACTS)) {
      expect(contract.maxAttempts).toBe(2);
    }
  });

  it('sends a cover letter straight to the candidate for a missing fact: there is nothing to retrieve', () => {
    expect(stageContract('cover_letter').retrievalAvailable).toBe(false);
  });
});

describe('describeStageDecision', () => {
  it('states the pairing, the tier and where the tier label came from', () => {
    const decision = routeStage({
      stage: 'cv_field_extraction',
      candidates: [candidate({ providerId: 'claude', model: 'haiku', ...tiered('small') })],
    });
    expect(describeStageDecision(decision)).toBe('cv_field_extraction: claude/haiku, tier small (operator_declared)');
  });

  it('names the missing requirement when nothing was eligible', () => {
    const none: readonly RoutingCandidate[] = [];
    expect(describeStageDecision(routeStage({ stage: 'application_field_map', candidates: none }))).toBe(
      'application_field_map: no eligible provider (requires hardenedNoNetwork)',
    );
  });
});
