import { Notification } from 'electron';

/**
 * Native OS notifications for the vacancy scan lifecycle (issue #366), mirroring
 * `application-preparation-notify.ts`/`automatic-submission-notify.ts`'s own pattern: pure,
 * independently-testable content builders plus a thin `Notification.isSupported()`-gated show. The
 * caller (`runVacancyScan` in `main.ts`) decides *whether* to notify (only when the app is
 * backgrounded -- see `isAppInBackground` there); this module only decides *what* the notification
 * says.
 */

export interface VacancyScanCompletedNotificationInput {
  /** Rows actually kept in the saved report. */
  kept: number;
  /** False when the report is capped or otherwise known-incomplete. */
  complete: boolean;
}

export interface VacancyScanFailedNotificationInput {
  /** Short, already-user-facing failure detail. Kept out of the title: macOS/Windows both truncate
   * notification bodies more forgivingly than titles. */
  detail: string;
}

export interface NotificationContent {
  title: string;
  body: string;
}

export function buildVacancyScanCompletedNotification(
  input: VacancyScanCompletedNotificationInput,
): NotificationContent {
  if (!input.complete) {
    return {
      title: 'Scan capped',
      body: `Kept ${input.kept.toLocaleString()} vacancies; the report is incomplete.`,
    };
  }
  return {
    title: 'Scan finished',
    body: `${input.kept.toLocaleString()} ${input.kept === 1 ? 'vacancy' : 'vacancies'} kept in your report.`,
  };
}

export function buildVacancyScanFailedNotification(
  input: VacancyScanFailedNotificationInput,
): NotificationContent {
  return {
    title: 'Scan failed',
    body: input.detail,
  };
}

/** A no-op (not an error) on a platform/session where notifications aren't supported at all --
 * missing a notification is a lesser failure than blocking scan completion over a UI capability. */
export function notifyVacancyScanCompleted(input: VacancyScanCompletedNotificationInput): void {
  if (!Notification.isSupported()) return;
  new Notification(buildVacancyScanCompletedNotification(input)).show();
}

export function notifyVacancyScanFailed(input: VacancyScanFailedNotificationInput): void {
  if (!Notification.isSupported()) return;
  new Notification(buildVacancyScanFailedNotification(input)).show();
}
