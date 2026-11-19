import { cpSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { ensureLightTheme, launchApp } from './fixtures.js';
import { APPLY_COMPANY, APPLY_ROLE, applyWorkspaceReport } from './apply-workspace-seed.js';

/**
 * The whole audited first journey for #756/#757, in the real built app: Welcome > Upload CV, then
 * Search, then Apply, with no trip to the CV page. The AI tool is a deterministic stand-in on PATH
 * (`fixtures/stub-claude`), so every model answer is a fixture file rather than a live session, and
 * nothing reaches a network or an employer: the vacancy link is on the reserved `.invalid` domain
 * and a manual target is never submitted from here.
 *
 * What this proves that a unit test cannot: the real drawer, the real pipeline, the real Chromium
 * PDF render, and the real CV that comes out of them keeping its Skills and Languages sections.
 */
const STUB_CLAUDE_DIR = fileURLToPath(new URL('./fixtures/stub-claude', import.meta.url));
const WELCOME_CV_PATH = fileURLToPath(new URL('./fixtures/welcome-cv.txt', import.meta.url));

const EXPECTED_SKILLS = 'React, TypeScript, Accessibility';
const EXPECTED_LANGUAGES = 'English (native), Dutch (B2)';

interface AttemptView {
  id: string;
  checkpoint: string;
  checkpointDetail: string;
}

async function readAttempt(window: Page): Promise<AttemptView | undefined> {
  return window.evaluate(async () => {
    const bridge = (window as unknown as { workspace: { listApplicationAttempts(): Promise<AttemptView[]> } }).workspace;
    return (await bridge.listApplicationAttempts())[0];
  });
}

/**
 * The vacancy link is on the reserved `.invalid` domain, so the app can never check the posting
 * itself and asks the person instead (#720). Preparation stops there before it ever reaches
 * tailoring, so the journey has to answer it -- once before the CV review and once after it.
 */
async function confirmPostingWhenAsked(window: Page): Promise<void> {
  await expect
    .poll(async () => (await readAttempt(window))?.checkpoint ?? '', { timeout: 120_000 })
    .toBe('needs_user');
  const attempt = await readAttempt(window);
  if (!attempt?.checkpointDetail.includes("confirm it's open")) return;
  const itsOpen = window.getByRole('button', { name: "It's open" });
  await expect(itsOpen).toBeVisible({ timeout: 60_000 });
  await itsOpen.click();
  await expect
    .poll(async () => (await readAttempt(window))?.checkpointDetail ?? '', { timeout: 120_000 })
    .not.toContain("confirm it's open");
}

test('Welcome upload reaches a tailored CV through the Apply review, with Skills and Languages kept', async () => {
  test.setTimeout(300_000);
  const userDataDir = await mkdtemp(join(tmpdir(), 'ovr-welcome-apply-'));
  const vacancyEngineDataRoot = await mkdtemp(join(tmpdir(), 'ovr-welcome-apply-engine-'));
  try {
    const reportDirectory = join(vacancyEngineDataRoot, 'reports', 'global-remote');
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(join(reportDirectory, 'latest.json'), JSON.stringify(applyWorkspaceReport()), 'utf8');
    // The same shipped candidate-profile config the `electronApp` fixture copies in: saving what
    // the person is looking for writes next to it.
    cpSync(fileURLToPath(new URL('../../../packages/vacancy-engine/config', import.meta.url)), join(vacancyEngineDataRoot, 'config'), {
      recursive: true,
    });

    const electronApp = await launchApp(userDataDir, {
      appId: `ovr-e2e-welcome-apply-${process.pid}`,
      vacancyEngineDataRoot,
      extraEnv: { PATH: `${STUB_CLAUDE_DIR}${delimiter}${process.env.PATH ?? ''}` },
    });
    try {
      const window = await electronApp.firstWindow();
      await window.waitForLoadState('domcontentloaded');
      await electronApp.evaluate(({ dialog }, filePath) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
      }, WELCOME_CV_PATH);

      // ---------------------------------------------------------------- Welcome: upload the CV
      const welcome = window.getByRole('dialog', { name: 'Welcome to Open Vacancy Radar' });
      await expect(welcome).toBeVisible({ timeout: 30_000 });
      await welcome.getByRole('button', { name: /^upload cv$/i }).click();
      await welcome.getByRole('button', { name: /save to cv library/i }).click();

      // Welcome's own AI-assisted fill of what the person is looking for, then back to the checklist.
      const fillDrawer = window.getByRole('dialog', { name: 'Fill from CV' });
      await expect(fillDrawer).toBeVisible({ timeout: 60_000 });
      try {
        await expect(fillDrawer.getByLabel('Strongest skills')).toHaveValue(/React/, { timeout: 60_000 });
      } catch (error) {
        console.log('FILL DRAWER:', (await fillDrawer.innerText()).slice(0, 1200));
        throw error;
      }
      await fillDrawer.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(fillDrawer).toHaveCount(0);
      await welcome.getByRole('button', { name: /^(done|skip for now)$/i }).click();
      await expect(welcome).toHaveCount(0);
      await ensureLightTheme(window);

      // ------------------------------------------------------------------- Search, then Apply
      const sidebar = window.getByRole('complementary', { name: 'Main' });
      await sidebar.getByRole('button', { name: 'Search', exact: true }).click();
      await window.getByRole('button', { name: 'Apply', exact: true }).click();
      const workspace = window.getByRole('region', { name: `${APPLY_ROLE} at ${APPLY_COMPANY}` });
      await expect(workspace).toBeVisible();

      await confirmPostingWhenAsked(window);

      // #756: the Welcome CV has no reviewed source yet, and the page says so with a working button.
      await expect(workspace.getByText('Your CV has not been reviewed yet, so it could not be tailored.')).toBeVisible({
        timeout: 120_000,
      });
      await expect(workspace.getByRole('button', { name: /try again/i })).toHaveCount(0);
      await workspace.getByRole('button', { name: 'Review this CV' }).click();

      // The review reads the CV in place; #757: it fills Skills and Languages, not just the records.
      const drawer = window.getByRole('dialog', { name: 'Edit CV' });
      await expect(drawer).toBeVisible();
      // The read starts on its own. A provider session that fails to start is retried from the
      // drawer's own button, exactly as a person would, rather than failing the journey.
      const records = drawer.getByText('Northwind Software', { exact: false });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await expect(records).toBeVisible({ timeout: 60_000 });
          break;
        } catch (error) {
          if (attempt === 2) {
            console.log('EDIT CV DRAWER:', (await drawer.innerText()).slice(0, 1500));
            throw error;
          }
          await drawer.getByRole('button', { name: /read my (full )?cv( again)?/i }).click();
        }
      }
      await expect(drawer.getByLabel('Skills')).toHaveValue(/React/, { timeout: 120_000 });
      await expect(drawer.getByLabel('Languages')).toHaveValue(EXPECTED_LANGUAGES);
      // Derived from the most recent reviewed role, not re-read by a second model pass.
      await expect(drawer.getByLabel('Title', { exact: true })).toHaveValue('Senior Frontend Engineer');
      await expect(drawer.getByLabel('Location', { exact: true })).toHaveCount(1);
      await expect(drawer.getByTestId('cv-drawer-skills-missing')).toHaveCount(0);
      await drawer.getByRole('button', { name: 'Confirm and save' }).click();
      await expect(drawer).toHaveCount(0);

      await confirmPostingWhenAsked(window);

      // ------------------------------------------------------- the documents the pipeline produced
      await expect(workspace.getByRole('region', { name: 'Your documents' })).toBeVisible({ timeout: 180_000 });
      const attempt = (await readAttempt(window))!;
      expect(attempt.checkpointDetail).not.toContain('no reviewed source record');
      expect(attempt.checkpointDetail).not.toContain('without any skills');

      const artifactRoot = join(userDataDir, 'application-artifacts', attempt.id);
      const files = (await readdir(artifactRoot)).filter((file) => file.endsWith('.pdf'));
      expect(files.length, `PDFs under ${artifactRoot}`).toBeGreaterThan(0);
      const { extractText } = await import('unpdf');
      const texts: string[] = [];
      for (const file of files) {
        const { text } = await extractText(new Uint8Array(await readFile(join(artifactRoot, file))), { mergePages: true });
        texts.push(text.replace(/\s+/gu, ' '));
      }
      // The template upper-cases headings with CSS, so the extracted text reads "SKILLS".
      const cvText = texts.find((text) => new RegExp(`SKILLS ${EXPECTED_SKILLS}`, 'iu').test(text));
      expect(cvText, `a tailored CV PDF with a Skills section among: ${texts.join(' || ')}`).toBeDefined();
      expect(cvText).toMatch(new RegExp(`LANGUAGES ${EXPECTED_LANGUAGES.replace(/[()]/gu, '\\$&')}`, 'iu'));
      expect(cvText).toMatch(/Jordan Rivers/u);
      expect(cvText).toMatch(/Northwind Software/u);
    } finally {
      await electronApp.close();
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    await rm(vacancyEngineDataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
