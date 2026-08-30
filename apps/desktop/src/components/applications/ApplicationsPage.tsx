import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ApplicationFilter,
  ApplicationInput,
  ApplicationRecord,
  ApplicationStatus,
  CvDocumentRecord,
  LetterRecord,
  SavedJobRecord,
} from '../../window.js';
import emptyApplicationsIllustration from '../../../assets/illustrations/empty-applications.svg?no-inline';
import { ConfirmDialog, EmptyState, UndoToast } from '../shell/index.js';
import { ApplicationDrawer } from './ApplicationDrawer.js';
import { ApplicationsTable } from './ApplicationsTable.js';
import { APPLICATIONS_FILTER_TABS, emptyStateTitle, sortApplications, toApplicationInput } from './application-status.js';

type DrawerState = { mode: 'create' } | { mode: 'edit'; record: ApplicationRecord };

interface PendingUndo {
  message: string;
  /** Precomputed by `toApplicationInput` at delete time — undo is a fresh `createApplication`
   * call with the same field values, not a soft-delete restore, so the record this recreates
   * gets a new id. */
  input: ApplicationInput;
}

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * Top-level "Applications" screen: an Active/Archived/All tab switch backed by
 * `listApplications({ filter })`, a pipeline table with inline status changes, add/edit through
 * `ApplicationDrawer`, and delete through `ConfirmDialog` with a short undo window.
 *
 * Owns the whole lifecycle against `window.workspace`, in the same shape as `SavedJobsPage`.
 * Deliberately not wired into `App.tsx` here — exported standalone via `index.ts` so the shell's
 * router can pick it up once every page agent's work has landed.
 */
