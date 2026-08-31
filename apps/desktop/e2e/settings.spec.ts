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
    // made (SettingsPage's subtitle says as much: "Saved automatically to local data"). This
    // confirms that promise across a real process restart, not just within one running instance.
    // This test can't use the `electronApp` fixture (it needs to close and relaunch mid-test
    // against the same user-data dir), so it calls `launchApp` directly and is responsible for its
    // own cleanup: both processes are closed in `finally`, not just after each succeeds, so a
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

  test('reset settings restores schema defaults, behind a confirm dialog', async ({ window }) => {
    // Schema defaults (SettingsPage.tsx's `SETTINGS_DEFAULTS`, mirroring electron/workspace/schema.ts):
    // theme 'system' and density 'comfortable'. `theme.ts`'s `applyTheme`/`applyDensity` remove the
    // `data-theme`/`data-density` attributes entirely for those defaults rather than naming them, so
    // "the attribute is absent" *is* the documented default state, not just one more value to check.
    //
    // The Theme/Density buttons must be clicked through the real UI, not seeded via a direct
    // `workspace.updateSettings` IPC call: `applyTheme`/`applyDensity` (which set the
    // `data-theme`/`data-density` attributes this test asserts on) are only ever invoked as a side
    // effect of SettingsPage's own `changeField` handler (or App.tsx's mount effect) -- updating
    // the underlying settings row alone would leave those attributes at their prior state, since
    // nothing reactively re-applies them just because the database changed underneath the app.
    await goto(window, 'Settings');
    await window.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark' }).click();
    await expect(window.locator('html')).toHaveAttribute('data-theme', 'openvacancyradar-dark');
    await window.getByRole('group', { name: 'Density' }).getByRole('button', { name: 'Compact' }).click();
    await expect(window.locator('html')).toHaveAttribute('data-density', 'compact');

    await window.getByRole('button', { name: 'Reset settings' }).click();
    const confirm = window.getByRole('alertdialog');
    await expect(confirm).toContainText(/reset settings\?/i);
    await confirm.getByRole('button', { name: 'Reset settings' }).click();

    const toast = window.getByRole('status').filter({ hasText: 'Settings reset' });
    await expect(toast).toBeVisible();

    await expect(window.locator('html')).not.toHaveAttribute('data-theme');
    await expect(window.locator('html')).not.toHaveAttribute('data-density');
    await expect(
      window.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'System' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      window.getByRole('group', { name: 'Density' }).getByRole('button', { name: 'Comfortable' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });
});
