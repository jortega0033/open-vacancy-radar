import { useCallback, useEffect, useRef, useState } from 'react';
import type { CvDocumentRecord, CvExportFormat } from '../../window.js';
import type { CandidateProfilePatch } from '../../../electron/vacancy-profile-validate.js';
import emptyCvIllustration from '../../../assets/illustrations/empty-cv.svg?no-inline';
import { ConfirmDialog, EmptyState, ErrorBanner, PageLoading } from '../shell/index.js';
import { CvDrawer, type CvDrawerSubmitPayload } from './CvDrawer.js';
import { CvLibraryTable } from './CvLibraryTable.js';
import { CvUploadAction } from './CvUploadAction.js';

/** How long the "Exported" confirmation stays up next to a row, matching `TailorCv`'s own
 * copy-feedback window. */
const EXPORT_FEEDBACK_MS = 2_000;

type DrawerState = { mode: 'add' } | { mode: 'edit'; record: CvDocumentRecord };

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

async function fillEmptySearchProfileFieldsFromCv(doc: CvDocumentRecord): Promise<boolean> {
  if (!('vacancyRadar' in window)) return false;
  const profile = await window.vacancyRadar.getSearchProfile();
  const patch: CandidateProfilePatch = {};

  const title = nonEmpty(doc.profile.title);
  const targetRole = nonEmpty(doc.targetRole) ?? title;
  const years = Number.parseInt(doc.profile.years.trim(), 10);
  const language = doc.profile.languages
    .split(',')
    .map((entry) => entry.trim())
    .find(Boolean);
  const skills = unique(doc.profile.skills);

  if (!profile.currentRole && title) patch.currentRole = title;
  if (!profile.location && nonEmpty(doc.profile.location)) patch.location = doc.profile.location.trim();
  if (profile.experienceYears === 0 && Number.isFinite(years) && years > 0) patch.experienceYears = years;
  if (!profile.constraints.professionalLanguage && language) {
    patch.constraints = { professionalLanguage: language };
  }
  if (profile.strongestSkills.length === 0 && skills.length > 0) {
    patch.strongestSkills = skills.slice(0, 10);
  }
  if (profile.targetRoles.length === 0 && targetRole) {
    patch.targetRoles = [targetRole];
  }

  if (Object.keys(patch).length === 0) return false;
  await window.vacancyRadar.saveSearchProfile(patch);
  return true;
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
    setActionStatus(undefined);
    try {
      // The whole refreshed library, so the previous default's demotion shows up too: see the
      // bridge doc comment on `setDefaultCvDocument` for why re-fetching would be redundant here.
      const refreshed = await window.workspace.setDefaultCvDocument(doc.id);
      setDocuments(refreshed);
      const promoted = refreshed.find((entry) => entry.id === doc.id) ?? doc;
      try {
        const filled = await fillEmptySearchProfileFieldsFromCv(promoted);
        if (filled) setActionStatus('Search profile filled from the default CV');
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

  const requestDelete = useCallback((doc: CvDocumentRecord) => {
    setActionError(undefined);
    setActionStatus(undefined);
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

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>{hasAnyDocuments && <p className="text-sm text-base-content/60">{documents?.length} on file</p>}</div>
        <div className="flex items-center gap-2">
          <CvUploadAction onSaved={() => void reloadDocuments()} />
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
            onExport={(doc, format) => void handleExport(doc, format)}
            exportingId={exportingId}
            exportedId={exportedId}
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
