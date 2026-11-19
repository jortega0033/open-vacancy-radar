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
  /**
   * What a ready CV will still be missing in its tailored documents (#757). Not a blocker: a CV can
   * genuinely list no skills, so the person decides, but it is never a silent "Yes" either, because
   * tailoring leaves the Skills section out entirely when the profile has none.
   */
  warnings: string[];
}

/** The one warning the readiness column shows for a ready CV whose profile lists no skills. */
export const NO_SKILLS_READINESS_WARNING = 'no skills listed, so tailored CVs have no Skills section';

export function cvTailoringReadiness(doc: Pick<CvDocumentRecord, 'source'> & { profile?: Pick<CvDocumentRecord['profile'], 'skills'> }): CvTailoringReadiness {
  if (!doc.source) {
    return { state: 'not_read', label: 'Not read yet', reasons: ['the full CV has not been read into records yet'], warnings: [] };
  }
  const reasons = describeCvSourceGaps(doc.source);
  if (reasons.length > 0) return { state: 'needs_review', label: 'Needs your review', reasons, warnings: [] };
  const warnings = doc.profile && doc.profile.skills.length === 0 ? [NO_SKILLS_READINESS_WARNING] : [];
  return { state: 'ready', label: 'Yes', reasons: [], warnings };
}
