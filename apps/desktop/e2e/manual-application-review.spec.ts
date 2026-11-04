import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { ensureLightTheme, launchApp } from './fixtures.js';
import { APPLY_COMPANY, APPLY_ROLE, APPLY_VACANCY_URL, seedApplyWorkspace } from './apply-workspace-seed.js';

/**
 * #657: from a selected Search result, Apply opens the Review & apply workspace in
 * place of the detail pane. Search stays on screen, there is no tab switch and no dialog. From
 * documents ready to the employer page takes two clicks (Approve package, Open the employer form);
 * opening a document is optional. Everything here is synthetic: the employer link is on the
 * reserved `.invalid` domain and the system browser and viewer are stubbed, so nothing is sent.
 */
test('Search opens the Review & apply workspace in place and reaches the employer form in two clicks', async () => {
  test.setTimeout(90_000);
  const seeded = await seedApplyWorkspace('ovr-manual-review');
  try {
    const electronApp = await launchApp(seeded.userDataDir, {
      appId: `ovr-e2e-manual-review-${process.pid}`,
      vacancyEngineDataRoot: seeded.vacancyEngineDataRoot,
    });
    try {
      const window = await electronApp.firstWindow();
      await window.waitForLoadState('domcontentloaded');
      await ensureLightTheme(window);
      // The system viewer and the system browser are stubbed: record what would have opened.
      await electronApp.evaluate(({ shell }) => {
        const record = globalThis as unknown as { __opened: string[]; __external: string[] };
        record.__opened = [];
        record.__external = [];
        shell.openPath = async (path: string) => {
          record.__opened.push(path);
          return '';
        };
        shell.openExternal = async (url: string) => {
          record.__external.push(url);
        };
      });

      const sidebar = window.getByRole('complementary', { name: 'Main' });
      await sidebar.getByRole('button', { name: 'Search', exact: true }).click();
      await expect(window.getByRole('button', { name: 'Apply', exact: true })).toBeVisible();
      await window.getByRole('button', { name: 'Apply', exact: true }).click();

      // One in-app screen: the workspace replaces the detail pane on Search. No tab switch, no dialog.
      const workspace = window.getByRole('region', { name: `${APPLY_ROLE} at ${APPLY_COMPANY}` });
      await expect(workspace).toBeVisible();
      await expect(window.getByRole('heading', { level: 1, name: 'Search jobs' })).toBeVisible();
      await expect(window.getByRole('dialog')).toHaveCount(0);
      await expect(window.getByRole('tab', { name: /^Ready to apply/ })).toHaveCount(0);
      await expect(workspace.getByRole('heading', { level: 2 })).toBeFocused();

      // Success reads as success. Internal checkpoint and policy wording stays out of sight.
      await expect(workspace.getByText('Ready to review')).toBeVisible();
      await expect(workspace.getByRole('status').first()).toContainText('Your CV and letter are ready.');
      await expect(workspace.getByText(/Needs your input|not approved for automated submission|checkpoint/i)).toHaveCount(0);
      await expect(workspace.getByText('Submit', { exact: true })).toHaveCount(0);

      // The CV and letter together, each with labelled Open and Save copy.
      const documents = workspace.getByRole('region', { name: 'Your documents' });
      await expect(documents.getByRole('button', { name: 'Open Tailored CV' })).toBeVisible();
      await expect(documents.getByRole('button', { name: 'Save copy of Tailored CV' })).toBeVisible();
      await expect(documents.getByRole('button', { name: 'Open Cover letter' })).toBeVisible();
      await expect(documents.getByRole('button', { name: 'Save copy of Cover letter' })).toBeVisible();
      await expect(workspace.getByText('Second opinion (optional)')).toBeVisible();

      // A real click on Open reaches the system viewer (#565 kept: nothing swallows the click).
      await documents.getByRole('button', { name: 'Open Tailored CV' }).click();
      await expect
        .poll(() => electronApp.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened))
        .toEqual([seeded.cvPath]);

      const approve = workspace.getByRole('button', { name: 'Approve package' });
      const skip = workspace.getByRole('button', { name: 'Skip', exact: true });
      for (const bounds of [
        { width: 1200, height: 800 },
        { width: 760, height: 820 },
      ]) {
        await electronApp.evaluate(
          ({ BrowserWindow }, nextBounds) => BrowserWindow.getAllWindows()[0]?.setBounds(nextBounds),
          bounds,
        );
        await window.waitForTimeout(150);
        await expect(workspace).toBeVisible();

        const geometry = await workspace.evaluate((element) => {
          const box = element.getBoundingClientRect();
          const buttons = [...element.querySelectorAll<HTMLButtonElement>('button')]
            .filter((button) => button.offsetParent !== null)
            .map((button) => button.getBoundingClientRect());
          return {
            box,
            buttons,
            viewportWidth: document.documentElement.clientWidth,
            pageScrollWidth: document.documentElement.scrollWidth,
          };
        });
        expect(geometry.box.left).toBeGreaterThanOrEqual(0);
        expect(geometry.box.right).toBeLessThanOrEqual(geometry.viewportWidth + 1);
        expect(geometry.pageScrollWidth).toBeLessThanOrEqual(geometry.viewportWidth + 1);
        for (const button of geometry.buttons) {
          expect(button.left).toBeGreaterThanOrEqual(geometry.box.left - 1);
          expect(button.right).toBeLessThanOrEqual(geometry.box.right + 1);
        }

        const suffix = `${bounds.width}x${bounds.height}`;
        const restPath = test.info().outputPath(`apply-workspace-${suffix}.png`);
        await window.screenshot({ animations: 'disabled', path: restPath });
        await test.info().attach(`apply-workspace-${suffix}`, { path: restPath, contentType: 'image/png' });

        // Keyboard reachable, no gesture needed.
        await approve.focus();
        await expect(approve).toBeFocused();
        await skip.focus();
        await expect(skip).toBeFocused();
      }

      // axe over the open workspace, in both themes.
      for (const theme of ['openvacancyradar', 'openvacancyradar-dark']) {
        await window.evaluate((value) => {
          document.documentElement.dataset.theme = value;
        }, theme);
        const results = await new AxeBuilder({ page: window })
          .setLegacyMode(true)
          .include('[data-testid="apply-workspace"]')
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
          .analyze();
        expect(results.violations, `${theme} Review & apply workspace axe violations`).toEqual([]);
      }
      await window.evaluate(() => {
        document.documentElement.dataset.theme = 'openvacancyradar';
      });

      // A person who already submitted on an earlier visit can record it without the employer form.
      await expect(workspace.getByRole('button', { name: 'I already submitted it' })).toBeVisible();

      // Click 1 of 2: Approve package. Focus moves to the one primary action left.
      await approve.click();
      const openForm = workspace.getByRole('button', { name: 'Open the employer form' });
      await expect(openForm).toBeFocused();
      // Click 2 of 2: the employer form opens in the system browser. The app sends nothing.
      await openForm.click();
      await expect
        .poll(() => electronApp.evaluate(() => (globalThis as unknown as { __external: string[] }).__external))
        .toEqual([APPLY_VACANCY_URL]);
      await expect(window.getByRole('dialog')).toHaveCount(0);

      // The person submits on the employer site, then records it explicitly. Focus already waits on
      // that control when they come back from the browser, and moves to Back once it is recorded.
      const submitted = workspace.getByRole('button', { name: 'I submitted it' });
      await expect(submitted).toBeFocused();
      await submitted.click();
      await expect(workspace.getByRole('status').first()).toContainText(`${APPLY_ROLE} at ${APPLY_COMPANY} is marked as applied.`);
      await expect(workspace.getByRole('button', { name: 'Back to the vacancy' })).toBeFocused();
      await expect(window.getByRole('heading', { level: 1, name: 'Search jobs' })).toBeVisible();
    } finally {
      await electronApp.close();
    }
  } finally {
    await seeded.cleanup();
  }
});
