import { cpSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Locator } from '@playwright/test';
import { launchApp } from './fixtures.js';
import { APPLY_COMPANY, APPLY_ROLE, applyWorkspaceReport } from './apply-workspace-seed.js';
import { FAKE_CV_FILE, FAKE_CV_TEXT, FAKE_LANGUAGES, FAKE_SKILLS, installFakeClaude } from './fake-claude.js';

/**
 * The audited first-application journey end to end (#756, #757): a fresh install, Welcome > Upload
 * CV > Save, Search > Apply. The AI steps answer through the stand-in CLI in `fake-claude.ts`, so the
 * run is deterministic and spends nothing. Apply first stops because the uploaded CV was never
 * reviewed; the page offers that review in place, the read fills Skills and Languages, Save restarts
 * preparation for the same job, and the rendered CV PDF carries both sections. The employer link is
 * on the reserved `.invalid` domain and the app never submits for a manual target.
 */
test('Welcome upload, Search, Apply: one in-place review, then a tailored CV with Skills and Languages', async () => {
  test.setTimeout(300_000);
  const userDataDir = await mkdtemp(join(tmpdir(), 'ovr-welcome-apply-'));
  const vacancyEngineDataRoot = await mkdtemp(join(tmpdir(), 'ovr-welcome-apply-engine-'));
  const reportDirectory = join(vacancyEngineDataRoot, 'reports', 'global-remote');
  await mkdir(reportDirectory, { recursive: true });
  // The search profile Welcome saves lives under the engine's config root, like the shared fixture seeds it.
  cpSync(fileURLToPath(new URL('../../../packages/vacancy-engine/config', import.meta.url)), join(vacancyEngineDataRoot, 'config'), {
    recursive: true,
  });
  await writeFile(join(reportDirectory, 'latest.json'), JSON.stringify(applyWorkspaceReport()), 'utf8');
  const cvPath = join(userDataDir, FAKE_CV_FILE);
  await writeFile(cvPath, FAKE_CV_TEXT, 'utf8');
  // `OVR_E2E_FAKE_CLAUDE_LOG` (test-runner side only) records what the stand-in was asked, for debugging.
  const fakeClaudeDir = await installFakeClaude(process.env.OVR_E2E_FAKE_CLAUDE_LOG ? { logPath: process.env.OVR_E2E_FAKE_CLAUDE_LOG } : {});

  const originalPath = process.env.PATH ?? '';
  process.env.PATH = `${fakeClaudeDir}:${originalPath}`;
  let electronApp;
  try {
    electronApp = await launchApp(userDataDir, { appId: `ovr-e2e-welcome-apply-${process.pid}`, vacancyEngineDataRoot });
  } finally {
    process.env.PATH = originalPath;
  }
  try {
    await runJourney(electronApp, userDataDir, cvPath);
  } finally {
    await electronApp.close();
    if (process.env.OVR_E2E_FAKE_CLAUDE_LOG) {
      // Debug mode: leave the workspace (daemon log included) on disk and say where it is.
      console.log(`welcome-to-apply: kept ${userDataDir}`);
    } else {
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
    await rm(vacancyEngineDataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    await rm(fakeClaudeDir, { recursive: true, force: true });
  }
});

/**
 * Waits for an AI read to land (`ready` enabled or visible). The daemon occasionally reports the
 * stand-in as not installed right after start-up; a person would simply press the read button again,
 * so this does the same, a bounded number of times.
 */
async function waitForRead(scope: Locator, ready: Locator, readAgain: Locator): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const failed = scope.getByText(/Could not read your CV this time|executable not found|not installed/iu);
    await expect
      .poll(async () => ((await ready.count()) > 0 && (await ready.isEnabled().catch(() => false))) || (await failed.count()) > 0, {
        timeout: 60_000,
      })
      .toBe(true);
    if ((await failed.count()) === 0) return;
    await readAgain.click();
  }
  await expect(ready).toBeEnabled();
}

