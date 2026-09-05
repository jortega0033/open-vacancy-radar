import type { ApplicationAttemptCheckpoint, ApplicationAttemptRecord } from '../../window.js';

/**
 * Checkpoint presentation for the read-only "In progress" attempts list (issue #202). An attempt
 * has no status a person sets directly -- `workspace/types.ts`'s own comment on `ApplicationAttemptPatch`
 * says the identity/provenance fields are immutable and only the main-process pipeline advances
 * `checkpoint` -- so unlike `application-status.ts`'s applications, there is no drawer to edit one
 * of these from, only a detail view.
 *
 * Colors follow DESIGN-TOKENS.md's "info stays grayscale, success/warning/error carry real hue"
 * rule: every checkpoint that means "still working on it" (including a deliberate `skipped`, which
 * is a neutral outcome, not a failure) is grayscale; `submitted` is the one real success; `failed`
 * is the one real error; `needs_user`/`submission_unknown` are warnings because they need a
 * person's attention, not because anything went definitively wrong.
 */
export const ATTEMPT_CHECKPOINT_LABEL: Record<ApplicationAttemptCheckpoint, string> = {
  queued: 'Queued',
  reading_jd: 'Reading job description',
  tailoring: 'Tailoring CV',
  rendering: 'Rendering documents',
  filling: 'Filling application',
  ready: 'Ready to submit',
  submitting: 'Submitting',
  submitted: 'Submitted',
  needs_user: 'Needs your input',
  skipped: 'Skipped',
  failed: 'Failed',
  submission_unknown: 'Submission unknown',
};

export type AttemptCheckpointTone = 'neutral' | 'success' | 'warning' | 'error';

const ATTEMPT_CHECKPOINT_TONE: Record<ApplicationAttemptCheckpoint, AttemptCheckpointTone> = {
  queued: 'neutral',
  reading_jd: 'neutral',
  tailoring: 'neutral',
  rendering: 'neutral',
  filling: 'neutral',
  ready: 'neutral',
  submitting: 'neutral',
  submitted: 'success',
  needs_user: 'warning',
  skipped: 'neutral',
  failed: 'error',
  submission_unknown: 'warning',
};

export const ATTEMPT_CHECKPOINT_BADGE_CLASS: Record<ApplicationAttemptCheckpoint, string> = Object.fromEntries(
  Object.entries(ATTEMPT_CHECKPOINT_TONE).map(([checkpoint, tone]) => [
    checkpoint,
    tone === 'neutral' ? 'badge badge-neutral badge-soft' : `badge badge-${tone} badge-soft`,
  ]),
) as Record<ApplicationAttemptCheckpoint, string>;

/** Most-recently-updated first: the attempt a person is most likely mid-way through or was just
 * asked about is the one they want to see without scrolling. */
export function sortAttempts(attempts: readonly ApplicationAttemptRecord[]): ApplicationAttemptRecord[] {
  return [...attempts].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
