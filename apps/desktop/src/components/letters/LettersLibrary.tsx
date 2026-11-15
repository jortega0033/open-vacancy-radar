import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { LetterRecord, LetterType, LetterUsageSummary } from '../../window.js';
import emptyLettersIllustration from '../../../assets/illustrations/empty-letters.svg?no-inline';
import { describeError } from '../cv/useAgentRun.js';
import { ConfirmDialog, EmptyState, ErrorBanner, PageLoading, UndoToast } from '../shell/index.js';
import { NotSet } from '../shell/NotSet.js';
import { LetterPreview } from './LetterPreview.js';
import {
  formatUpdatedAt,
  labelFor,
  LETTER_STATUS_BADGE_CLASS,
  LETTER_STATUS_OPTIONS,
  LETTER_TYPE_OPTIONS,
} from './types.js';

/** A letter that was just deleted, kept so Undo can write the same content back. */
interface PendingUndo {
  message: string;
  letter: LetterRecord;
  /** Gives each delete its own toast (and its own full undo window), even for two same-titled letters. */
  seq: number;
}

/** #738: case-insensitive match on title, company, role and body. */
export function letterMatches(letter: LetterRecord, query: string, type: LetterType | ''): boolean {
  if (type && letter.type !== type) return false;
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [letter.title, letter.company, letter.role, letter.body].some((field) =>
    field.toLocaleLowerCase().includes(needle),
  );
}

