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

    // Edit drawer: change a different field, confirm the row reflects it.
    await row.getByRole('button', { name: /^edit$/i }).click();
    const editDialog = window.getByRole('dialog').filter({ hasText: 'Edit application' });
    await editDialog.getByLabel(/next step/i).fill('Technical interview · 2 Sep');
    await editDialog.getByRole('button', { name: /save changes/i }).click();
    await expect(editDialog).toBeHidden();
    await expect(window.getByRole('row', { name: /Redwood Software/ })).toContainText('Technical interview');

    // Delete offers an undo.
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
});
