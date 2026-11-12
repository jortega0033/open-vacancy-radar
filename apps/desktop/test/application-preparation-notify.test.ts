import { beforeEach, describe, expect, it, vi } from 'vitest';

const { NotificationMock, isSupported, show, handlers } = vi.hoisted(() => {
  const show = vi.fn();
  const isSupported = vi.fn(() => true);
  const handlers = new Map<string, () => void>();
  const NotificationMock = vi.fn().mockImplementation(function () {
    return {
      show,
      on: (event: string, handler: () => void) => {
        handlers.set(event, handler);
      },
    };
  });
  (NotificationMock as unknown as { isSupported: typeof isSupported }).isSupported = isSupported;
  return { NotificationMock, isSupported, show, handlers };
});
vi.mock('electron', () => ({ Notification: NotificationMock }));

const { buildApplicationPreparationNotification, notifyApplicationPreparation } = await import(
  '../electron/application-preparation-notify.js'
);

beforeEach(() => {
  NotificationMock.mockClear();
  isSupported.mockReturnValue(true);
  show.mockClear();
  handlers.clear();
});

describe('application preparation notification', () => {
  it('names the application that is ready under Ready to apply', () => {
    expect(buildApplicationPreparationNotification({ company: 'Acme', role: 'Engineer', needsUser: false })).toEqual({
      title: 'Application ready to review',
      body: 'Engineer at Acme is ready under Ready to apply.',
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

  it('runs the click route only when the person clicks the notification (#657)', () => {
    const onClick = vi.fn();
    notifyApplicationPreparation({ company: 'Acme', role: 'Engineer', needsUser: false }, onClick);
    expect(show).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
    handlers.get('click')?.();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('registers no click handler when no route is given', () => {
    notifyApplicationPreparation({ company: 'Acme', role: 'Engineer', needsUser: false });
    expect(handlers.has('click')).toBe(false);
  });
});
