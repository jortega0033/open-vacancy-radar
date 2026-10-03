import { useEffect, useRef } from 'react';
import type { AgentRunStatus } from './useAgentRun.js';
import type { ProviderId } from '@agent-dock/shared';
import { ErrorBanner } from '../shell/index.js';
import { ProviderErrorNotice } from './ProviderErrorNotice.js';

/**
 * The streaming answer surface, shared by both AI features: a bordered, fixed-height, scrolling
 * region with `role="log"` so a screen reader announces additions, rather than a growing block
 * that pushes the buttons off-screen mid-answer.
 *
 * Every state is explicit and named: idle, working, streaming-but-not-done, done, failed,
 * cancelled (because "nothing visibly happening" is indistinguishable from "hung" otherwise).
 * Monochrome throughout (see DESIGN-TOKENS.md): status is carried by weight, borders and opacity.
 */
export interface AiOutputProps {
  status: AgentRunStatus;
  text: string;
  error?: string;
  /** What the panel says before the first run, e.g. "Load a CV and pick a vacancy to start." */
  idleHint: string;
  /** What the spinner says while waiting, e.g. "Analyzing your CV against this vacancy…" */
  busyLabel: string;
  label: string;
  /** With `onRetry`, a failed run gets the guided provider notice (usage limit, sign-in, unavailable)
   * instead of the raw message (#461). */
  providerId?: ProviderId;
  onRetry?: () => void;
}

export function AiOutput({ status, text, error, idleHint, busyLabel, label, providerId, onRetry }: AiOutputProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isBusy = status === 'starting' || status === 'streaming';

  // Follow the tail as chunks arrive, the way a log view does.
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [text]);

  return (
    <div className="mt-4">
      {isBusy && (
        <div className="mb-3 flex items-center gap-3 text-sm text-base-content/70" role="status">
          <span className="loading loading-spinner loading-sm" aria-hidden="true" />
          <span>{status === 'starting' ? 'Getting started…' : busyLabel}</span>
        </div>
      )}

      {status === 'failed' && error && (
        providerId && onRetry ? (
          <ProviderErrorNotice className="mb-3" error={error} providerId={providerId} onRetry={onRetry} />
        ) : (
          <ErrorBanner className="mb-3">
            {error}
          </ErrorBanner>
        )
      )}

      {status === 'cancelled' && (
        <div className="mb-3 border-l-2 border-base-content pl-2 text-sm opacity-70">Cancelled.</div>
      )}

      {text ? (
        <div
          ref={scrollRef}
          className="rounded-box max-h-96 overflow-y-auto border border-base-300 bg-base-100 p-4 text-sm leading-relaxed whitespace-pre-wrap"
          role="log"
          aria-label={label}
          aria-busy={isBusy}
        >
          {text}
        </div>
      ) : (
        !isBusy &&
        status !== 'failed' && (
          <div className="rounded-box border border-base-300 p-4 text-sm text-base-content/60">{idleHint}</div>
        )
      )}
    </div>
  );
}
