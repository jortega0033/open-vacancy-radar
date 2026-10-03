import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApplicationAttemptRecord, SavedJobInput, SavedJobRecord, SavedJobStatus } from '../../window.js';
import emptySavedJobsIllustration from '../../../assets/illustrations/empty-saved-jobs.svg?no-inline';
import noResultsIllustration from '../../../assets/illustrations/no-results.svg?no-inline';
import { ConfirmDialog, EmptyState, ErrorBanner, PageLoading, UndoToast } from '../shell/index.js';
import { SavedJobDrawer } from './SavedJobDrawer.js';
import { SavedJobFilterBox } from './SavedJobFilterBox.js';
import { toSavedJobInput } from './saved-job-input.js';
import { newestAttemptBySavedJob } from './saved-job-application.js';
import { SavedJobsTable } from './SavedJobsTable.js';

type DrawerState = { mode: 'add' } | { mode: 'edit'; job: SavedJobRecord };

interface PendingUndo {
  message: string;
  job: SavedJobRecord;
}

interface PrepareNotice {
  message: string;
  attemptId?: string;
}

const PREPARE_EXPLAINED_KEY = 'ovr.savedJobs.prepareExplained';
/** How often each row's application state is re-read while the page is open (#467). */
const ATTEMPT_REFRESH_MS = 5_000;

function readExplained(): boolean {
  try {
    return window.localStorage.getItem(PREPARE_EXPLAINED_KEY) === '1';
  } catch {
    return false;
  }
}

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export interface SavedJobsPageProps {
  /**
   * Fired after any mutation that can change the saved jobs count (create, delete, or undoing a
   * delete) so the caller (App.tsx) can refresh the sidebar badge and the header's saved jobs
   * count without waiting for the user to navigate away and back.
   *
   * Status changes and edits are not wired to this: neither one changes the total count.
   */
  onSavedJobsChanged?: () => void;
  onViewApplicationAttempt?: (attemptId: string) => void;
}

/**
 * Top-level "Saved Jobs" screen (`export-src.html` lines ~259-307): a role/company filter, a
 * table of saved jobs with an inline status select, add/edit through a right-side drawer, and
 * delete through a confirm dialog with a short undo window.
 *
 * Owns the whole lifecycle against `window.workspace`. Deliberately not wired into `App.tsx`
 * here. This page is exported standalone (see `index.ts`) so the shell's router can pick it up
 * once every page agent's work has landed, without every agent racing to edit the same file.
 */
