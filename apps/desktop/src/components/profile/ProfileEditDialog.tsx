import { X } from '@phosphor-icons/react';
import { useCallback, useState } from 'react';
import { Dialog } from '../shell/Dialog.js';
import { SearchProfileSection } from '../settings/SearchProfileSection.js';

export interface ProfileEditDialogProps {
  onClose: () => void;
  /** Fires after every successful save, so the page behind can refresh its summary at once. */
  onChanged: () => void;
}

/**
 * "What you are looking for" in edit mode: the existing search profile form (target roles and
 * country first, the rest under "More options") in a dialog, so Edit works the same from the CV
 * page and from Search without leaving either.
 */
export function ProfileEditDialog({ onClose, onChanged }: ProfileEditDialogProps) {
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; message: string }>();

  const handleSaved = useCallback(() => {
    setStatus({ kind: 'saved', message: 'Saved' });
    onChanged();
  }, [onChanged]);
  const handleSaveError = useCallback((message: string, details?: string) => {
    setStatus({ kind: 'error', message: details ? `${message} ${details}` : message });
  }, []);

  return (
    <Dialog
      aria-labelledby="profile-edit-title"
      boxClassName="flex max-h-[85vh] max-w-2xl flex-col p-0"
      onClose={onClose}
    >
      <div className="flex items-center justify-between border-b border-base-300 px-5 py-3.5">
        <h2 id="profile-edit-title" className="text-sm font-semibold">
          What you are looking for
        </h2>
        <button type="button" aria-label="Close" className="btn btn-ghost btn-sm btn-circle" onClick={onClose}>
          <X size={16} weight="bold" aria-hidden="true" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <SearchProfileSection focusOnLoad onSaved={handleSaved} onSaveError={handleSaveError} />
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-base-300 px-5 py-3">
        <p
          role={status?.kind === 'error' ? 'alert' : 'status'}
          className={`text-sm ${status?.kind === 'error' ? 'text-error' : 'text-base-content/60'}`}
        >
          {status?.message ?? ''}
        </p>
        <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>
          Done
        </button>
      </div>
    </Dialog>
  );
}
