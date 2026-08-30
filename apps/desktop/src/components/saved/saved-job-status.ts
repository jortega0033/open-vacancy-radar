import type { SavedJobStatus } from '../../window.js';

/**
 * The saved-job pipeline is intentionally three states — matching `SavedJobStatus` exactly.
 * Do not add a fourth status here without adding it to the schema/bridge first; this list is a
 * view over that enum, not a place to invent new states.
 */
export const SAVED_JOB_STATUSES: SavedJobStatus[] = ['considering', 'preparing', 'applied'];

export const SAVED_JOB_STATUS_LABEL: Record<SavedJobStatus, string> = {
  considering: 'Considering',
  preparing: 'Preparing',
  applied: 'Applied',
};
