import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';
import { dismissWelcomeModalIfShown, expect, launchApp } from './fixtures.js';

test('damaged-cache banner keeps every action inside at supported window widths', async () => {
  test.setTimeout(120_000);
  const userDataDir = mkdtempSync(join(tmpdir(), 'ovr-damaged-cache-banner-'));
  const vacancyEngineDataRoot = join(userDataDir, 'vacancy-engine');
  cpSync(
    fileURLToPath(new URL('../../../packages/vacancy-engine/config', import.meta.url)),
    join(vacancyEngineDataRoot, 'config'),
    { recursive: true },
  );
  writeFileSync(join(userDataDir, 'vacancy-engine.db'), Buffer.alloc(8192, 0xab));

  try {
    const electronApp = await launchApp(userDataDir, { vacancyEngineDataRoot });
    try {
      const window = await electronApp.firstWindow();
      await window.waitForLoadState('domcontentloaded');
      await dismissWelcomeModalIfShown(window);
      const banner = window.getByRole('alert').filter({ hasText: 'Searching is not available right now.' });
      const actions = ['Rebuild job cache', 'Check again', 'Copy diagnostics'];
      for (const name of actions) await expect(banner.getByRole('button', { name })).toBeVisible();

      for (const width of [760, 1000, 1280]) {
        await electronApp.evaluate(({ BrowserWindow }, value) => {
          BrowserWindow.getAllWindows()[0]?.setBounds({ width: value, height: 720 });
        }, width);
        const geometry = await banner.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const buttons = [...element.querySelectorAll('button')].map((button) => {
            const rect = button.getBoundingClientRect();
            return rect.left >= bounds.left && rect.right <= bounds.right;
          });
          return { buttons, noHorizontalOverflow: element.scrollWidth <= element.clientWidth };
        });
        expect(geometry, `${width}px damaged-cache banner layout`).toEqual({
          buttons: [true, true, true],
          noHorizontalOverflow: true,
        });
        const screenshotPath = test.info().outputPath(`damaged-cache-banner-${width}.png`);
        await banner.screenshot({ path: screenshotPath });
        await test.info().attach(`damaged-cache-banner-${width}`, {
          path: screenshotPath,
          contentType: 'image/png',
        });
      }
    } finally {
      await electronApp.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
