import { fileURLToPath } from 'node:url';
import { expect, goto, test } from './fixtures.js';

const SAMPLE_CV_PATH = fileURLToPath(new URL('./fixtures/sample-cv.txt', import.meta.url));

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
    async function addManualProfile(name: string) {
      await window.getByRole('button', { name: /add manual profile/i }).first().click();
      const dialog = window.getByRole('dialog', { name: /add manual cv profile/i });
      await dialog.getByLabel(/^name/i).fill(name);
      await dialog.getByRole('button', { name: /add cv/i }).click();
      await expect(dialog).toBeHidden();
    }

    await goto(window, 'CV');

    // `createCvDocument` (electron/workspace/repository.ts) makes the very first document the
    // default automatically; every one after that starts out not-default, which is exactly the
    // starting condition this test needs (one already-default row and one that isn't yet).
    await addManualProfile('Frontend CV — Netherlands');
    const firstRow = window.getByRole('row', { name: /Frontend CV — Netherlands/ });
    await expect(firstRow.getByText('Default', { exact: true })).toBeVisible();

    await addManualProfile('Backend CV — Remote');
    const secondRow = window.getByRole('row', { name: /Backend CV — Remote/ });
    await expect(secondRow.getByRole('button', { name: /set as default/i })).toBeVisible();
    // Only one row carries the marker at a time.
    await expect(secondRow.getByText('Default', { exact: true })).toHaveCount(0);

    await secondRow.getByRole('button', { name: /set as default/i }).click();

    await expect(secondRow.getByText('Default', { exact: true })).toBeVisible();
    await expect(firstRow.getByRole('button', { name: /set as default/i })).toBeVisible();
    await expect(firstRow.getByText('Default', { exact: true })).toHaveCount(0);
  });
});
