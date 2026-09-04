import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderId } from '@agent-dock/shared';
import { AiOutput } from './AiOutput.js';
import { buildCvTailorPrompt } from './prompts.js';
import { describeError, useAgentRun } from './useAgentRun.js';
import type { CvDocument, VacancyLead } from './types.js';

export interface TailorCvProps {
  cv: CvDocument | null;
  vacancy: VacancyLead | null;
  /** Optional provider model id (e.g. 'sonnet'); omitted means the CLI's own default. */
  model?: string;
  /** Which installed CLI to run through; omitted means Claude Code. */
  provider?: ProviderId;
}

type CopyState = 'idle' | 'copied' | 'failed';

const COPY_FEEDBACK_MS = 2_000;

/**
 * Drafts a tailored CV for one vacancy: the same real CV content, reordered and re-emphasized to
 * fit this specific posting, streamed in, and copyable out. Never a new fact, never a save path.
 *
 * "Regenerate" is a plain new session with the same inputs rather than a follow-up turn: each draft
 * is independent, so a bad one can simply be discarded, and no conversation state has to be kept
 * alive between them.
 */
export function TailorCv({ cv, vacancy, model, provider }: TailorCvProps) {
  const run = useAgentRun();
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [copyError, setCopyError] = useState<string>();
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(
    () => () => {
      if (copyTimeoutRef.current !== undefined) clearTimeout(copyTimeoutRef.current);
    },
    [],
  );

  const canRun = !!cv && !!vacancy && !run.isBusy;
  const hasDraft = run.text.trim().length > 0;

  const handleRun = useCallback(() => {
    if (!cv || !vacancy) return;
    setCopyState('idle');
    setCopyError(undefined);
    void run.start(buildCvTailorPrompt(cv, vacancy), {
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
    });
  }, [cv, vacancy, model, provider, run]);

  const handleCopy = useCallback(async () => {
    if (copyTimeoutRef.current !== undefined) clearTimeout(copyTimeoutRef.current);
    try {
      await navigator.clipboard.writeText(run.text);
      setCopyState('copied');
      setCopyError(undefined);
    } catch (err) {
      // Clipboard access can be denied; say so rather than silently pretending it worked.
      setCopyState('failed');
      setCopyError(describeError(err, 'could not copy to the clipboard'));
    }
    copyTimeoutRef.current = setTimeout(() => setCopyState('idle'), COPY_FEEDBACK_MS);
  }, [run.text]);

  return (
    <div className="card card-border rounded-box border-base-300 bg-base-100">
      <div className="card-body gap-3 p-5">
        <div className="card-title text-base font-bold">Tailored CV</div>
        <p className="text-sm text-base-content/60">
          Your actual CV content, reordered and re-emphasized for this specific vacancy. It is a
          draft to review, not a replacement for the CV on file.
        </p>

        {!cv && <div className="text-sm text-base-content/60">Load a CV above to enable this.</div>}
        {cv && !vacancy && (
          <div className="text-sm text-base-content/60">Select a vacancy to tailor your CV for.</div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" type="button" onClick={handleRun} disabled={!canRun}>
            {hasDraft && !run.isBusy ? 'Regenerate' : 'Draft tailored CV'}
          </button>
          <button className="btn btn-outline" type="button" onClick={() => void run.cancel()} disabled={!run.isBusy}>
            Cancel
          </button>
          <button
            className="btn btn-outline"
            type="button"
            onClick={() => void handleCopy()}
            disabled={!hasDraft || run.isBusy}
          >
            Copy to clipboard
          </button>
          {copyState === 'copied' && (
            <span className="text-sm font-medium" role="status">
              Copied
            </span>
          )}
        </div>

        {copyState === 'failed' && copyError && (
          <div className="alert alert-error text-sm" role="alert">
            {copyError}
          </div>
        )}

        <AiOutput
          status={run.status}
          text={run.text}
          {...(run.error ? { error: run.error } : {})}
          label="tailored CV draft"
          idleHint="No draft yet."
          busyLabel="Tailoring your CV for this vacancy…"
        />
      </div>
    </div>
  );
}