async function runJourney(electronApp: ElectronApplication, userDataDir: string, cvPath: string): Promise<void> {
  const mainLines: string[] = [];
  const keep = (chunk: Buffer | string) => {
    for (const line of String(chunk).split('\n')) if (line.trim()) mainLines.push(line.slice(0, 400));
    if (mainLines.length > 600) mainLines.splice(0, mainLines.length - 600);
  };
  electronApp.process().stdout?.on('data', keep);
  electronApp.process().stderr?.on('data', keep);
  try {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await electronApp.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, cvPath);

    // Welcome (#764): pick the file (saved at once), let "Fill from CV" read it, one review Save lands on Search.
    const welcome = window.getByRole('dialog', { name: 'Welcome to Open Vacancy Radar' });
    await expect(welcome).toBeVisible({ timeout: 15_000 });
    // The checklist checks the AI tool once, on open, usually before the daemon has finished starting;
    // a person presses Check again. The item disappears once the tool is ready.
    const runtimeItem = welcome.getByText('Connect your AI tool');
    for (let attempt = 0; attempt < 12 && (await runtimeItem.count()) > 0; attempt += 1) {
      const checkAgain = welcome.getByRole('button', { name: 'Check again' });
      if (await checkAgain.isEnabled().catch(() => false)) await checkAgain.click();
      await window.waitForTimeout(5_000);
    }
    await expect(runtimeItem).toHaveCount(0);
    await welcome.getByRole('button', { name: /^upload cv$/i }).click();
    const fill = window.getByRole('dialog', { name: 'Fill from CV' });
    await expect(fill).toBeVisible({ timeout: 15_000 });
    const saveProfile = fill.getByRole('button', { name: 'Save', exact: true });
    await waitForRead(fill, saveProfile, fill.getByRole('button', { name: 'Read CV', exact: true }));
    await saveProfile.click();
    await expect(fill).toHaveCount(0, { timeout: 30_000 });
    await expect(welcome).toHaveCount(0);

    // Search > Apply, straight from Welcome. No visit to the CV page.
    const sidebar = window.getByRole('complementary', { name: 'Main' });
    await sidebar.getByRole('button', { name: 'Search', exact: true }).click();
    await window.getByRole('button', { name: 'Apply', exact: true }).click();
    const workspace = window.getByRole('region', { name: `${APPLY_ROLE} at ${APPLY_COMPANY}` });
    await expect(workspace).toBeVisible();

    // The reserved domain cannot be checked, so the person confirms the posting is open (#720).
    const itsOpen = window.getByRole('button', { name: "It's open" });
    await expect(itsOpen).toBeVisible({ timeout: 60_000 });
    await itsOpen.click();

    // The uploaded CV was never reviewed: the page says so once and offers the review, never a futile retry.
    const review = workspace.getByRole('button', { name: 'Review this CV' });
    await expect(review).toBeVisible({ timeout: 90_000 });
    await expect(workspace.getByText('Your CV has not been reviewed yet, so it could not be tailored.')).toBeVisible();
    await expect(workspace.getByRole('button', { name: /try again/i })).toHaveCount(0);

    // The review reads the CV into records and completes the profile; the person confirms.
    await review.click();
    const drawer = window.getByRole('dialog', { name: 'Edit CV' });
    await expect(drawer).toBeVisible();
    await waitForRead(drawer, drawer.getByText('Redwood Software', { exact: false }), drawer.getByRole('button', { name: 'Read my full CV' }));
    await expect(drawer.getByLabel('Skills')).toHaveValue(FAKE_SKILLS.join(', '), { timeout: 60_000 });
    await expect(drawer.getByLabel('Languages')).toHaveValue(FAKE_LANGUAGES);
    await expect(drawer.getByLabel('Title', { exact: true })).toHaveValue('Frontend Developer');
    await expect(drawer.getByLabel('Location', { exact: true })).toHaveCount(1);
    await expect(drawer.getByTestId('cv-drawer-skills-missing')).toHaveCount(0);
    await drawer.getByRole('button', { name: 'Confirm and save' }).click();
    await expect(drawer).toHaveCount(0);

    // Same application, now prepared: both documents, and the CV keeps its Skills and Languages.
    await expect(workspace.getByRole('status').first()).toContainText('Your CV and letter are ready.', { timeout: 120_000 });
    await expect(workspace.getByText('Ready to review')).toBeVisible();
    const documents = workspace.getByRole('region', { name: 'Your documents' });
    await expect(documents.getByRole('button', { name: 'Open Tailored CV' })).toBeVisible();
    await expect(workspace.getByRole('alert', { name: 'Your CV lists no skills' })).toHaveCount(0);

    const attemptId = await window.evaluate(async () => {
      const bridge = (window as unknown as { workspace: { listApplicationAttempts(): Promise<{ id: string }[]> } }).workspace;
      const attempts = await bridge.listApplicationAttempts();
      return attempts[0]?.id ?? null;
    });
    expect(attemptId).not.toBeNull();
    const artifactRoot = join(userDataDir, 'application-artifacts', attemptId!);
    const files = (await readdir(artifactRoot)).filter((file) => file.endsWith('.pdf'));
    const { extractText } = await import('unpdf');
    const texts: string[] = [];
    for (const file of files) {
      const { text } = await extractText(new Uint8Array(await readFile(join(artifactRoot, file))), { mergePages: true });
      texts.push(text.replace(/\s+/gu, ' '));
    }
    // Headings are upper-cased by the template's CSS. Skills come back in the tailored order.
    const cvText = texts.find((text) => /SKILLS TypeScript, React, Playwright/iu.test(text));
    expect(cvText, `a tailored CV PDF with a Skills section among: ${texts.join(' || ')}`).toBeDefined();
    expect(cvText).toMatch(new RegExp(`LANGUAGES ${FAKE_LANGUAGES.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'iu'));
    expect(cvText).toMatch(/EXPERIENCE Frontend Developer, Redwood Software/iu);
  } catch (error) {
    if (process.env.OVR_E2E_FAKE_CLAUDE_LOG) {
      console.log(`welcome-to-apply: main process tail\n${mainLines.filter((line) => /session|claude|provider|error|warn|which/iu.test(line)).slice(-40).join('\n')}`);
    }
    throw error;
  }
}
