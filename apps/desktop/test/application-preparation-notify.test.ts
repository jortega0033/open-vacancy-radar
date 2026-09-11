import { beforeEach, describe, expect, it, vi } from 'vitest';

const { NotificationMock, isSupported, show } = vi.hoisted(() => {
  const show = vi.fn();
  const isSupported = vi.fn(() => true);
  const NotificationMock = vi.fn().mockImplementation(function () {
    return { show };
  });
  (NotificationMock as unknown as { isSupported: typeof isSupported }).isSupported = isSupported;
  return { NotificationMock, isSupported, show };
});
vi.mock('electron', () => ({ Notification: NotificationMock }));

const { buildApplicationPreparationNotification, notifyApplicationPreparation } = await import(
  '../electron/application-preparation-notify.js'
);

beforeEach(() => {
  NotificationMock.mockClear();
  isSupported.mockReturnValue(true);
  show.mockClear();
});

describe('application preparation notification', () => {
  it('names the application that is ready in the review queue', () => {
    expect(buildApplicationPreparationNotification({ company: 'Acme', role: 'Engineer', needsUser: false })).toEqual({
      title: 'Application ready to review',
      body: 'Engineer at Acme is ready in your Review queue.',
    });
  });

  it('distinguishes an attempt that needs attention', () => {
    expect(buildApplicationPreparationNotification({ company: 'Acme', role: 'Engineer', needsUser: true }).title).toMatch(
      /needs your attention/i,
    );
  });

  it('shows only when the platform supports notifications', () => {
    notifyApplicationPreparation({ company: 'Acme', role: 'Engineer', needsUser: false });
    expect(show).toHaveBeenCalledTimes(1);
    isSupported.mockReturnValue(false);
    notifyApplicationPreparation({ company: 'Acme', role: 'Engineer', needsUser: false });
    expect(NotificationMock).toHaveBeenCalledTimes(1);
  });
});
