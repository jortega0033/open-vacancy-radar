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
        body: `${input.role} at ${input.company} is waiting in your Review queue.`,
      }
    : {
        title: 'Application ready to review',
        body: `${input.role} at ${input.company} is ready in your Review queue.`,
      };
}

export function notifyApplicationPreparation(input: ApplicationPreparationNotificationInput): void {
  if (!Notification.isSupported()) return;
  new Notification(buildApplicationPreparationNotification(input)).show();
}
