import { expect, goto, test } from './fixtures.js';

test.describe('Saved Jobs', () => {
  test('adds a job manually, edits it, and deletes it with undo', async ({ window }) => {
    await goto(window, 'Saved Jobs');
    await window.getByRole('button', { name: /add job manually/i }).first().click();

    const addDialog = window.getByRole('dialog', { name: /add saved job/i });
    await addDialog.getByLabel('Role').fill('Senior Frontend Engineer');
    await addDialog.getByLabel('Company').fill('Redwood Software');
    await addDialog.getByLabel('Location').fill('Amsterdam, Netherlands');
    await addDialog.getByRole('button', { name: /^save$/i }).click();
    await expect(addDialog).toBeHidden();

    const row = window.getByRole('row', { name: /Redwood Software/ });
    await expect(row).toContainText('Senior Frontend Engineer');

    await row.getByRole('button', { name: /^edit$/i }).click();
    const editDialog = window.getByRole('dialog', { name: /edit saved job/i });
    await expect(editDialog.getByLabel('Role')).toHaveValue('Senior Frontend Engineer');
    await editDialog.getByLabel('Role').fill('Staff Frontend Engineer');
    await editDialog.getByRole('button', { name: /^save$/i }).click();
    await expect(editDialog).toBeHidden();
    await expect(window.getByRole('row', { name: /Redwood Software/ })).toContainText('Staff Frontend Engineer');

    // Delete offers an undo. Recreating the row is a real, load-bearing feature here, not just a
    // toast: SavedJobsPage's docstring is explicit that CV documents deliberately do NOT get this
    // (their text can't be reconstructed), which makes this the one place undo must actually work.
    await window.getByRole('row', { name: /Redwood Software/ }).getByRole('button', { name: /^delete$/i }).click();
    const confirm = window.getByRole('alertdialog');
    await expect(confirm).toContainText(/Delete saved job/i);
    await confirm.getByRole('button', { name: /^delete$/i }).click();
    await expect(window.getByRole('row', { name: /Redwood Software/ })).toHaveCount(0);

    const toast = window.getByRole('status').filter({ hasText: 'Redwood Software' });
    await expect(toast).toBeVisible();
    await toast.getByRole('button', { name: /undo/i }).click();
    await expect(window.getByRole('row', { name: /Redwood Software/ })).toBeVisible();
  });
});
