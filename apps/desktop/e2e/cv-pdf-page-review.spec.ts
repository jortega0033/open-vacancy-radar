import { appendFileSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { ensureLightTheme, launchApp } from './fixtures.js';
import { PDF_REVIEW_CASE_LABEL, PDF_REVIEW_EXPORT_NAME, seedPdfReviewCase } from './seed-pdf-review-case.js';

/**
 * Reading a saved PDF inside the app (#434), in the real built app. The case is seeded through the
 * repository before launch (`seed-pdf-review-case.ts`); everything after launch is the real UI and the
 * real main process, including the real Chromium PDF renderer for the export and the real pdf.js draw
 * in the renderer under its own Content-Security-Policy. Only the save dialog and `shell.openPath` are
 * stubbed, because there is no native dialog or viewer to drive in CI.
 */

interface WorkspaceBridge {
  listCvEvidenceOverlays(cvId: string): Promise<{ id: string; artifacts: { artifactId: string }[] }[]>;
  confirmCvArtifact(overlayId: string, artifactId: string): Promise<unknown>;
}

const EXPORT_TIMEOUT = { timeout: 20_000 };

interface Session {
  electronApp: ElectronApplication;
  window: Page;
  saveDir: string;
  cvId: string;
  overlayId: string;
  consoleProblems: string[];
}

async function withSeededApp(body: (session: Session) => Promise<void>): Promise<void> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'ovr-e2e-pdfreview-'));
  const saveDir = await mkdtemp(join(tmpdir(), 'ovr-e2e-pdfreview-out-'));
  const { cvId, overlayId } = seedPdfReviewCase(userDataDir);
  const electronApp = await launchApp(userDataDir, { appId: `ovr-e2e-pdf-review-${process.pid}` });
  try {
    const window = await electronApp.firstWindow();
    const consoleProblems: string[] = [];
    window.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') consoleProblems.push(message.text());
    });
    window.on('pageerror', (error) => consoleProblems.push(error.message));
    await window.waitForLoadState('domcontentloaded');
    await ensureLightTheme(window);
    await body({ electronApp, window, saveDir, cvId, overlayId, consoleProblems });
  } finally {
    await electronApp.close();
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    await rm(saveDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function stubNativeSurfaces(electronApp: ElectronApplication, saveDir: string) {
  await electronApp.evaluate(
    ({ dialog, shell }, dir) => {
      const record = globalThis as unknown as { __opened: string[] };
      record.__opened = [];
      dialog.showSaveDialog = (async (_window: unknown, options: { defaultPath: string }) => ({
        canceled: false,
        filePath: `${dir}/${options.defaultPath}`,
      })) as unknown as typeof dialog.showSaveDialog;
      shell.openPath = async (path: string) => {
        record.__opened.push(path);
        return '';
      };
    },
    saveDir,
  );
}

const openedInViewer = (electronApp: ElectronApplication) =>
  electronApp.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened);

async function exportPdf(window: Page, electronApp: ElectronApplication, saveDir: string): Promise<{ pdf: Locator; pdfPath: string; pages: number }> {
  await window.getByRole('complementary', { name: 'Main' }).getByRole('button', { name: 'CV', exact: true }).click();
  await window.getByRole('button', { name: `Open ${PDF_REVIEW_CASE_LABEL}` }).click();
  const panel = window.getByRole('region', { name: 'Exported files' });
  await panel.scrollIntoViewIfNeeded();
  const pdf = panel.getByLabel('PDF file', { exact: true });
  await stubNativeSurfaces(electronApp, saveDir);
  await pdf.getByRole('button', { name: 'Export as PDF' }).click();
  await expect(pdf.getByRole('status').first()).toHaveText('Exported, waiting for your review', EXPORT_TIMEOUT);
  const text = (await pdf.innerText()).match(/(\d+) pages?\b/);
  expect(text, 'the saved PDF reports its page count').not.toBeNull();
  const pages = Number(text![1]);
  return { pdf, pdfPath: `${saveDir}/${PDF_REVIEW_EXPORT_NAME}.pdf`, pages };
}

/** Scrolls the page list a screen at a time until the end, as a candidate reading it would. */
async function scrollToEnd(region: Locator): Promise<void> {
  await region.evaluate(async (element) => {
    for (let top = 0; top <= element.scrollHeight; top += Math.max(element.clientHeight / 2, 50)) {
      element.scrollTo({ top });
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    element.scrollTo({ top: element.scrollHeight });
  });
}

/** How many canvases hold painted pixels (anything that is not blank white). */
const paintedCanvases = (window: Page) =>
  window.evaluate(() => {
    let painted = 0;
    for (const canvas of document.querySelectorAll<HTMLCanvasElement>('canvas[data-drawn="true"]')) {
      const context = canvas.getContext('2d');
      if (!context || canvas.width === 0 || canvas.height === 0) continue;
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! < 200 || data[i + 1]! < 200 || data[i + 2]! < 200) {
          painted += 1;
          break;
        }
      }
    }
    return painted;
  });

