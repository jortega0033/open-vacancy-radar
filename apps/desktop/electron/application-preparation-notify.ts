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

export function notifyApplicationPreparation(input: ApplicationPreparationNotificationInput): void {
  if (!Notification.isSupported()) return;
  new Notification(buildApplicationPreparationNotification(input)).show();
}
