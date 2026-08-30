import { useCallback, useEffect, useState } from 'react';
import type { LetterRecord } from '../../window.js';
import emptyLettersIllustration from '../../../assets/illustrations/empty-letters.svg?no-inline';
import { describeError } from '../cv/useAgentRun.js';
import { ConfirmDialog, EmptyState } from '../shell/index.js';
import {
  formatUpdatedAt,
  labelFor,
  LETTER_STATUS_BADGE_CLASS,
  LETTER_STATUS_OPTIONS,
  LETTER_TYPE_OPTIONS,
} from './types.js';

export interface LettersLibraryProps {
  /**
   * Bumped by the parent whenever a save happened elsewhere (the generator), so the table reloads
   * rather than showing a stale title/status for a row the user just edited.
   */
  refreshToken?: number;
  /** Open this row in the generator, in edit mode. */
  onOpen: (letter: LetterRecord) => void;
  /** Start a blank generator run. Rendered as "New letter" in the toolbar and the empty state. */
  onNew?: () => void;
  /** Fired after a create/delete so the shell can refresh the sidebar's letter count. */
  onCountChanged?: () => void;
}

/**
 * The saved-letters table (`export-src.html` "Letters" screen, lines ~524-559): title, company,
 * role, type, updated date and status, with Open / Duplicate / Delete per row.
 *
 * Owns its own load against `window.workspace` rather than receiving rows as a prop, for the same
 * reason `SavedJobsPage` does: the page above it should not have to know how to recover from an
 * IPC failure that only this table can describe. It deliberately keeps *three* error slots apart:
 * a failed initial load (nothing to show), a failed row action (the table is still valid), and a
 * delete that reported `{ deleted: false }` (the row was already gone). Collapsing those would
 * either hide a working table behind a load error or silently swallow a failed duplicate.
 *
 * The row is not itself clickable: the actions are real buttons, and a `<tr onClick>` wrapping
 * them would make "Duplicate" ambiguously also mean "Open" for keyboard and screen-reader users.
 */
export function LettersLibrary({ refreshToken = 0, onOpen, onNew, onCountChanged }: LettersLibraryProps) {
  const [letters, setLetters] = useState<LetterRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LetterRecord | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await window.workspace.listLetters();
        if (!cancelled) {
          setLetters(rows);
          setLoadError(undefined);
        }
      } catch (err) {
        if (!cancelled) setLoadError(describeError(err, 'could not load your letters'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  const handleDuplicate = useCallback(
    async (letter: LetterRecord) => {
      setActionError(undefined);
      setBusyId(letter.id);
      try {
        const copy = await window.workspace.duplicateLetter(letter.id);
        // `listLetters` is ordered by `updatedAt` descending, so the fresh copy belongs at the top.
        setLetters((prev) => [copy, ...(prev ?? [])]);
        onCountChanged?.();
      } catch (err) {
        setActionError(describeError(err, 'could not duplicate this letter'));
      } finally {
        setBusyId(null);
      }
    },
    [onCountChanged],
  );

  const confirmDelete = useCallback(async () => {
    const letter = deleteTarget;
    if (!letter) return;
    setDeleteTarget(null);
    setActionError(undefined);
    setBusyId(letter.id);
    try {
      // `{ deleted: false }` means the row had already gone server-side. Drop it locally either
      // way so the table matches reality, and say so rather than reporting a phantom success.
      const result = await window.workspace.deleteLetter(letter.id);
      setLetters((prev) => (prev ?? []).filter((row) => row.id !== letter.id));
      if (!result.deleted) setActionError('That letter had already been deleted.');
      onCountChanged?.();
    } catch (err) {
      setActionError(describeError(err, 'could not delete this letter'));
    } finally {
      setBusyId(null);
    }
  }, [deleteTarget, onCountChanged]);

  const isLoading = letters === null;
  const rows = letters ?? [];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-sm text-base-content/60">
          Generated and saved application documents. Open a letter to edit or regenerate it.
        </p>
        {onNew && (
          <button className="btn btn-primary btn-sm" type="button" onClick={onNew}>
            New letter
          </button>
        )}
      </div>

      {loadError && (
        <div className="alert alert-error mt-4 text-sm" role="alert">
          {loadError}
        </div>
      )}
      {actionError && (
        <div className="alert alert-error mt-4 text-sm" role="alert">
          {actionError}
        </div>
      )}

      {isLoading && !loadError && (
        <div className="mt-4 flex items-center gap-3 text-sm text-base-content/70" role="status">
          <span className="loading loading-spinner loading-sm" aria-hidden="true" />
          <span>Loading your letters…</span>
        </div>
      )}

      {!isLoading && rows.length === 0 && !loadError && (
        <EmptyState
          illustration={emptyLettersIllustration}
          title="No letters yet"
          description="Generate a motivation or cover letter from a vacancy and your CV. Saved letters stay on this computer."
          action={
            onNew && (
              <button className="btn btn-primary btn-sm" type="button" onClick={onNew}>
                New letter
              </button>
            )
          }
        />
      )}

      {rows.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Company</th>
                <th>Role</th>
                <th>Type</th>
                <th>Updated</th>
                <th>Status</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((letter) => (
                <tr key={letter.id} className="ovr-row hover:bg-base-200">
                  <td className="font-medium">{letter.title}</td>
                  <td className="text-base-content/80">{letter.company || '-'}</td>
                  <td className="text-base-content/80">{letter.role || '-'}</td>
                  <td className="whitespace-nowrap text-base-content/70">
                    {labelFor(LETTER_TYPE_OPTIONS, letter.type)}
                  </td>
                  <td className="whitespace-nowrap text-base-content/60">
                    {formatUpdatedAt(letter.updatedAt)}
                  </td>
                  <td>
                    <span className={`${LETTER_STATUS_BADGE_CLASS[letter.status]} whitespace-nowrap`}>
                      {labelFor(LETTER_STATUS_OPTIONS, letter.status)}
                    </span>
                  </td>
                  <td className="text-right whitespace-nowrap">
                    <button
                      className="btn btn-ghost btn-xs"
                      type="button"
                      onClick={() => onOpen(letter)}
                      disabled={busyId === letter.id}
                    >
                      Open
                    </button>
                    <button
                      className="btn btn-ghost btn-xs"
                      type="button"
                      onClick={() => void handleDuplicate(letter)}
                      disabled={busyId === letter.id}
                    >
                      Duplicate
                    </button>
                    <button
                      className="btn btn-ghost btn-xs text-error"
                      type="button"
                      onClick={() => setDeleteTarget(letter)}
                      disabled={busyId === letter.id}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete letter?"
          message={`This permanently removes "${deleteTarget.title}" from your letters. It cannot be undone.`}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