/** Which letter (and optionally which version) to open in preview, e.g. from an application. */
export interface LetterPreviewTarget {
  letterId: string;
  versionId?: string | null;
}

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
  /** #738: open this letter's preview once the list has loaded (the "Open in Letters" link). */
  initialPreview?: LetterPreviewTarget | null;
  /** Fired once `initialPreview` was acted on, so the parent stops passing it to a later mount. */
  onInitialPreviewConsumed?: () => void;
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
export function LettersLibrary({
  refreshToken = 0,
  onOpen,
  onNew,
  onCountChanged,
  initialPreview = null,
  onInitialPreviewConsumed,
}: LettersLibraryProps) {
  const searchId = useId();
  const typeFilterId = useId();
  const [letters, setLetters] = useState<LetterRecord[] | null>(null);
  const [summaries, setSummaries] = useState<ReadonlyMap<string, LetterUsageSummary>>(new Map());
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<LetterType | ''>('');
  const [preview, setPreview] = useState<LetterPreviewTarget | null>(null);
  const [usageToken, setUsageToken] = useState(0);
  /** The initial preview is applied once, after the first load, never again on a later reload. */
  const initialPreviewPending = useRef(initialPreview);
  /** The id whose Undo is in flight: dismissing that toast must not purge the letter being restored. */
  const restoringId = useRef<string | null>(null);
  /** Mirrors `pendingUndo` for the callbacks that close its window. */
  const pendingUndoRef = useRef<PendingUndo | null>(null);
  const undoSeq = useRef(0);
  /** The row whose Preview button gets focus back when the preview closes. */
  const returnFocusId = useRef<string | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LetterRecord | null>(null);
  const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await window.workspace.listLetters();
        if (!cancelled) {
          setLetters(rows);
          setLoadError(undefined);
          const target = initialPreviewPending.current;
          if (target) {
            initialPreviewPending.current = null;
            onInitialPreviewConsumed?.();
            if (rows.some((row) => row.id === target.letterId)) {
              returnFocusId.current = target.letterId;
              setPreview(target);
            }
            else setActionError('That letter has been deleted. The application keeps the copy it recorded.');
          }
        }
      } catch (err) {
        if (!cancelled) setLoadError(describeError(err, 'could not load your letters'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  // Usage is secondary: a failure here leaves the table usable with no "Used in" numbers.
  useEffect(() => {
    let cancelled = false;
    window.workspace
      .listLetterUsageSummaries()
      .then((rows) => {
        if (!cancelled) setSummaries(new Map(rows.map((row) => [row.letterId, row])));
      })
      .catch(() => {
        if (!cancelled) setSummaries(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken, usageToken]);

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
      if (result.deleted) {
        // A newer delete replaces the toast, which closes the previous letter's undo window.
        const previous = pendingUndoRef.current;
        if (previous && previous.letter.id !== letter.id) {
          void window.workspace.purgeLetter(previous.letter.id).catch(() => undefined);
        }
        undoSeq.current += 1;
        const next = { message: `Deleted "${letter.title}".`, letter, seq: undoSeq.current };
        pendingUndoRef.current = next;
        setPendingUndo(next);
      } else {
        setActionError('That letter had already been deleted.');
      }
      onCountChanged?.();
    } catch (err) {
      setActionError(describeError(err, 'could not delete this letter'));
    } finally {
      setBusyId(null);
    }
  }, [deleteTarget, onCountChanged]);

  /**
   * #738: the undo window closed without Undo, so the soft-deleted letter and its versions are purged.
   * (If the app quits first, the next start purges it.) Application records keep their own copies.
   */
  const dismissUndo = useCallback(() => {
    const current = pendingUndoRef.current;
    if (current && restoringId.current !== current.letter.id) {
      void window.workspace.purgeLetter(current.letter.id).catch(() => undefined);
    }
    pendingUndoRef.current = null;
    setPendingUndo(null);
  }, []);

  // Leaving the Library (another tab or page) closes the undo window, so the letter is purged now
  // rather than lingering until the next start.
  useEffect(
    () => () => {
      const current = pendingUndoRef.current;
      if (current && restoringId.current !== current.letter.id) {
        void window.workspace.purgeLetter(current.letter.id).catch(() => undefined);
      }
      pendingUndoRef.current = null;
    },
    [],
  );

  // Back from a preview: focus returns to the row's Preview button instead of the page body.
  useEffect(() => {
    if (preview || !returnFocusId.current) return;
    const id = returnFocusId.current;
    returnFocusId.current = null;
    document.querySelector<HTMLElement>(`[data-preview-for="${CSS.escape(id)}"]`)?.focus();
  }, [preview]);

  const openPreview = useCallback((target: LetterPreviewTarget) => {
    returnFocusId.current = target.letterId;
    setPreview(target);
  }, []);

  /** Restores the SAME letter (same id, versions and links), not a fresh copy. */
  const handleUndo = useCallback(async () => {
    const undo = pendingUndo;
    if (!undo) return;
    restoringId.current = undo.letter.id;
    try {
      const restored = await window.workspace.restoreLetter(undo.letter.id);
      setLetters((prev) => [restored, ...(prev ?? []).filter((row) => row.id !== restored.id)]);
      onCountChanged?.();
    } catch (err) {
      setActionError(describeError(err, 'could not undo the delete'));
    } finally {
      restoringId.current = null;
    }
  }, [pendingUndo, onCountChanged]);

  const isLoading = letters === null;
  const allRows = letters ?? [];
  const rows = useMemo(
    () => allRows.filter((letter) => letterMatches(letter, query, typeFilter)),
    [allRows, query, typeFilter],
  );
  const previewLetter = preview ? allRows.find((row) => row.id === preview.letterId) ?? null : null;

  // Rendered in both views, so opening a preview neither hides the toast nor restarts its window.
  const undoToast = pendingUndo && (
    <UndoToast key={pendingUndo.seq} message={pendingUndo.message} onUndo={handleUndo} onDismiss={dismissUndo} />
  );

  if (previewLetter && preview) {
    return (
      <>
      <LetterPreview
        key={`${previewLetter.id}-${preview.versionId ?? 'current'}`}
        letter={previewLetter}
        initialVersionId={preview.versionId ?? null}
        onBack={() => setPreview(null)}
        onEdit={onOpen}
        onChanged={(updated) => {
          setLetters((prev) => (prev ?? []).map((row) => (row.id === updated.id ? updated : row)));
          setUsageToken((token) => token + 1);
        }}
      />
      {undoToast}
      </>
    );
  }

  return (
    <div>
      {/* The empty state carries its own New letter button, so the toolbar one waits for rows. */}
      {allRows.length > 0 && (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1" htmlFor={searchId}>
              <span className="ovr-eyebrow">Search letters</span>
              <input
                id={searchId}
                type="search"
                aria-label="Search letters"
                className="input input-sm w-64"
                placeholder="Title, company, role or text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label className="flex flex-col gap-1" htmlFor={typeFilterId}>
              <span className="ovr-eyebrow">Type</span>
              <select
                id={typeFilterId}
                className="select select-sm"
                value={typeFilter}
                onChange={(event) => setTypeFilter(event.target.value as LetterType | '')}
              >
                <option value="">All types</option>
                {LETTER_TYPE_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {onNew && (
            <button className="btn btn-primary btn-sm" type="button" onClick={onNew}>
              New letter
            </button>
          )}
        </div>
      )}

      {loadError && <ErrorBanner className="mt-4">{loadError}</ErrorBanner>}
      {actionError && <ErrorBanner className="mt-4">{actionError}</ErrorBanner>}

      {isLoading && !loadError && <PageLoading label="Loading your letters…" />}

      {!isLoading && allRows.length > 0 && rows.length === 0 && (
        <div className="mt-6 flex flex-col items-start gap-2 text-sm" role="status">
          <p>No letters match.</p>
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            onClick={() => {
              setQuery('');
              setTypeFilter('');
            }}
          >
            Clear search
          </button>
        </div>
      )}

      {!isLoading && allRows.length === 0 && !loadError && (
        <EmptyState
          illustration={emptyLettersIllustration}
          title="No letters yet"
          description="Write a motivation or cover letter from a job and your CV."
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
        <div
          className="ovr-responsive-table mt-4 overflow-x-auto"
          data-testid="letters-responsive-table"
        >
          <table className="table ovr-responsive-table__table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Company</th>
                <th>Role</th>
                <th>Type</th>
                <th>Created</th>
                <th>Updated</th>
                <th>Status</th>
                <th>Used in</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((letter) => {
                const summary = summaries.get(letter.id);
                const editedSinceSent = summary?.editedSinceSent === true;
                return (
                <tr key={letter.id} className="ovr-row hover:bg-base-200">
                  <td className="ovr-responsive-table__cell font-medium" data-label="Title">
                    {letter.title}
                  </td>
                  <td
                    className="ovr-responsive-table__cell text-base-content/80"
                    data-label="Company"
                  >
                    {letter.company || <NotSet />}
                  </td>
                  <td className="ovr-responsive-table__cell text-base-content/80" data-label="Role">
                    {letter.role || <NotSet />}
                  </td>
                  <td
                    className="ovr-responsive-table__cell whitespace-nowrap text-base-content/70"
                    data-label="Type"
                  >
                    {labelFor(LETTER_TYPE_OPTIONS, letter.type)}
                  </td>
                  <td
                    className="ovr-responsive-table__cell whitespace-nowrap text-base-content/60"
                    data-label="Created"
                  >
                    {letter.createdAt ? formatUpdatedAt(letter.createdAt) : <NotSet label="Not recorded" />}
                  </td>
                  <td
                    className="ovr-responsive-table__cell whitespace-nowrap text-base-content/60"
                    data-label="Updated"
                  >
                    {formatUpdatedAt(letter.updatedAt)}
                    {letter.currentVersion !== null && letter.currentVersion > 1 && (
                      <span className="block text-xs">Version {letter.currentVersion}</span>
                    )}
                  </td>
                  <td className="ovr-responsive-table__cell" data-label="Status">
                    <span
                      className={`${LETTER_STATUS_BADGE_CLASS[letter.status]} whitespace-nowrap`}
                    >
                      {labelFor(LETTER_STATUS_OPTIONS, letter.status)}
                    </span>
                  </td>
                  <td className="ovr-responsive-table__cell whitespace-nowrap text-base-content/70" data-label="Used in">
                    {summary && summary.usedIn > 0 ? (
                      `${summary.usedIn} ${summary.usedIn === 1 ? 'application' : 'applications'}`
                    ) : (
                      <NotSet label="None" />
                    )}
                    {editedSinceSent && (
                      <span className="badge badge-outline badge-sm mt-1 block w-fit">Edited since sent</span>
                    )}
                  </td>
                  <td
                    className="ovr-responsive-table__cell ovr-responsive-table__actions text-right whitespace-nowrap"
                    data-label="Actions"
                  >
                    <button
                      className="btn btn-ghost btn-sm px-1.5"
                      type="button"
                      onClick={() => openPreview({ letterId: letter.id })}
                      data-preview-for={letter.id}
                      disabled={busyId === letter.id}
                      aria-label={`Preview ${letter.title}`}
                    >
                      Preview
                    </button>
                    <button
                      className="btn btn-ghost btn-sm px-1.5"
                      type="button"
                      onClick={() => onOpen(letter)}
                      disabled={busyId === letter.id}
                      aria-label={`Open ${letter.title}`}
                    >
                      Open
                    </button>
                    <button
                      className="btn btn-ghost btn-sm px-1.5"
                      type="button"
                      onClick={() => void handleDuplicate(letter)}
                      disabled={busyId === letter.id}
                      aria-label={`Duplicate ${letter.title}`}
                    >
                      Duplicate
                    </button>
                    <button
                      className="btn btn-ghost btn-sm px-1.5 text-error"
                      type="button"
                      onClick={() => setDeleteTarget(letter)}
                      disabled={busyId === letter.id}
                      aria-label={`Delete ${letter.title}`}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete letter?"
          message={`This removes "${deleteTarget.title}" from your letters. You can undo this for a few seconds after deleting.`}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {undoToast}
    </div>
  );
}
