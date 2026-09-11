import type { FastifyInstance } from 'fastify';
import { V2_SESSION_VIEW_SCHEMA_VERSION, type ProviderStatus } from '@agent-dock/shared';
import { GENERATION_STAGES, routeStage, stageContract, type RoutingCandidate } from '@agent-dock/vacancy-agent-adapter';
import type { ProviderRegistry } from '@agent-dock/agent-runtime';

/**
 * `GET /v2/stage-routing` (issue #284): for each generation stage, which installed providers may
 * run it and which may not, with the reason.
 *
 * Read-only, and deliberately the *only* thing this route does. It answers an eligibility question
 * over the providers this daemon has registered; it does not start anything, does not select a
 * model, and has no write path of any kind. A client uses it to explain to a user why an AI feature
 * is unavailable ("the field map needs a CLI that implements the no-network profile") instead of
 * discovering that at the moment a session is refused.
 *
 * ## Why it does not pick a model
 *
 * `routeStage` ranks by an operator-declared tier, and nothing in this build declares one yet:
 * `ProviderModelV2` reports an id, a display name and a default flag, and says nothing about model
 * size. So every candidate this route constructs is `tier: 'unknown'`, which is the honest label and
 * which makes the ordering among eligible providers meaningless on purpose. What *is* meaningful --
 * and is the whole reason the route exists -- is the eligible/rejected split, which is driven
 * entirely by declared capabilities and real install/auth state. A per-stage model preference is a
 * settings surface, and it lands with that surface rather than being invented here.
 *
 * ## Cost
 *
 * One `registry.detectAll()`, which probes the filesystem and can spawn a `where`/`which` child per
 * candidate install directory -- the same cost `GET /providers` and `GET /v2/providers` already
 * carry, and not rate-limited for the same reason they are not: this daemon binds 127.0.0.1 only,
 * every request needs the per-launch bearer token, and the only caller that can reach it is the
 * desktop app's own Electron main process.
 *
 * ## What this route is not
 *
 * It is not the enforcement point for the field-map hardening contract. `POST
 * /sessions/application-field-map` keeps its own literal provider check, which does not consult
 * this route, this router, or any declared capability -- see that route's own doc comment for why
 * that gate must not rest on an adapter's self-description. A provider reported eligible here would
 * still be refused there unless it is the one this repo has actually reviewed for the profile.
 */
function toCandidate(status: ProviderStatus): RoutingCandidate {
  return {
    providerId: status.id,
    capabilities: status.capabilities,
    tier: 'unknown',
    tierEvidence: 'operator_declared',
    // `not_configured` rather than `not_published`: this build has no price table for any provider,
    // which is a fact about this installation, not a claim about what the provider publishes.
    price: { kind: 'unknown', reason: 'not_configured' },
    installed: status.installed,
    authenticated: status.authenticated,
  };
}

export function registerV2StageRoutingRoutes(app: FastifyInstance, registry: ProviderRegistry): void {
  app.get('/v2/stage-routing', async () => {
    const statuses = await registry.detectAll();
    const candidates = statuses.map(toCandidate);

    const stages = GENERATION_STAGES.map((stage) => {
      const contract = stageContract(stage);
      const decision = routeStage({ stage, candidates });
      const rejected = decision.rejected.map((entry) => ({
        providerId: entry.providerId,
        reason: entry.reason,
        ...(entry.missingCapabilities === undefined ? {} : { missingCapabilities: entry.missingCapabilities }),
      }));
      const rejectedIds = new Set(rejected.map((entry) => entry.providerId));
      return {
        stage,
        workload: contract.workload,
        requiredCapabilities: contract.requiredCapabilities,
        maxAttempts: contract.maxAttempts,
        retrievalAvailable: contract.retrievalAvailable,
        eligibleProviders: candidates
          .filter((entry) => !rejectedIds.has(entry.providerId))
          .map((entry) => entry.providerId),
        rejectedProviders: rejected,
      };
    });

    return { schemaVersion: V2_SESSION_VIEW_SCHEMA_VERSION, stages };
  });
}
