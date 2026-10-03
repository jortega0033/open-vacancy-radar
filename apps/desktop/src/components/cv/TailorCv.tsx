import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderId } from '@agent-dock/shared';
import type { CvProfile, CvSourceDocument } from '../../window.js';
import { buildGenerationInputBundle } from '../../../electron/generation-input.js';
import { buildBundledDocumentPrompt } from '../generation/prompts.js';
import { AiOutput } from './AiOutput.js';
import { describeError, useAgentRun } from './useAgentRun.js';
import type { CvDocument, VacancyLead } from './types.js';
import { ErrorBanner } from '../shell/index.js';

export interface TailorCvProps {
  cv: CvDocument | null;
  vacancy: VacancyLead | null;
  /** #274's reviewed structured source, when this CV has one. Read-only here. */
  sourceCv?: CvSourceDocument | null;
  /** The corrected private profile, when one has been confirmed for this CV. */
  profile?: CvProfile | null;
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
export function TailorCv({ cv, vacancy, sourceCv, profile, model, provider }: TailorCvProps) {
  const run = useAgentRun();
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [copyError, setCopyError] = useState<string>();
  /** Stays set once the draft was copied, until a new draft replaces it, so the warning does not fade with "Copied". */
  const [copiedDraft, setCopiedDraft] = useState(false);
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
    setCopiedDraft(false);
    // #281: one bundle in, one prompt out. The reviewed source, the corrected profile, the
    // requirement lines read out of the whole posting and the completeness ledger all reach the
    // prompt through `buildGenerationInputBundle` rather than being gathered here.
    const bundle = buildGenerationInputBundle({
      documentType: 'tailored_cv',
      cv,
      vacancy,
      sourceCv: sourceCv ?? null,
      profile: profile ?? null,
    });
    void run.start(buildBundledDocumentPrompt(bundle), {
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
    });
  }, [cv, vacancy, sourceCv, profile, model, provider, run]);

  const handleCopy = useCallback(async () => {
    if (copyTimeoutRef.current !== undefined) clearTimeout(copyTimeoutRef.current);
    try {
      await navigator.clipboard.writeText(run.text);
      setCopyState('copied');
      setCopyError(undefined);
      setCopiedDraft(true);
    } catch (err) {
      // Clipboard access can be denied; say so rather than silently pretending it worked.
      setCopyState('failed');
      setCopyError(describeError(err, 'could not copy to the clipboard'));
    }
    copyTimeoutRef.current = setTimeout(() => setCopyState('idle'), COPY_FEEDBACK_MS);
  }, [run.text]);

  return (
    <details className="card card-border rounded-box border-base-300 bg-base-100">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 p-5 text-base font-bold">
        Quick draft to read
        <span className="badge badge-warning badge-sm">Unchecked</span>
      </summary>
      <div className="card-body gap-3 p-5 pt-0">
        <p className="text-sm text-base-content/60">
          A quick draft to read. It is never approved and does not replace your CV.
        </p>

        {!cv && <div className="text-sm text-base-content/60">Load a CV above to enable this.</div>}
        {cv && !vacancy && (
          <div className="text-sm text-base-content/60">Select a vacancy to tailor your CV for.</div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-outline" type="button" onClick={handleRun} disabled={!canRun}>
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
          <ErrorBanner>
            {copyError}
          </ErrorBanner>
        )}
        {copiedDraft && (
          <div className="alert alert-warning text-sm" role="status">
            This draft is unchecked. Read every line against your own record before you use any of it.
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
    </details>
  );
}
