import { expect, goto, test } from './fixtures.js';

test.describe('Applications', () => {
  test('creates an application, changes its status inline, edits it, and deletes it with undo', async ({
    window,
  }) => {
    await goto(window, 'Applications');
    await window.getByRole('button', { name: /add application/i }).click();

    const createDialog = window.getByRole('dialog').filter({ hasText: 'New application' });
    await createDialog.getByLabel(/^role/i).fill('Senior Frontend Engineer');
    await createDialog.getByLabel(/^company/i).fill('Redwood Software');
    await createDialog.getByRole('button', { name: /create application/i }).click();
    await expect(createDialog).toBeHidden();

    const row = window.getByRole('row', { name: /Redwood Software/ });
    await expect(row).toContainText('Senior Frontend Engineer');
    await expect(row.getByLabel('Application status')).toHaveValue('preparing');

    // The status column is inline-editable right in the table, separate from the edit drawer below.
    await row.getByLabel('Application status').selectOption('applied');
    await expect(row.getByLabel('Application status')).toHaveValue('applied');

    await row.getByRole('button', { name: /^edit$/i }).click();
    const editDialog = window.getByRole('dialog').filter({ hasText: 'Edit application' });
    await editDialog.getByLabel(/next step/i).fill('Technical interview · 2 Sep');
    await editDialog.getByRole('button', { name: /save changes/i }).click();
    await expect(editDialog).toBeHidden();
    await expect(window.getByRole('row', { name: /Redwood Software/ })).toContainText('Technical interview');

    await window.getByRole('row', { name: /Redwood Software/ }).getByRole('button', { name: /^delete$/i }).click();
    const confirm = window.getByRole('alertdialog');
    await expect(confirm).toContainText(/delete this application/i);
    await confirm.getByRole('button', { name: /^delete$/i }).click();
    await expect(window.getByRole('row', { name: /Redwood Software/ })).toHaveCount(0);

    const toast = window.getByRole('status').filter({ hasText: 'Redwood Software' });
    await expect(toast).toBeVisible();
    await toast.getByRole('button', { name: /undo/i }).click();
    await expect(window.getByRole('row', { name: /Redwood Software/ })).toBeVisible();
  });

  test('shows the read-only In progress tab, with no way to add one from the renderer', async ({ window }) => {
    // A fresh workspace has no application_attempts rows -- nothing in the renderer can create
    // one (issue #202: an attempt's existence is owned entirely by the main-process pipeline) --
    // so this real run only exercises the tab switch and empty state, not a populated list; the
    // fuller behavior (row rendering, the detail drawer) is covered against mocked data in
    // ApplicationsPage.test.tsx.
    await goto(window, 'Applications');
    await window.getByRole('tab', { name: 'In progress' }).click();

    await expect(window.getByText('Nothing in progress')).toBeVisible();
    await expect(window.getByRole('button', { name: /add application/i })).toHaveCount(0);
  });
});
