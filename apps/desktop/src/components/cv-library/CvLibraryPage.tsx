import { useCallback, useEffect, useRef, useState } from 'react';
import type { CvDocumentRecord, CvEvidenceOverlayRecord, CvExportFormat } from '../../window.js';
import emptyCvIllustration from '../../../assets/illustrations/empty-cv.svg?no-inline';
import { ConfirmDialog, EmptyState, ErrorBanner, PageLoading } from '../shell/index.js';
import { CvAssistant, type VacancyLead } from '../cv/index.js';
import { CvDrawer, type CvDrawerSubmitPayload } from './CvDrawer.js';
import { CvLibraryTable } from './CvLibraryTable.js';
import { CvUploadAction } from './CvUploadAction.js';
import {
  fillEmptySearchProfileFieldsFromCv,
  SEARCH_PROFILE_FILLED_STATUS,
  tryFillSearchProfileFromCv,
  type SearchProfileFillOutcome,
} from './fill-search-profile-from-cv.js';
import { ManualCaseForm } from './ManualCaseForm.js';
import { describeTailoringCase } from './tailoring-cases.js';
import { TailoringCases } from './TailoringCases.js';

export { describeTailoringCase };

/** How long the "Exported" confirmation stays up next to a row, matching `TailorCv`'s own
 * copy-feedback window. */
const EXPORT_FEEDBACK_MS = 2_000;

