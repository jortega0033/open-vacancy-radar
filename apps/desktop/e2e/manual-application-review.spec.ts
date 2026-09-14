import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createWorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';
import { ensureLightTheme, launchApp } from './fixtures.js';

const VACANCY_KEY = 'manual-review-vacancy';
const VACANCY_URL = 'https://example.invalid/jobs/manual-review-vacancy';
const REPORT = {
  runId: 'e2e-manual-application-review',
  generatedAt: '2026-09-12T00:00:00.000Z',
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
      company: 'Northstar Product Engineering',
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
      contentHash: 'manual-review-content-hash',
      description: 'Build accessible product interfaces for an international team.',
      postedAt: '2026-09-01T00:00:00.000Z',
      profileScore: 82,
      worldwideSponsorMatch: null,
    },
  ],
  methodology: [],
  attribution: [],
};

test('Search opens a compact manual swipe review with equivalent controls', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'ovr-manual-review-'));
  const vacancyEngineDataRoot = await mkdtemp(join(tmpdir(), 'ovr-manual-review-engine-'));
  const reportDirectory = join(vacancyEngineDataRoot, 'reports', 'global-remote');

  try {
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(join(reportDirectory, 'latest.json'), JSON.stringify(REPORT), 'utf8');

    const seeded = createWorkspaceDb(userDataDir);
    try {
      const cv = workspace.createCvDocument(seeded.db, {
        name: 'Reviewed Frontend CV.pdf',
        kind: 'manual',
        text: 'Senior frontend product engineer.',
      });
      const attempt = workspace.createApplicationAttempt(seeded.db, {
        vacancyKey: VACANCY_KEY,
        canonicalUrl: VACANCY_URL,
        company: 'Northstar Product Engineering',
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
        fileName: 'Northstar-Frontend-CV.pdf',
        mimeType: 'application/pdf',
        byteSize: 128,
        contentHash: 'artifact-content-hash',
      });
    } finally {
      seeded.close();
    }

    const electronApp = await launchApp(userDataDir, {
      appId: `ovr-e2e-manual-review-${process.pid}`,
      vacancyEngineDataRoot,
    });
    try {
      const window = await electronApp.firstWindow();
      await window.waitForLoadState('domcontentloaded');
      await ensureLightTheme(window);
      await window.getByRole('complementary', { name: 'Main' }).getByRole('button', { name: 'Search', exact: true }).click();
      await expect(window.getByRole('button', { name: 'Prepare application' })).toBeVisible();
      await window.getByRole('button', { name: 'Prepare application' }).click();

      const dialog = window.getByRole('dialog');
      const card = dialog.getByTestId('manual-application-swipe-card');
      const backs = dialog.getByTestId('manual-swipe-card-back');
      const skipButton = dialog.getByRole('button', { name: 'Skip', exact: true });
      const continueButton = dialog.getByRole('button', { name: 'Continue on employer site' });
      await expect(card).toBeVisible();
      await expect(backs).toHaveCount(2);
      await expect(skipButton).toBeEnabled();
      await expect(continueButton).toBeEnabled();
      await expect(dialog.getByTestId('manual-swipe-guidance').getByText('Continue', { exact: true })).toBeVisible();
      await expect(dialog.getByText('Submit', { exact: true })).toHaveCount(0);

      for (const bounds of [
        { width: 1200, height: 800 },
        { width: 760, height: 820 },
      ]) {
        await electronApp.evaluate(
          ({ BrowserWindow }, nextBounds) => BrowserWindow.getAllWindows()[0]?.setBounds(nextBounds),
          bounds,
        );
        await window.waitForTimeout(100);

        const geometry = await dialog.evaluate((element) => {
          const dialogBounds = element.getBoundingClientRect();
          const boxElement = element.querySelector<HTMLElement>('.modal-box');
          const box = boxElement?.getBoundingClientRect();
          const front = element
            .querySelector<HTMLElement>('[data-testid="manual-application-swipe-card"]')
            ?.getBoundingClientRect();
          const buttons = [...(boxElement?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
            .filter((button) => button.offsetParent !== null)
            .map((button) => button.getBoundingClientRect());
          if (!box || !front) throw new Error('manual review layout is incomplete');
          return { dialogBounds, box, front, buttons };
        });
        expect(geometry.box.left).toBeGreaterThanOrEqual(geometry.dialogBounds.left);
        expect(geometry.box.right).toBeLessThanOrEqual(geometry.dialogBounds.right);
        expect(geometry.box.top).toBeGreaterThanOrEqual(geometry.dialogBounds.top);
        expect(geometry.box.bottom).toBeLessThanOrEqual(geometry.dialogBounds.bottom);
        for (const button of geometry.buttons) {
          expect(button.left).toBeGreaterThanOrEqual(geometry.box.left);
          expect(button.right).toBeLessThanOrEqual(geometry.box.right);
        }

        const suffix = `${bounds.width}x${bounds.height}`;
        const restPath = test.info().outputPath(`manual-review-rest-${suffix}.png`);
        await window.screenshot({ animations: 'disabled', path: restPath });
        await test.info().attach(`manual-review-rest-${suffix}`, {
          path: restPath,
          contentType: 'image/png',
        });

        const frontBefore = await card.boundingBox();
        const backBefore = await backs.first().boundingBox();
        if (!frontBefore || !backBefore) throw new Error('manual review deck is not measurable');
        await window.mouse.move(frontBefore.x + frontBefore.width / 2, frontBefore.y + frontBefore.height / 2);
        await window.mouse.down();
        await window.mouse.move(frontBefore.x + frontBefore.width / 2 + 80, frontBefore.y + frontBefore.height / 2, { steps: 4 });

        const frontDuring = await card.boundingBox();
        const backDuring = await backs.first().boundingBox();
        if (!frontDuring || !backDuring) throw new Error('manual review deck disappeared while dragging');
        expect(frontDuring.x).toBeGreaterThan(frontBefore.x + 40);
        expect(backDuring.x).toBeCloseTo(backBefore.x, 0);
        await expect(skipButton).toBeEnabled();
        await expect(continueButton).toBeEnabled();

        const dragPath = test.info().outputPath(`manual-review-mid-drag-${suffix}.png`);
        await window.screenshot({ animations: 'disabled', path: dragPath });
        await test.info().attach(`manual-review-mid-drag-${suffix}`, {
          path: dragPath,
          contentType: 'image/png',
        });

        await window.mouse.up();
        await expect
          .poll(async () => (await card.boundingBox())?.x)
          .toBeCloseTo(frontBefore.x, 0);
        await skipButton.focus();
        await expect(skipButton).toBeFocused();
        await continueButton.focus();
        await expect(continueButton).toBeFocused();
      }
    } finally {
      await electronApp.close();
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
    await rm(vacancyEngineDataRoot, { recursive: true, force: true });
  }
});
