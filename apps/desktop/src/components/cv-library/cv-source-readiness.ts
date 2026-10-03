import { describeCvSourceGaps } from '../../../electron/workspace/cv-source-schema.js';
import type { CvDocumentRecord } from '../../window.js';

/**
 * Whether a CV may back a tailored, approved document (#447). Three facts that used to blur into one
 * green "Parsed" are kept apart:
 *
 *  - text was read out of the file (the Parse status column),
 *  - a structured source exists (`doc.source` is not null), and
 *  - the candidate reviewed it (`reviewedAt` is stamped, and the source is complete).
 *
 * Only the third makes a CV ready. `describeCvSourceGaps` is the same function the approval and
 * export code asks, so this column can never say Yes where an approval would be refused.
 */
export type CvTailoringReadinessState = 'ready' | 'needs_review' | 'not_read';

export interface CvTailoringReadiness {
  state: CvTailoringReadinessState;
  label: 'Yes' | 'Needs your review' | 'Not read yet';
  /** What is missing, in the user's terms. Empty when ready. */
  reasons: string[];
}

export function cvTailoringReadiness(doc: Pick<CvDocumentRecord, 'source'>): CvTailoringReadiness {
  if (!doc.source) {
    return { state: 'not_read', label: 'Not read yet', reasons: ['the full CV has not been read into records yet'] };
  }
  const reasons = describeCvSourceGaps(doc.source);
  return reasons.length > 0
    ? { state: 'needs_review', label: 'Needs your review', reasons }
    : { state: 'ready', label: 'Yes', reasons: [] };
}
