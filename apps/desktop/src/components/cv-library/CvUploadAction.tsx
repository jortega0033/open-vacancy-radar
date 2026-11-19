import { useCallback, useEffect, useRef, useState } from 'react';
import { CvTranscriptionFlow } from '../cv/CvTranscriptionFlow.js';
import { SaveCvToLibrary } from '../cv/SaveCvToLibrary.js';
import { useCvPicker } from '../cv/useCvPicker.js';
import { describeError } from '../cv/useAgentRun.js';
import type { CvDocument } from '../cv/types.js';
import type { SearchProfileFillOutcome } from './fill-search-profile-from-cv.js';

export interface CvUploadActionProps {
  /** Called once the picked file has been persisted, so the parent can refresh its list. */
  onSaved: (id: string, outcome?: SearchProfileFillOutcome) => void;
  /** If true, the upload button uses btn-primary; if false, btn-outline. Default: true. */
  isPrimary?: boolean;
  /** The welcome flow fills the profile itself through its reviewed drawer, so it turns this off. */
  fillSearchProfile?: boolean;
  /** Welcome only (#764): picking the file is the decision, so save it straight away instead of
   * showing "Loaded ... (N characters)" with a separate Save to CV library confirm. Off by default:
   * the CV Library page keeps its explicit save step. */
  saveOnPick?: boolean;
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
export function CvUploadAction({ onSaved, isPrimary = true, fillSearchProfile = true, saveOnPick = false }: CvUploadActionProps) {
  const picker = useCvPicker();
  const [picked, setPicked] = useState<CvDocument | null>(null);
  const [autoSaving, setAutoSaving] = useState(false);
  const [autoSaveError, setAutoSaveError] = useState<string>();
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  useEffect(() => {
    if (picker.state.phase !== 'done') return;
    const { result } = picker.state;
    const cv: CvDocument = { fileName: result.fileName, text: result.text, textSource: result.textSource };
    picker.reset();
    if (!saveOnPick) {
      setPicked(cv);
      return;
    }
    // The same persist call `SaveCvToLibrary` makes. No search-profile auto-fill here: the only
    // caller (Welcome) fills the profile through its reviewed drawer instead.
    setAutoSaving(true);
    setAutoSaveError(undefined);
    void window.workspace
      .createCvDocument({ name: cv.fileName, kind: 'uploaded', text: cv.text, textSource: cv.textSource })
      .then((created) => onSavedRef.current(created.id))
      .catch((err: unknown) => setAutoSaveError(describeError(err, 'could not save this CV to your library')))
      .finally(() => setAutoSaving(false));
  }, [picker, saveOnPick]);

  const handleSaved = useCallback(
    (id: string, outcome?: SearchProfileFillOutcome) => {
      setPicked(null);
      onSaved(id, outcome);
    },
    [onSaved],
  );

  const isPicking = picker.state.phase === 'picking' || picker.state.phase === 'transcribing' || autoSaving;
  const buttonClass = isPrimary ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm';

  if (picked) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-box border border-base-300 bg-base-200/40 px-3 py-2">
        <span className="text-sm">
          Loaded <span className="font-mono">{picked.fileName}</span> (
          {picked.text.length.toLocaleString('en-US')} characters)
        </span>
        <SaveCvToLibrary cv={picked} onSaved={handleSaved} fillSearchProfile={fillSearchProfile} />
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setPicked(null)}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex items-center gap-2">
        <button className={buttonClass} type="button" onClick={() => void picker.pick()} disabled={isPicking}>
          {(picker.state.phase === 'picking' || autoSaving) && (
            <span className="loading loading-spinner loading-xs text-primary-content" aria-hidden="true" />
          )}
          Upload CV
        </button>
      </div>
      {autoSaving && (
        <p className="text-xs text-base-content/70" role="status">
          Saving your CV...
        </p>
      )}
      {autoSaveError && (
        <p className="text-sm text-error" role="alert">
          {autoSaveError}
        </p>
      )}
      <CvTranscriptionFlow picker={picker} />
    </div>
  );
}