test('the pages are drawn in the panel by the real renderer, and confirming waits for the last one', async () => {
  test.setTimeout(120_000);
  await withSeededApp(async ({ electronApp, window, saveDir, cvId, overlayId, consoleProblems }) => {
    const { pdf, pdfPath, pages } = await exportPdf(window, electronApp, saveDir);
    expect(pages, 'the seeded CV runs to more than one page').toBeGreaterThan(1);

    const confirm = pdf.getByRole('button', { name: 'I read every page and it looks right' });
    await expect(confirm).toBeDisabled();

    // The system viewer is a second way to look. Opening it records that the app launched it and
    // nothing more: confirming stays locked.
    await pdf.getByRole('button', { name: 'Open in my PDF viewer' }).click();
    await expect.poll(() => openedInViewer(electronApp)).toEqual([pdfPath]);
    await expect(confirm).toBeDisabled();

    // The main process refuses the confirmation itself, whatever the page's buttons say.
    const artifactId = await window.evaluate(
      async ({ cv, overlay }) => {
        const cases = await (globalThis as unknown as { workspace: WorkspaceBridge }).workspace.listCvEvidenceOverlays(cv);
        return cases.find((entry) => entry.id === overlay)!.artifacts.at(-1)!.artifactId;
      },
      { cv: cvId, overlay: overlayId },
    );
    const early = await window.evaluate(
      async ({ id, artifact }) => {
        const bridge = () => (globalThis as unknown as { workspace: WorkspaceBridge }).workspace;
        try {
          await bridge().confirmCvArtifact(id, artifact);
          return 'accepted';
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      },
      { id: overlayId, artifact: artifactId },
    );
    expect(early).toMatch(/read every page of the PDF in the app/);

    // Show the pages: the first is drawn, the rest wait until they scroll into view.
    await pdf.getByRole('button', { name: 'Show the pages here' }).click();
    const region = pdf.getByRole('region', { name: 'PDF pages' });
    await expect(region).toBeVisible();
    await expect(region.locator('figure')).toHaveCount(pages);
    await expect(pdf.getByLabel('Pages shown')).toContainText(`of ${pages}`);
    await expect.poll(() => paintedCanvases(window)).toBeGreaterThanOrEqual(1);
    await expect(confirm).toBeDisabled();
    expect(await region.locator('canvas[data-drawn="true"]').count(), 'later pages are not drawn before they are reached').toBeLessThan(pages);

    await scrollToEnd(region);
    await expect(region.locator('canvas[data-drawn="true"]')).toHaveCount(pages);
    await expect(region.getByText('Extracted text', { exact: true }), 'every page offers its text').toHaveCount(pages);
    expect(await paintedCanvases(window), 'every page has real pixels, not a blank canvas').toBe(pages);
    await expect(confirm).toBeEnabled();
    await expect(pdf.getByLabel('Pages shown')).toHaveText(`All ${pages} ${pages === 1 ? 'page was' : 'pages were'} shown.`);

    await confirm.click();
    await expect(pdf.getByRole('status').first()).toHaveText('Accepted');

    // pdf.js ran under the renderer's own policy: no blocked worker, font or script.
    expect(consoleProblems.filter((message) => /content security policy|refused to|worker|pdf\.js|pdfjs/i.test(message))).toEqual([]);
    // The file on disk was only read, never changed.
    expect(readFileSync(pdfPath).subarray(0, 4).toString()).toBe('%PDF');
  });
});

test('a file that changed on disk after export is not shown and cannot be accepted', async () => {
  test.setTimeout(90_000);
  await withSeededApp(async ({ electronApp, window, saveDir }) => {
    const { pdf, pdfPath } = await exportPdf(window, electronApp, saveDir);
    appendFileSync(pdfPath, '\n% edited after export\n');

    await pdf.getByRole('button', { name: 'Show the pages here' }).click();
    await expect(pdf.getByRole('alert')).toContainText('not the one saved at export');
    await expect(pdf.getByRole('region', { name: 'PDF pages' })).toHaveCount(0);
    await expect(pdf.getByRole('button', { name: 'I read every page and it looks right' })).toBeDisabled();
    await expect(pdf.getByRole('button', { name: 'Try showing the pages again' })).toBeEnabled();
  });
});

test('every page is readable at the minimum window size, scrolling inside the panel', async () => {
  test.setTimeout(120_000);
  await withSeededApp(async ({ electronApp, window, saveDir }) => {
    const { pdf, pages } = await exportPdf(window, electronApp, saveDir);
    const minimum = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('no window');
      const [width, height] = win.getMinimumSize();
      win.setBounds({ x: 0, y: 0, width: width ?? 0, height: height ?? 0 });
      return { width: width ?? 0, height: height ?? 0 };
    });
    expect(minimum).toEqual({ width: 760, height: 600 });
    await window.waitForTimeout(200);
    const viewport = await window.evaluate(() => ({ width: self.innerWidth, height: self.innerHeight }));

    await pdf.getByRole('button', { name: 'Show the pages here' }).click();
    const region = pdf.getByRole('region', { name: 'PDF pages' });
    await region.scrollIntoViewIfNeeded();
    await expect(region).toBeVisible();
    await scrollToEnd(region);
    await expect(region.locator('canvas[data-drawn="true"]')).toHaveCount(pages);

    // The pages scroll inside the panel: the list is shorter than its content, and nothing scrolls sideways.
    const metrics = await region.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(metrics.clientHeight).toBeLessThanOrEqual(viewport.height);

    const overflow = await window.evaluate(() => {
      const offenders: string[] = [];
      for (const element of [document.documentElement, document.body, ...document.querySelectorAll<HTMLElement>('main, [class*="overflow"]')]) {
        if (element.scrollWidth > element.clientWidth) offenders.push(`${element.tagName}.${element.className}`.slice(0, 80));
      }
      return offenders;
    });
    expect(overflow).toEqual([]);

    // Each page fits the width of the list, so it can be read without scrolling sideways.
    for (const canvas of await region.locator('canvas').all()) {
      const box = await canvas.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      expect(box!.width).toBeGreaterThan(200);
    }

    await pdf.getByRole('button', { name: 'I read every page and it looks right' }).scrollIntoViewIfNeeded();
    await expect(pdf.getByRole('button', { name: 'I read every page and it looks right' })).toBeEnabled();

    const screenshotPath = test.info().outputPath('pdf-page-review-minimum-window.png');
    await window.screenshot({ animations: 'disabled', path: screenshotPath });
    await test.info().attach('pdf-page-review-minimum-window', { path: screenshotPath, contentType: 'image/png' });
  });
});
