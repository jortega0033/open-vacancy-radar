import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { expect, goto, launchApp, test } from './fixtures.js';

test.describe('Settings', () => {
  test('theme and density apply to the document immediately, with no reload', async ({ window }) => {
    await goto(window, 'Settings');

    await window.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark' }).click();
    await expect(window.locator('html')).toHaveAttribute('data-theme', 'openvacancyradar-dark');

    await window.getByRole('group', { name: 'Density' }).getByRole('button', { name: 'Compact' }).click();
    await expect(window.locator('html')).toHaveAttribute('data-density', 'compact');
  });

  test('settings persist across a full app relaunch', async () => {
    // Every setting change here is saved to the embedded workspace SQLite file the moment it's
    // made (SettingsPage's subtitle says as much: "Saved automatically to local data") — this
    // confirms that promise across a real process restart, not just within one running instance.
    // This test can't use the `electronApp` fixture (it needs to close and relaunch mid-test
    // against the same user-data dir), so it calls `launchApp` directly and is responsible for its
    // own cleanup — both processes are closed in `finally`, not just after each succeeds, so a
    // failing assertion between launches can't leave one running on the CI runner.
    const userDataDir = mkdtempSync(join(tmpdir(), 'ovr-e2e-settings-'));
    let first: ElectronApplication | undefined;
    let second: ElectronApplication | undefined;
    try {
      first = await launchApp(userDataDir);
      const firstWindow = await first.firstWindow();
      await firstWindow.waitForLoadState('domcontentloaded');

      await goto(firstWindow, 'Settings');
      await firstWindow.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark' }).click();
      await expect(firstWindow.locator('html')).toHaveAttribute('data-theme', 'openvacancyradar-dark');
      await first.close();
      first = undefined;

      second = await launchApp(userDataDir);
      const secondWindow = await second.firstWindow();
      await secondWindow.waitForLoadState('domcontentloaded');

      // The setting is applied on load before the user navigates anywhere, so this alone proves
      // it round-tripped through the database rather than being process-local state.
      await expect(secondWindow.locator('html')).toHaveAttribute('data-theme', 'openvacancyradar-dark');
      await goto(secondWindow, 'Settings');
      await expect(
        secondWindow.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark' }),
      ).toHaveAttribute('aria-pressed', 'true');

      await second.close();
      second = undefined;
    } finally {
      await first?.close().catch(() => {});
      await second?.close().catch(() => {});
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
