import { useEffect, useState } from 'react';
import type { ProviderId, ProviderStatus } from '@agent-dock/shared';
import { resolveEffectiveProvider } from './resolve-effective-provider.js';

export interface EffectiveProvider {
  provider: ProviderId;
  providerStatus: ProviderStatus | undefined;
  providers: ProviderStatus[] | undefined;
}

/**
 * Combines the persisted `defaultProvider` preference with a live `listProviders()` read to
 * decide which CLI an AI feature actually runs a session through (issue #400). Every call site
 * this replaces had its own copy of exactly this pair of effects; centralizing them here is what
 * keeps "resolve against what's installed, never silently rewrite the preference" one behavior
 * instead of five.
 *
 * Best-effort on both reads, matching every call site this replaces: a failed fetch just leaves
 * the `'claude'` useState default in place rather than blocking the feature.
 */
export function useEffectiveProvider(): EffectiveProvider {
  const [preferred, setPreferred] = useState<ProviderId>('claude');
  const [providers, setProviders] = useState<ProviderStatus[]>();

  // The default provider is a settings preference (set from the AI Runtime page); a failure here
  // just leaves the Claude Code default in place rather than blocking the feature.
  useEffect(() => {
    let cancelled = false;
    void window.workspace
      .getSettings()
      .then((settings) => {
        if (!cancelled) setPreferred(settings.defaultProvider);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Best effort: a failed provider listing just leaves `provider` as the raw preference (the
  // resolver's own no-alternative-known fallback) rather than blocking the feature.
  useEffect(() => {
    let cancelled = false;
    window.agentDock
      .listProviders()
      .then((list) => {
        if (!cancelled) setProviders(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const provider = providers ? resolveEffectiveProvider(preferred, providers) : preferred;
  return { provider, providerStatus: providers?.find((status) => status.id === provider), providers };
}
