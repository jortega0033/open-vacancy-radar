import { useCallback, useEffect, useState } from 'react';
import { CvTranscriptionFlow } from '../cv/CvTranscriptionFlow.js';
import { SaveCvToLibrary } from '../cv/SaveCvToLibrary.js';
import { useCvPicker } from '../cv/useCvPicker.js';
import type { CvDocument } from '../cv/types.js';

export interface CvUploadActionProps {
  /** Called once the picked file has been persisted, so the parent can refresh its list. */
  onSaved: () => void;
}

/**
 * "Upload CV" for the CV library. Picks a file through `useCvPicker` (issue #396; the same hook
 * the CV assistant's `CvUpload` uses, so a scanned/image-only PDF gets the same reviewed AI-
 * transcription offer here as everywhere else in the app), then hands the resolved text to the
 * existing `SaveCvToLibrary` component to persist unchanged rather than re-implementing
 * `createCvDocument` persistence that is already implemented and already tested.
 *
 * Only the pick-and-resolve flow lives here (no "show extracted text" affordance), so this stays a
 * thin composition of "pick" (this component) and "persist" (`SaveCvToLibrary`) rather than a
 * second `CvUpload`.
 */
export function CvUploadAction({ onSaved }: CvUploadActionProps) {
  const picker = useCvPicker();
  const [picked, setPicked] = useState<CvDocument | null>(null);

  useEffect(() => {
    if (picker.state.phase !== 'done') return;
    const { result } = picker.state;
    setPicked({ fileName: result.fileName, text: result.text, textSource: result.textSource });
    picker.reset();
  }, [picker]);

  const handleSaved = useCallback(() => {
    setPicked(null);
    onSaved();
  }, [onSaved]);

  const isPicking = picker.state.phase === 'picking' || picker.state.phase === 'transcribing';

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
    <div className="flex flex-col items-start gap-2">
      <div className="flex items-center gap-2">
        <button className="btn btn-primary btn-sm" type="button" onClick={() => void picker.pick()} disabled={isPicking}>
          {picker.state.phase === 'picking' && (
            <span className="loading loading-spinner loading-xs text-primary-content" aria-hidden="true" />
          )}
          Upload CV
        </button>
      </div>
      <CvTranscriptionFlow picker={picker} />
    </div>
  );
}
