import { useCallback, useState } from 'react';
import { describeError } from './useAgentRun.js';
import type { CvDocument } from './types.js';
import {
  SEARCH_PROFILE_FILLED_STATUS,
  tryFillSearchProfileFromCv,
  type SearchProfileFillOutcome,
} from '../cv-library/fill-search-profile-from-cv.js';

export interface SaveCvToLibraryProps {
  cv: CvDocument;
  /** Called with the new row's id once it is persisted, so a parent can select it. */
  onSaved?: (id: string, outcome?: SearchProfileFillOutcome) => void;
  /** When the saved CV becomes the default, fill the empty search profile fields from it. Default true. */
  fillSearchProfile?: boolean;
}

/**
 * Turns a one-off upload into a real `cv_documents` row.
 *
 * The ephemeral path deliberately stays: picking a CV to run a single gap analysis against one
 * vacancy is a legitimate thing to do without committing the document to a library you then have
 * to curate. So saving is an explicit second step rather than a side effect of the upload: the
 * user decides whether this file is a keeper.
 *
 * Only the extracted text and the file name cross into the database; the file itself is never
 * copied and its path never leaves the main process (see the `cv` bridge in electron/preload.ts).
 */
export function SaveCvToLibrary({ cv, onSaved, fillSearchProfile = true }: SaveCvToLibraryProps) {
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string>();
  const [fillNote, setFillNote] = useState<SearchProfileFillOutcome>();

  const handleSave = useCallback(async () => {
    setError(undefined);
    setState('saving');
    try {
      const created = await window.workspace.createCvDocument({
        name: cv.fileName,
        kind: 'uploaded',
        text: cv.text,
        // Issue #396: `undefined` here (every call site that predates the AI-transcription
        // fallback) falls through to the column default, `'text_layer'`.
        textSource: cv.textSource,
      });
      const outcome = fillSearchProfile && created.isDefault ? await tryFillSearchProfileFromCv(created) : undefined;
      setFillNote(outcome);
      setState('saved');
      onSaved?.(created.id, outcome);
    } catch (err) {
      setState('idle');
      setError(describeError(err, 'could not save this CV to your library'));
    }
  }, [cv.fileName, cv.text, cv.textSource, onSaved, fillSearchProfile]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button className="btn btn-outline btn-sm" type="button" onClick={handleSave} disabled={state !== 'idle'}>
        {state === 'saving' && <span className="loading loading-spinner loading-xs text-base-content" aria-hidden="true" />}
        {state === 'saved' ? 'Saved to library' : 'Save to CV library'}
      </button>
      {state === 'saved' && (
        <span className="text-sm text-success" role="status">
          Added to your CV library.
        </span>
      )}
      {fillNote?.filled && (
        <span className="text-sm text-success" role="status">
          {SEARCH_PROFILE_FILLED_STATUS}.
        </span>
      )}
      {fillNote?.error && (
        <span className="text-sm text-error" role="alert">
          Saved, but the search profile was not filled: {fillNote.error}
        </span>
      )}
      {error && (
        <span className="text-sm text-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
