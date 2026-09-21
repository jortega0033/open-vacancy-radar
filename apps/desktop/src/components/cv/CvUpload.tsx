import { useEffect, useState } from 'react';
import { CvTranscriptionFlow } from './CvTranscriptionFlow.js';
import { useCvPicker } from './useCvPicker.js';
import type { CvDocument } from './types.js';

/**
 * Picks a CV through the `window.cv` bridge (via `useCvPicker`, issue #396) and hands the extracted
 * text up.
 *
 * Controlled on purpose: the CV lives in the parent (CvAssistant) so gap analysis and the cover
 * letter share one upload. Asking for the same document twice for two features that run
 * side by side would be the obvious flow bug here.
 *
 * The outcomes of the picker are distinct and all visible: loaded (name + character count, with
 * the text inspectable so the user can confirm the extraction sensibly before it is sent anywhere),
 * cancelled (nothing changes, no error shown: cancelling is not a failure), failed (the real
 * reason, e.g. an encrypted PDF), and -- for a scanned/image-only PDF -- an opt-in offer to
 * transcribe it with AI, reviewed before use (`CvTranscriptionFlow`).
 */
export interface CvUploadProps {
  cv: CvDocument | null;
  onCvChange(cv: CvDocument | null): void;
  /** Display name of the CLI the loaded text is actually sent to, e.g. "Claude Code" or "Codex"
   * (see `PROVIDER_LABEL`): reflects the user's configured default provider, not a fixed one. */
  providerLabel: string;
}

export function CvUpload({ cv, onCvChange, providerLabel }: CvUploadProps) {
  const picker = useCvPicker();
  const [showText, setShowText] = useState(false);

  useEffect(() => {
    if (picker.state.phase !== 'done') return;
    const { result } = picker.state;
    onCvChange({ fileName: result.fileName, text: result.text, textSource: result.textSource });
    setShowText(false);
    picker.reset();
  }, [onCvChange, picker]);

  const isLoading = picker.state.phase === 'picking' || picker.state.phase === 'transcribing';

  return (
    <div className="card card-border rounded-box border-base-300 bg-base-100">
      <div className="card-body gap-3 p-5">
        <div className="card-title text-base font-bold">Your CV</div>
        <p className="text-sm text-base-content/60">
          PDF, Word, plain text or Markdown. The file is read on this machine and its text is only sent to
          your own {providerLabel} CLI.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <button className="btn" type="button" onClick={() => void picker.pick()} disabled={isLoading}>
            {picker.state.phase === 'picking' && (
              <span className="loading loading-spinner loading-xs text-base-content" aria-hidden="true" />
            )}
            {cv ? 'Replace CV' : 'Choose CV file'}
          </button>
          {cv && (
            <>
              <button className="btn btn-outline btn-sm" type="button" onClick={() => setShowText((v) => !v)}>
                {showText ? 'Hide text' : 'Show extracted text'}
              </button>
              <button
                className="btn btn-outline btn-sm"
                type="button"
                onClick={() => {
                  onCvChange(null);
                  setShowText(false);
                }}
                disabled={isLoading}
              >
                Remove
              </button>
            </>
          )}
        </div>

        {picker.state.phase === 'picking' && (
          <div className="text-sm text-base-content/70" role="status">
            Reading and extracting text&hellip;
          </div>
        )}

        <CvTranscriptionFlow picker={picker} />

        {cv && (
          <div className="text-sm">
            CV loaded: <span className="font-mono">{cv.fileName}</span>,{' '}
            {cv.text.length.toLocaleString('en-US')} characters
          </div>
        )}

        {cv && showText && (
          <div
            className="rounded-box max-h-72 overflow-y-auto border border-base-300 p-3 font-mono text-xs whitespace-pre-wrap"
            aria-label="extracted CV text"
          >
            {cv.text}
          </div>
        )}
      </div>
    </div>
  );
}
