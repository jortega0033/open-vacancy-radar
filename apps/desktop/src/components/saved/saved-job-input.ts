import type { SavedJobInput, SavedJobRecord } from '../../window.js';

/**
 * Turns a persisted row back into the shape `createSavedJob` expects, dropping the
 * server-assigned `id`/`savedAt`. Used for the delete-undo flow: the delete is real and
 * irreversible, so "undo" is actually a fresh `createSavedJob` call with the same field values:
 * the recreated row gets a new id and a new `savedAt`, which is the expected, honest behavior for
 * an undo built on top of a real delete rather than a soft-delete/restore.
 */
export function toSavedJobInput(job: SavedJobRecord): SavedJobInput {
  return {
    role: job.role,
    company: job.company,
    market: job.market,
    location: job.location,
    vacancyKey: job.vacancyKey,
    salary: job.salary,
    arrangement: job.arrangement,
    verification: job.verification,
    matchPercent: job.matchPercent,
    sourceUrl: job.sourceUrl,
    notes: job.notes,
    status: job.status,
  };
}
