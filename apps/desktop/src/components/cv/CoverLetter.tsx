import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProviderId } from '@agent-dock/shared';
import { PROVIDER_LABEL } from '../../provider-labels.js';
import type { CvProfile, CvSourceDocument, LetterTone } from '../../window.js';
import { buildGenerationInputBundle } from '../../../electron/generation-input.js';
import { buildBundledDocumentPrompt } from '../generation/prompts.js';
import {
  canGenerateGroundedLetter,
  GROUNDED_LETTER_DISCLOSURE,
  GROUNDED_LETTER_UNAVAILABLE,
  renderGroundedLetterFromSelection,
  type GroundedLetterRequest,
} from '../letters/grounded.js';
import { AiOutput } from './AiOutput.js';
import { describeError, useAgentRun } from './useAgentRun.js';
import type { CvDocument, VacancyLead } from './types.js';

export interface CoverLetterProps {
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
 * This card offers no tone control, so it picks the one tone that reads as the candidate's own
 * register rather than as a house style. Named here instead of inlined because the same value has
 * to reach the prompt and the assembly, and the two disagreeing would mean the letter the user
 * sees is not the one the selection was made for.
 */
const CARD_TONE: LetterTone = 'natural';

/**
 * Drafts a tailored motivation letter for one vacancy from the loaded CV and lets the user copy it
 * out or ask for a different draft.
 *
 * "Regenerate" is a plain new session with the same inputs rather than a follow-up turn: each draft
 * is independent, so a bad one can simply be discarded, and no conversation state has to be kept
 * alive between them.
 *
 * F-J changed what a run actually is. The session no longer writes a letter; it returns a list of
 * ids chosen from the candidate's own reviewed CV facts, and this component assembles the letter
 * from those (see `components/letters/grounded.ts`). Three consequences are visible in the code
 * below and all three are deliberate:
 *
 *  - `chunkSeparator: ''`, because the reply has to parse as one JSON object and the "\n\n" the
 *    prose features want would land inside it.
 *  - The panel shows `letter`, never `run.text`. A model reply that is not a valid selection
 *    produces no document at all, so there is no state in which raw output reaches the user
 *    looking like a draft.
 *  - Generation requires a reviewed source CV. An ad-hoc upload has no confirmed facts to cite, and
 *    the honest answer to that is to say so, not to fall back to prose nobody checked.
 */
export function CoverLetter({ cv, vacancy, sourceCv, profile, model, provider }: CoverLetterProps) {
  const run = useAgentRun({ chunkSeparator: '' });
  const [letter, setLetter] = useState('');
  const [selectionError, setSelectionError] = useState<string>();
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [copyError, setCopyError] = useState<string>();
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  // Which run's reply has already been assembled. A counter rather than a text comparison, so a
  // second run returning the identical selection still replaces the draft on screen.
  const runSeq = useRef(0);
  const appliedSeq = useRef(0);
  // The inputs the in-flight run was started for. Held rather than recomputed at completion time so
  // a letter is always assembled from the same facts the selection was made over, even if the user
  // changed the selected CV or vacancy while it was running.
  const requestRef = useRef<GroundedLetterRequest | null>(null);

  useEffect(
    () => () => {
      if (copyTimeoutRef.current !== undefined) clearTimeout(copyTimeoutRef.current);
    },
    [],
  );

  // #281: the motivation letter is one document type on the shared generation bundle, so it carries
  // the same corrected facts, critical requirements and completeness ledger the CV and the Letters
  // page do instead of its own separately-assembled prompt.
  const bundle = useMemo(
    () =>
      cv && vacancy
        ? buildGenerationInputBundle({
            documentType: 'motivation_letter',
            cv,
            vacancy,
            sourceCv: sourceCv ?? null,
            profile: profile ?? null,
          })
        : null,
    [cv, vacancy, sourceCv, profile],
  );

  const isGrounded = canGenerateGroundedLetter(bundle);
  const canRun = isGrounded && !run.isBusy;
  const hasDraft = letter.trim().length > 0;
  /** A rejected selection is a failure of this run as much as a dead session is, and it is reported
   * through the same panel so the user never has to look in two places for "what went wrong". */
  const failure = selectionError ?? run.error;

  const handleRun = useCallback(() => {
    if (!bundle) return;
    setCopyState('idle');
    setCopyError(undefined);
    setSelectionError(undefined);
    setLetter('');
    runSeq.current += 1;
    requestRef.current = { bundle, type: 'motivation_letter', tone: CARD_TONE, length: bundle.length };
    void run.start(buildBundledDocumentPrompt(bundle, { tone: CARD_TONE }), {
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
    });
  }, [bundle, model, provider, run]);

  // Assemble the finished letter once per completed run. A selection that does not parse, or that
  // names a fact this CV does not carry, becomes a stated failure here and never a draft.
  useEffect(() => {
    if (run.status !== 'completed') return;
    if (appliedSeq.current === runSeq.current) return;
    const request = requestRef.current;
    if (!request) return;
    appliedSeq.current = runSeq.current;
    try {
      setLetter(renderGroundedLetterFromSelection(run.text, request));
      setSelectionError(undefined);
    } catch (err) {
      setLetter('');
      setSelectionError(describeError(err, 'the letter generation run returned something that could not be used'));
    }
  }, [run.status, run.text]);

  const handleCopy = useCallback(async () => {
    if (copyTimeoutRef.current !== undefined) clearTimeout(copyTimeoutRef.current);
    try {
      await navigator.clipboard.writeText(letter);
      setCopyState('copied');
      setCopyError(undefined);
    } catch (err) {
      // Clipboard access can be denied; say so rather than silently pretending it worked.
      setCopyState('failed');
      setCopyError(describeError(err, 'could not copy to the clipboard'));
    }
    copyTimeoutRef.current = setTimeout(() => setCopyState('idle'), COPY_FEEDBACK_MS);
  }, [letter]);

  return (
    <div className="card card-border rounded-box border-base-300 bg-base-100">
      <div className="card-body gap-3 p-5">
        <div className="card-title text-base font-bold">Cover letter</div>
        <p className="text-sm text-base-content/60">
          A motivation letter for this specific vacancy. {GROUNDED_LETTER_DISCLOSURE} Read it before
          you send it: it is a first draft, not a submission.
        </p>

        {!cv && <div className="text-sm text-base-content/60">Load a CV above to enable this.</div>}
        {cv && !vacancy && (
          <div className="text-sm text-base-content/60">Select a vacancy to write a letter for.</div>
        )}
        {bundle && !isGrounded && (
          <div className="text-sm text-base-content/60">{GROUNDED_LETTER_UNAVAILABLE}</div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" type="button" onClick={handleRun} disabled={!canRun}>
            {hasDraft && !run.isBusy ? 'Regenerate' : 'Draft cover letter'}
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
          status={selectionError ? 'failed' : run.status}
          text={letter}
          {...(failure ? { error: failure } : {})}
          label="cover letter draft"
          idleHint="No draft yet."
          busyLabel="Choosing which of your CV facts belong in this letter…"
          providerLabel={PROVIDER_LABEL[provider ?? 'claude']}
        />
      </div>
    </div>
  );
}
