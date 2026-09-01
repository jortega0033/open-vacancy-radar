import type { ProviderStatus } from '@agent-dock/shared';
import {
  LEGACY_ONE_SHOT_TRANSPORT_ID,
  acceptedWorkBoundaryFor,
  findProviderCompatibility,
  type ProviderImplementation,
} from '@agent-dock/agent-runtime';
import type { ActiveSessionCapacity } from './active-session-limiter.js';

/**
 * Projects this repo's real v1 `ProviderStatus` onto the v2 provider read view.
 *
 * ## What this deliberately is not
 *
 * Upstream AgentDock's v2 provider surface is built on a capability catalog, `CapabilityRequest`
 * objects, and a `negotiateCapabilities` handshake, because upstream's v2 clients *create* sessions
 * through that surface. This repo ships only read routes for v2 (see
 * docs/adr-agentdock-v2-provenance.md#adi-05 for why `POST /v2/sessions` is deferred), and a
 * read-only status view needs none of that machinery. Porting it would mean introducing a
 * negotiation vocabulary with no producer, no consumer, and no test that could distinguish a
 * correct implementation from a plausible one.
 *
 * What a v2 client can actually learn here, beyond the v1 view, is the part that is real in this
 * repo: which transport a session would run over, whether that provider/version pairing is in the
 * reviewed compatibility manifest, where its accepted-work boundary sits, and how much of the
 * active-session budget is left.
 */

export interface ProviderV2View {
  id: string;
  name: string;
  installed: boolean;
  authenticated: string;
  version?: string;
  executablePath?: string;
  availableModels?: string[];
  capabilities: Record<string, boolean>;
  transportId: string;
  /**
   * `false` means the installed CLI version is not one this repo has run its conformance fixtures
   * against. That is an expected, supported state (a user on a newer CLI), not an error -- it only
   * means `acceptedWorkBoundary` below is the fail-closed default rather than a verified fact.
   */
  compatibilityVerified: boolean;
  acceptedWorkBoundary: string;
  capacity: ActiveSessionCapacity;
}

/**
 * The manifest is keyed by a wider set than `ProviderId` (it also models the in-repo `fake`
 * provider). Narrowing explicitly rather than casting means an unmodelled provider id produces a
 * clean manifest miss -- and therefore the conservative boundary -- instead of a lookup against a
 * value the manifest's own type says cannot occur.
 */
function asProviderImplementation(id: string): ProviderImplementation | undefined {
  return id === 'claude' || id === 'codex' || id === 'fake' ? id : undefined;
}

export function toProviderV2View(status: ProviderStatus, capacity: ActiveSessionCapacity): ProviderV2View {
  const implementation = asProviderImplementation(status.id);
  const compatibility = implementation
    ? findProviderCompatibility(implementation, status.version, LEGACY_ONE_SHOT_TRANSPORT_ID)
    : undefined;

  const capabilities: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(status.capabilities)) {
    // `absent means unsupported` in v1 (AD-15). Flattening that to an explicit `false` here is
    // safe in one direction only, which is this one: a v2 reader gets a total map with no
    // undefined third state to mishandle, and nothing gains a capability it did not have.
    capabilities[key] = value === true;
  }

  return {
    id: status.id,
    name: status.name,
    installed: status.installed,
    authenticated: status.authenticated,
    ...(status.version === undefined ? {} : { version: status.version }),
    ...(status.executablePath === undefined ? {} : { executablePath: status.executablePath }),
    ...(status.availableModels === undefined ? {} : { availableModels: [...status.availableModels] }),
    capabilities,
    transportId: LEGACY_ONE_SHOT_TRANSPORT_ID,
    compatibilityVerified: compatibility !== undefined,
    acceptedWorkBoundary: acceptedWorkBoundaryFor(compatibility),
    capacity,
  };
}
