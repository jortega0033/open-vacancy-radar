import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { ensureLightTheme, launchApp } from './fixtures.js';
import { SEEDED_APPROVED_BULLET, SEEDED_CASE_LABEL, SEEDED_CV_NAME, seedApprovedTailoringCase } from './seed-tailoring-case.js';

/**
 * The tailoring-case path in the real, built app (#435): open an approved case from the CV Library,
 * export both formats through the real renderers and validators, review and accept each file, and
 * see the files marked out of date after the CV changes. The reviewed CV source, the case and its
 * approval are seeded through the repository before launch (`seed-tailoring-case.ts`), because the
 * AI steps that normally produce them cannot run here. Everything after launch is the real UI and
 * the real main process. Only two native surfaces are stubbed, as `cv-library.spec.ts` does for the
 * file picker: the save dialog (a temp path instead of the OS dialog) and `shell.openPath` (nothing
 * to open a viewer on in CI).
 */

// Rendering and checking a real PDF or Word file takes a few seconds on a loaded machine.
const EXPORT_TIMEOUT = { timeout: 20_000 };

const PDF_MAGIC = Buffer.from('%PDF');
const DOCX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

interface Session {
  electronApp: ElectronApplication;
  window: Page;
  saveDir: string;
}

async function withSeededApp(body: (session: Session) => Promise<void>): Promise<void> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'ovr-e2e-case-'));
  const saveDir = await mkdtemp(join(tmpdir(), 'ovr-e2e-case-out-'));
  seedApprovedTailoringCase(userDataDir);
  const electronApp = await launchApp(userDataDir, { appId: `ovr-e2e-tailoring-case-${process.pid}` });
  try {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await ensureLightTheme(window);
    await body({ electronApp, window, saveDir });
  } finally {
    await electronApp.close();
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    await rm(saveDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

/** Replaces the save dialog with one that saves into `saveDir` under the suggested name, or
 * cancels, and records what it was asked. `shell.openPath` records the path instead of opening it. */
async function stubNativeSurfaces(electronApp: ElectronApplication, saveDir: string, mode: 'save' | 'cancel') {
  await electronApp.evaluate(
    ({ dialog, shell }, { dir, behavior }) => {
      const record = globalThis as unknown as { __saveRequests: unknown[]; __opened: string[] };
      record.__saveRequests = [];
      record.__opened = [];
      dialog.showSaveDialog = (async (_window: unknown, options: { defaultPath: string }) => {
        record.__saveRequests.push(options);
        return behavior === 'cancel' ? { canceled: true, filePath: '' } : { canceled: false, filePath: `${dir}/${options.defaultPath}` };
      }) as unknown as typeof dialog.showSaveDialog;
      shell.openPath = async (path: string) => {
        record.__opened.push(path);
        return '';
      };
    },
    { dir: saveDir, behavior: mode },
  );
}

const nativeRecord = (electronApp: ElectronApplication) =>
  electronApp.evaluate(() => {
    const record = globalThis as unknown as { __saveRequests: unknown[]; __opened: string[] };
    return { saveRequests: record.__saveRequests, opened: record.__opened };
  });

async function openSeededCase(window: Page): Promise<Locator> {
  await window.getByRole('complementary', { name: 'Main' }).getByRole('button', { name: 'CV', exact: true }).click();
  const table = window.getByRole('table', { name: `Tailoring cases for ${SEEDED_CV_NAME}` });
  await window.getByRole('button', { name: `Open ${SEEDED_CASE_LABEL}` }).click();
  await expect(table).toBeHidden();
  const panel = window.getByRole('region', { name: 'Exported files' });
  await panel.scrollIntoViewIfNeeded();
  await expect(panel).toBeVisible();
  return panel;
}

const sha256OfFile = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('opens an approved case, exports both formats, reviews each file, and marks them out of date after a CV change', async () => {
  test.setTimeout(90_000);
  await withSeededApp(async ({ electronApp, window, saveDir }) => {
    await window.getByRole('complementary', { name: 'Main' }).getByRole('button', { name: 'CV', exact: true }).click();
    const casesTable = window.getByRole('table', { name: `Tailoring cases for ${SEEDED_CV_NAME}` });
    await expect(casesTable).toBeVisible();
    const caseRow = casesTable.getByRole('row', { name: new RegExp(SEEDED_CASE_LABEL) });
    await expect(caseRow.getByRole('cell').nth(2)).toHaveText('CV approved');
    await expect(caseRow.getByRole('cell').nth(3)).toHaveText('not exported');
    await expect(caseRow.getByRole('cell').nth(4)).toHaveText('not exported');

    const panel = await openSeededCase(window);
    const pdf = panel.getByLabel('PDF file', { exact: true });
    const word = panel.getByLabel('Word file', { exact: true });
    await expect(pdf.getByRole('status')).toHaveText('Not exported');
    await expect(word.getByRole('status')).toHaveText('Not exported');

    // A cancelled save dialog leaves the case exactly as it was and writes nothing.
    await stubNativeSurfaces(electronApp, saveDir, 'cancel');
    await pdf.getByRole('button', { name: 'Export as PDF' }).click();
    await expect.poll(async () => (await nativeRecord(electronApp)).saveRequests.length).toBe(1);
    await expect(pdf.getByRole('button', { name: 'Export as PDF' })).toBeEnabled();
    await expect(pdf.getByRole('status')).toHaveText('Not exported');
    expect(existsSync(join(saveDir, `${SEEDED_CV_NAME}.pdf`))).toBe(false);

    // The PDF is rendered, checked and saved; it then waits for the candidate's own review.
    await stubNativeSurfaces(electronApp, saveDir, 'save');
    await pdf.getByRole('button', { name: 'Export as PDF' }).click();
    await expect(pdf.getByRole('status')).toHaveText('Exported, waiting for your review', EXPORT_TIMEOUT);
    const pdfPath = `${saveDir}/${SEEDED_CV_NAME}.pdf`;
    expect(readFileSync(pdfPath).subarray(0, 4).equals(PDF_MAGIC)).toBe(true);
    await expect(panel.getByRole('status').filter({ hasText: `Saved to ${saveDir}` })).toBeVisible();
    // The record shows the hash of the bytes that were written.
    const pdfHash = sha256OfFile(pdfPath);
    await expect(pdf).toContainText(`Hash ${pdfHash.slice(0, 12)}`);
    await expect(pdf).toContainText('1 page(s)');
    expect((await nativeRecord(electronApp)).saveRequests).toEqual([
      expect.objectContaining({ title: 'Export approved CV', defaultPath: `${SEEDED_CV_NAME}.pdf` }),
    ]);

    // A PDF cannot be accepted before its pages were shown in the app. Opening the system viewer
    // is a second way to look and does not unlock confirming.
    const confirmPdf = pdf.getByRole('button', { name: 'I read every page and it looks right' });
    await expect(confirmPdf).toBeDisabled();
    await pdf.getByRole('button', { name: 'Open in my PDF viewer' }).click();
    await expect.poll(async () => (await nativeRecord(electronApp)).opened).toEqual([pdfPath]);
    await expect(confirmPdf).toBeDisabled();
    await pdf.getByRole('button', { name: 'Show the pages here' }).click();
    await expect(pdf.getByRole('region', { name: 'PDF pages' })).toBeVisible();
    await expect(confirmPdf).toBeEnabled();
    await confirmPdf.click();
    await expect(pdf.getByRole('status')).toHaveText('Accepted');

    // The Word file is a separate format with its own status and its own review.
    await expect(word.getByRole('status')).toHaveText('Not exported');
    await word.getByRole('button', { name: 'Export as Word' }).click();
    await expect(word.getByRole('status')).toHaveText('Exported, waiting for your review', EXPORT_TIMEOUT);
    const docxPath = `${saveDir}/${SEEDED_CV_NAME}.docx`;
    expect(readFileSync(docxPath).subarray(0, 4).equals(DOCX_MAGIC)).toBe(true);
    const docxHash = sha256OfFile(docxPath);
    await expect(word).toContainText(`Hash ${docxHash.slice(0, 12)}`);
    await word.getByRole('button', { name: 'I reviewed this in my editor' }).click();
    await expect(word.getByRole('status')).toHaveText('Accepted');
    await expect(pdf.getByRole('status')).toHaveText('Accepted');

    // The approved wording, not the source wording, is what was exported and recorded.
    await window.getByRole('button', { name: 'Preview approved CV' }).click();
    await expect(window.getByLabel('Composed CV preview')).toContainText(SEEDED_APPROVED_BULLET);

    // The case list reads the stored records for each format.
    await window.getByRole('button', { name: 'Back to CV library' }).click();
    await expect(caseRow.getByRole('cell').nth(3)).toHaveText('accepted');
    await expect(caseRow.getByRole('cell').nth(4)).toHaveText('accepted');

    // Changing the CV's skills changes what the case was approved against, so both files are out of date.
    await window.getByRole('row', { name: new RegExp(SEEDED_CV_NAME) }).first().getByRole('button', { name: /^edit$/i }).click();
    const editDialog = window.getByRole('dialog', { name: /edit cv/i });
    await editDialog.getByLabel(/skills/i).fill('TypeScript, Playwright');
    await editDialog.getByRole('button', { name: /save changes/i }).click();
    await expect(editDialog).toBeHidden();
    await expect(caseRow.getByRole('cell').nth(2)).toHaveText('In progress');
    await expect(caseRow.getByRole('cell').nth(3)).toHaveText('out of date');
    await expect(caseRow.getByRole('cell').nth(4)).toHaveText('out of date');
    // The files stay on disk, byte for byte what was exported and accepted.
    expect(sha256OfFile(pdfPath)).toBe(pdfHash);
    expect(sha256OfFile(docxPath)).toBe(docxHash);
  });
});

test('the review and file panels stay fully usable at the minimum window size', async () => {
  test.setTimeout(90_000);
  await withSeededApp(async ({ electronApp, window, saveDir }) => {
    await stubNativeSurfaces(electronApp, saveDir, 'save');
    const panel = await openSeededCase(window);
    // Every button the panel can show, in its widest wording: files waiting for review, in both formats.
    await panel.getByLabel('PDF file', { exact: true }).getByRole('button', { name: 'Export as PDF' }).click();
    await expect(panel.getByLabel('PDF file', { exact: true }).getByRole('status')).toHaveText('Exported, waiting for your review', EXPORT_TIMEOUT);
    await panel.getByLabel('Word file', { exact: true }).getByRole('button', { name: 'Export as Word' }).click();
    await expect(panel.getByLabel('Word file', { exact: true }).getByRole('status')).toHaveText('Exported, waiting for your review', EXPORT_TIMEOUT);
    await window.getByRole('button', { name: 'Preview approved CV' }).click();
    await expect(window.getByLabel('Composed CV preview')).toBeVisible();

    const minimum = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error('no window');
      const [width, height] = win.getMinimumSize();
      win.setBounds({ x: 0, y: 0, width: width ?? 0, height: height ?? 0 });
      return { width: width ?? 0, height: height ?? 0 };
    });
    // The minimum is the app's own enforced one (#340), not a number chosen here.
    expect(minimum).toEqual({ width: 760, height: 600 });
    await window.waitForTimeout(200);
    const viewport = await window.evaluate(() => ({ width: self.innerWidth, height: self.innerHeight }));
    expect(viewport.width).toBeLessThanOrEqual(minimum.width);

    // No horizontal page scroll, on the document and on every scrolling ancestor of the panels.
    const overflow = await window.evaluate(() => {
      const offenders: string[] = [];
      for (const element of [document.documentElement, document.body, ...document.querySelectorAll<HTMLElement>('main, [class*="overflow"]')]) {
        if (element.scrollWidth > element.clientWidth) offenders.push(`${element.tagName}.${element.className}`.slice(0, 80));
      }
      return offenders;
    });
    expect(overflow).toEqual([]);

    const panels = [panel, window.getByRole('region', { name: 'Project selection' }), window.getByLabel('Composed CV preview')];
    for (const region of panels) {
      await expect(region).toBeVisible();
      await region.scrollIntoViewIfNeeded();
      const box = await region.boundingBox();
      expect(box, 'panel has a layout box').not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      // Nothing inside the panel is wider than the panel itself.
      expect(await region.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    }

    // Every action in the two panels is reachable, inside the window, and not cut off or covered.
    const actions = [
      ...(await panel.getByRole('button').all()),
      window.getByRole('button', { name: 'Preview approved CV' }),
      window.getByRole('button', { name: 'Back to CV library' }),
    ];
    expect(actions.length).toBeGreaterThanOrEqual(8);
    for (const action of actions) {
      await action.scrollIntoViewIfNeeded();
      const box = await action.boundingBox();
      const label = (await action.innerText()).trim();
      expect(box, `${label} has a layout box`).not.toBeNull();
      expect(box!.x, `${label} starts inside the window`).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, `${label} ends inside the window`).toBeLessThanOrEqual(viewport.width);
      expect(box!.width, `${label} has a usable width`).toBeGreaterThan(24);
      expect(box!.height, `${label} has a usable height`).toBeGreaterThan(20);
      // The text is not clipped by the button's own box.
      expect(await action.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), `${label} is not clipped`).toBe(true);
      // Actionable: visible, stable, enabled-or-intentionally-disabled and not covered by anything.
      if (await action.isEnabled()) await action.click({ trial: true });
    }

    const screenshotPath = test.info().outputPath('tailoring-case-minimum-window.png');
    await window.screenshot({ animations: 'disabled', path: screenshotPath });
    await test.info().attach('tailoring-case-minimum-window', { path: screenshotPath, contentType: 'image/png' });
  });
});
