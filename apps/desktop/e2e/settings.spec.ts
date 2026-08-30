import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from '@playwright/test';
import { expect, goto, test } from './fixtures.js';

const MAIN_ENTRY = fileURLToPath(new URL('../dist-electron/main.js', import.meta.url));

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
    const userDataDir = mkdtempSync(join(tmpdir(), 'ovr-e2e-settings-'));
    try {
      const first = await electron.launch({ args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, '--disable-gpu'] });
      const firstWindow = await first.firstWindow();
      await firstWindow.waitForLoadState('domcontentloaded');

      await firstWindow.getByRole('button', { name: 'Settings', exact: true }).click();
      await firstWindow.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark' }).click();
      await expect(firstWindow.locator('html')).toHaveAttribute('data-theme', 'openvacancyradar-dark');
      await first.close();

      const second = await electron.launch({ args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, '--disable-gpu'] });
      const secondWindow = await second.firstWindow();
      await secondWindow.waitForLoadState('domcontentloaded');

      // The setting is applied on load before the user navigates anywhere, so this alone proves
      // it round-tripped through the database rather than being process-local state.
      await expect(secondWindow.locator('html')).toHaveAttribute('data-theme', 'openvacancyradar-dark');
      await secondWindow.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(
        secondWindow.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark' }),
      ).toHaveAttribute('aria-pressed', 'true');

      await second.close();
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
