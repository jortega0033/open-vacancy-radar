import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError, useAgentRun } from './useAgentRun.js';
import { useEffectiveProvider } from '../../use-effective-provider.js';
import { PROVIDER_LABEL } from '../../provider-labels.js';
import type { CvTextSource } from '../../window.js';

export interface CvPickerResult {
  fileName: string;
  text: string;
  textSource: CvTextSource;
}

export type CvPickerState =
  | { phase: 'idle' }
  | { phase: 'picking' }
  /** Explicit, opt-in consent (issue #396): the original PDF is about to leave the local-extraction
   * path and be sent to `providerLabel` for transcription. Nothing is sent until `confirmTranscription`. */
  | { phase: 'consent'; fileName: string; providerLabel: string }
  /** A scanned/image-only PDF this app cannot offer to transcribe -- either it has more pages than
   * the transcription fallback supports, or no configured AI runtime can accept a file attachment
   * right now. Either way, the existing re-export/paste guidance is the only path forward. */
  | { phase: 'unavailable'; fileName: string; reason: 'too-many-pages' | 'no-provider' }
  | { phase: 'transcribing'; fileName: string }
  /** The transcribed text is shown for review before it can be saved anywhere -- issue #396's
   * requirement that AI-transcribed text is never silently treated as canonical. `reviewText` is
   * editable; `confirmReview` is the one thing that produces a `'done'` result from this phase. */
  | { phase: 'review'; fileName: string }
  | { phase: 'done'; result: CvPickerResult }
  | { phase: 'error'; message: string };

/**
 * Mirrors `cv-text.ts`'s `MAX_CV_EXTRACTED_TEXT_CHARS` intentionally: that module is Node-only
 * (imports `node:fs/promises`) and cannot be imported from renderer code, so the same bound is
 * restated here rather than shared. Generous for any real CV, transcribed or not; this exists to
 * refuse an implausibly oversized model output, not to trim a normal one.
 */
const MAX_TRANSCRIBED_CV_TEXT_CHARS = 2_000_000;

const TRANSCRIPTION_PROMPT = [
  'The attached PDF is a scanned or image-only CV/resume with no selectable text layer.',
  'Transcribe it faithfully into plain text: every section, employer, date range, degree, and',
  'skill, in the same order as the original document. Do not summarize, comment, translate, or',
  'add anything that is not present in the document. Reply with only the transcribed text.',
].join(' ');

export interface UseCvPicker {
  state: CvPickerState;
  /** Opens the native picker. Every outcome (a plain read, an offer to transcribe, cancellation, or
   * a genuine read failure) is reflected in `state`, never thrown -- the caller renders `state`,
   * it does not need to catch this call. */
  pick(): Promise<void>;
  confirmTranscription(): void;
  declineTranscription(): void;
  reviewText: string;
  setReviewText(text: string): void;
  confirmReview(): void;
  /** Cancels whatever is in flight (an offer not yet answered, a running transcription) and
   * discards any staged file, returning to `idle`. */
  cancel(): void;
  /** Clears a terminal state (`'done'`, `'error'`, `'unavailable'`) back to `idle` once the caller
   * has consumed it. */
  reset(): void;
}

