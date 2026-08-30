import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, test as base, type ElectronApplication, type Page } from '@playwright/test';

const MAIN_ENTRY = fileURLToPath(new URL('../dist-electron/main.js', import.meta.url));

interface Fixtures {
  electronApp: ElectronApplication;
  window: Page;
}

/**
 * Launches the real built app once per test against a fresh, throwaway `--user-data-dir` — the
 * same Chromium flag Electron itself reads for `app.getPath('userData')`, so every test gets an
 * empty embedded-SQLite workspace and never touches a developer's real local data or another
 * test's. The daemon spawns too (`electron/main.ts`'s `spawnDaemon`), same as a real launch; tests
 * that don't touch AI features never need to wait on or care about it.
 */
export const test = base.extend<Fixtures>({
  // eslint-disable-next-line no-empty-pattern
  electronApp: async ({}, use) => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'ovr-e2e-'));
    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, '--disable-gpu'],
    });
    await use(app);
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
  },

  window: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await use(page);
  },
});

export { expect } from '@playwright/test';

/**
 * Selects a sidebar destination by its accessible name (`AppSidebar`'s `NavGroup` sets
 * `aria-label={item.label}` on every nav button — "Search", "Saved Jobs", "Applications", "CV",
 * "Letters", "AI Runtime", "Settings").
 */
export async function goto(window: Page, label: string): Promise<void> {
  await window.getByRole('button', { name: label, exact: true }).click();
}

/**
 * Forces the Light theme before a screenshot. The default theme setting is `'system'`, which
 * follows the OS/CI-runner preference live — without this, the same test could snapshot a light
 * or dark UI depending on where it runs, which is noise, not a real regression.
 */
export async function ensureLightTheme(window: Page): Promise<void> {
  await goto(window, 'Settings');
  await window.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Light' }).click();
}
