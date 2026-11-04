// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageBoxOptions } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ dialog: { showMessageBox: vi.fn() } }));

import {
  buildBlindApplyConfirmOptions,
  confirmTextHashOf,
  isBlindApplyAuthorized,
  requestBlindApplyAuthorization,
  type BlindApplyAuthorizationFacts,
} from '../electron/blind-apply-authorization.js';
import { createWorkspaceDb, type WorkspaceDb } from '../electron/workspace/client.js';
import * as store from '../electron/workspace/blind-apply-store.js';
import { CANCEL_BUTTON_INDEX } from '../electron/workspace-confirm.js';

let dir: string;
let db: WorkspaceDb;
let close: () => void;

const FACTS: BlindApplyAuthorizationFacts = {
  roleFamilies: ['frontend'],
  roleFamilyNames: ['Frontend / UI engineering'],
  filtersSnapshot: { primaryCountry: 'PT', minimumMonthlyBaseEur: 3000 },
  filterLines: ['Based in PT', 'At least 3000 EUR a month'],
  profileVersion: 'candidate-profile-1',
  cv: { id: 'cv-1', name: 'Main CV', contentHash: 'abc' },
  policyIds: ['ashby-fixture-test-only'],
  realTargets: [],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-blind-auth-'));
  ({ db, close } = createWorkspaceDb(dir));
});

afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the Blind Apply confirmation dialog', () => {
  const options = buildBlindApplyConfirmOptions({
    roleFamilyNames: ['Frontend / UI engineering'],
    filterLines: ['Based in PT'],
    cvName: 'Main CV',
    realTargets: [],
  });

  it('defaults to Cancel and treats any dismissal as Cancel', () => {
    expect(options.buttons).toEqual(['Cancel', 'Turn on Blind Apply']);
    expect(options.defaultId).toBe(CANCEL_BUTTON_INDEX);
    expect(options.cancelId).toBe(CANCEL_BUTTON_INDEX);
    expect(options.noLink).toBe(true);
  });

  it('lists the role family, the filters and the CV once, and says there is no daily limit', () => {
    const text = `${options.message}\n${options.detail}`;
    expect(text).toContain('Frontend / UI engineering');
    expect(text).toContain('Filter: Based in PT');
    expect(text).toContain('CV used: Main CV');
    expect(text).toContain('There is no daily limit');
  });

  it('never offers a per-application or numeric choice, and the only buttons are cancel and confirm', () => {
    expect(options.checkboxLabel).toBeUndefined();
    expect(options.buttons).toHaveLength(2);
    expect(`${options.message}${options.detail}`).not.toMatch(/\b(?:per day|each application you|up to \d+)/i);
  });

  it('is honest that no real site is supported when there is none', () => {
    expect(options.detail).toContain('none yet (a local test form only)');
    expect(options.detail).toContain('"Apply yourself"');
    const withTarget = buildBlindApplyConfirmOptions({ roleFamilyNames: ['Frontend'], filterLines: [], cvName: 'CV', realTargets: ['Example ATS'] });
    expect(withTarget.detail).toContain('Sites it can send to: Example ATS.');
    expect(withTarget.detail).not.toContain('none yet');
  });

  it('states what it never does, so the consent is informed', () => {
    expect(options.detail).toContain('never');
    expect(options.detail).toMatch(/consent box/);
    expect(options.detail).toMatch(/bot check/);
  });
});

describe('requestBlindApplyAuthorization', () => {
  it('records nothing unless the person approves, however the dialog was dismissed', async () => {
    const confirm = vi.fn(async () => false);
    const result = await requestBlindApplyAuthorization({ db, parent: undefined, confirm }, FACTS);
    expect(result).toEqual({ ok: false, reason: 'declined' });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(isBlindApplyAuthorized(db)).toBe(false);
    expect(store.getActiveBlindApplyAuthorization(db)).toBeNull();
  });

  it('on approval records the exact filters, CV, policies and the hash of the wording shown', async () => {
    let shown: MessageBoxOptions | undefined;
    const confirm = vi.fn(async (_parent: unknown, options: MessageBoxOptions) => {
      shown = options;
      return true;
    });
    const result = await requestBlindApplyAuthorization({ db, parent: undefined, confirm }, FACTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.authorization).toMatchObject({
      roleFamilies: ['frontend'],
      filtersSnapshot: { primaryCountry: 'PT', minimumMonthlyBaseEur: 3000 },
      profileVersion: 'candidate-profile-1',
      sourceCvId: 'cv-1',
      sourceCvContentHash: 'abc',
      policyIds: ['ashby-fixture-test-only'],
      useSavedAnswers: true,
      stoppedAt: null,
    });
    expect(result.authorization.confirmTextHash).toBe(confirmTextHashOf(shown!));
    expect(isBlindApplyAuthorized(db)).toBe(true);
    // One authorization, and nothing in it is a limit of any kind.
    expect(Object.keys(result.authorization).filter((key) => /cap|limit|quota|max|daily|expire/i.test(key))).toEqual([]);
  });

  it('refuses without asking when there is no CV, no profile or no role family to confirm', async () => {
    const confirm = vi.fn(async () => true);
    expect(await requestBlindApplyAuthorization({ db, parent: undefined, confirm }, { ...FACTS, cv: null })).toEqual({ ok: false, reason: 'no_cv' });
    expect(await requestBlindApplyAuthorization({ db, parent: undefined, confirm }, { ...FACTS, profileVersion: '' })).toEqual({ ok: false, reason: 'no_profile' });
    expect(await requestBlindApplyAuthorization({ db, parent: undefined, confirm }, { ...FACTS, roleFamilies: [] })).toEqual({ ok: false, reason: 'no_role_family' });
    expect(confirm).not.toHaveBeenCalled();
    expect(isBlindApplyAuthorized(db)).toBe(false);
  });

  it('confirming again after a CV change replaces the old authorization without deleting it', async () => {
    const confirm = vi.fn(async () => true);
    const first = await requestBlindApplyAuthorization({ db, parent: undefined, confirm }, FACTS);
    const second = await requestBlindApplyAuthorization({ db, parent: undefined, confirm }, { ...FACTS, cv: { id: 'cv-1', name: 'Main CV', contentHash: 'def' } });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(store.getActiveBlindApplyAuthorization(db)?.id).toBe(second.authorization.id);
    expect(store.getBlindApplyAuthorization(db, first.authorization.id)?.stoppedAt).not.toBeNull();
  });
});
