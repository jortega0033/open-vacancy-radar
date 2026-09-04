import { useCallback, useState } from 'react';
import { SaveCvToLibrary } from '../cv/SaveCvToLibrary.js';
import type { CvFile } from '../../window.js';

export interface CvUploadActionProps {
  /** Called once the picked file has been persisted, so the parent can refresh its list. */
  onSaved: () => void;
}

/**
 * "Upload CV" for the CV library. Picks a file through the same `window.cv` bridge the CV
 * assistant's `CvUpload` uses (PDF, plain text or Markdown; the design reference's prototype also
 * mentions DOCX, but the real `cv:select-and-read` bridge does not support it, so this action
 * doesn't claim it does), then hands the extracted text to the existing `SaveCvToLibrary`
 * component to persist unchanged rather than re-implementing `createCvDocument` persistence that
 * is already implemented and already tested.
 *
 * Only the plain bridge call lives here (no picker UI, no show/hide-extracted-text affordance),
 * so this stays a thin composition of "pick" (this component) and "persist" (`SaveCvToLibrary`)
 * rather than a second `CvUpload`.
 */
export function CvUploadAction({ onSaved }: CvUploadActionProps) {
  const [picked, setPicked] = useState<CvFile | null>(null);
  const [isPicking, setIsPicking] = useState(false);
  const [error, setError] = useState<string>();

  const handlePick = useCallback(async () => {
    setError(undefined);
    setIsPicking(true);
    try {
      const selected = await window.cv.selectAndRead();
      // null = the user closed the dialog; nothing to do.
      if (selected) setPicked(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not read that file');
    } finally {
      setIsPicking(false);
    }
  }, []);

  const handleSaved = useCallback(() => {
    setPicked(null);
    onSaved();
  }, [onSaved]);

  if (picked) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-box border border-base-300 bg-base-200/40 px-3 py-2">
        <span className="text-sm">
          Loaded <span className="font-mono">{picked.fileName}</span> (
          {picked.text.length.toLocaleString('en-US')} characters)
        </span>
        <SaveCvToLibrary cv={picked} onSaved={handleSaved} />
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setPicked(null)}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button className="btn btn-primary btn-sm" type="button" onClick={handlePick} disabled={isPicking}>
        {isPicking && <span className="loading loading-spinner loading-xs text-primary-content" aria-hidden="true" />}
        Upload CV
      </button>
      {error && (
        <span className="text-sm text-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
