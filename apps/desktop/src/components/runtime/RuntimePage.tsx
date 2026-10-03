import { useCallback, useEffect, useState } from 'react';
import type { ProviderId, ProviderStatus } from '@agent-dock/shared';
import { PROVIDER_LABEL } from '../../provider-labels.js';
import { activeProviderLimit, useProviderLimits } from '../../provider-limits.js';
import { AiHelperNotice, ErrorBanner, PageLoading } from '../shell/index.js';
import { ProviderCard, type ProviderCheckState } from './ProviderCard.js';

type VerifyResult = { kind: 'ok' } | { kind: 'failed'; reason: string; details?: string };

/** A failure shown as one plain sentence, with the raw message (when there is one) behind "Details". */
interface Problem {
  message: string;
  details?: string;
}

function problem(err: unknown, message: string): Problem {
  return err instanceof Error && err.message ? { message, details: err.message } : { message };
}

const HELPER_NOT_RESPONDING = 'The AI helper is not responding. Try again in a moment.';

export interface RuntimePageProps {
  /** App-wide daemon connectivity, computed once in App.tsx: every page would otherwise need its
   * own `getDaemonStatus`/`onDaemonStatus` subscription for the same one piece of state. */
  daemonState: 'connecting' | 'ready' | 'unavailable';
  daemonError?: string;
  /** The AI helper's "Try again" (#478): same state and handler the shell's notice uses. */
  onRetryHelper?: () => void;
  helperRetrying?: boolean;
  helperRetryFailed?: boolean;
  /** Fired after "Use as default" persists, so the sidebar/header label updates immediately
   * without this page needing to know how those are rendered. */
  onDefaultProviderChanged?: (provider: ProviderId) => void;
}

/**
 * The real "AI Runtime" screen from the prototype: which CLIs are available,
 * which one AI features run through, and a way to verify a CLI without spending a model call.
 * Replaces the AgentDock template's generic "pick a provider, type a prompt, watch raw events"
 * tester. That panel tested the daemon during development; it was never a feature a job-seeker
 * uses, and nothing in the CV/letter/gap-analysis code paths went through it (they use
 * `useAgentRun` directly).
 */
export function RuntimePage({
  daemonState,
  daemonError,
  onRetryHelper,
  helperRetrying = false,
  helperRetryFailed = false,
  onDefaultProviderChanged,
}: RuntimePageProps) {
  const [providers, setProviders] = useState<ProviderStatus[]>();
  const providerLimits = useProviderLimits();
  const [providersError, setProvidersError] = useState<Problem>();
  const [defaultProvider, setDefaultProvider] = useState<ProviderId>('claude');
  const [savingDefault, setSavingDefault] = useState(false);
  const [actionError, setActionError] = useState<Problem>();
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<VerifyResult>();
  const [checkStates, setCheckStates] = useState<Partial<Record<ProviderId, ProviderCheckState>>>({});

  const loadProviders = useCallback(async () => {
    try {
      const list = await window.agentDock.listProviders();
      setProviders(list);
      setProvidersError(undefined);
    } catch (err) {
      setProvidersError(problem(err, HELPER_NOT_RESPONDING));
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
        setActionError(problem(err, 'Could not save your choice.'));
      } finally {
        setSavingDefault(false);
      }
    },
    [onDefaultProviderChanged],
  );

  // "Check again" on one provider's card: re-reads every provider's status (one call) and reports
  // pending, ready or still-blocked for the card that asked.
  const checkAgain = useCallback(async (provider: ProviderId) => {
    setCheckStates((current) => ({ ...current, [provider]: 'checking' }));
    try {
      const list = await window.agentDock.listProviders();
      setProviders(list);
      setProvidersError(undefined);
      const status = list.find((p) => p.id === provider);
      const ready = status?.installed === true && status.authenticated === 'authenticated';
      setCheckStates((current) => ({ ...current, [provider]: ready ? 'ready' : 'blocked' }));
    } catch (err) {
      setProvidersError(problem(err, HELPER_NOT_RESPONDING));
      setCheckStates((current) => ({ ...current, [provider]: 'blocked' }));
    }
  }, []);

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
          reason: `${PROVIDER_LABEL[defaultProvider]} is installed but not signed in. Sign in, then check again.`,
        });
      } else {
        setVerifyResult({ kind: 'ok' });
      }
    } catch (err) {
      const { message, details } = problem(err, HELPER_NOT_RESPONDING);
      setVerifyResult({ kind: 'failed', reason: message, ...(details ? { details } : {}) });
    } finally {
      setVerifying(false);
    }
  }, [defaultProvider]);

  if (daemonState === 'unavailable' || helperRetrying) {
    return (
      <div className="max-w-3xl">
        <AiHelperNotice
          {...(daemonError ? { error: daemonError } : {})}
          retrying={helperRetrying}
          retryFailed={helperRetryFailed}
          onRetry={() => onRetryHelper?.()}
        />
      </div>
    );
  }

  const installed = providers?.filter((p) => p.installed) ?? [];
  // Choosing only matters with a real choice. With one tool installed there is nothing to pick,
  // unless the saved choice points at a tool that is missing.
  const showPicker =
    installed.length >= 2 || (installed.length === 1 && installed[0]?.id !== defaultProvider);

  return (
    <div className="max-w-3xl">
      <p className="text-sm text-base-content/70">
        The AI features run through Claude Code or Codex, already signed in on this computer. Your
        login details are never read or stored by this app.
      </p>

      {daemonState === 'connecting' && <PageLoading label="Starting the AI helper…" />}
      {providersError && (
        <ErrorBanner className="mt-4" {...(providersError.details ? { details: providersError.details } : {})}>
          {providersError.message}
        </ErrorBanner>
      )}
      {actionError && (
        <ErrorBanner className="mt-4" {...(actionError.details ? { details: actionError.details } : {})}>
          {actionError.message}
        </ErrorBanner>
      )}

      {providers && (
        <div className="mt-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
          {providers.map((status) => (
            <ProviderCard
              key={status.id}
              status={status}
              isDefault={status.id === defaultProvider}
              saving={savingDefault}
              showPicker={showPicker}
              onUseAsDefault={() => void useAsDefault(status.id)}
              onCheckAgain={() => void checkAgain(status.id)}
              {...(providerLimits.has(status.id) && activeProviderLimit(status.id) ? { limit: activeProviderLimit(status.id)! } : {})}
              {...(checkStates[status.id] ? { checkState: checkStates[status.id] } : {})}
            />
          ))}
        </div>
      )}

      <details className="mt-5 rounded-box border border-base-300 p-4">
        <summary className="cursor-pointer text-sm font-medium">Advanced check</summary>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="ovr-eyebrow">AI tool in use</div>
            <div className="mt-1 text-sm font-semibold">{PROVIDER_LABEL[defaultProvider]}</div>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => void verify()} disabled={verifying}>
            {verifying ? 'Checking…' : 'Check'}
          </button>
        </div>

        {verifyResult?.kind === 'ok' && (
          <p className="mt-2.5 text-sm" role="status">
            {PROVIDER_LABEL[defaultProvider]} is working.
          </p>
        )}
        {verifyResult?.kind === 'failed' && (
          <ErrorBanner className="mt-2.5" {...(verifyResult.details ? { details: verifyResult.details } : {})}>
            {verifyResult.reason}
          </ErrorBanner>
        )}

        <p className="mt-3 text-xs text-base-content/60">This check does not use your AI quota.</p>
      </details>
    </div>
  );
}
