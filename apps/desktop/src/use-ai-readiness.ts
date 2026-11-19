import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderId } from '@agent-dock/shared';
import { useProviderOverride } from './provider-limits.js';
import { resolveEffectiveProvider } from './resolve-effective-provider.js';

/**
 * Whether the AI tool an AI feature would actually run through can run right now (#767).
 *
 * The provider is resolved exactly like `useEffectiveProvider` resolves it (the saved preference,
 * the one unambiguous installed alternative, or this session's limit override), so a screen that
 * shows this status and the AI run it then starts always talk about the same tool. Welcome used to
 * read the bare preference while its "Fill from CV" drawer ran the resolved one.
 */
export type AiReadiness =
  | { kind: 'checking' }
  | { kind: 'ready'; provider: ProviderId }
  | { kind: 'not-installed'; provider: ProviderId }
  | { kind: 'not-authenticated'; provider: ProviderId }
  | { kind: 'unreachable' };

/** Live read, re-run on demand and whenever the AI helper reports ready (it is often still
 * starting when the first screen opens). */
export function useAiReadiness(): { readiness: AiReadiness; recheck: () => Promise<void> } {
  const [readiness, setReadiness] = useState<AiReadiness>({ kind: 'checking' });
  const override = useProviderOverride();
  const overrideRef = useRef(override);
  overrideRef.current = override;
  const mounted = useRef(true);

  const recheck = useCallback(async () => {
    setReadiness({ kind: 'checking' });
    try {
      const settings = await window.workspace.getSettings().catch(() => undefined);
      const preferred = settings?.defaultProvider ?? 'claude';
      const providers = await window.agentDock.listProviders();
      const provider = overrideRef.current ?? resolveEffectiveProvider(preferred, providers);
      const status = providers.find((p) => p.id === provider);
      let next: AiReadiness;
      if (!status?.installed) next = { kind: 'not-installed', provider };
      else if (status.authenticated !== 'authenticated') next = { kind: 'not-authenticated', provider };
      else next = { kind: 'ready', provider };
      if (mounted.current) setReadiness(next);
    } catch {
      if (mounted.current) setReadiness({ kind: 'unreachable' });
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void recheck();
    const unsubscribe = window.agentDock.onDaemonStatus((status) => {
      if (status.state === 'ready') void recheck();
    });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [recheck]);

  // A limit override chosen elsewhere changes which tool would run: re-read for that one.
  useEffect(() => {
    if (override) void recheck();
  }, [override, recheck]);

  return { readiness, recheck };
}
