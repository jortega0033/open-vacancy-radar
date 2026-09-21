import { useCallback, useEffect, useState } from 'react';
import { describeError, useAgentRun } from './useAgentRun.js';
import type { CvTextSource } from '../../window.js';

export interface CvPickerResult {
  fileName: string;
  text: string;
  textSource: CvTextSource;
}

export type CvPickerState =
  | { phase: 'idle' }
  | { phase: 'picking' }
  /** A scanned/image-only PDF this app cannot offer to transcribe (too many pages, no capable
   * provider), or one the user declined the native consent dialog for. `'declined'` is treated as
   * silently as a cancelled picker dialog: the user already answered, in an OS-native prompt main
   * itself showed, so there is nothing more for this hook to add. The other two reasons are surfaced
   * so the caller can point at the existing re-export/paste guidance. */
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

export interface UseCvPicker {
  state: CvPickerState;
  /** Opens the native picker. Every outcome (a plain read, a transcription starting, cancellation,
   * or a genuine read failure) is reflected in `state`, never thrown -- the caller renders `state`,
   * it does not need to catch this call. For a scanned/image-only PDF, `pick()` only ever resolves
   * with a transcription already under way: main itself decides whether to offer one at all and,
   * if so, shows the native consent dialog and stages the file, all before this promise resolves
   * (see `cv:select-and-read`'s own doc comment in main.ts for why that decision cannot be made in
   * this hook, or anywhere else in the renderer). */
  pick(): Promise<void>;
  reviewText: string;
  setReviewText(text: string): void;
  confirmReview(): void;
  /** Cancels a running transcription and returns to `idle`. */
  cancel(): void;
  /** Clears a terminal state (`'done'`, `'error'`, `'unavailable'`) back to `idle` once the caller
   * has consumed it. */
  reset(): void;
}

export function useCvPicker(): UseCvPicker {
  const [state, setState] = useState<CvPickerState>({ phase: 'idle' });
  const [reviewText, setReviewText] = useState('');
  const transcription = useAgentRun({ chunkSeparator: '' });

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

    if (selected.status === 'scanned-pdf-unavailable') {
      if (selected.reason === 'declined') {
        setState({ phase: 'idle' }); // the user already answered a real dialog; nothing more to say
      } else {
        setState({ phase: 'unavailable', fileName: selected.fileName, reason: selected.reason });
      }
      return;
    }

    // status === 'scanned-pdf': the user has already consented, in the native dialog main showed
    // before this call ever resolved, and the file is already staged. Nothing left to ask here --
    // start the transcription immediately. The prompt and provider below are placeholders: main's
    // `daemon:create-session` handler overrides both, and the provider, whenever an
    // `attachmentCandidateId` is present, precisely so this hook cannot redirect a real consent to
    // a different provider or a self-chosen prompt (see that handler's own comment).
    setState({ phase: 'transcribing', fileName: selected.fileName });
    void transcription.start('transcribe the attached document', {
      attachmentCandidateId: selected.candidateId,
    });
  }, [transcription]);

  const confirmReview = useCallback(() => {
    if (state.phase !== 'review') return;
    setState({ phase: 'done', result: { fileName: state.fileName, text: reviewText, textSource: 'ai_transcription' } });
  }, [reviewText, state]);

  const cancel = useCallback(() => {
    if (state.phase === 'transcribing') void transcription.cancel();
    setState({ phase: 'idle' });
  }, [state.phase, transcription]);

  const reset = useCallback(() => setState({ phase: 'idle' }), []);

  // Reacts to the transcription session's terminal status rather than deriving it during render.
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
    reviewText,
    setReviewText,
    confirmReview,
    cancel,
    reset,
  };
}
