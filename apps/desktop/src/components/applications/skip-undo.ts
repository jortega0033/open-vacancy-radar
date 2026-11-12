import type { ApplicationAttemptRecord } from '../../window.js';

/** How long the "Skipped" undo stays up after a skip in the allowlisted review dialog. Longer than
 * the delete undo. A skip in the Review & apply workspace keeps its Undo in place instead. */
export const SKIP_UNDO_MS = 10_000;

/**
 * Reverses only a skip (#468). The application is read again first: if it moved on from `skipped`,
 * nothing is written, so an undo can never overwrite a later checkpoint such as a submission.
 * Resolves true when the checkpoint and detail it had before the skip were put back.
 */
export async function restoreSkippedAttempt(previous: ApplicationAttemptRecord): Promise<boolean> {
  const current = await window.workspace.getApplicationAttempt(previous.id);
  if (current?.checkpoint !== 'skipped') return false;
  await window.workspace.updateApplicationAttempt(previous.id, {
    checkpoint: previous.checkpoint,
    checkpointDetail: previous.checkpointDetail,
  });
  return true;
}
