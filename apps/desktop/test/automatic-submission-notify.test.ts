import { beforeEach, describe, expect, it, vi } from 'vitest';

const { NotificationMock, isSupported, show } = vi.hoisted(() => {
  const show = vi.fn();
  const isSupported = vi.fn(() => true);
  const NotificationMock = vi.fn().mockImplementation(() => ({ show }));
  (NotificationMock as unknown as { isSupported: typeof isSupported }).isSupported = isSupported;
  return { NotificationMock, isSupported, show };
});
vi.mock('electron', () => ({ Notification: NotificationMock }));

const { buildAutomaticSubmissionNotification, notifyAutomaticSubmission } = await import('../electron/automatic-submission-notify.js');

beforeEach(() => {
  NotificationMock.mockClear();
  isSupported.mockReturnValue(true);
  show.mockClear();
});

describe('buildAutomaticSubmissionNotification', () => {
  it('announces a real success, naming the role and company', () => {
    const content = buildAutomaticSubmissionNotification({ company: 'Acme Corp', role: 'Senior Engineer', ok: true });
    expect(content.title).toMatch(/submitted/i);
    expect(content.body).toContain('Senior Engineer');
    expect(content.body).toContain('Acme Corp');
  });

  it('surfaces a refusal detail rather than a bare "it failed"', () => {
    const content = buildAutomaticSubmissionNotification({
      company: 'Acme Corp',
      role: 'Senior Engineer',
      ok: false,
      detail: 'the daily automatic-submission cap was reached',
    });
    expect(content.title).toMatch(/needs your attention/i);
    expect(content.body).toContain('the daily automatic-submission cap was reached');
  });

  it('uses no em dash anywhere in the user-facing text', () => {
    const success = buildAutomaticSubmissionNotification({ company: 'Acme', role: 'Engineer', ok: true });
    const failure = buildAutomaticSubmissionNotification({ company: 'Acme', role: 'Engineer', ok: false, detail: 'refused' });
    expect(`${success.title} ${success.body}`).not.toContain('—');
    expect(`${failure.title} ${failure.body}`).not.toContain('—');
  });
});

describe('notifyAutomaticSubmission', () => {
  it('shows a real notification when the platform supports it', () => {
    notifyAutomaticSubmission({ company: 'Acme', role: 'Engineer', ok: true });
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('does nothing, without throwing, when notifications are unsupported', () => {
    isSupported.mockReturnValue(false);
    expect(() => notifyAutomaticSubmission({ company: 'Acme', role: 'Engineer', ok: true })).not.toThrow();
    expect(NotificationMock).not.toHaveBeenCalled();
  });
});