export function ApplicationsPage() {
  const [filter, setFilter] = useState<ApplicationFilter>('active');
  const [applications, setApplications] = useState<ApplicationRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string>();

  const [savedJobs, setSavedJobs] = useState<readonly SavedJobRecord[]>([]);
  const [cvDocuments, setCvDocuments] = useState<readonly CvDocumentRecord[]>([]);
  const [letters, setLetters] = useState<readonly LetterRecord[]>([]);

  const [drawerState, setDrawerState] = useState<DrawerState | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<ApplicationRecord | null>(null);
  const [actionError, setActionError] = useState<string>();

  const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(null);

  // Linked-record dropdowns (saved job / CV / letter) load once, independently of the
  // applications list itself — a failure here must never block the pipeline table from showing.
  useEffect(() => {
    let cancelled = false;
    async function loadLinkedRecords() {
      try {
        const [jobs, cvs, letterRows] = await Promise.all([
          window.workspace.listSavedJobs(),
          window.workspace.listCvDocuments(),
          window.workspace.listLetters(),
        ]);
        if (cancelled) return;
        setSavedJobs(jobs);
        setCvDocuments(cvs);
        setLetters(letterRows);
      } catch {
        // Dropdowns degrade to "None"; the drawer still works for manual entry.
      }
    }
    void loadLinkedRecords();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoadError(undefined);
    async function load() {
      try {
        const rows = await window.workspace.listApplications(filter);
        if (!cancelled) setApplications(rows);
      } catch (err) {
        if (!cancelled) setLoadError(describeError(err, 'could not load applications'));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [filter]);

  const sortedApplications = useMemo(() => sortApplications(applications ?? []), [applications]);

  const openCreateDrawer = useCallback(() => setDrawerState({ mode: 'create' }), []);
  const openEditDrawer = useCallback((record: ApplicationRecord) => setDrawerState({ mode: 'edit', record }), []);
  const closeDrawer = useCallback(() => setDrawerState(null), []);

  const handleDrawerSubmit = useCallback(
    async (input: ApplicationInput) => {
      if (!drawerState) return;
      if (drawerState.mode === 'create') {
        const created = await window.workspace.createApplication(input);
        setApplications((prev) => [...(prev ?? []), created]);
      } else {
        const updated = await window.workspace.updateApplication(drawerState.record.id, input);
        setApplications((prev) => (prev ?? []).map((row) => (row.id === updated.id ? updated : row)));
      }
      // Rejecting here is intentional: `ApplicationDrawer` catches a thrown error and shows it
      // inline without closing itself, so a failed save leaves the drawer open with the message.
      setDrawerState(null);
    },
    [drawerState],
  );

  const handleStatusChange = useCallback(async (record: ApplicationRecord, status: ApplicationStatus) => {
    setActionError(undefined);
    try {
      const updated = await window.workspace.updateApplication(record.id, { status });
      setApplications((prev) => (prev ?? []).map((row) => (row.id === updated.id ? updated : row)));
    } catch (err) {
      setActionError(describeError(err, 'could not update status'));
    }
  }, []);

  const handleToggleArchive = useCallback(
    async (record: ApplicationRecord) => {
      setActionError(undefined);
      try {
        const updated = await window.workspace.updateApplication(record.id, { archived: !record.archived });
        setApplications((prev) => {
          const rows = prev ?? [];
          // The active/archived tabs are server-filtered by `listApplications({ filter })`; if
          // this toggle moved the row out of the tab currently on screen, drop it locally rather
          // than leaving a stale row visible until the next reload.
          const belongsToCurrentTab = filter === 'all' || updated.archived === (filter === 'archived');
          if (!belongsToCurrentTab) return rows.filter((row) => row.id !== updated.id);
          return rows.map((row) => (row.id === updated.id ? updated : row));
        });
      } catch (err) {
        setActionError(describeError(err, 'could not update this application'));
      }
    },
    [filter],
  );

  const requestDelete = useCallback((record: ApplicationRecord) => {
    setActionError(undefined);
    setDeleteTarget(record);
  }, []);

  const cancelDelete = useCallback(() => setDeleteTarget(null), []);

  const confirmDelete = useCallback(async () => {
    const record = deleteTarget;
    if (!record) return;
    setDeleteTarget(null);
    try {
      const result = await window.workspace.deleteApplication(record.id);
      // `{ deleted: false }` means the row was already gone server-side; still drop it locally
      // so the table matches reality, but skip the "undo a delete that didn't happen" toast.
      setApplications((prev) => (prev ?? []).filter((row) => row.id !== record.id));
      if (result.deleted) {
        setPendingUndo({
          message: `Deleted "${record.role}" at ${record.company}.`,
          input: toApplicationInput(record),
        });
      }
    } catch (err) {
      setActionError(describeError(err, 'could not delete this application'));
    }
  }, [deleteTarget]);

  const dismissUndo = useCallback(() => setPendingUndo(null), []);

  const handleUndo = useCallback(async () => {
    const undo = pendingUndo;
    if (!undo) return;
    try {
      const recreated = await window.workspace.createApplication(undo.input);
      setApplications((prev) => [...(prev ?? []), recreated]);
    } catch (err) {
      setActionError(describeError(err, 'could not undo the delete'));
    }
  }, [pendingUndo]);

  const isLoading = applications === null;
  const isEmpty = !isLoading && sortedApplications.length === 0;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Applications</h2>
        <button type="button" className="btn btn-primary btn-sm" onClick={openCreateDrawer}>
          Add application
        </button>
      </div>

      <div role="tablist" className="tabs tabs-border mt-4">
        {APPLICATIONS_FILTER_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={filter === tab.key}
            className={`tab ${filter === tab.key ? 'tab-active' : ''}`}
            onClick={() => setFilter(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {loadError && (
        <div className="alert alert-error mt-4" role="alert">
          {loadError}
        </div>
      )}
      {actionError && (
        <div className="alert alert-error mt-4" role="alert">
          {actionError}
        </div>
      )}

      {isLoading && !loadError && <div className="alert alert-info mt-4">Loading applications…</div>}

      {isEmpty && (
        <EmptyState
          illustration={emptyApplicationsIllustration}
          title={emptyStateTitle(filter)}
          description="Track roles you're preparing for, applying to, or already hearing back from."
          action={
            filter !== 'archived' ? (
              <button type="button" className="btn btn-primary btn-sm" onClick={openCreateDrawer}>
                Add your first application
              </button>
            ) : undefined
          }
        />
      )}

      {!isLoading && sortedApplications.length > 0 && (
        <div className="mt-4">
          <ApplicationsTable
            applications={sortedApplications}
            onStatusChange={handleStatusChange}
            onEdit={openEditDrawer}
            onToggleArchive={handleToggleArchive}
            onDelete={requestDelete}
          />
        </div>
      )}

      {drawerState && (
        <ApplicationDrawer
          key={drawerState.mode === 'edit' ? drawerState.record.id : 'new'}
          mode={drawerState.mode}
          record={drawerState.mode === 'edit' ? drawerState.record : null}
          savedJobs={savedJobs}
          cvDocuments={cvDocuments}
          letters={letters}
          onCancel={closeDrawer}
          onSubmit={handleDrawerSubmit}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete this application?"
          message={`This removes the application for "${deleteTarget.role}" at ${deleteTarget.company}. You can undo this for a few seconds after deleting.`}
          onConfirm={confirmDelete}
          onCancel={cancelDelete}
        />
      )}

      {pendingUndo && (
        <UndoToast message={pendingUndo.message} onUndo={handleUndo} onDismiss={dismissUndo} />
      )}
    </div>
  );
}
