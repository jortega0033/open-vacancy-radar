import { useCallback, useEffect, useState } from 'react';
import type { ApplicationAnswerRecord } from '../../window.js';
import { ConfirmDialog, ErrorBanner, PageLoading } from '../shell/index.js';
import { SettingsSection } from './controls.js';

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

const CONTROL_TYPE_LABEL: Record<ApplicationAnswerRecord['controlType'], string> = {
  text: 'Text field',
  textarea: 'Text area',
};

/** The backend already returns these most-recently-updated-first (see the bridge's own doc comment
 * on `listApplicationAnswers`), but this sorts again defensively rather than trusting that order
 * blindly -- cheap insurance against it ever drifting. */
function sortByUpdatedAtDesc(records: readonly ApplicationAnswerRecord[]): ApplicationAnswerRecord[] {
  return [...records].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

interface AnswerRowProps {
  record: ApplicationAnswerRecord;
  onSaved: (updated: ApplicationAnswerRecord) => void;
  onRequestDelete: (record: ApplicationAnswerRecord) => void;
}

/**
 * One saved answer: label, control-type badge, where it was last used, the answer body (visually
 * clamped, never truncated in the DOM so a screen reader still gets the whole thing), and
 * edit/delete actions. Its own component, like `ApplicationPreparedSummary`'s `AwaitingAnswerRow`,
 * because each row needs its own draft/busy/error state that a `.map` callback cannot give it.
 */
function AnswerRow({ record, onSaved, onRequestDelete }: AnswerRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(record.answer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const startEdit = useCallback(() => {
    setDraft(record.answer);
    setError(undefined);
    setEditing(true);
  }, [record.answer]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
    setError(undefined);
  }, []);

  const save = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed) {
      // Fail fast client-side, never even reaching the bridge: `parseApplicationAnswerPatch` would
      // refuse this too, but there is no reason to round-trip to main just to be told that.
      setError('An answer cannot be empty.');
      return;
    }
    setBusy(true);
    setError(undefined);
    void (async () => {
      try {
        // The record the bridge returns, not the typed text spliced in locally: main may have
        // normalized or trimmed it differently, and `updatedAt`/`normalizedKey` are its to set.
        const updated = await window.workspace.updateApplicationAnswer(record.id, { answer: trimmed });
        onSaved(updated);
        setEditing(false);
      } catch (err) {
        // Stay in edit mode on failure so nothing typed is lost.
        setError(describeError(err, 'could not save this answer'));
      } finally {
        setBusy(false);
      }
    })();
  }, [draft, record.id, onSaved]);

  return (
    <li className="ovr-row border-b border-base-300">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{record.label}</span>
            <span className="badge badge-ghost badge-sm">{CONTROL_TYPE_LABEL[record.controlType]}</span>
          </div>
          {record.originCompany && (
            <p className="mt-0.5 text-xs text-base-content/60">Used at {record.originCompany}</p>
          )}
        </div>
        {!editing && (
          <div className="flex flex-none gap-2 pt-0.5">
            <button
              type="button"
              className="btn btn-xs btn-outline"
              aria-label={`Edit answer for ${record.label}`}
              onClick={startEdit}
            >
              Edit
            </button>
            <button
              type="button"
              className="btn btn-xs btn-outline btn-error"
              aria-label={`Delete answer for ${record.label}`}
              onClick={() => onRequestDelete(record)}
            >
              Delete
            </button>
          </div>
        )}
      </div>

      {editing ? (
        <div className="mt-2 flex flex-col gap-2">
          <textarea
            className="textarea textarea-sm w-full"
            rows={3}
            value={draft}
            disabled={busy}
            aria-label={`Edit answer for ${record.label}`}
            onChange={(event) => setDraft(event.target.value)}
          />
          {error && <p className="text-xs text-error">{error}</p>}
          <div className="flex gap-2">
            <button type="button" className="btn btn-xs btn-primary" disabled={busy} onClick={save}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="btn btn-xs btn-outline" disabled={busy} onClick={cancelEdit}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm text-base-content/80">
          {record.answer}
        </p>
      )}
    </li>
  );
}

/**
 * "Saved application answers" (issue #372's management UI): view, edit, and delete answers saved
 * while reviewing an application for reuse on a similar recurring question elsewhere. A settings
 * subsection, not a page of its own -- no header or nav, it renders inline inside `SettingsPage`'s
 * Workspace tab, right after the Applications section, and owns its own list state so the parent
 * page never has to know this data exists.
 *
 * Delete has no undo, like `CvLibraryPage`'s: `DeleteResult` carries nothing that could support a
 * real one, and the ticket does not ask for one either.
 */
export function SavedAnswersSection() {
  const [answers, setAnswers] = useState<ApplicationAnswerRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [deleteTarget, setDeleteTarget] = useState<ApplicationAnswerRecord | null>(null);
  const [deleteError, setDeleteError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await window.workspace.listApplicationAnswers();
        if (!cancelled) setAnswers(sortByUpdatedAtDesc(loaded));
      } catch (err) {
        if (!cancelled) setLoadError(describeError(err, 'could not load your saved answers'));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSaved = useCallback((updated: ApplicationAnswerRecord) => {
    setAnswers((prev) => (prev ?? []).map((entry) => (entry.id === updated.id ? updated : entry)));
  }, []);

  const requestDelete = useCallback((record: ApplicationAnswerRecord) => {
    setDeleteError(undefined);
    setDeleteTarget(record);
  }, []);

  const cancelDelete = useCallback(() => setDeleteTarget(null), []);

  const confirmDelete = useCallback(() => {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(null);
    void (async () => {
      try {
        await window.workspace.deleteApplicationAnswer(target.id);
        setAnswers((prev) => (prev ?? []).filter((entry) => entry.id !== target.id));
      } catch (err) {
        setDeleteError(describeError(err, 'could not delete this saved answer'));
      }
    })();
  }, [deleteTarget]);

  const isLoading = answers === null;
  const hasAnswers = (answers?.length ?? 0) > 0;

  return (
    <SettingsSection title="Saved application answers">
      <p className="ovr-row border-b border-base-300 text-sm text-base-content/70">
        Answers you chose to save while reviewing an application, so a recurring question can be
        reused instead of retyped.
      </p>

      {loadError && <ErrorBanner className="mt-3">{loadError}</ErrorBanner>}
      {deleteError && <ErrorBanner className="mt-3">{deleteError}</ErrorBanner>}

      {isLoading && !loadError && <PageLoading label="Loading saved answers…" />}

      {!isLoading && !hasAnswers && !loadError && (
        <p className="ovr-row text-sm text-base-content/60">
          No saved answers yet. Save one from an application review to reuse it on a similar
          question elsewhere.
        </p>
      )}

      {!isLoading && hasAnswers && (
        <ul>
          {(answers ?? []).map((record) => (
            <AnswerRow key={record.id} record={record} onSaved={handleSaved} onRequestDelete={requestDelete} />
          ))}
        </ul>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete this saved answer?"
          message={
            <>
              This permanently removes the saved answer for{' '}
              <span className="font-medium text-base-content">{deleteTarget.label}</span>. This
              cannot be undone.
            </>
          }
          confirmLabel="Delete"
          onConfirm={confirmDelete}
          onCancel={cancelDelete}
        />
      )}
    </SettingsSection>
  );
}