type DrawerState = { mode: 'add' } | { mode: 'edit'; record: CvDocumentRecord };

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * "CV library" screen (`export-src.html` lines ~359-445): every CV document (uploaded or typed
 * in by hand) with an upload action, an "add manual profile" drawer that doubles as the edit
 * form for any document's profile metadata, set-default, and delete.
 *
 * Deliberately not wired into `App.tsx` here, same as the other standalone page exports: the
 * shell's router picks pages up once each page agent's work has landed, without every agent
 * racing to edit the same file.
 *
 * Delete has no undo, unlike `SavedJobsPage`/the applications page. Those can offer one because
 * "undo" there is just re-creating an equivalent row via `createSavedJob`/`createApplication`:
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
  /** The tailoring cases that go with `deleteTarget`: `null` when they could not be listed. */
  const [deleteCases, setDeleteCases] = useState<CvEvidenceOverlayRecord[] | null>([]);
  /** `'form'` while the candidate fills in the job, then the vacancy the workspace opens on. A
   * reopened case also names the CV it belongs to. */
  const [tailoring, setTailoring] = useState<'form' | { vacancy: VacancyLead; cvId?: string } | null>(null);
  /** Bumped after a CV is saved from the review drawer, for the tailoring workspace behind it. */
  const [libraryRevision, setLibraryRevision] = useState(0);
  const [actionError, setActionError] = useState<string>();
  const [actionStatus, setActionStatus] = useState<string>();

  const [exportingId, setExportingId] = useState<string | null>(null);
  const [exportedId, setExportedId] = useState<string | null>(null);
  const exportedTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(
    () => () => {
      if (exportedTimeoutRef.current !== undefined) clearTimeout(exportedTimeoutRef.current);
    },
    [],
  );

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

  const showFillOutcome = useCallback((outcome: SearchProfileFillOutcome) => {
    if (outcome.error) {
      setActionError(`CV saved, but the search profile was not filled: ${outcome.error}`);
    } else if (outcome.filled) {
      setActionStatus(SEARCH_PROFILE_FILLED_STATUS);
    }
  }, []);

  const handleDrawerSubmit = useCallback(
    async (payload: CvDrawerSubmitPayload) => {
      if (!drawerState) return;
      setActionError(undefined);
      setActionStatus(undefined);
      let saved: CvDocumentRecord;
      if (drawerState.mode === 'add') {
        const created = await window.workspace.createCvDocument({ ...payload, kind: 'manual' });
        saved = created;
        setDocuments((prev) => [created, ...(prev ?? [])]);
      } else {
        const updated = await window.workspace.updateCvDocument(drawerState.record.id, payload);
        saved = updated;
        setDocuments((prev) => (prev ?? []).map((doc) => (doc.id === updated.id ? updated : doc)));
        // An open tailoring case re-reads the library, so its source notice clears in place (#447).
        setLibraryRevision((revision) => revision + 1);
      }
      setDrawerState(null);
      // Only the default CV (the first one, or one edited while it is the default) feeds the profile.
      if (saved.isDefault) showFillOutcome(await tryFillSearchProfileFromCv(saved));
    },
    [drawerState, showFillOutcome],
  );

  const handleSetDefault = useCallback(async (doc: CvDocumentRecord) => {
    setActionError(undefined);
    setActionStatus(undefined);
    try {
      // The whole refreshed library, so the previous default's demotion shows up too: see the
      // bridge doc comment on `setDefaultCvDocument` for why re-fetching would be redundant here.
      const refreshed = await window.workspace.setDefaultCvDocument(doc.id);
      setDocuments(refreshed);
      const promoted = refreshed.find((entry) => entry.id === doc.id) ?? doc;
      try {
        const filled = await fillEmptySearchProfileFieldsFromCv(promoted);
        if (filled) setActionStatus(SEARCH_PROFILE_FILLED_STATUS);
      } catch (err) {
        setActionError(`Default CV set, but the search profile was not filled: ${describeError(err, 'unknown error')}`);
      }
    } catch (err) {
      setActionError(describeError(err, 'could not set this CV as default'));
    }
  }, []);

  /** #156: exports one CV entry to PDF/DOCX via the native save dialog. `{ saved: false }` means
   * the user cancelled that dialog, not a failure, so it is treated as a silent no-op rather than
   * an error -- the same distinction `LetterGenerator`'s own export handler makes. */
  const handleExport = useCallback(async (doc: CvDocumentRecord, format: CvExportFormat) => {
    if (exportedTimeoutRef.current !== undefined) clearTimeout(exportedTimeoutRef.current);
    setActionError(undefined);
    setActionStatus(undefined);
    setExportingId(doc.id);
    // Cleared synchronously, not left to the pending timeout above: without this, a second export
    // started while a previous "Exported" badge is still showing would leave that stale badge
    // visible for the whole new export's duration, misrepresenting a run that has not finished yet
    // as already complete.
    setExportedId(null);
    try {
      const result = await window.workspace.exportCvDocument(doc.id, format);
      if (result.saved) {
        setExportedId(doc.id);
        exportedTimeoutRef.current = setTimeout(() => setExportedId(null), EXPORT_FEEDBACK_MS);
      }
    } catch (err) {
      setActionError(describeError(err, 'could not export this CV'));
    } finally {
      setExportingId(null);
    }
  }, []);

  const requestDelete = useCallback(async (doc: CvDocumentRecord) => {
    setActionError(undefined);
    setActionStatus(undefined);
    // Deleting a CV deletes its tailoring cases with it (#419), so they are listed before the
    // candidate confirms. A listing failure is stated in the dialog rather than hidden.
    try {
      setDeleteCases(await window.workspace.listCvEvidenceOverlays(doc.id));
    } catch {
      setDeleteCases(null);
    }
    setDeleteTarget(doc);
  }, []);

  const cancelDelete = useCallback(() => setDeleteTarget(null), []);

  const confirmDelete = useCallback(async () => {
    const doc = deleteTarget;
    if (!doc) return;
    setDeleteTarget(null);
    try {
      await window.workspace.deleteCvDocument(doc.id);
      // Not a local filter: deleting the default CV promotes another remaining one to default on
      // the backend (see `deleteCvDocument` in `electron/workspace/repository.ts`), and only a
      // refetch picks that promotion up. Filtering the deleted row out of the already-loaded list
      // would leave every remaining CV looking non-default until the next reload.
      await reloadDocuments();
    } catch (err) {
      setActionError(describeError(err, 'could not delete this CV'));
    }
  }, [deleteTarget, reloadDocuments]);

  const isLoading = documents === null;
  const hasAnyDocuments = (documents?.length ?? 0) > 0;

  /** Opens the exact CV's review over whatever is on screen; the tailoring case behind it stays put. */
  const reviewCv = (cvId: string) => {
    const record = documents?.find((doc) => doc.id === cvId);
    if (record) openEditDrawer(record);
  };

  const drawer = drawerState ? (
    <CvDrawer
      key={drawerState.mode === 'edit' ? drawerState.record.id : 'new'}
      mode={drawerState.mode}
      record={drawerState.mode === 'edit' ? drawerState.record : undefined}
      onCancel={closeDrawer}
      onSubmit={handleDrawerSubmit}
    />
  ) : null;

  if (tailoring !== null) {
    return (
      <div className="flex flex-col gap-4 max-w-3xl mx-auto">
        <button type="button" className="btn btn-ghost btn-sm self-start" onClick={() => setTailoring(null)}>
          Back to CV library
        </button>
        {tailoring === 'form' && documents === null ? (
          <PageLoading label="Loading your CV library…" />
        ) : tailoring === 'form' ? (
          <ManualCaseForm
            documents={documents ?? []}
            onSubmit={(vacancy, cvId) => setTailoring({ vacancy, ...(cvId ? { cvId } : {}) })}
            onCancel={() => setTailoring(null)}
          />
        ) : (
          <CvAssistant
            vacancy={tailoring.vacancy}
            {...(tailoring.cvId ? { initialCvId: tailoring.cvId } : {})}
            onReviewCv={reviewCv}
            libraryRevision={libraryRevision}
            tailoringCase
          />
        )}
        {drawer}
      </div>
    );
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>{hasAnyDocuments && <p className="text-sm text-base-content/60">{documents?.length} on file</p>}</div>
        <div className="flex items-center gap-2">
          <button className="btn btn-primary btn-sm" type="button" onClick={() => setTailoring('form')}>
            Tailor for a job
          </button>
          <CvUploadAction
            onSaved={(_id, outcome) => {
              void reloadDocuments();
              if (outcome) showFillOutcome(outcome);
            }}
          />
          <button className="btn btn-outline btn-sm" type="button" onClick={openAddDrawer}>
            Add manual profile
          </button>
        </div>
      </div>

      {loadError && <ErrorBanner className="mt-4">{loadError}</ErrorBanner>}
      {actionError && <ErrorBanner className="mt-4">{actionError}</ErrorBanner>}
      {actionStatus && (
        <div className="alert alert-success alert-soft mt-4 text-sm" role="status">
          {actionStatus}
        </div>
      )}

      {isLoading && !loadError && <PageLoading label="Loading your CV library…" />}

      {!isLoading && !hasAnyDocuments && (
        <EmptyState
          illustration={emptyCvIllustration}
          title="No CV on file"
          description="Upload a PDF, Word, plain text or Markdown file, or add a manual profile, to enable job match analysis and tailored cover letters."
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
            onDelete={(doc) => void requestDelete(doc)}
            onExport={handleExport}
            exportingId={exportingId}
            exportedId={exportedId}
          />
        </div>
      )}

      {!isLoading && hasAnyDocuments && (
        <TailoringCases documents={documents ?? []} onOpen={(vacancy, cvId) => setTailoring({ vacancy, cvId })} />
      )}

      {drawer}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete this CV?"
          message={
            <>
              <p>
                This permanently removes <span className="font-medium text-base-content">{deleteTarget.name}</span>{' '}
                from your CV library, including any extracted text. This cannot be undone.
              </p>
              {deleteCases === null && (
                <p className="mt-2">
                  The tailoring cases for this CV could not be listed, so any that exist will be deleted
                  without being shown here.
                </p>
              )}
              {deleteCases !== null && deleteCases.length > 0 && (
                <div className="mt-2">
                  <p>
                    {deleteCases.length === 1 ? 'This tailoring case is' : `These ${deleteCases.length} tailoring cases are`}{' '}
                    deleted with it, including their job descriptions, answers and approvals:
                  </p>
                  <ul className="mt-1 list-disc pl-5" aria-label="Tailoring cases that will be deleted">
                    {deleteCases.map((tailoringCase) => (
                      <li key={tailoringCase.id}>{describeTailoringCase(tailoringCase)}</li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="mt-2">Files you already exported from this CV outside the app are not deleted.</p>
            </>
          }
          onConfirm={() => void confirmDelete()}
          onCancel={cancelDelete}
        />
      )}
    </div>
  );
}
