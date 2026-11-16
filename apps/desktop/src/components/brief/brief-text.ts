import type {
  AssessmentState,
  BriefPostingStatus,
  BriefRequirementItem,
  EligibilityClass,
  PreferenceGroupName,
} from '../../../electron/application-brief.js';

/**
 * Every sentence the application brief shows that is not data, in one place so the three states a
 * person must tell apart (known mismatch, not known, not assessed) can never drift into one wording.
 * Plain statements, never colour-only.
 */

export const BRIEF_INTRO =
  'Kept on this computer. Built from your last Search scan, the posting text saved with this job and your CV. No AI is used to show it.';

export const ASSESSMENT_HEADLINE: Record<AssessmentState, string> = {
  missing: 'Not assessed yet',
  current: 'Up to date',
  partial: 'Only partly read',
  stale: 'Out of date',
  unavailable: 'Cannot be assessed yet',
};

export const MISSING_ASSESSMENT_NOTE =
  'Nothing has compared this posting with your CV yet. That is not a low fit. Select this job in the list and choose Assess selected jobs to do it.';

export const ELIGIBILITY_HEADLINE: Record<EligibilityClass, string> = {
  known_mismatch: 'Known mismatch',
  uncertain: 'Not known yet',
  consistent: 'Looks fine',
  informational: 'Stated by the posting',
};

export const ELIGIBILITY_EXPLAIN: Record<EligibilityClass, string> = {
  known_mismatch: 'A source says this does not fit you.',
  uncertain: 'No source has said either way. This is not a mismatch.',
  consistent: 'A source says this fits.',
  informational: 'Only matters if you need it.',
};

export const POSTING_HEADLINE: Record<BriefPostingStatus, string> = {
  not_checked: 'Not checked yet',
  confirmed_open: 'Open when last checked',
  confirmed_closed: 'Looked closed when last checked',
  materially_changed: 'Changed since it was prepared',
  unable_to_verify: 'Could not be checked',
  not_applicable: 'Not checked again',
};

export const PREFERENCE_NOTE =
  'This changes your own preferences only. The employer’s statements and anything you already sent stay exactly as they are.';

export const GROUP_FIELD_LABEL: Partial<Record<PreferenceGroupName, string>> = {
  location: 'Country you work from',
  languages: 'Languages you work in',
  relocation: 'Would you relocate for a job like this?',
};

export const CLASSIFICATION_LABEL: Record<BriefRequirementItem['classification'], string> = {
  required: 'Required',
  preferred: 'Preferred',
  unclear: 'Unclear',
};

/**
 * #709: the three honest ways a saved copy can have no query variants. Each says WHY, so "nothing was
 * recorded" is never read as "no query found this job".
 */
export const QUERY_NOT_RECORDED: Record<'missing' | 'no_plan' | 'no_scan_row', string> = {
  missing: 'Search queries were not recorded for this copy. It was saved before the app kept them.',
  no_plan: 'That scan ran without a search plan, so there were no query variants to record.',
  no_scan_row: 'No scan row from the scan that found this copy was still loaded, so its queries were not recorded.',
};

export const SEARCH_PROVENANCE_NOTE =
  'Recorded once, from the scan each copy was saved from. A later scan or a change to your search plan does not rewrite it.';

export const COPY_LABEL: Record<'saved_job' | 'attempt', string> = {
  saved_job: 'Saved copy',
  attempt: 'Preparation copy',
};

export function formatDay(iso: string | null | undefined): string {
  if (!iso) return 'an unknown date';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function isHttpUrl(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^https?:\/\//iu.test(value);
}
