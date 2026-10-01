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

const {
  buildVacancyScanCompletedNotification,
  buildVacancyScanFailedNotification,
  notifyVacancyScanCompleted,
  notifyVacancyScanFailed,
} = await import('../electron/vacancy-scan-notify.js');

beforeEach(() => {
  NotificationMock.mockClear();
  isSupported.mockReturnValue(true);
  show.mockClear();
});

describe('vacancy scan notifications (issue #366)', () => {
  it('names the kept count for a complete scan', () => {
    expect(buildVacancyScanCompletedNotification({ kept: 42, complete: true })).toEqual({
      title: 'Scan finished',
      body: '42 vacancies kept in your report.',
    });
  });

  it('uses singular wording for exactly one result', () => {
    expect(buildVacancyScanCompletedNotification({ kept: 1, complete: true }).body).toBe(
      '1 vacancy kept in your report.',
    );
  });

  it('distinguishes a capped/incomplete report', () => {
    const content = buildVacancyScanCompletedNotification({ kept: 5_000, complete: false });
    expect(content.title).toBe('Scan capped');
    expect(content.body).toContain('5,000');
    expect(content.body).toMatch(/incomplete/i);
  });

  it('carries the failure detail', () => {
    expect(buildVacancyScanFailedNotification({ detail: 'network unreachable' })).toEqual({
      title: 'Scan failed',
      body: 'network unreachable',
    });
  });

  it('shows only when the platform supports notifications', () => {
    notifyVacancyScanCompleted({ kept: 3, complete: true });
    expect(show).toHaveBeenCalledTimes(1);
    isSupported.mockReturnValue(false);
    notifyVacancyScanCompleted({ kept: 3, complete: true });
    expect(NotificationMock).toHaveBeenCalledTimes(1);
  });

  it('never throws when notifications are unsupported', () => {
    isSupported.mockReturnValue(false);
    expect(() => notifyVacancyScanFailed({ detail: 'boom' })).not.toThrow();
    expect(NotificationMock).not.toHaveBeenCalled();
  });
});
