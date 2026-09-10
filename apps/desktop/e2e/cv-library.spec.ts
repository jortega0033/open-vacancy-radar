import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, goto, test } from './fixtures.js';

const SAMPLE_CV_PATH = fileURLToPath(new URL('./fixtures/sample-cv.txt', import.meta.url));

/** Magic bytes for each exported format, the same check the ticket's own QA pass used to confirm
 * Letters' export produces a real, non-empty file rather than a stub. */
const PDF_MAGIC = Buffer.from('%PDF');
const DOCX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04": the ZIP local-file header.

test.describe('CV library', () => {
  test('adds a manual profile, edits it, and deletes it', async ({ window }) => {
    await goto(window, 'CV');
    await expect(window.getByText(/no cv on file/i)).toBeVisible();

    await window.getByRole('button', { name: /add manual profile/i }).first().click();
    const addDialog = window.getByRole('dialog', { name: /add manual cv profile/i });
    await expect(addDialog).toBeVisible();

    await addDialog.getByLabel(/^name/i).fill('Frontend CV — Netherlands');
    await addDialog.getByLabel(/skills/i).fill('React, TypeScript, Accessibility');
    await addDialog.getByRole('button', { name: /add cv/i }).click();
    await expect(addDialog).toBeHidden();
    await expect(window.getByText('Frontend CV — Netherlands')).toBeVisible();

    const row = window.getByRole('row', { name: /Frontend CV — Netherlands/ });
    await row.getByRole('button', { name: /^edit$/i }).click();
    const editDialog = window.getByRole('dialog', { name: /edit cv/i });
    await expect(editDialog.getByLabel(/^name/i)).toHaveValue('Frontend CV — Netherlands');
    await editDialog.getByLabel(/^name/i).fill('Frontend CV — Renamed');
    await editDialog.getByRole('button', { name: /save changes/i }).click();
    await expect(editDialog).toBeHidden();
    await expect(window.getByText('Frontend CV — Renamed')).toBeVisible();

    // Delete: confirmation dialog says it cannot be undone (no undo for CV documents), then it's gone.
    await window.getByRole('row', { name: /Frontend CV — Renamed/ }).getByRole('button', { name: /^delete$/i }).click();
    const confirm = window.getByRole('alertdialog');
    await expect(confirm).toContainText(/cannot be undone/i);
    await confirm.getByRole('button', { name: /^delete$/i }).click();
    await expect(window.getByText(/no cv on file/i)).toBeVisible();
  });

  test('uploads a CV file and saves the extracted text to the library', async ({ window, electronApp }) => {
    // `cv:select-and-read`'s native OS file picker can't be driven by Playwright directly: the
    // standard workaround for Electron e2e is stubbing `dialog.showOpenDialog` in the main process
    // to return a canned path instead of opening a real dialog.
    await electronApp.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, SAMPLE_CV_PATH);

    await goto(window, 'CV');
    await window.getByRole('button', { name: /^upload cv$/i }).click();
    await expect(window.getByText(/loaded/i)).toContainText('sample-cv.txt');

    // "Save to CV library" unmounts the picked-file panel the instant the save resolves (back to
    // the plain "Upload CV" button) and reloads the list: the durable, testable outcome is the
    // new row appearing with a "Parsed" status, not the transient confirmation in between.
    await window.getByRole('button', { name: /save to cv library/i }).click();
    await expect(window.getByRole('button', { name: /^upload cv$/i })).toBeVisible();
    await expect(window.getByText('sample-cv.txt')).toBeVisible();
    await expect(window.getByText('Parsed', { exact: true })).toBeVisible();
  });

  test('moves the default marker when a different CV is set as default', async ({ window }) => {
    // Seeded via `workspace.createCvDocument` (the same IPC channel the "Add CV" dialog's own
    // submit handler calls) rather than driving that dialog twice through the UI: this test is
    // about the default-selection control, not about the add-CV flow, which already has its own
    // dedicated coverage in the first test in this file. `CvLibraryPage` fetches its list fresh on
    // mount (`listCvDocuments()`), so seeding before `goto` is enough to have both rows render.
    //
    // `createCvDocument` (electron/workspace/repository.ts) makes the very first document the
    // default automatically; every one after that starts out not-default, which is exactly the
    // starting condition this test needs (one already-default row and one that isn't yet).
    await window.evaluate(() =>
      self.workspace.createCvDocument({ name: 'Frontend CV — Netherlands', kind: 'manual' }),
    );
    await window.evaluate(() =>
      self.workspace.createCvDocument({ name: 'Backend CV — Remote', kind: 'manual' }),
    );

    await goto(window, 'CV');

    const firstRow = window.getByRole('row', { name: /Frontend CV — Netherlands/ });
    await expect(firstRow.getByText('Default', { exact: true })).toBeVisible();

    const secondRow = window.getByRole('row', { name: /Backend CV — Remote/ });
    await expect(secondRow.getByRole('button', { name: /set as default/i })).toBeVisible();
    // Only one row carries the marker at a time.
    await expect(secondRow.getByText('Default', { exact: true })).toHaveCount(0);

    await secondRow.getByRole('button', { name: /set as default/i }).click();

    await expect(secondRow.getByText('Default', { exact: true })).toBeVisible();
    await expect(firstRow.getByRole('button', { name: /set as default/i })).toBeVisible();
  });

  test('exports a CV to PDF and DOCX with the default app-authored template (#156)', async ({
    window,
    electronApp,
  }) => {
    await window.evaluate(() =>
      self.workspace.createCvDocument({
        name: 'Frontend CV — Netherlands',
        kind: 'manual',
        targetRole: 'Senior Frontend Engineer',
        profile: {
          title: 'Senior Frontend Engineer',
          location: 'Amsterdam, Netherlands',
          skills: ['TypeScript', 'React', 'Accessibility'],
          summary: 'Frontend engineer with eight years building design systems.',
        },
      }),
    );

    await goto(window, 'CV');
    const row = window.getByRole('row', { name: /Frontend CV — Netherlands/ });
    await expect(row).toBeVisible();

    // `workspace:cv-documents:export` drives a real native save dialog in the main process, which
    // Playwright cannot click through directly, so it is stubbed exactly like the CV upload picker
    // above and like `letters.spec.ts`'s own export test -- to a real path in a throwaway directory
    // this test owns and cleans up itself. PDF and DOCX each get their own throwaway directory
    // (rather than sharing one): writing a second file to a directory Windows/AV just finished
    // scanning the first write in was an observed source of flaky ENOENT errors in this exact test,
    // unrelated to the export handler itself -- a fresh directory per format sidesteps that.
    const pdfDir = mkdtempSync(join(tmpdir(), 'ovr-e2e-cv-export-pdf-'));
    const docxDir = mkdtempSync(join(tmpdir(), 'ovr-e2e-cv-export-docx-'));
    try {
      // PDF first.
      const pdfPath = join(pdfDir, 'resume.pdf');
      await electronApp.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath });
      }, pdfPath);

      // The Export menu is a daisyUI CSS-`:focus`-driven dropdown (`CvLibraryTable.tsx`'s
      // `dropdown dropdown-end`), the same kind `letters.spec.ts` already drives: the menu item is
      // waited on explicitly rather than clicked immediately after the toggle, since a click
      // dispatched before the dropdown's focus state has settled would otherwise be a flaky
      // "not visible" timeout instead of a deterministic pass.
      await row.getByRole('button', { name: /^export$/i }).click();
      const pdfOption = row.getByRole('button', { name: /pdf \(\.pdf\)/i });
      await expect(pdfOption).toBeVisible();
      await pdfOption.click();
      await expect(row.getByText('Exported', { exact: true })).toBeVisible();

      // `workspace:cv-documents:export`'s own handler already ran this exact PDF through
      // `validateRenderedResumePdf` before ever reaching the save dialog (see main.ts), which
      // confirms the rendered text actually contains this CV's own title -- not re-asserted here
      // via a raw-byte substring search, since a real PDF's content streams are typically
      // Flate-compressed and would not contain readable text at the byte level regardless of
      // whether rendering worked correctly.
      const pdfBytes = readFileSync(pdfPath);
      expect(pdfBytes.byteLength).toBeGreaterThan(0);
      expect(pdfBytes.subarray(0, 4)).toEqual(PDF_MAGIC);

      // Then DOCX, against the same row.
      const docxPath = join(docxDir, 'resume.docx');
      await electronApp.evaluate(({ dialog }, filePath) => {
        dialog.showSaveDialog = async () => ({ canceled: false, filePath });
      }, docxPath);

      await row.getByRole('button', { name: /^export$/i }).click();
      const docxOption = row.getByRole('button', { name: /word \(\.docx\)/i });
      await expect(docxOption).toBeVisible();
      await docxOption.click();
      await expect(row.getByText('Exported', { exact: true })).toBeVisible();

      const docxBytes = readFileSync(docxPath);
      expect(docxBytes.byteLength).toBeGreaterThan(0);
      expect(docxBytes.subarray(0, 4)).toEqual(DOCX_MAGIC);
    } finally {
      rmSync(pdfDir, { recursive: true, force: true });
      rmSync(docxDir, { recursive: true, force: true });
    }
  });
});
