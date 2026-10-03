import { expect, goto, test } from './fixtures.js';

/**
 * Focus behaviour of the shared Dialog (#454), in the real Chromium that Electron embeds. The
 * jsdom suite cannot check the parts that belong to the browser: the inert background, the Tab
 * trap and the top layer. These tests do.
 */

async function activeIsInside(window: import('@playwright/test').Page, selector: string): Promise<boolean> {
  return window.evaluate((css) => document.activeElement?.closest(css) != null, selector);
}

test.describe('Dialog focus', () => {
  test('focus moves into a confirmation, stays there through Tab, and returns to the trigger on Escape', async ({ window }) => {
    await goto(window, 'Settings');
    await window.getByRole('tab', { name: 'Data' }).click();

    const trigger = window.getByRole('button', { name: 'Delete my data' });
    await trigger.focus();
    await trigger.click();

    const dialog = window.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    // On the field that guards the deletion, never on the destructive button.
    await expect(dialog.getByRole('textbox', { name: /type delete to confirm/i })).toBeFocused();
    expect(await activeIsInside(window, 'dialog')).toBe(true);

    // Tab and Shift+Tab around the whole page's worth of stops: focus never reaches the background.
    for (let step = 0; step < 12; step += 1) {
      await window.keyboard.press('Tab');
      expect(await activeIsInside(window, 'dialog')).toBe(true);
    }
    for (let step = 0; step < 12; step += 1) {
      await window.keyboard.press('Shift+Tab');
      expect(await activeIsInside(window, 'dialog')).toBe(true);
    }

    await window.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('a cancelled confirmation starts on Cancel and gives focus back to the row\'s button', async ({ window }) => {
    await goto(window, 'Saved jobs');
    await window.getByRole('button', { name: /add job manually/i }).first().click();
    const drawer = window.getByRole('dialog', { name: /add saved job/i });
    await drawer.getByLabel('Role').fill('Focus Regression Role');
    await drawer.getByLabel('Company').fill('Focus Regression Co');
    await drawer.getByLabel('Location').fill('Remote');
    await drawer.getByRole('button', { name: /^save$/i }).click();
    await expect(drawer).toBeHidden();

    const deleteButton = window.getByRole('row', { name: /Focus Regression Co/ }).getByRole('button', { name: /^delete /i });
    await deleteButton.focus();
    await deleteButton.click();

    const confirm = window.getByRole('alertdialog');
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    await expect(deleteButton).toBeFocused();
  });

  test('Escape closes the Welcome modal', async ({ electronApp }) => {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    const welcome = window.getByRole('dialog', { name: 'Welcome to Open Vacancy Radar' });
    await expect(welcome).toBeVisible();
    expect(await activeIsInside(window, 'dialog')).toBe(true);

    await window.keyboard.press('Escape');
    await expect(welcome).toBeHidden();
  });
});
