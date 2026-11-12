import { Notification } from 'electron';

export interface ApplicationPreparationNotificationInput {
  company: string;
  role: string;
  needsUser: boolean;
}

export function buildApplicationPreparationNotification(input: ApplicationPreparationNotificationInput) {
  return input.needsUser
    ? {
        title: 'Application needs your attention',
        body: `${input.role} at ${input.company} is waiting under Ready to apply.`,
      }
    : {
        title: 'Application ready to review',
        body: `${input.role} at ${input.company} is ready under Ready to apply.`,
      };
}

/**
 * Shows the notification. `onClick` runs when the person clicks it (#657): main focuses the window
 * and opens this application in the Review & apply workspace. The notification is kept referenced
 * until it is clicked or closed, so its click handler is not collected first.
 */
const shown = new Set<unknown>();

export function notifyApplicationPreparation(input: ApplicationPreparationNotificationInput, onClick?: () => void): void {
  if (!Notification.isSupported()) return;
  const notification = new Notification(buildApplicationPreparationNotification(input));
  if (onClick && typeof notification.on === 'function') {
    shown.add(notification);
    notification.on('click', () => {
      shown.delete(notification);
      onClick();
    });
    notification.on('close', () => {
      shown.delete(notification);
    });
  }
  notification.show();
}
