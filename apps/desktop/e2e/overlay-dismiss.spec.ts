import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base } from '@playwright/test';
import { createWorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';
import { ensureLightTheme, expect, goto, launchApp, test } from './fixtures.js';

/**
 * Regression coverage for open-vacancy-radar#386: no overlay in this app (a popover, a modal, or a
 * drawer) closed on Escape, and the Salary popover additionally ignored outside clicks. The fix is
 * one shared hook (`useEscapeToClose`, see `src/components/shell/useEscapeToClose.ts`) wired into
 * every overlay component, plus dedicated outside-click handling for the Salary popover specifically
 * (a native `<details>`, not a React-controlled modal). Each overlay named in the issue gets its own
 * test here rather than one shared helper, since each is reached through a different flow and some
 * (`ApplicationReviewSession`, `ApplicationAttemptDrawer`) need a seeded workspace the plain `window`
 * fixture doesn't provide.
 */

test.describe('Escape and outside-click dismissal', () => {
  test('Escape closes the Salary popover, and so does a click outside it', async ({ window }) => {
    await goto(window, 'Search');

    // Not `getByRole('button', { name: 'Salary' })`: overriding a native `<summary>`'s default
    // disclosure marker with `list-none` (SearchFilterBar.tsx's own styling) takes it out of
    // Chromium's accessibility tree as a button, even though it stays a real, clickable summary.
    const salaryButton = window.locator('summary', { hasText: 'Salary' });
    const minimumSalaryInput = window.getByLabel('Minimum annual salary');

    await salaryButton.click();
    await expect(minimumSalaryInput).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(minimumSalaryInput).toBeHidden();

    // Outside-click dismissal (the issue's second half: the popover used to also swallow clicks
    // meant for whatever it overlapped, since nothing closed it first) -- clicking a plain, unrelated
    // point on the page while it's open must close it too, not just Escape.
    await salaryButton.click();
    await expect(minimumSalaryInput).toBeVisible();
    await window.getByRole('heading', { name: 'No search yet' }).click();
    await expect(minimumSalaryInput).toBeHidden();
  });

  test('Escape closes the "Browse all vacancies?" confirmation', async ({ window }) => {
    await goto(window, 'Search');
    await window.getByRole('button', { name: /browse all vacancies/i }).click();

    const confirm = window.getByRole('dialog', { name: /browse all vacancies\?/i });
    await expect(confirm).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(confirm).toBeHidden();
  });

  test('Escape closes the add-saved-job drawer and the delete confirmation', async ({ window }) => {
    await goto(window, 'Saved Jobs');
    await window
      .getByRole('button', { name: /add job manually/i })
      .first()
      .click();

    const addDialog = window.getByRole('dialog', { name: /add saved job/i });
    await expect(addDialog).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(addDialog).toBeHidden();

    // ConfirmDialog (the shared destructive-confirmation modal used by every delete flow) is the
    // other overlay reachable from this same page -- save a row, delete it, and Escape the
    // confirmation instead of confirming or cancelling by click.
    await window
      .getByRole('button', { name: /add job manually/i })
      .first()
      .click();
    await addDialog.getByLabel('Role').fill('Escape Regression Role');
    await addDialog.getByLabel('Company').fill('Escape Regression Co');
    await addDialog.getByLabel('Location').fill('Remote');
    await addDialog.getByRole('button', { name: /^save$/i }).click();
    await expect(addDialog).toBeHidden();

    await window
      .getByRole('row', { name: /Escape Regression Co/ })
      .getByRole('button', { name: /^delete$/i })
      .click();
    const confirm = window.getByRole('alertdialog');
    await expect(confirm).toBeVisible();
    await window.keyboard.press('Escape');
    await expect(confirm).toBeHidden();
    // Cancelling (whether by Escape or the Cancel button) never deletes the row -- confirms Escape
    // actually went through `onCancel`, not `onConfirm`.
    await expect(window.getByRole('row', { name: /Escape Regression Co/ })).toBeVisible();
  });
});

const VACANCY_KEY = 'overlay-dismiss-vacancy';
const VACANCY_URL = 'https://example.invalid/jobs/overlay-dismiss-vacancy';
const REPORT = {
  runId: 'e2e-overlay-dismiss',
  generatedAt: '2026-09-16T00:00:00.000Z',
  profileVersion: 'global-remote-profile-v1',
  criteria: {
    role: 'frontend',
    fullyRemote: true,
    applicantLocation: 'anywhere-outside-us-nl',
    usCitizenshipRequired: false,
    minimumAnnualBaseUsd: 100_000,
    currency: 'USD',
  },
  statistics: {
    discoveryRequests: 1,
    discoveryListings: 1,
    discoveryUniqueListings: 1,
    discoveryOfficialReviewCandidates: 1,
    officialBoardsOrPagesAttempted: 0,
    officialRequests: 0,
    strictMatches: 0,
    manualReview: 0,
    nearMisses: 0,
    excludedOrInactive: 0,
    blockedOrErrored: 0,
    registrySources: 0,
    activeRegistrySources: 0,
    gatedRegistrySources: 0,
    manualOrProhibitedRegistrySources: 0,
  },
  sourceRegistry: [],
  discoverySources: [],
  strictMatches: [],
  manualReview: [],
  nearMisses: [],
  excludedOrInactive: [],
  blockedOrErrored: [],
  officialAudit: [],
  discoveryAudit: [
    {
      key: VACANCY_KEY,
      provider: 'remotive',
      company: 'Overlay Dismiss Engineering',
      title: 'Senior Frontend Product Engineer',
      url: VACANCY_URL,
      location: 'Netherlands',
      employmentType: 'full_time',
      currency: 'EUR',
      salaryPeriod: 'year',
      advertisedMinimum: 70_000,
      annualizedMinimumUsd: 82_000,
      decision: 'official_review_candidate',
      reasons: ['Frontend role'],
      contentHash: 'overlay-dismiss-content-hash',
      description: 'Build accessible product interfaces for an international team.',
      postedAt: '2026-09-01T00:00:00.000Z',
      profileScore: 82,
      worldwideSponsorMatch: null,
    },
  ],
  methodology: [],
  attribution: [],
};

base.describe('Escape dismissal for seeded-workspace overlays', () => {
  base(
    'Escape closes the manual application review session',
    async () => {
      const userDataDir = await mkdtemp(join(tmpdir(), 'ovr-overlay-dismiss-review-'));
      const vacancyEngineDataRoot = await mkdtemp(join(tmpdir(), 'ovr-overlay-dismiss-review-engine-'));
      const reportDirectory = join(vacancyEngineDataRoot, 'reports', 'global-remote');

      try {
        await mkdir(reportDirectory, { recursive: true });
        await writeFile(join(reportDirectory, 'latest.json'), JSON.stringify(REPORT), 'utf8');

        const seeded = createWorkspaceDb(userDataDir);
        try {
          const cv = workspace.createCvDocument(seeded.db, {
            name: 'Overlay Dismiss CV.pdf',
            kind: 'manual',
            text: 'Senior frontend product engineer.',
          });
          const attempt = workspace.createApplicationAttempt(seeded.db, {
            vacancyKey: VACANCY_KEY,
            canonicalUrl: VACANCY_URL,
            company: 'Overlay Dismiss Engineering',
            role: 'Senior Frontend Product Engineer',
            sourceCvId: cv.id,
            sourceCvContentHash: 'source-cv-content-hash',
            jdSnapshot: 'Build accessible product interfaces for an international team.',
            jdSnapshotHash: 'jd-content-hash',
            jdComplete: true,
            checkpoint: 'needs_user',
            checkpointDetail:
              'Your application documents are ready. This employer site requires a manual application.',
          });
          workspace.createApplicationArtifact(seeded.db, {
            attemptId: attempt.id,
            kind: 'cv_pdf',
            fileName: 'Overlay-Dismiss-CV.pdf',
            mimeType: 'application/pdf',
            byteSize: 128,
            contentHash: 'artifact-content-hash',
          });
        } finally {
          seeded.close();
        }

        const electronApp = await launchApp(userDataDir, {
          appId: `ovr-e2e-overlay-dismiss-review-${process.pid}`,
          vacancyEngineDataRoot,
        });
        try {
          const window = await electronApp.firstWindow();
          await window.waitForLoadState('domcontentloaded');
          await ensureLightTheme(window);
          await window.getByRole('complementary', { name: 'Main' }).getByRole('button', { name: 'Search', exact: true }).click();
          await window.getByRole('button', { name: 'Prepare application' }).click();

          const dialog = window.getByRole('dialog');
          await expect(dialog.getByTestId('manual-application-swipe-card')).toBeVisible();
          await window.keyboard.press('Escape');
          await expect(dialog).toBeHidden();
        } finally {
          await electronApp.close();
        }
      } finally {
        await rm(userDataDir, { recursive: true, force: true });
        await rm(vacancyEngineDataRoot, { recursive: true, force: true });
      }
    },
  );

  base('Escape closes the read-only attempt detail drawer', async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), 'ovr-overlay-dismiss-attempt-'));
    const vacancyEngineDataRoot = await mkdtemp(join(tmpdir(), 'ovr-overlay-dismiss-attempt-engine-'));

    try {
      const seeded = createWorkspaceDb(userDataDir);
      try {
        const cv = workspace.createCvDocument(seeded.db, {
          name: 'Overlay Dismiss Attempt CV.pdf',
          kind: 'manual',
          text: 'Senior frontend product engineer.',
        });
        // `submitted` is a completed checkpoint (neither `REVIEW_CHECKPOINTS` nor
        // `PREPARING_CHECKPOINTS` in ApplicationsPage.tsx), which is what lands an attempt in the
        // History view and opens the plain `ApplicationAttemptDrawer` on a row click, rather than
        // the review-and-submit session covered by the test above.
        workspace.createApplicationAttempt(seeded.db, {
          vacancyKey: 'overlay-dismiss-attempt-drawer-vacancy',
          canonicalUrl: 'https://example.invalid/jobs/overlay-dismiss-attempt-drawer-vacancy',
          company: 'Attempt Drawer Regression Co',
          role: 'Staff Frontend Engineer',
          sourceCvId: cv.id,
          sourceCvContentHash: 'source-cv-content-hash',
          jdSnapshot: 'Own the frontend platform roadmap.',
          jdSnapshotHash: 'jd-content-hash',
          jdComplete: true,
          checkpoint: 'submitted',
          checkpointDetail: 'Submitted via the employer site.',
        });
      } finally {
        seeded.close();
      }

      const electronApp = await launchApp(userDataDir, {
        appId: `ovr-e2e-overlay-dismiss-attempt-${process.pid}`,
        vacancyEngineDataRoot,
      });
      try {
        const window = await electronApp.firstWindow();
        await window.waitForLoadState('domcontentloaded');
        await ensureLightTheme(window);
        await window.getByRole('complementary', { name: 'Main' }).getByRole('button', { name: 'Applications', exact: true }).click();
        await window.getByRole('tab', { name: 'Review queue' }).click();
        await window.getByRole('button', { name: /^History/ }).click();
        await window.getByRole('row', { name: /Attempt Drawer Regression Co/ }).click();

        const drawer = window.getByRole('dialog');
        await expect(drawer.getByText('Attempt Drawer Regression Co')).toBeVisible();
        await window.keyboard.press('Escape');
        await expect(drawer).toBeHidden();
      } finally {
        await electronApp.close();
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
      await rm(vacancyEngineDataRoot, { recursive: true, force: true });
    }
  });
});
