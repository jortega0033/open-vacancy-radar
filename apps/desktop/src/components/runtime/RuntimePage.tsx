import { useCallback, useEffect, useState } from 'react';
import type { ProviderId, ProviderStatus } from '@agent-dock/shared';
import runtimeUnavailableIllustration from '../../../assets/illustrations/runtime-unavailable.svg?no-inline';
import { PROVIDER_LABEL } from '../../provider-labels.js';
import { EmptyState } from '../shell/index.js';
import { ProviderCard } from './ProviderCard.js';

type VerifyResult =
  | { kind: 'ok'; executablePath: string; version: string }
  | { kind: 'failed'; reason: string };

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export interface RuntimePageProps {
  /** App-wide daemon connectivity, computed once in App.tsx — every page would otherwise need its
   * own `getDaemonStatus`/`onDaemonStatus` subscription for the same one piece of state. */
  daemonState: 'connecting' | 'ready' | 'unavailable';
  daemonError?: string;
  /** Fired after "Use as default" persists, so the sidebar/header label updates immediately
   * without this page needing to know how those are rendered. */
  onDefaultProviderChanged?: (provider: ProviderId) => void;
}

/**
 * The real "AI Runtime" screen from the prototype: which CLIs are available, their capabilities,
 * which one AI features run through, and a way to verify a CLI without spending a model call.
 * Replaces the AgentDock template's generic "pick a provider, type a prompt, watch raw events"
 * tester — that panel tested the daemon during development; it was never a feature a job-seeker
 * uses, and nothing in the CV/letter/gap-analysis code paths went through it (they use
 * `useAgentRun` directly).
 */
export function RuntimePage({ daemonState, daemonError, onDefaultProviderChanged }: RuntimePageProps) {
  const [providers, setProviders] = useState<ProviderStatus[]>();
  const [providersError, setProvidersError] = useState<string>();
  const [defaultProvider, setDefaultProvider] = useState<ProviderId>('claude');
  const [savingDefault, setSavingDefault] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult>();

  const loadProviders = useCallback(async () => {
    try {
      const list = await window.agentDock.listProviders();
      setProviders(list);
      setProvidersError(undefined);
    } catch (err) {
      setProvidersError(describeError(err, 'could not reach the local runtime'));
    }
  }, []);

  useEffect(() => {
    if (daemonState !== 'ready') return;
    void loadProviders();
  }, [daemonState, loadProviders]);

  useEffect(() => {
    let cancelled = false;
    void window.workspace
      .getSettings()
      .then((settings) => {
        if (!cancelled) setDefaultProvider(settings.defaultProvider);
      })
      .catch(() => {
        // the useState default ('claude') is already sensible
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const useAsDefault = useCallback(
    async (provider: ProviderId) => {
      setActionError(undefined);
      setSavingDefault(true);
      try {
        const updated = await window.workspace.updateSettings({ defaultProvider: provider });
        setDefaultProvider(updated.defaultProvider);
        setVerifyResult(undefined);
        onDefaultProviderChanged?.(updated.defaultProvider);
      } catch (err) {
        setActionError(describeError(err, 'could not save the default runtime'));
      } finally {
        setSavingDefault(false);
      }
    },
    [onDefaultProviderChanged],
  );

  const verify = useCallback(async () => {
    setVerifying(true);
    setVerifyResult(undefined);
    try {
      const list = await window.agentDock.listProviders();
      setProviders(list);
      const status = list.find((p) => p.id === defaultProvider);
      if (!status?.installed) {
        setVerifyResult({ kind: 'failed', reason: `${PROVIDER_LABEL[defaultProvider]} is not installed.` });
      } else if (status.authenticated !== 'authenticated') {
        setVerifyResult({
          kind: 'failed',
          reason: `${PROVIDER_LABEL[defaultProvider]} is installed but not authenticated. Run its login command, then verify again.`,
        });
      } else {
        setVerifyResult({
          kind: 'ok',
          executablePath: status.executablePath ?? 'detected, path not reported',
          version: status.version ?? 'detected, version not reported',
        });
      }
    } catch (err) {
      setVerifyResult({ kind: 'failed', reason: describeError(err, 'verification failed') });
    } finally {
      setVerifying(false);
    }
  }, [defaultProvider]);

  if (daemonState === 'unavailable') {
    return (
      <EmptyState
        illustration={runtimeUnavailableIllustration}
        title="AI runtime unavailable"
        description={`The local runtime is not available. AI-assisted actions remain disabled until it starts.${daemonError ? ` (${daemonError})` : ''}`}
      />
    );
  }

  return (
    <div className="max-w-3xl">
      <h2 className="text-lg font-semibold">AI Runtime</h2>
      <p className="mt-2 text-sm text-base-content/70">
        Open Vacancy Radar uses an AI CLI already installed and authenticated on this computer,
        through the local AgentDock runtime.
      </p>
      <p className="mt-1 text-xs text-base-content/50">
        AgentDock does not read or store your Claude Code or Codex login credentials.
        Authentication remains managed by the installed CLI.
      </p>

      {daemonState === 'connecting' && (
        <div className="alert alert-info mt-4">Connecting to local daemon…</div>
      )}
      {providersError && <div className="alert alert-error mt-4">{providersError}</div>}
      {actionError && <div className="alert alert-error mt-4">{actionError}</div>}

      {providers && (
        <div className="mt-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          {providers.map((status) => (
            <ProviderCard
              key={status.id}
              status={status}
              isDefault={status.id === defaultProvider}
              saving={savingDefault}
              onUseAsDefault={() => void useAsDefault(status.id)}
            />
          ))}
        </div>
      )}

      <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-box border border-base-300 p-4">
        <div>
          <div className="text-[11px] font-semibold tracking-wide text-base-content/60 uppercase">
            Default runtime
          </div>
          <div className="mt-1 text-sm font-semibold">{PROVIDER_LABEL[defaultProvider]}</div>
          <div className="mt-0.5 text-xs text-base-content/60">
            Model: CLI default — Open Vacancy Radar uses the model configured by the selected CLI.
          </div>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => void verify()} disabled={verifying}>
          {verifying ? 'Verifying…' : 'Verify'}
        </button>
      </div>

      {verifyResult?.kind === 'ok' && (
        <div className="mt-2.5 rounded-box border border-base-300 bg-base-200 p-3.5 text-xs leading-loose">
          <div>
            <span className="text-success">✓</span> Executable detected —{' '}
            <span className="font-mono">{verifyResult.executablePath}</span>
          </div>
          <div>
            <span className="text-success">✓</span> Version check passed — {verifyResult.version}
          </div>
          <div>
            <span className="text-success">✓</span> Authentication status available — Authenticated
          </div>
        </div>
      )}
      {verifyResult?.kind === 'failed' && (
        <div className="alert alert-error mt-2.5 text-xs">{verifyResult.reason}</div>
      )}

      <p className="mt-5 max-w-xl text-xs text-base-content/50">
        Verification checks that the executable exists, responds to a version query, and reports
        its authentication status. It does not run a model request and does not consume usage.
      </p>
    </div>
  );
}
