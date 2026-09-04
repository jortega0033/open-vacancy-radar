import type { ApplicationFilter, ApplicationInput, ApplicationRecord, ApplicationStatus } from '../../window.js';

/**
 * Canonical status list/labels/styling. `types.ts` (electron/workspace/types.ts) is the source of
 * truth for the enum itself. Nothing here may invent a status the schema does not have.
 *
 * Colors follow DESIGN-TOKENS.md: the pipeline states (preparing/applied/recruiter_screen/
 * interview) are "still working on it" and stay grayscale, matching the "info stays grayscale"
 * rule. `offer` and `rejected` are genuine outcomes, so they get the real success/error hue on the
 * inline `<select>` itself. The option text still names the state either way, so color is never
 * the only signal.
 */
export const APPLICATION_STATUS_ORDER: readonly ApplicationStatus[] = [
  'preparing',
  'applied',
  'recruiter_screen',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
];

export const APPLICATION_STATUS_LABEL: Record<ApplicationStatus, string> = {
  preparing: 'Preparing',
  applied: 'Applied',
  recruiter_screen: 'Recruiter screen',
  interview: 'Interview',
  offer: 'Offer',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

export const APPLICATION_STATUS_SELECT_CLASS: Record<ApplicationStatus, string> = {
  preparing: 'select select-sm',
  applied: 'select select-sm',
  recruiter_screen: 'select select-sm',
  interview: 'select select-sm',
  offer: 'select select-sm select-success',
  rejected: 'select select-sm select-error',
  withdrawn: 'select select-sm',
};

export interface ApplicationsFilterTab {
  key: ApplicationFilter;
  label: string;
}

export const APPLICATIONS_FILTER_TABS: readonly ApplicationsFilterTab[] = [
  { key: 'active', label: 'Active' },
  { key: 'archived', label: 'Archived' },
  { key: 'all', label: 'All' },
];

/**
 * Most-recently-applied first, matching the pipeline mental model of "what did I just do." Rows
 * that have not been applied to yet (still `preparing`, `appliedAt` null) have no date to sort by,
 * so they sink below anything with a real applied date and fall back to a stable alphabetical
 * order by role.
 */
export function sortApplications(applications: readonly ApplicationRecord[]): ApplicationRecord[] {
  return [...applications].sort((a, b) => {
    const aTime = a.appliedAt ? Date.parse(a.appliedAt) : null;
    const bTime = b.appliedAt ? Date.parse(b.appliedAt) : null;
    if (aTime !== null && bTime !== null) return bTime - aTime;
    if (aTime !== null) return -1;
    if (bTime !== null) return 1;
    return a.role.localeCompare(b.role);
  });
}

/** `<input type="date">` wants `YYYY-MM-DD`; `appliedAt` may carry a full ISO timestamp. */
export function toDateInputValue(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}

/** Rebuilds the create payload for an existing record: used to recreate a row on delete-undo. */
export function toApplicationInput(record: ApplicationRecord): ApplicationInput {
  return {
    role: record.role,
    company: record.company,
    location: record.location,
    savedJobId: record.savedJobId,
    verification: record.verification,
    status: record.status,
    appliedAt: record.appliedAt,
    nextStep: record.nextStep,
    contact: record.contact,
    cvId: record.cvId,
    letterId: record.letterId,
    notes: record.notes,
    archived: record.archived,
  };
}

export function emptyStateTitle(filter: ApplicationFilter): string {
  return filter === 'archived' ? 'No archived applications' : 'No applications yet';
}
