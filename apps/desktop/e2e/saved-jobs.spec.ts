import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';
import { dismissWelcomeModalIfShown, ensureLightTheme, expect, goto, launchApp, test } from './fixtures.js';

test('saved job with a reported application keeps one row with actions in the Actions column', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'ovr-saved-reported-'));
  try {
    const seeded = createWorkspaceDb(userDataDir);
    try {
      workspace.createSavedJob(seeded.db, {
        role: 'Senior Frontend Engineer',
        company: 'Redwood Software',
        location: 'Amsterdam, Netherlands',
        vacancyKey: 'saved-reported-vacancy',
      });
      workspace.createApplicationAttempt(seeded.db, {
        vacancyKey: 'saved-reported-vacancy',
        company: 'Redwood Software',
        role: 'Senior Frontend Engineer',
        sourceCvContentHash: 'source-cv-content-hash',
        jdSnapshotHash: 'jd-content-hash',
        checkpoint: 'user_reported',
        checkpointDetail: 'Reported as applied.',
      });
    } finally {
      seeded.close();
    }

    const electronApp = await launchApp(userDataDir, {
      appId: `ovr-e2e-saved-reported-${process.pid}`,
    });
    try {
      const window = await electronApp.firstWindow();
      await window.waitForLoadState('domcontentloaded');
      await dismissWelcomeModalIfShown(window);
      await ensureLightTheme(window);
      await goto(window, 'Saved jobs');
      const row = window.getByRole('row', { name: /Redwood Software/ });
      await expect(row).toContainText('Reported as applied');

      for (const theme of ['openvacancyradar', 'openvacancyradar-dark']) {
        await window.evaluate(
          (next) => document.documentElement.setAttribute('data-theme', next),
          theme,
        );
        for (const width of [1000, 1280, 1456]) {
          await electronApp.evaluate(
            ({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0]?.setBounds(bounds),
            { width, height: 900 },
          );
          await window.waitForTimeout(100);

          const layout = await row.evaluate((rowElement) => {
            const table = rowElement.closest<HTMLElement>('[aria-label="Saved jobs"]')!;
            const shell = table.parentElement!;
            const header = table.querySelector<HTMLElement>('thead tr')!;
            const rect = (el: Element) => el.getBoundingClientRect();
            const actionsHeader = [...header.children].find((el) => el.textContent === 'Actions')!;
            const roleHeader = [...header.children].find((el) => el.textContent === 'Role')!;
            const cell = (label: string) =>
              rowElement.querySelector<HTMLElement>(`[data-label="${label}"]`)!;
            const badge = cell('Application').querySelector<HTMLElement>('.badge')!;
            const buttons = [...cell('Actions').querySelectorAll('button')].map((b) => rect(b));
            return {
              tableMode: getComputedStyle(header).display === 'grid',
              headerTopDelta: Math.abs(rect(actionsHeader).top - rect(roleHeader).top),
              rowHeight: rect(rowElement).height,
              badgeHeight: rect(badge).height,
              actionTops: buttons.map((b) => b.top),
              actionsLeft: rect(cell('Actions')).left,
              companyRight: rect(cell('Company')).right,
              buttonsInside: buttons.every((b) => b.right <= rect(shell).right + 1),
              overflow: shell.scrollWidth - shell.clientWidth,
            };
          });

          expect(layout.overflow).toBeLessThanOrEqual(0);
          expect(layout.buttonsInside).toBe(true);
          expect(layout.actionTops.length).toBe(3);
          if (layout.tableMode) {
            expect(layout.headerTopDelta).toBeLessThanOrEqual(1);
            expect(
              Math.max(...layout.actionTops) - Math.min(...layout.actionTops),
            ).toBeLessThanOrEqual(1);
            expect(layout.actionsLeft).toBeGreaterThanOrEqual(layout.companyRight);
            expect(layout.rowHeight).toBeLessThanOrEqual(100);
            expect(layout.badgeHeight).toBeLessThanOrEqual(32);
          }
        }
      }
    } finally {
      await electronApp.close();
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  }
});

