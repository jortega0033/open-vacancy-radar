import { beforeEach, describe, expect, it, vi } from 'vitest';

const { showMessageBox } = vi.hoisted(() => ({ showMessageBox: vi.fn() }));
vi.mock('electron', () => ({ dialog: { showMessageBox } }));

const { resolveApplicationTargetPolicy } = vi.hoisted(() => ({ resolveApplicationTargetPolicy: vi.fn() }));
vi.mock('../electron/application-target-policies.js', () => ({ resolveApplicationTargetPolicy }));

const { createAutomationGrant } = vi.hoisted(() => ({ createAutomationGrant: vi.fn() }));
vi.mock('../electron/workspace/repository.js', () => ({ createAutomationGrant }));

const {
  ALLOW_BUTTON_INDEX,
  CANCEL_BUTTON_INDEX,
  MAX_AUTOMATION_GRANT_DURATION_MS,
  buildAutomationGrantConfirmOptions,
  requestAutomationGrant,
} = await import('../electron/automatic-submission-grant.js');

const ELIGIBLE_POLICY = { id: 'workable-jobs-board', displayName: 'Workable job board', termsEligibleForAutomation: true };
const INELIGIBLE_POLICY = { ...ELIGIBLE_POLICY, id: 'greenhouse', termsEligibleForAutomation: false };
const FAKE_DB = {} as never;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  showMessageBox.mockReset();
  resolveApplicationTargetPolicy.mockReset();
  createAutomationGrant.mockReset();
});

describe('the confirmation dialog defaults to refusing', () => {
  it('points both defaultId and cancelId at Cancel', () => {
    const options = buildAutomationGrantConfirmOptions({ displayName: 'Acme', expiresAt: '2026-02-01T00:00:00.000Z' });
    expect(options.buttons?.[CANCEL_BUTTON_INDEX]).toBe('Cancel');
    expect(options.defaultId).toBe(CANCEL_BUTTON_INDEX);
    expect(options.cancelId).toBe(CANCEL_BUTTON_INDEX);
    expect(options.defaultId).toBe(options.cancelId);
  });

  it('sets noLink, so the approving button is not rendered as the quiet secondary choice', () => {
    expect(buildAutomationGrantConfirmOptions({ displayName: 'Acme', expiresAt: '2026-02-01T00:00:00.000Z' }).noLink).toBe(true);
  });

  it('names the policy and the expiry', () => {
    const options = buildAutomationGrantConfirmOptions({ displayName: 'Workable job board', expiresAt: '2026-02-01T00:00:00.000Z' });
    expect(options.message).toContain('Workable job board');
    expect(options.message).toContain(new Date('2026-02-01T00:00:00.000Z').toLocaleString());
  });

  it('uses no em dash anywhere in the user-facing text', () => {
    const options = buildAutomationGrantConfirmOptions({ displayName: 'Acme', expiresAt: '2026-02-01T00:00:00.000Z' });
    const text = [options.title, options.message, options.detail, ...(options.buttons ?? [])].join(' ');
    expect(text).not.toContain('—');
  });
});

describe('requestAutomationGrant', () => {
  it('refuses an unknown policy id before ever showing a dialog', async () => {
    resolveApplicationTargetPolicy.mockReturnValue(undefined);
    const result = await requestAutomationGrant(undefined, FAKE_DB, 'not-a-real-policy', ONE_DAY_MS);
    expect(result).toEqual({ ok: false, reason: 'unknown_policy' });
    expect(showMessageBox).not.toHaveBeenCalled();
  });

  it('refuses a policy the terms register has not cleared for automation, before ever showing a dialog', async () => {
    resolveApplicationTargetPolicy.mockReturnValue(INELIGIBLE_POLICY);
    const result = await requestAutomationGrant(undefined, FAKE_DB, 'greenhouse', ONE_DAY_MS);
    expect(result).toEqual({ ok: false, reason: 'not_eligible_for_automation' });
    expect(showMessageBox).not.toHaveBeenCalled();
  });

  it('refuses a non-positive or excessive duration before ever showing a dialog', async () => {
    resolveApplicationTargetPolicy.mockReturnValue(ELIGIBLE_POLICY);
    await expect(requestAutomationGrant(undefined, FAKE_DB, 'workable-jobs-board', 0)).resolves.toEqual({ ok: false, reason: 'invalid_duration' });
    await expect(requestAutomationGrant(undefined, FAKE_DB, 'workable-jobs-board', -1)).resolves.toEqual({ ok: false, reason: 'invalid_duration' });
    await expect(
      requestAutomationGrant(undefined, FAKE_DB, 'workable-jobs-board', MAX_AUTOMATION_GRANT_DURATION_MS + 1),
    ).resolves.toEqual({ ok: false, reason: 'invalid_duration' });
    expect(showMessageBox).not.toHaveBeenCalled();
  });

  it('treats every non-approval dialog response as a decline, never creating a grant', async () => {
    resolveApplicationTargetPolicy.mockReturnValue(ELIGIBLE_POLICY);
    for (const response of [CANCEL_BUTTON_INDEX, 99, -1]) {
      showMessageBox.mockResolvedValueOnce({ response });
      const result = await requestAutomationGrant(undefined, FAKE_DB, 'workable-jobs-board', ONE_DAY_MS);
      expect(result).toEqual({ ok: false, reason: 'declined' });
    }
    expect(createAutomationGrant).not.toHaveBeenCalled();
  });

  it('creates a grant only on an exact click of the allow button, with an expiry durationMs out', async () => {
    resolveApplicationTargetPolicy.mockReturnValue(ELIGIBLE_POLICY);
    showMessageBox.mockResolvedValueOnce({ response: ALLOW_BUTTON_INDEX });
    const fakeGrant = { id: 'grant-1', policyId: 'workable-jobs-board', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-02T00:00:00.000Z', revokedAt: null };
    createAutomationGrant.mockReturnValue(fakeGrant);

    const result = await requestAutomationGrant(undefined, FAKE_DB, 'workable-jobs-board', ONE_DAY_MS);

    expect(result).toEqual({ ok: true, grant: fakeGrant });
    expect(createAutomationGrant).toHaveBeenCalledWith(FAKE_DB, { policyId: 'workable-jobs-board', expiresAt: expect.any(String) });
  });
});