export function useCvPicker(): UseCvPicker {
  const [state, setState] = useState<CvPickerState>({ phase: 'idle' });
  const [reviewText, setReviewText] = useState('');
  const candidateIdRef = useRef<string>();
  const transcription = useAgentRun({ chunkSeparator: '' });
  const { provider, providerStatus } = useEffectiveProvider();

  const discardCandidate = useCallback(() => {
    const candidateId = candidateIdRef.current;
    candidateIdRef.current = undefined;
    if (candidateId) void window.cv.discardStagedTranscription(candidateId).catch(() => {});
  }, []);

  const pick = useCallback(async () => {
    setState({ phase: 'picking' });
    let selected;
    try {
      selected = await window.cv.selectAndRead();
    } catch (err) {
      setState({ phase: 'error', message: describeError(err, 'could not read that file') });
      return;
    }

    if (!selected) {
      setState({ phase: 'idle' }); // the user closed the dialog -- not a failure
      return;
    }

    if (selected.status === 'ok') {
      setState({ phase: 'done', result: { fileName: selected.fileName, text: selected.text, textSource: 'text_layer' } });
      return;
    }

    // status === 'scanned-pdf'
    if (selected.tooManyPages || !selected.candidateId) {
      setState({ phase: 'unavailable', fileName: selected.fileName, reason: 'too-many-pages' });
      return;
    }
    // The provider status list can still be loading on first render; this only ever *withholds*
    // the offer in that window, never wrongly makes one -- `capabilities.attachments` must be
    // explicitly true.
    if (!providerStatus?.installed || providerStatus.capabilities.attachments !== true) {
      candidateIdRef.current = selected.candidateId;
      discardCandidate(); // nothing will ever consume it; free the staged copy right away
      setState({ phase: 'unavailable', fileName: selected.fileName, reason: 'no-provider' });
      return;
    }

    candidateIdRef.current = selected.candidateId;
    setState({ phase: 'consent', fileName: selected.fileName, providerLabel: PROVIDER_LABEL[provider] });
  }, [discardCandidate, provider, providerStatus]);

  const confirmTranscription = useCallback(() => {
    if (state.phase !== 'consent') return;
    const candidateId = candidateIdRef.current;
    if (!candidateId) return;
    const fileName = state.fileName;
    setState({ phase: 'transcribing', fileName });
    void transcription.start(TRANSCRIPTION_PROMPT, { provider, attachmentCandidateId: candidateId });
  }, [provider, state, transcription]);

  const declineTranscription = useCallback(() => {
    if (state.phase !== 'consent') return;
    discardCandidate();
    setState({ phase: 'idle' });
  }, [discardCandidate, state.phase]);

  const confirmReview = useCallback(() => {
    if (state.phase !== 'review') return;
    setState({ phase: 'done', result: { fileName: state.fileName, text: reviewText, textSource: 'ai_transcription' } });
  }, [reviewText, state]);

  const cancel = useCallback(() => {
    if (state.phase === 'transcribing') void transcription.cancel();
    discardCandidate();
    setState({ phase: 'idle' });
  }, [discardCandidate, state.phase, transcription]);

  const reset = useCallback(() => setState({ phase: 'idle' }), []);

  // Reacts to the transcription session's terminal status rather than deriving it during render:
  // `candidateIdRef` is only ever read again by `confirmTranscription` while `state.phase ===
  // 'consent'`; once a session has actually started (`'transcribing'`), the candidate id has
  // already been consumed server-side (issue #396's one-shot `consumeStagedCvAttachment`), so this
  // effect needs no id at all, only `transcription`'s own status/text/error.
  useEffect(() => {
    if (state.phase !== 'transcribing') return;
    if (transcription.status === 'completed') {
      const text = transcription.text.trim();
      if (text.length > MAX_TRANSCRIBED_CV_TEXT_CHARS) {
        setState({
          phase: 'error',
          message: `the transcription came back implausibly large (over ${MAX_TRANSCRIBED_CV_TEXT_CHARS.toLocaleString('en-US')} characters) and was rejected`,
        });
      } else {
        setReviewText(text);
        setState({ phase: 'review', fileName: state.fileName });
      }
    } else if (transcription.status === 'failed') {
      setState({ phase: 'error', message: transcription.error ?? 'transcription failed' });
    } else if (transcription.status === 'cancelled') {
      setState({ phase: 'idle' });
    }
    // `state.fileName` is read but not listed: including the whole `state` object would rerun this
    // on every phase change, not just a transcription status change, and `fileName` cannot change
    // without `phase` also changing away from `'transcribing'` first.
  }, [transcription.status, transcription.text, transcription.error]);

  return {
    state,
    pick,
    confirmTranscription,
    declineTranscription,
    reviewText,
    setReviewText,
    confirmReview,
    cancel,
    reset,
  };
}
