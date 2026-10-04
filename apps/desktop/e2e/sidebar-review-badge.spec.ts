import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';
import { createWorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';
import { expect, launchApp } from './fixtures.js';

test('expanded Applications badge leaves the label readable in light and dark themes', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'ovr-sidebar-review-'));
  const vacancyEngineDataRoot = join(userDataDir, 'vacancy-engine');
  cpSync(
    fileURLToPath(new URL('../../../packages/vacancy-engine/config', import.meta.url)),
    join(vacancyEngineDataRoot, 'config'),
    { recursive: true },
  );
  try {
    const seeded = createWorkspaceDb(userDataDir);
    try {
      const cv = workspace.createCvDocument(seeded.db, {
        name: 'Sidebar Review CV',
        kind: 'manual',
        text: 'Frontend engineer.',
      });
      workspace.createApplicationAttempt(seeded.db, {
        vacancyKey: 'sidebar-review-badge-vacancy',
        canonicalUrl: 'https://example.invalid/jobs/sidebar-review-badge-vacancy',
        company: 'Example Company',
        role: 'Frontend Engineer',
        sourceCvId: cv.id,
        sourceCvContentHash: 'source-cv-content-hash',
        jdSnapshot: 'Build accessible product interfaces.',
        jdSnapshotHash: 'jd-content-hash',
        jdComplete: true,
        checkpoint: 'needs_user',
        checkpointDetail: 'Your application is ready for review.',
      });
    } finally {
      seeded.close();
    }

    const electronApp = await launchApp(userDataDir, { vacancyEngineDataRoot });
    try {
      const window = await electronApp.firstWindow();
      await window.waitForLoadState('domcontentloaded');
      await electronApp.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setBounds({ width: 1280, height: 720 });
      });
      const sidebar = window.getByRole('complementary', { name: 'Main' });
      const expand = sidebar.getByRole('button', { name: 'Expand sidebar' });
      if (await expand.isVisible()) await expand.click();
      const applications = sidebar.getByRole('button', { name: 'Applications, 1 to review' });
      await expect(applications).toBeVisible();
      await expect(applications.locator('span.truncate')).toBeVisible();

      for (const [name, theme] of [
        ['light', 'openvacancyradar'],
        ['dark', 'openvacancyradar-dark'],
      ] as const) {
        await window.evaluate((value) => {
          document.documentElement.dataset.theme = value;
        }, theme);
        const geometry = await applications.evaluate((button) => {
          const label = button.querySelector<HTMLElement>('span.truncate');
          const badge = button.querySelector<HTMLElement>('.badge-warning');
          if (!label || !badge) throw new Error('Review badge or Applications label missing');
          const buttonBox = button.getBoundingClientRect();
          const labelBox = label.getBoundingClientRect();
          const badgeBox = badge.getBoundingClientRect();
          return {
            labelFits: label.scrollWidth <= label.clientWidth,
            badgeFits: badge.scrollWidth <= badge.clientWidth,
            badgeOnOneLine: badgeBox.height <= labelBox.height + 2,
            insideButton: badgeBox.right <= buttonBox.right && badgeBox.left >= buttonBox.left,
          };
        });
        expect(geometry, `${name} theme sidebar layout`).toEqual({
          labelFits: true,
          badgeFits: true,
          badgeOnOneLine: true,
          insideButton: true,
        });
        const screenshotPath = test.info().outputPath(`sidebar-review-${name}.png`);
        await sidebar.screenshot({ path: screenshotPath });
        await test.info().attach(`sidebar-review-${name}`, { path: screenshotPath, contentType: 'image/png' });
      }
    } finally {
      await electronApp.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
