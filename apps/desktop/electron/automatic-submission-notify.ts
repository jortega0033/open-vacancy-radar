import { Notification } from 'electron';

/**
 * A native OS notification for every automatic submission outcome (#203 scope item 7) -- success
 * included, not just failure: the whole point is that a person should never be surprised, days
 * later, to discover an application went out automatically with no record of it happening in the
 * moment. `buildAutomaticSubmissionNotification` is pure and exported so its wording is directly
 * testable without a real OS notification.
 */

export interface AutomaticSubmissionNotificationInput {
  company: string;
  role: string;
  ok: boolean;
  /** Present only when `ok` is false. */
  detail?: string;
}

export interface NotificationContent {
  title: string;
  body: string;
}

export function buildAutomaticSubmissionNotification(input: AutomaticSubmissionNotificationInput): NotificationContent {
  if (input.ok) {
    return {
      title: 'Application submitted automatically',
      body: `${input.role} at ${input.company} was submitted.`,
    };
  }
  return {
    title: 'Automatic submission needs your attention',
    body: `${input.role} at ${input.company} was not submitted automatically: ${input.detail ?? 'see the attempt for details'}.`,
  };
}

/** Shows the real notification. A no-op (not an error) on a platform/session where notifications
 * aren't supported at all -- missing a notification is a lesser failure than crashing the
 * automatic-submission flow over a UI capability. */
export function notifyAutomaticSubmission(input: AutomaticSubmissionNotificationInput): void {
  if (!Notification.isSupported()) return;
  const { title, body } = buildAutomaticSubmissionNotification(input);
  new Notification({ title, body }).show();
}
