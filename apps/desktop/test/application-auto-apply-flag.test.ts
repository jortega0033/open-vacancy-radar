// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApplicationTargetPolicy } from '@agent-dock/application-executor';
import {
  FIXTURE_FORM_URLS,
  isAutoApplyEnabled,
  resolvePolicyIdAmong,
  resolvePolicyIdForCanonicalUrl,
  setAutoApplyEnabled,
} from '../electron/application-target-policies.js';
import { createWorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';
import { parseSettingsPatch } from '../electron/workspace/validate.js';

/**
 * The MVP auto-apply kill switch: this release ships with no site automatically submittable, and
 * this file is where that claim is actually checked.
 *
 * The claim deliberately is not "the policy table is empty". It is not -- it carries the local
 * fixture entries -- and even if it were, emptiness is a promise about every future pull request
 * rather than a property of the code. What is checked here instead is that
 * `resolvePolicyIdForCanonicalUrl`, the single function every caller holding a URL goes through,
 * refuses while the switch is off *even for a policy that plainly matches the URL it is asked
 * about*. That is why the suppression test below builds its own policy rather than leaning on
 * whatever the compiled table happens to contain today.
 */

/**
 * A stand-in for the kind of entry a future pull request would add if a real applicant-tracking
 * system ever cleared #197's terms register: an ordinary `origins` policy over an https host, with
 * navigation and submission both switched on. Nothing here is registered with the app -- it exists
 * only to be handed to `resolvePolicyIdAmong` as a policy the resolver would otherwise happily
 * match, so the kill switch is tested against a real match rather than against an empty search.
 */
const WOULD_OTHERWISE_MATCH: ApplicationTargetPolicy = {
  id: 'hypothetical-future-real-target',
  displayName: 'A future real target (test construct, never compiled in)',
  origins: ['https://jobs.example.invalid'],
  adapter: 'generic-html-form',
  termsRegisterEntry: 'n/a (test construct)',
  termsVersion: 'n/a (test construct)',
  termsReviewedAt: '2026-01-01',
  allowedActions: ['openTarget', 'snapshot', 'fill', 'select', 'attach', 'capture', 'handoff', 'submit'],
  uploadConstraints: { maxBytes: 10 * 1024 * 1024, mimeTypes: ['application/pdf'] },
  rateLimits: { perDay: 10, perEmployerPerDay: 1, minIntervalMs: 0 },
  killSwitches: { navigate: false, fill: false, upload: false, submit: false },
  termsEligibleForAutomation: true,
  maxSteps: 100,
  timeoutMs: 60_000,
  maximumSnapshotBytes: 2 * 1024 * 1024,
};

const WOULD_OTHERWISE_MATCH_URL = 'https://jobs.example.invalid/openings/42/apply';

afterEach(() => {
  // Every test here either asserts the shipped state or turns the switch on for one assertion; the
  // module is shared, so it goes back to refusing regardless of which.
  setAutoApplyEnabled(false);
});

describe('the auto-apply kill switch ships off', () => {
  it('starts off before anything hydrates it, so a failed or missing hydration refuses rather than permits', () => {
    expect(isAutoApplyEnabled()).toBe(false);
  });

  it('is off for a brand-new workspace database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ovr-auto-apply-default-'));
    const { db, close } = createWorkspaceDb(dir);
    try {
      expect(workspace.getSettings(db).autoApplyEnabled).toBe(false);
    } finally {
      close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cannot be turned on by the renderer: the settings validator drops the field entirely', () => {
    // Alongside a field the validator does accept, so this proves the payload itself was fine and
    // it is `autoApplyEnabled` specifically that did not survive.
    expect(parseSettingsPatch({ autoScanEnabled: true, autoApplyEnabled: true })).toEqual({ autoScanEnabled: true });
  });
});

describe('while the kill switch is off, no URL resolves to a target policy', () => {
  it('suppresses a policy that plainly matches the URL it is asked about', () => {
    expect(resolvePolicyIdAmong([WOULD_OTHERWISE_MATCH], WOULD_OTHERWISE_MATCH_URL)).toBeUndefined();

    // ...and the same call with the switch on does match, so the line above is the switch refusing,
    // not the policy failing to cover this URL in the first place.
    setAutoApplyEnabled(true);
    expect(resolvePolicyIdAmong([WOULD_OTHERWISE_MATCH], WOULD_OTHERWISE_MATCH_URL)).toBe(WOULD_OTHERWISE_MATCH.id);
  });

  it('suppresses the compiled table the same way, through the function every real caller uses', () => {
    expect(resolvePolicyIdForCanonicalUrl(FIXTURE_FORM_URLS.withUpload)).toBeUndefined();
    expect(resolvePolicyIdForCanonicalUrl(FIXTURE_FORM_URLS.withoutUpload)).toBeUndefined();

    setAutoApplyEnabled(true);
    expect(resolvePolicyIdForCanonicalUrl(FIXTURE_FORM_URLS.withUpload)).toBe('ashby-fixture-test-only');
  });

  it('still refuses a URL no policy covers, switch on or off', () => {
    const unlisted = 'https://careers.some-employer.invalid/apply/1';
    expect(resolvePolicyIdForCanonicalUrl(unlisted)).toBeUndefined();
    setAutoApplyEnabled(true);
    expect(resolvePolicyIdForCanonicalUrl(unlisted)).toBeUndefined();
  });
});

describe('the switch is a live setting, not a value read once', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ovr-auto-apply-setting-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('follows the stored setting the way main.ts hydrates it', () => {
    const { db, close } = createWorkspaceDb(dir);
    try {
      // Exactly what `ensureWorkspaceDb` does once the database is open. Written here through the
      // repository rather than the IPC validator because the validator refuses this field on
      // purpose -- main-process code is the only writer there is.
      workspace.updateSettings(db, { autoApplyEnabled: true });
      setAutoApplyEnabled(workspace.getSettings(db).autoApplyEnabled);
      expect(resolvePolicyIdForCanonicalUrl(FIXTURE_FORM_URLS.withUpload)).toBe('ashby-fixture-test-only');

      workspace.updateSettings(db, { autoApplyEnabled: false });
      setAutoApplyEnabled(workspace.getSettings(db).autoApplyEnabled);
      expect(resolvePolicyIdForCanonicalUrl(FIXTURE_FORM_URLS.withUpload)).toBeUndefined();
    } finally {
      close();
    }
  });
});