export function SavedJobsPage({ onSavedJobsChanged, onViewApplicationAttempt }: SavedJobsPageProps = {}) {
  const [jobs, setJobs] = useState<SavedJobRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string>();

  const [query, setQuery] = useState('');

  const [drawerState, setDrawerState] = useState<DrawerState | null>(null);
  const [savingDrawer, setSavingDrawer] = useState(false);
  const [drawerError, setDrawerError] = useState<string>();

  const [deleteTarget, setDeleteTarget] = useState<SavedJobRecord | null>(null);
  const [actionError, setActionError] = useState<string>();

  const [pendingUndo, setPendingUndo] = useState<PendingUndo | null>(null);

  // #272: which job's preparation request is in flight, and what came back from the last one. One
  // at a time by id rather than a single boolean, so a slow request never disables every other
  // row's button.
  const [preparingJobIds, setPreparingJobIds] = useState<ReadonlySet<string>>(() => new Set());
  const [prepareNotice, setPrepareNotice] = useState<PrepareNotice>();
  /** The newest attempt per saved job (#467), so each row says where its application stands. */
  const [attemptsByJobId, setAttemptsByJobId] = useState<ReadonlyMap<string, ApplicationAttemptRecord>>(() => new Map());
  const [explained, setExplained] = useState(readExplained);
  const [autoApplyEnabled, setAutoApplyEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const rows = await window.workspace.listSavedJobs();
        if (!cancelled) setJobs(rows);
      } catch (err) {
        if (!cancelled) setLoadError(describeError(err, 'could not load saved jobs'));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshAttempts = useCallback(async () => {
    try {
      const [rows, attempts, applications] = await Promise.all([
        window.workspace.listSavedJobs(),
        window.workspace.listApplicationAttempts(),
        window.workspace.listApplications('all'),
      ]);
      setAttemptsByJobId(newestAttemptBySavedJob(rows, attempts, applications));
    } catch {
      // The rows still render with "Not started"; a failed refresh is not worth an error banner.
    }
  }, []);

  useEffect(() => {
    void refreshAttempts();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshAttempts();
    }, ATTEMPT_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refreshAttempts]);

  useEffect(() => {
    let cancelled = false;
    void window.workspace
      .getSettings()
      .then((settings) => {
        if (!cancelled) setAutoApplyEnabled(settings.autoApplyEnabled);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const dismissExplanation = useCallback(() => {
    setExplained(true);
    try {
      window.localStorage.setItem(PREPARE_EXPLAINED_KEY, '1');
    } catch {
      // Remembering this is a convenience; the note simply shows again next time.
    }
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
          // A newly created job changes the total count.
          onSavedJobsChanged?.();
        } else {
          const updated = await window.workspace.updateSavedJob(drawerState.job.id, input);
          setJobs((prev) => (prev ?? []).map((job) => (job.id === updated.id ? updated : job)));
        }
        setDrawerState(null);
      } catch (err) {
        setDrawerError(describeError(err, 'could not save this job'));
      } finally {
        setSavingDrawer(false);
      }
    },
    [drawerState, onSavedJobsChanged],
  );

  const handleStatusChange = useCallback(async (job: SavedJobRecord, status: SavedJobStatus) => {
    setActionError(undefined);
    try {
      const updated = await window.workspace.updateSavedJob(job.id, { status });
      setJobs((prev) => (prev ?? []).map((row) => (row.id === updated.id ? updated : row)));
    } catch (err) {
      setActionError(describeError(err, 'could not update status'));
    }
  }, []);

  /**
   * Hands one saved job to the preparation pipeline (#272). This records an attempt and queues it;
   * it never submits anything, and it never reaches the daemon or a browser from here -- Electron
   * main resolves the vacancy, the CV and the destination itself and does the work under a queue
   * lease. Progress shows up on the Applications page's "In progress" tab.
   *
   * A refusal is reported as a plain notice rather than an error banner: "an application for this
   * vacancy is already in progress" is the dedup rule working, not a failure.
   */
  const handlePrepare = useCallback(async (job: SavedJobRecord) => {
    setActionError(undefined);
    setPrepareNotice(undefined);
    setPreparingJobIds((current) => new Set(current).add(job.id));
    try {
      const result = await window.applicationPipeline.start(job.id);
      setPrepareNotice(
        result.ok
          ? {
              message: `Preparing an application for "${job.role}" at ${job.company}.${result.warning ? ` ${result.warning}` : ''}`,
              attemptId: result.attemptId,
            }
          : { message: result.detail ?? 'this application could not be started', attemptId: result.attemptId },
      );
      if (result.ok) onSavedJobsChanged?.();
      void refreshAttempts();
    } catch (err) {
      setActionError(describeError(err, 'could not start preparing this application'));
    } finally {
      setPreparingJobIds((current) => {
        const next = new Set(current);
        next.delete(job.id);
        return next;
      });
    }
  }, [onSavedJobsChanged, refreshAttempts]);

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
      // `{ deleted: false }` means the row was already gone server-side; still drop it locally so
      // the table matches reality, but skip the "undo a delete that didn't happen" toast.
      setJobs((prev) => (prev ?? []).filter((row) => row.id !== job.id));
      if (result.deleted) {
        setPendingUndo({ message: `Deleted "${job.role}" at ${job.company}.`, job });
        // A deleted job moves out of the total count.
        onSavedJobsChanged?.();
      }
    } catch (err) {
      setActionError(describeError(err, 'could not delete this job'));
    }
  }, [deleteTarget, onSavedJobsChanged]);

  const dismissUndo = useCallback(() => setPendingUndo(null), []);

  const handleUndo = useCallback(async () => {
    const undo = pendingUndo;
    if (!undo) return;
    try {
      const recreated = await window.workspace.createSavedJob(toSavedJobInput(undo.job));
      setJobs((prev) => [recreated, ...(prev ?? [])]);
      // Undoing a delete moves a job back into the total count.
      onSavedJobsChanged?.();
    } catch (err) {
      setActionError(describeError(err, 'could not undo the delete'));
    }
  }, [pendingUndo, onSavedJobsChanged]);

  const isLoading = jobs === null;
  const hasAnyJobs = (jobs?.length ?? 0) > 0;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div />
        <div className="flex items-center gap-2">
          <SavedJobFilterBox value={query} onChange={setQuery} disabled={isLoading} />
          <button className="btn btn-primary btn-sm" type="button" onClick={openAddDrawer}>
            Add job manually
          </button>
        </div>
      </div>

      {loadError && <ErrorBanner className="mt-4">{loadError}</ErrorBanner>}
      {actionError && <ErrorBanner className="mt-4">{actionError}</ErrorBanner>}
      {prepareNotice && (
        <div className="alert alert-info mt-4 flex items-center justify-between gap-3" role="status">
          <span>{prepareNotice.message}</span>
          {prepareNotice.attemptId && onViewApplicationAttempt && (
            <button
              type="button"
              className="btn btn-info btn-sm"
              onClick={() => onViewApplicationAttempt(prepareNotice.attemptId!)}
            >
              View application
            </button>
          )}
        </div>
      )}

      {hasAnyJobs && !explained && (
        <div className="alert alert-info alert-soft mt-4 flex items-start justify-between gap-3 text-sm" role="note">
          <span>
            <strong>Prepare application</strong> tailors your CV to the job and fills in the employer&apos;s form,
            then stops for your review.{' '}
            {autoApplyEnabled
              ? 'Sites you have approved for automatic sending can be scheduled to send after a short cancel window that stays visible on every page. Every other site waits for you to choose Send application.'
              : 'Nothing is sent automatically: you review each application and choose Send application yourself.'}
          </span>
          <button type="button" className="btn btn-ghost btn-xs flex-none" onClick={dismissExplanation}>
            Got it
          </button>
        </div>
      )}

      {isLoading && !loadError && <PageLoading label="Loading saved jobs…" />}

      {!isLoading && !hasAnyJobs && (
        <EmptyState
          illustration={emptySavedJobsIllustration}
          title="No saved jobs"
          description="Save vacancies from a scan, or add one manually to compare opportunities and prepare applications."
          action={
            <button className="btn btn-primary btn-sm" type="button" onClick={openAddDrawer}>
              Add manually
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
            onPrepareApplication={handlePrepare}
            preparingJobIds={preparingJobIds}
            attemptsByJobId={attemptsByJobId}
            {...(onViewApplicationAttempt ? { onOpenReview: onViewApplicationAttempt } : {})}
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
