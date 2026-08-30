import { useCallback, useEffect, useState } from 'react';
import type { CvDocumentRecord } from '../../window.js';
import emptyCvIllustration from '../../../assets/illustrations/empty-cv.svg?no-inline';
import { ConfirmDialog, EmptyState } from '../shell/index.js';
import { CvDrawer, type CvDrawerSubmitPayload } from './CvDrawer.js';
import { CvLibraryTable } from './CvLibraryTable.js';
import { CvUploadAction } from './CvUploadAction.js';

type DrawerState = { mode: 'add' } | { mode: 'edit'; record: CvDocumentRecord };

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * "CV library" screen (`export-src.html` lines ~359-445): every CV document — uploaded or typed
 * in by hand — with an upload action, an "add manual profile" drawer that doubles as the edit
 * form for any document's profile metadata, set-default, and delete.
 *
 * Deliberately not wired into `App.tsx` here, same as the other standalone page exports — the
 * shell's router picks pages up once each page agent's work has landed, without every agent
 * racing to edit the same file.
 *
 * Delete has no undo, unlike `SavedJobsPage`/the applications page. Those can offer one because
 * "undo" there is just re-creating an equivalent row via `createSavedJob`/`createApplication` —
 * every field on the record is something the user typed and the UI still has in hand right up to
 * the delete. A CV document's main value is its extracted `text`, and this screen never retains a
 * copy of that text once a row is saved (an uploaded file's text lives only in the database row,
 * and the picked-file state is dropped as soon as `SaveCvToLibrary` persists it). A fabricated
 * "undo" that silently recreated a blank-text row would be worse than admitting there isn't one,
 * so its delete confirmation says "cannot be undone" instead.
 */
export function CvLibraryPage() {
  const [documents, setDocuments] = useState<CvDocumentRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string>();

  const [drawerState, setDrawerState] = useState<DrawerState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CvDocumentRecord | null>(null);
  const [actionError, setActionError] = useState<string>();

  /** Used after a successful upload, where the save flow only reports back a new id, not a row. */
  const reloadDocuments = useCallback(async () => {
    try {
      const rows = await window.workspace.listCvDocuments();
      setDocuments(rows);
      setLoadError(undefined);
    } catch (err) {
      setLoadError(describeError(err, 'could not load your CV library'));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const rows = await window.workspace.listCvDocuments();
        if (!cancelled) setDocuments(rows);
      } catch (err) {
        if (!cancelled) setLoadError(describeError(err, 'could not load your CV library'));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const openAddDrawer = useCallback(() => setDrawerState({ mode: 'add' }), []);
  const openEditDrawer = useCallback((record: CvDocumentRecord) => setDrawerState({ mode: 'edit', record }), []);
  const closeDrawer = useCallback(() => setDrawerState(null), []);

  const handleDrawerSubmit = useCallback(
    async (payload: CvDrawerSubmitPayload) => {
      if (!drawerState) return;
      if (drawerState.mode === 'add') {
        const created = await window.workspace.createCvDocument({ ...payload, kind: 'manual' });
        setDocuments((prev) => [created, ...(prev ?? [])]);
      } else {
        const updated = await window.workspace.updateCvDocument(drawerState.record.id, payload);
        setDocuments((prev) => (prev ?? []).map((doc) => (doc.id === updated.id ? updated : doc)));
      }
      setDrawerState(null);
    },
    [drawerState],
  );

  const handleSetDefault = useCallback(async (doc: CvDocumentRecord) => {
    setActionError(undefined);
    try {
      // The whole refreshed library, so the previous default's demotion shows up too — see the
      // bridge doc comment on `setDefaultCvDocument` for why re-fetching would be redundant here.
      const refreshed = await window.workspace.setDefaultCvDocument(doc.id);
      setDocuments(refreshed);
    } catch (err) {
      setActionError(describeError(err, 'could not set this CV as default'));
    }
  }, []);

  const requestDelete = useCallback((doc: CvDocumentRecord) => {
    setActionError(undefined);
    setDeleteTarget(doc);
  }, []);

  const cancelDelete = useCallback(() => setDeleteTarget(null), []);

  const confirmDelete = useCallback(async () => {
    const doc = deleteTarget;
    if (!doc) return;
    setDeleteTarget(null);
    try {
      await window.workspace.deleteCvDocument(doc.id);
      setDocuments((prev) => (prev ?? []).filter((row) => row.id !== doc.id));
    } catch (err) {
      setActionError(describeError(err, 'could not delete this CV'));
    }
  }, [deleteTarget]);

  const isLoading = documents === null;
  const hasAnyDocuments = (documents?.length ?? 0) > 0;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">CV library</h2>
          {hasAnyDocuments && <p className="mt-1 text-sm text-base-content/60">{documents?.length} on file</p>}
        </div>
        <div className="flex items-center gap-2">
          <CvUploadAction onSaved={() => void reloadDocuments()} />
          <button className="btn btn-outline btn-sm" type="button" onClick={openAddDrawer}>
            Add manual profile
          </button>
        </div>
      </div>

      {loadError && <div className="alert alert-error mt-4">{loadError}</div>}
      {actionError && <div className="alert alert-error mt-4">{actionError}</div>}

      {isLoading && !loadError && <div className="alert alert-info mt-4">Loading your CV library…</div>}

      {!isLoading && !hasAnyDocuments && (
        <EmptyState
          illustration={emptyCvIllustration}
          title="No CV on file"
          description="Upload a PDF, plain text or Markdown file, or add a manual profile, to enable job match analysis and tailored cover letters."
          action={
            <button className="btn btn-primary btn-sm" type="button" onClick={openAddDrawer}>
              Add manual profile
            </button>
          }
        />
      )}

      {!isLoading && hasAnyDocuments && (
        <div className="mt-4">
          <CvLibraryTable
            documents={documents ?? []}
            onEdit={openEditDrawer}
            onSetDefault={(doc) => void handleSetDefault(doc)}
            onDelete={requestDelete}
          />
        </div>
      )}

      {drawerState && (
        <CvDrawer
          key={drawerState.mode === 'edit' ? drawerState.record.id : 'new'}
          mode={drawerState.mode}
          record={drawerState.mode === 'edit' ? drawerState.record : undefined}
          onCancel={closeDrawer}
          onSubmit={handleDrawerSubmit}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete this CV?"
          message={
            <>
              This permanently removes <span className="font-medium text-base-content">{deleteTarget.name}</span>{' '}
              from your CV library, including any extracted text. This cannot be undone.
            </>
          }
          onConfirm={() => void confirmDelete()}
          onCancel={cancelDelete}
        />
      )}
    </div>
  );
}
