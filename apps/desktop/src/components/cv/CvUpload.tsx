import { useCallback, useState } from 'react';
import { describeError } from './useAgentRun.js';
import type { CvDocument } from './types.js';

/**
 * Picks a CV through the `window.cv` bridge and hands the extracted text up.
 *
 * Controlled on purpose: the CV lives in the parent (CvAssistant) so gap analysis and the cover
 * letter share one upload. Asking for the same document twice for two features that run
 * side by side would be the obvious flow bug here.
 *
 * The three outcomes of the picker are distinct and all visible: loaded (name + character count,
 * with the text inspectable so the user can confirm the PDF extracted sensibly before it is sent
 * anywhere), cancelled (nothing changes, no error shown: cancelling is not a failure), and failed
 * (the real reason, e.g. a scanned PDF with no selectable text).
 */
export interface CvUploadProps {
  cv: CvDocument | null;
  onCvChange(cv: CvDocument | null): void;
}

export function CvUpload({ cv, onCvChange }: CvUploadProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [showText, setShowText] = useState(false);

  const handleSelect = useCallback(async () => {
    setError(undefined);
    setIsLoading(true);
    try {
      const selected = await window.cv.selectAndRead();
      // null = the user closed the dialog. Leave any previously loaded CV in place.
      if (selected) {
        onCvChange(selected);
        setShowText(false);
      }
    } catch (err) {
      setError(describeError(err, 'could not read that file'));
    } finally {
      setIsLoading(false);
    }
  }, [onCvChange]);

  return (
    <div className="card card-border rounded-box border-base-300 bg-base-100">
      <div className="card-body gap-3 p-5">
        <div className="card-title text-base font-bold">Your CV</div>
        <p className="text-sm text-base-content/60">
          PDF, plain text or Markdown. The file is read on this machine and its text is only sent to
          your own Claude Code CLI.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <button className="btn" type="button" onClick={handleSelect} disabled={isLoading}>
            {isLoading && <span className="loading loading-spinner loading-xs text-base-content" aria-hidden="true" />}
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
                  setError(undefined);
                }}
                disabled={isLoading}
              >
                Remove
              </button>
            </>
          )}
        </div>

        {isLoading && (
          <div className="text-sm text-base-content/70" role="status">
            Reading and extracting text…
          </div>
        )}

        {error && (
          <div className="alert alert-error text-sm" role="alert">
            {error}
          </div>
        )}

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
