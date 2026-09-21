import type { ProviderId, ProviderStatus } from '@agent-dock/shared';

/**
 * Which provider an AI feature should actually run a session through: the persisted preference
 * if it's installed, otherwise the one unambiguous installed alternative, otherwise the
 * preference as-is (issue #400). Never mutates or implies rewriting the persisted preference --
 * callers must not write this result back to settings.
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
  const [onlyAlternative, ...rest] = installedAlternatives;
  if (onlyAlternative && rest.length === 0) return onlyAlternative.id;

  return preferred;
}
