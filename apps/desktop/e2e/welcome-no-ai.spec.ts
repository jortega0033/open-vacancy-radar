import { cpSync, existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { FAKE_CV_FILE, FAKE_CV_TEXT } from './fake-claude.js';
import { launchApp } from './fixtures.js';

/**
 * Welcome's CV step with no AI CLI installed at all (#767): the acceptance of that issue, against
 * the real built app. Unlike `welcome-to-apply.spec.ts`, no stand-in CLI is put on PATH; on top of
 * that, every PATH entry that holds a real `claude`/`codex` (a developer machine, or WSL's Windows
 * interop) is dropped from the app's PATH, so the daemon genuinely finds no AI tool -- the audited
 * machine state. On CI, where no CLI exists, the filter is a no-op.
 *
 * Saving the CV must never start a provider session or show a red error. The drawer names the real
 * cause and offers manual entry, which reaches the review form and saves, landing on Search with
 * the typed target role (#764's one-review-Save exit).
 */
test('Welcome with no AI CLI: CV saves, no session starts, manual entry saves and lands on Search', async () => {
  test.setTimeout(180_000);
  const userDataDir = await mkdtemp(join(tmpdir(), 'ovr-welcome-no-ai-'));
  // An isolated engine root, like welcome-to-apply.spec.ts: the profile this test saves must land
  // in a throwaway copy of the engine config, never in the repo's own.
  const vacancyEngineDataRoot = await mkdtemp(join(tmpdir(), 'ovr-welcome-no-ai-engine-'));
  cpSync(fileURLToPath(new URL('../../../packages/vacancy-engine/config', import.meta.url)), join(vacancyEngineDataRoot, 'config'), {
    recursive: true,
  });
  const cvPath = join(userDataDir, FAKE_CV_FILE);
  await writeFile(cvPath, FAKE_CV_TEXT, 'utf8');

  const originalPath = process.env.PATH ?? '';
  process.env.PATH = originalPath
    .split(':')
    .filter((dir) => dir && !existsSync(join(dir, 'claude')) && !existsSync(join(dir, 'codex')))
    .join(':');
  let electronApp;
  try {
    electronApp = await launchApp(userDataDir, { appId: `ovr-e2e-welcome-no-ai-${process.pid}`, vacancyEngineDataRoot });
  } finally {
    process.env.PATH = originalPath;
  }
  try {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await electronApp.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, cvPath);

    const welcome = window.getByRole('dialog', { name: 'Welcome to Open Vacancy Radar' });
    await expect(welcome).toBeVisible({ timeout: 30_000 });
    // The checklist itself knows the tool is missing. The daemon's first answer right after
    // start-up can be slow or transiently wrong under e2e (same caveat as welcome-to-apply.spec),
    // so press Check again the way a person would until the status settles.
    const notInstalled = welcome.getByText('Claude Code is not installed yet.');
    for (let attempt = 0; attempt < 12 && (await notInstalled.count()) === 0; attempt += 1) {
      const checkAgain = welcome.getByRole('button', { name: 'Check again' });
      if (await checkAgain.isEnabled({ timeout: 2_000 }).catch(() => false)) await checkAgain.click({ timeout: 5_000 });
      await window.waitForTimeout(5_000);
    }
    await expect(notInstalled).toBeVisible();

    await welcome.getByRole('button', { name: /^upload cv$/i }).click();
    const fill = window.getByRole('dialog', { name: 'Fill from CV' });
    await expect(fill).toBeVisible({ timeout: 15_000 });

    // The honest state: cause named, no red error, no retry that cannot work.
    await expect(fill.getByText("No AI tool connected, so your details can't be filled in automatically.")).toBeVisible({
      timeout: 30_000,
    });
    await expect(fill.getByRole('alert')).toHaveCount(0);
    await expect(fill.getByText(/this time/i)).toHaveCount(0);
    await expect(fill.getByRole('button', { name: 'Read CV', exact: true })).toHaveCount(0);
    await expect(fill.getByRole('button', { name: 'Set up an AI tool' })).toBeVisible();
    await expect(fill.getByRole('button', { name: 'Skip', exact: true })).toBeVisible();

    // Manual entry reaches the same review form, and Save is reachable without an AI tool.
    await fill.getByRole('button', { name: 'Fill these in myself' }).click();
    const role = fill.getByLabel('Current role');
    await expect(role).toBeVisible();
    await role.fill('Frontend Engineer');
    await fill.getByLabel('Target roles').fill('Senior Frontend Engineer');
    await fill.getByRole('button', { name: 'Save', exact: true }).click();

    // One review Save finishes Welcome (#764) and lands on Search with the saved role.
    await expect(fill).toHaveCount(0, { timeout: 30_000 });
    await expect(welcome).toHaveCount(0);
    await expect(window.getByRole('searchbox', { name: 'Role or keywords' })).toHaveValue('Senior Frontend Engineer', {
      timeout: 15_000,
    });
    await expect(window.getByRole('button', { name: 'Search for Senior Frontend Engineer' })).toBeVisible();

    // The CV really is in the library.
    await window.getByRole('complementary', { name: 'Main' }).getByRole('button', { name: 'CV', exact: true }).click();
    await expect(window.getByText(FAKE_CV_FILE).first()).toBeVisible({ timeout: 15_000 });
  } finally {
    await electronApp.close();
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    await rm(vacancyEngineDataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
