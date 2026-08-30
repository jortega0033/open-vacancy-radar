import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SavedJobInput, SavedJobRecord, SavedJobStatus } from '../../window.js';
import emptySavedJobsIllustration from '../../../assets/illustrations/empty-saved-jobs.svg?no-inline';
import noResultsIllustration from '../../../assets/illustrations/no-results.svg?no-inline';
import { ConfirmDialog, EmptyState, UndoToast } from '../shell/index.js';
import { SavedJobDrawer } from './SavedJobDrawer.js';
import { SavedJobFilterBox } from './SavedJobFilterBox.js';
import { toSavedJobInput } from './saved-job-input.js';
import { SavedJobsTable } from './SavedJobsTable.js';

type DrawerState = { mode: 'add' } | { mode: 'edit'; job: SavedJobRecord };

interface PendingUndo {
  message: string;
  job: SavedJobRecord;
}

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * Top-level "Saved Jobs" screen (`export-src.html` lines ~259-307): a role/company filter, a
 * table of saved jobs with an inline status select, add/edit through a right-side drawer, and
 * delete through a confirm dialog with a short undo window.
 *
 * Owns the whole lifecycle against `window.workspace`.
 */
export function SavedJobsPage() {
  const [jobs, setJobs] = useState<SavedJobRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string>();

  const [query, setQuery] = useState('');

  const [drawerState, setDrawerState] = useState<DrawerState | null>(null);
  const [savingDrawer, setSavingDrawer] = useState(false);
  const [drawerError, setDrawerError] = useState<string>();

  const [deleteTarget, setDeleteTarget] = useState<SavedJobRecord | null>(null);
  const [actionError, setActionError] = useState<string>();

  const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const rows = await window.workspace.listSavedJobs();
        if (!cancelled) setJobs(rows);
      } catch (err) {
        if (!cancelled) setLoadError(describeError(err, 'Could not load saved jobs.'));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredJobs = useMemo(() => {
    const rows = jobs ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (job) => job.role.toLowerCase().includes(needle) || job.company.toLowerCase().includes(needle),
    );
  }, [jobs, query]);

  const openAddDrawer = useCallback(() => {
    setDrawerError(undefined);
    setDrawerState({ mode: 'add' });
  }, []);

  const openEditDrawer = useCallback((job: SavedJobRecord) => {
    setDrawerError(undefined);
    setDrawerState({ mode: 'edit', job });
  }, []);

  const closeDrawer = useCallback(() => {
    if (savingDrawer) return;
    setDrawerState(null);
  }, [savingDrawer]);

  const handleDrawerSave = useCallback(
    async (input: SavedJobInput) => {
      if (!drawerState) return;
      setSavingDrawer(true);
      setDrawerError(undefined);
      try {
        if (drawerState.mode === 'add') {
          const created = await window.workspace.createSavedJob(input);
          setJobs((prev) => [created, ...(prev ?? [])]);
        } else {
          const updated = await window.workspace.updateSavedJob(drawerState.job.id, input);
          setJobs((prev) => (prev ?? []).map((job) => (job.id === updated.id ? updated : job)));
        }
        setDrawerState(null);
      } catch (err) {
        setDrawerError(describeError(err, 'Could not save this job.'));
      } finally {
        setSavingDrawer(false);
      }
    },
    [drawerState],
  );

  const handleStatusChange = useCallback(async (job: SavedJobRecord, status: SavedJobStatus) => {
    setActionError(undefined);
    try {
      const updated = await window.workspace.updateSavedJob(job.id, { status });
      setJobs((prev) => (prev ?? []).map((row) => (row.id === updated.id ? updated : row)));
    } catch (err) {
      setActionError(describeError(err, 'Could not update the status.'));
    }
  }, []);

  const requestDelete = useCallback((job: SavedJobRecord) => {
    setActionError(undefined);
    setDeleteTarget(job);
  }, []);

  const cancelDelete = useCallback(() => setDeleteTarget(null), []);

  const confirmDelete = useCallback(async () => {
    const job = deleteTarget;
    if (!job) return;
    setDeleteTarget(null);
    try {
      const result = await window.workspace.deleteSavedJob(job.id);
      // `{ deleted: false }` means the row was already gone on the server. Still drop it locally so
      // the table matches reality, but skip the "undo a delete that didn't happen" toast.
      setJobs((prev) => (prev ?? []).filter((row) => row.id !== job.id));
      if (result.deleted) {
        setPendingUndo({ message: `Deleted "${job.role}" at ${job.company}.`, job });
      }
    } catch (err) {
      setActionError(describeError(err, 'Could not delete this job.'));
    }
  }, [deleteTarget]);

  const dismissUndo = useCallback(() => setPendingUndo(null), []);

  const handleUndo = useCallback(async () => {
    const undo = pendingUndo;
    if (!undo) return;
    try {
      const recreated = await window.workspace.createSavedJob(toSavedJobInput(undo.job));
      setJobs((prev) => [recreated, ...(prev ?? [])]);
    } catch (err) {
      setActionError(describeError(err, 'Could not undo the deletion.'));
    }
  }, [pendingUndo]);

  const isLoading = jobs === null;
  const hasAnyJobs = (jobs?.length ?? 0) > 0;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Saved jobs</h2>
          {hasAnyJobs && <p className="mt-1 text-sm text-base-content/60">{jobs?.length} saved</p>}
        </div>
        <div className="flex items-center gap-2">
          <SavedJobFilterBox value={query} onChange={setQuery} disabled={isLoading} />
          <button className="btn btn-primary btn-sm" type="button" onClick={openAddDrawer}>
            Add job manually
          </button>
        </div>
      </div>

      {loadError && <div className="alert alert-error mt-4">{loadError}</div>}
      {actionError && <div className="alert alert-error mt-4">{actionError}</div>}

      {isLoading && !loadError && <div className="alert alert-info mt-4">Loading saved jobs…</div>}

      {!isLoading && !hasAnyJobs && (
        <EmptyState
          illustration={emptySavedJobsIllustration}
          title="No saved jobs"
          description="Save vacancies from search results, or add one manually to review it and prepare an application."
          action={
            <button className="btn btn-primary btn-sm" type="button" onClick={openAddDrawer}>
              Add first job
            </button>
          }
        />
      )}

      {!isLoading && hasAnyJobs && filteredJobs.length === 0 && (
        <EmptyState
          illustration={noResultsIllustration}
          title="No saved jobs match that search"
          description="Try a different role or company."
        />
      )}

      {!isLoading && filteredJobs.length > 0 && (
        <div className="mt-4">
          <SavedJobsTable
            jobs={filteredJobs}
            onEdit={openEditDrawer}
            onDelete={requestDelete}
            onStatusChange={handleStatusChange}
          />
        </div>
      )}

      {drawerState && (
        <SavedJobDrawer
          key={drawerState.mode === 'edit' ? drawerState.job.id : 'new'}
          job={drawerState.mode === 'edit' ? drawerState.job : undefined}
          onSave={handleDrawerSave}
          onClose={closeDrawer}
          saving={savingDrawer}
          error={drawerError}
        />
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="Delete saved job?"
          message={
            <>
              This removes <span className="font-medium text-base-content">{deleteTarget.role}</span> at{' '}
              <span className="font-medium text-base-content">{deleteTarget.company}</span> from your saved
              jobs. You can undo this for a few seconds after deleting.
            </>
          }
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
