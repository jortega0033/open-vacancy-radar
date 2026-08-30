import { useCallback, useState } from 'react';
import { describeError } from './useAgentRun.js';
import type { CvDocument } from './types.js';

export interface SaveCvToLibraryProps {
  cv: CvDocument;
  /** Called with the new row's id once it is persisted, so a parent can select it. */
  onSaved?: (id: string) => void;
}

/**
 * Turns a one-off upload into a persisted `cv_documents` row.
 *
 * The ephemeral path deliberately stays: picking a CV to run a single gap analysis against one
 * vacancy is a legitimate thing to do without committing the document to a library you then have
 * to curate. Saving is therefore an explicit second step rather than a side effect of the upload;
 * user decides whether this file is a keeper.
 *
 * Only the extracted text and the file name cross into the database; the file itself is never
 * copied and its path never leaves the main process (see the `cv` bridge in electron/preload.ts).
 */
export function SaveCvToLibrary({ cv, onSaved }: SaveCvToLibraryProps) {
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string>();

  const handleSave = useCallback(async () => {
    setError(undefined);
    setState('saving');
    try {
      const created = await window.workspace.createCvDocument({
        name: cv.fileName,
        kind: 'uploaded',
        text: cv.text,
      });
      setState('saved');
      onSaved?.(created.id);
    } catch (err) {
      setState('idle');
      setError(describeError(err, 'Could not save this CV to your library.'));
    }
  }, [cv.fileName, cv.text, onSaved]);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button className="btn btn-outline btn-sm" type="button" onClick={handleSave} disabled={state !== 'idle'}>
        {state === 'saving' && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
        {state === 'saved' ? 'Saved to library' : 'Save to CV library'}
      </button>
      {state === 'saved' && (
        <span className="text-sm text-success" role="status">
          Added to your CV library.
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
