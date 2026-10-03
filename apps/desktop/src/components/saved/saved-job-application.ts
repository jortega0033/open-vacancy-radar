import type { ApplicationAttemptRecord } from '../../window.js';

/**
 * What a saved job's row says about its application, derived from the newest linked attempt (#467).
 *
 * The wording follows the evidence, not the optimism of the pipeline: "Sent" appears only for an
 * attempt whose receipt this app observed, a person's own report is labelled as theirs, and an
 * unconfirmed send is labelled unconfirmed. A prepared application is "Ready to review", never sent.
 */
export interface SavedJobApplicationState {
  label: string;
  tone: 'neutral' | 'info' | 'success' | 'warning' | 'error';
  /** The attempt to open, or null when none exists (or the last one was skipped). */
  attemptId: string | null;
  /** Whether "Prepare application" is still the right action for this row. */
  canPrepare: boolean;
  /** Whether a send is scheduled and can still be cancelled from the attempt. */
  scheduled: boolean;
}

const PREPARING_LABEL: Partial<Record<ApplicationAttemptRecord['checkpoint'], string>> = {
  queued: 'Preparing (queued)',
  reading_jd: 'Preparing (reading the job description)',
  tailoring: 'Preparing (tailoring CV)',
  rendering: 'Preparing (building documents)',
  filling: 'Preparing (filling the form)',
};

function shortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function shortTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function describeSavedJobApplication(attempt: ApplicationAttemptRecord | undefined): SavedJobApplicationState {
  if (!attempt) return { label: 'Not started', tone: 'neutral', attemptId: null, canPrepare: true, scheduled: false };
  const { checkpoint } = attempt;
  const open = { attemptId: attempt.id, canPrepare: false, scheduled: false } as const;
  switch (checkpoint) {
    case 'ready':
      if (attempt.scheduledAutomaticSubmitAt) {
        return { ...open, scheduled: true, label: `Sending automatically at ${shortTime(attempt.scheduledAutomaticSubmitAt)}`, tone: 'warning' };
      }
      return { ...open, label: 'Ready to review', tone: 'info' };
    case 'needs_user':
      return { ...open, label: 'Needs your input', tone: 'warning' };
    case 'submitting':
      return { ...open, label: 'Sending now', tone: 'info' };
    case 'submitted':
      return { ...open, label: `Sent ${shortDate(attempt.submittedAt ?? attempt.updatedAt)}`.trim(), tone: 'success' };
    case 'user_reported':
      return { ...open, label: `Reported as applied ${shortDate(attempt.submittedAt ?? attempt.updatedAt)}`.trim(), tone: 'neutral' };
    case 'submission_unknown':
      return { ...open, label: 'Sent, not confirmed', tone: 'warning' };
    case 'failed':
      return { ...open, label: 'Preparation failed', tone: 'error' };
    case 'skipped':
      return { label: 'Skipped', tone: 'neutral', attemptId: attempt.id, canPrepare: true, scheduled: false };
    default:
      return { ...open, label: PREPARING_LABEL[checkpoint] ?? 'Preparing', tone: 'info' };
  }
}

/** The newest attempt for each saved job, matched by posting key and, for jobs without one, by the
 * Applications row the attempt is linked to. */
export function newestAttemptBySavedJob(
  jobs: readonly { id: string; vacancyKey: string | null }[],
  attempts: readonly ApplicationAttemptRecord[],
  applications: readonly { id: string; savedJobId: string | null }[],
): Map<string, ApplicationAttemptRecord> {
  const savedJobIdByApplicationId = new Map(
    applications.filter((application) => application.savedJobId).map((application) => [application.id, application.savedJobId!]),
  );
  const newest = new Map<string, ApplicationAttemptRecord>();
  const sorted = [...attempts].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const jobByVacancyKey = new Map(jobs.filter((job) => job.vacancyKey).map((job) => [job.vacancyKey!, job.id]));
  for (const attempt of sorted) {
    const jobId =
      (attempt.vacancyKey ? jobByVacancyKey.get(attempt.vacancyKey) : undefined) ??
      (attempt.applicationId ? savedJobIdByApplicationId.get(attempt.applicationId) : undefined);
    if (jobId && !newest.has(jobId)) newest.set(jobId, attempt);
  }
  return newest;
}