test.describe('Saved jobs', () => {
  test('adds a job manually, edits it, and deletes it with undo', async ({ window }) => {
    await goto(window, 'Saved jobs');
    await window
      .getByRole('button', { name: /add job manually/i })
      .first()
      .click();

    const addDialog = window.getByRole('dialog', { name: /add saved job/i });
    await addDialog.getByLabel('Role').fill('Senior Frontend Engineer');
    await addDialog.getByLabel('Company').fill('Redwood Software');
    await addDialog.getByLabel('Location').fill('Amsterdam, Netherlands');
    await addDialog.getByRole('button', { name: /^save$/i }).click();
    await expect(addDialog).toBeHidden();

    const row = window.getByRole('row', { name: /Redwood Software/ });
    await expect(row).toContainText('Senior Frontend Engineer');

    await row.getByRole('button', { name: /^edit /i }).click();
    const editDialog = window.getByRole('dialog', { name: /edit saved job/i });
    await expect(editDialog.getByLabel('Role')).toHaveValue('Senior Frontend Engineer');
    await editDialog.getByLabel('Role').fill('Staff Frontend Engineer');
    await editDialog.getByRole('button', { name: /^save$/i }).click();
    await expect(editDialog).toBeHidden();
    await expect(window.getByRole('row', { name: /Redwood Software/ })).toContainText(
      'Staff Frontend Engineer',
    );

    // Delete offers an undo. Recreating the row is a real, load-bearing feature here, not just a
    // toast: SavedJobsPage's docstring is explicit that CV documents deliberately do NOT get this
    // (their text can't be reconstructed), which makes this the one place undo must actually work.
    await window
      .getByRole('row', { name: /Redwood Software/ })
      .getByRole('button', { name: /^delete /i })
      .click();
    const confirm = window.getByRole('alertdialog');
    await expect(confirm).toContainText(/Delete saved job/i);
    await confirm.getByRole('button', { name: /^delete$/i }).click();
    await expect(window.getByRole('row', { name: /Redwood Software/ })).toHaveCount(0);

    const toast = window.getByRole('status').filter({ hasText: 'Redwood Software' });
    await expect(toast).toBeVisible();
    await toast.getByRole('button', { name: /undo/i }).click();
    await expect(window.getByRole('row', { name: /Redwood Software/ })).toBeVisible();
  });

  test('keeps primary identity, status, and actions inside the visible table at common desktop sizes', async ({
    electronApp,
    window,
  }) => {
    await goto(window, 'Saved jobs');
    await window
      .getByRole('button', { name: /add job manually/i })
      .first()
      .click();

    const addDialog = window.getByRole('dialog', { name: /add saved job/i });
    await addDialog.getByLabel('Role').fill('Senior Frontend Platform Engineer');
    await addDialog.getByLabel('Company').fill('A company with a deliberately long name');
    await addDialog.getByLabel('Location').fill('Amsterdam, Netherlands and remote');
    await addDialog.getByLabel('Salary').fill('EUR 6,500 to 8,000 per month');
    await addDialog.getByLabel('Arrangement').fill('Remote-first with occasional travel');
    await addDialog.getByLabel('Sponsor check').fill('Recognised sponsor');
    await addDialog.getByRole('button', { name: /^save$/i }).click();
    await expect(addDialog).toBeHidden();

    const row = window.getByRole('row', { name: /deliberately long name/i });
    await expect(row).toBeVisible();

    for (const theme of ['openvacancyradar', 'openvacancyradar-dark']) {
      for (const density of ['comfortable', 'compact']) {
        await window.evaluate(
          ([nextTheme, nextDensity]) => {
            document.documentElement.setAttribute('data-theme', nextTheme);
            if (nextDensity === 'compact')
              document.documentElement.setAttribute('data-density', nextDensity);
            else document.documentElement.removeAttribute('data-density');
          },
          [theme, density] as const,
        );

        for (const bounds of [
          { width: 1000, height: 720 },
          { width: 1440, height: 900 },
        ]) {
          await electronApp.evaluate(
            ({ BrowserWindow }, nextBounds) =>
              BrowserWindow.getAllWindows()[0]?.setBounds(nextBounds),
            bounds,
          );
          await window.waitForTimeout(50);

          const geometry = await row.evaluate((rowElement) => {
            const table = rowElement.closest<HTMLElement>('[aria-label="Saved jobs"]');
            const shell = table?.parentElement;
            const status = rowElement.querySelector<HTMLElement>('select');
            const actions = rowElement.querySelector<HTMLElement>('[data-label="Actions"]');
            const controls = [
              status,
              ...Array.from(actions?.querySelectorAll<HTMLElement>('button') ?? []),
            ];
            if (!table || !shell || !status || !actions || controls.some((control) => !control)) {
              throw new Error('Saved jobs geometry is incomplete');
            }
            const shellBounds = shell.getBoundingClientRect();
            const controlBounds = controls.map((control) => {
              const bounds = control!.getBoundingClientRect();
              return {
                left: bounds.left,
                right: bounds.right,
                top: bounds.top,
                bottom: bounds.bottom,
              };
            });
            return {
              documentOverflow:
                document.documentElement.scrollWidth - document.documentElement.clientWidth,
              shellOverflow: shell.scrollWidth - shell.clientWidth,
              shellLeft: shellBounds.left,
              shellRight: shellBounds.right,
              controlBounds,
            };
          });

          expect(geometry.documentOverflow).toBeLessThanOrEqual(0);
          expect(geometry.shellOverflow).toBeLessThanOrEqual(0);
          for (const control of geometry.controlBounds) {
            expect(control.left).toBeGreaterThanOrEqual(geometry.shellLeft - 1);
            expect(control.right).toBeLessThanOrEqual(geometry.shellRight + 1);
          }

          if (theme === 'openvacancyradar-dark' && density === 'compact' && bounds.width === 1000) {
            const screenshotPath = test.info().outputPath('saved-jobs-1000-dark-compact.png');
            await window.screenshot({ animations: 'disabled', path: screenshotPath });
            await test.info().attach('saved-jobs-1000-dark-compact', {
              path: screenshotPath,
              contentType: 'image/png',
            });
          }
        }
      }
    }
  });
});
