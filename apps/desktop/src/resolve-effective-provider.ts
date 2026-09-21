import type { ProviderId, ProviderStatus } from '@agent-dock/shared';

/**
 * Issue #400: `defaultProvider` is a persisted user preference (set only from the AI Runtime
 * page's "Use as default" action -- see `ProviderCard.tsx`), not a live read of what is actually
 * installed. On a machine with only one CLI installed, and a preference left pointing at the
 * other one (or still at the factory default, `'claude'`), every AI feature that read
 * `settings.defaultProvider` directly tried to run through a CLI that was not there at all,
 * instead of falling back to the one that actually is.
 *
 * This is the one place that reconciliation happens. It is deliberately a pure, synchronous
 * function with no side effects: it never writes back to persisted settings, never calls into
 * `window.workspace` or `window.agentDock` itself, and never mutates its inputs. Every AI-feature
 * call site computes its own preference (`settings.defaultProvider`) and its own provider-status
 * list (`window.agentDock.listProviders()`) the same way it always did, and passes both in here
 * to get the provider a session should actually run through.
 *
 * Priority order:
 * 1. The preferred provider, if it is installed -- the common case, and what keeps a
 *    both-installed or neither-installed machine behaving exactly as before.
 * 2. If the preferred provider is not installed and there is exactly one *other* provider
 *    installed, that one -- the actual bug fix: a single-CLI machine whose preference points
 *    elsewhere (or was never changed from the `'claude'` default) still gets a working provider.
 * 3. Otherwise (nothing installed, or more than one alternative installed -- not reachable with
 *    today's two providers, but the logic is generic rather than hardcoded to exactly two so a
 *    third provider does not need this rewritten), the preference itself, unchanged. A caller
 *    that wants to explain "not installed" in the UI still gets the persisted value to explain.
 */
export function resolveEffectiveProvider(
  preferred: ProviderId,
  providerStatuses: readonly ProviderStatus[],
): ProviderId {
  const preferredStatus = providerStatuses.find((status) => status.id === preferred);
  if (preferredStatus?.installed) return preferred;

  const installedAlternatives = providerStatuses.filter(
    (status) => status.id !== preferred && status.installed,
  );
  if (installedAlternatives.length === 1) return installedAlternatives[0]!.id;

  return preferred;
}
