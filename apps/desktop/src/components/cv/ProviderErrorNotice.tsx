import { useEffect, useState } from 'react';
import type { ProviderId, ProviderStatus } from '@agent-dock/shared';
import { PROVIDER_LABEL } from '../../provider-labels.js';
import { classifyProviderError } from '../../provider-error.js';
import { setProviderOverride } from '../../provider-limits.js';
import { ErrorBanner, WarningBanner } from '../shell/index.js';

export interface ProviderErrorNoticeProps {
  /** The raw message the failed run ended with. */
  error: string;
  /** The provider that run went through. */
  providerId: ProviderId;
  /** Runs the failed step again, with whichever provider is current when it is called. */
  onRetry?: () => void;
  className?: string;
}

function usable(status: ProviderStatus): boolean {
  return status.installed && status.authenticated === 'authenticated';
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * What a failed AI run says (#461). A usage limit is a state to wait out or route around, not an
 * error in the work, so it is a warning that says the work was kept, names the reset time only when
 * the provider gave one, and offers the other provider only when it is installed and signed in.
 * Everything else the provider printed stays behind Details with home-folder paths shortened.
 *
 * Switching is for this session only: it never rewrites the saved default, and it reruns just the
 * step that failed. The case, its approved facts and any letter draft are untouched by it.
 */
export function ProviderErrorNotice({ error, providerId, onRetry, className }: ProviderErrorNoticeProps) {
  const info = classifyProviderError(error);
  const label = PROVIDER_LABEL[providerId];
  const [alternative, setAlternative] = useState<ProviderStatus>();
  const [pendingSwitch, setPendingSwitch] = useState<ProviderId | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Only a usage limit can be routed around, so only then is the other provider worth looking up.
  useEffect(() => {
    if (info.kind !== 'usage_limit') return;
    let cancelled = false;
    window.agentDock
      .listProviders()
      .then((list) => {
        if (!cancelled) setAlternative(list.find((status) => status.id !== providerId && usable(status)));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [info.kind, providerId]);

  // Once the override is in place the page re-renders with the new provider; only then is a retry
  // handed the right one.
  useEffect(() => {
    if (pendingSwitch !== null && providerId === pendingSwitch) {
      setPendingSwitch(null);
      onRetry?.();
    }
  }, [pendingSwitch, providerId, onRetry]);

  useEffect(() => {
    if (info.resetAt === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [info.resetAt]);

  if (info.kind === 'other') {
    return (
      <ErrorBanner
        {...(className ? { className } : {})}
        details={info.details}
        action={onRetry && (
          <button type="button" className="btn btn-outline btn-xs" onClick={onRetry}>
            Try again
          </button>
        )}
      >
        {label} could not finish this step.
      </ErrorBanner>
    );
  }

  const details = (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs font-medium">Details</summary>
      <pre className="mt-1 max-h-40 overflow-auto text-xs break-words whitespace-pre-wrap">{info.details}</pre>
    </details>
  );

  if (info.kind === 'usage_limit') {
    const waiting = info.resetAt !== undefined && info.resetAt > now;
    return (
      <WarningBanner stacked {...(className ? { className } : {})}>
        <p>
          {label} has reached its usage limit{info.resetLabel ? ` until ${info.resetLabel}` : ''}. Your work so far is kept.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {alternative && (
            <button
              type="button"
              className="btn btn-warning btn-xs"
              onClick={() => {
                setPendingSwitch(alternative.id);
                setProviderOverride(alternative.id);
              }}
            >
              Use {PROVIDER_LABEL[alternative.id]} for now
            </button>
          )}
          <button type="button" className="btn btn-outline btn-xs" onClick={onRetry} disabled={!onRetry || waiting}>
            {info.resetLabel ? `Try again after ${info.resetAt !== undefined ? formatClock(info.resetAt) : info.resetLabel}` : 'Try again'}
          </button>
        </div>
        {details}
      </WarningBanner>
    );
  }

  const message =
    info.kind === 'not_signed_in'
      ? `${label} is not signed in. Sign in from the AI runtime page, then try again.`
      : `${label} could not be started. Check the AI runtime page, then try again.`;
  return (
    <WarningBanner stacked {...(className ? { className } : {})}>
      <p>{message}</p>
      <div className="mt-2">
        <button type="button" className="btn btn-outline btn-xs" onClick={onRetry} disabled={!onRetry}>
          Try again
        </button>
      </div>
      {details}
    </WarningBanner>
  );
}
