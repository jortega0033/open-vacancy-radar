import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { dismissWelcomeModalIfShown, goto, launchApp } from './fixtures.js';
import { OVERDUE_ROW, QUIET_ROW, SEEDED_ACTION_TITLE, seedFollowUpsCase } from './seed-follow-ups-case.js';

/**
 * The follow-ups surfaces (#692) in the real, built app at the supported desktop widths, in both themes and
 * both densities: the Applications table with its follow-up summary and "Follow-ups" button, the drawer with an
 * overdue step, a history entry and a prepared draft, the empty drawer, and the form and confirmations that open
 * inside it. Two applications are seeded through the real repository before launch (`seed-follow-ups-case.ts`);
 * everything after launch is the real preload, IPC, main process and renderer. No draft is requested, so no model
 * is ever reached, and nothing is sent anywhere.
 *
 * What is asserted is what a person would notice: no sideways scrolling in the table or the drawer, every
 * control drawn and inside its container, every enabled control reachable by keyboard (a Tab walk that cannot
 * leave the modal), and the status notice drawn in a colour that reads on its background. `responsive-data-tables`
 * keeps checking the existing Applications, CV and Letters tables; this file does not replace or loosen it.
 */

const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1000, height: 720 },
  { width: 800, height: 600 },
] as const;

interface Session {
  electronApp: ElectronApplication;
  window: Page;
}

async function withSeededApp(body: (session: Session) => Promise<void>): Promise<void> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'ovr-e2e-follow-ups-'));
  seedFollowUpsCase(userDataDir);
  const electronApp = await launchApp(userDataDir, { appId: `ovr-e2e-follow-ups-${process.pid}` });
  try {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await dismissWelcomeModalIfShown(window);
    await body({ electronApp, window });
  } finally {
    await electronApp.close();
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

const settle = (window: Page): Promise<void> =>
  window.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

interface ControlReport {
  name: string;
  drawn: boolean;
  inside: boolean;
  disabled: boolean;
  radio: boolean;
  focusable: boolean;
}

/** Everything about a container's controls that a layout regression would break. */
async function audit(container: Locator): Promise<{ clientWidth: number; scrollWidth: number; scrollers: Array<{ clientWidth: number; scrollWidth: number }>; controls: ControlReport[] }> {
  return container.evaluate((root) => {
    const rootRect = root.getBoundingClientRect();
    const scrollers = [root, ...root.querySelectorAll<HTMLElement>('.overflow-y-auto, .overflow-x-auto')].map((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    const controls = [...root.querySelectorAll<HTMLElement>('button, input, select, textarea, summary')].flatMap((control) => {
      const rect = control.getBoundingClientRect();
      const closedDetails = control.closest('details:not([open])') && control.tagName !== 'SUMMARY';
      if (closedDetails) return [];
      const drawn = rect.width > 0 && rect.height > 0 && getComputedStyle(control).visibility !== 'hidden';
      const disabled = (control as HTMLButtonElement).disabled === true;
      let focusable = false;
      if (drawn && !disabled) {
        control.focus();
        focusable = document.activeElement === control;
      }
      return [
        {
          name: control.getAttribute('aria-label') || control.textContent?.trim().slice(0, 50) || control.tagName.toLowerCase(),
          drawn,
          inside: rect.left >= rootRect.left - 1 && rect.right <= rootRect.right + 1,
          disabled,
          radio: control instanceof HTMLInputElement && control.type === 'radio',
          focusable,
        },
      ];
    });
    return { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth, scrollers, controls };
  });
}

async function expectFits(container: Locator, what: string): Promise<void> {
  const report = await audit(container);
  expect(report.scrollWidth, `${what}: horizontal overflow`).toBeLessThanOrEqual(report.clientWidth + 1);
  for (const scroller of report.scrollers) expect(scroller.scrollWidth, `${what}: a scroll area overflows sideways`).toBeLessThanOrEqual(scroller.clientWidth + 1);
  expect(report.controls.length, `${what}: has controls`).toBeGreaterThan(0);
  for (const control of report.controls) {
    expect(control.drawn, `${what}: "${control.name}" is drawn`).toBe(true);
    expect(control.inside, `${what}: "${control.name}" is inside its container`).toBe(true);
    if (!control.disabled) expect(control.focusable, `${what}: "${control.name}" takes keyboard focus`).toBe(true);
  }
}

/** Tab from the first control: focus must stay inside the modal and reach every enabled control. */
async function expectTabWalk(window: Page, dialog: Locator, what: string): Promise<void> {
  // An element is named by its position in the dialog, which is stable while nothing is added or removed.
  const expected = await dialog.evaluate((root) => {
    // A radio group takes one Tab stop, so single radios are not required individually.
    const controls = [...root.querySelectorAll<HTMLElement>('button, input, select, textarea, summary')].filter(
      (control) => !(control as HTMLButtonElement).disabled && control.getBoundingClientRect().width > 0 && !(control instanceof HTMLInputElement && control.type === 'radio'),
    );
    controls[0]?.focus();
    const all = [...root.querySelectorAll('*')];
    return controls.map((control) => all.indexOf(control));
  });
  expect(expected.length, `${what}: has tab stops`).toBeGreaterThan(3);
  const visited = new Set<number>();
  for (let step = 0; step < expected.length + 8; step += 1) {
    await window.keyboard.press('Tab');
    const state = await dialog.evaluate((root) => {
      const active = document.activeElement;
      return { inside: !!active && root.contains(active), index: active ? [...root.querySelectorAll('*')].indexOf(active) : -1 };
    });
    expect(state.inside, `${what}: Tab never leaves the modal`).toBe(true);
    visited.add(state.index);
  }
  expect(expected.filter((index) => !visited.has(index)), `${what}: every enabled control is reached by Tab`).toEqual([]);
}

/** Contrast of the notice text against what is actually painted behind it, measured on the rendered pixels. */
async function noticeContrast(notice: Locator): Promise<number> {
  return notice.evaluate((element) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    const pixel = (layers: string[]): [number, number, number] => {
      context.clearRect(0, 0, 1, 1);
      for (const layer of layers) {
        context.fillStyle = '#123456';
        context.fillStyle = layer;
        if (context.fillStyle === '#123456' && layer.trim().toLowerCase() !== '#123456') throw new Error(`unreadable colour ${layer}`);
        context.fillRect(0, 0, 1, 1);
      }
      const data = context.getImageData(0, 0, 1, 1).data;
      return [data[0]!, data[1]!, data[2]!];
    };
    // The first opaque-enough background behind the text.
    let background = 'rgb(255, 255, 255)';
    for (let node: Element | null = element; node; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor;
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      if (context.getImageData(0, 0, 1, 1).data[3]! >= 250) {
        background = color;
        break;
      }
    }
    const luminance = ([r, g, b]: [number, number, number]): number => {
      const channel = (value: number): number => {
        const v = value / 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const back = luminance(pixel([background]));
    const text = luminance(pixel([background, getComputedStyle(element).color]));
    const [hi, lo] = back > text ? [back, text] : [text, back];
    return (hi + 0.05) / (lo + 0.05);
  });
}

test('follow-ups in the table and drawer fit, stay reachable and stay readable at supported widths', async () => {
  test.setTimeout(240_000);
  await withSeededApp(async ({ electronApp, window }) => {
    for (const theme of ['openvacancyradar', 'openvacancyradar-dark']) {
      for (const density of ['comfortable', 'compact']) {
        await window.evaluate(
          ({ theme, density }) => {
            document.documentElement.dataset.theme = theme;
            if (density === 'compact') document.documentElement.dataset.density = 'compact';
            else delete document.documentElement.dataset.density;
          },
          { theme, density },
        );

        for (const viewport of VIEWPORTS) {
          const where = `${theme} / ${density} / ${viewport.width}px`;
          await electronApp.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0]?.setBounds(bounds), viewport);
          await goto(window, 'Applications');
          await settle(window);

          // The table: both seeded rows, their summaries and their Follow-ups buttons.
          const table = window.getByTestId('applications-responsive-table');
          await expect(table).toBeVisible();
          const overdueRow = table.getByRole('row').filter({ hasText: OVERDUE_ROW.company });
          const quietRow = table.getByRole('row').filter({ hasText: QUIET_ROW.company });
          await expect(overdueRow.getByTestId('follow-up-summary')).toContainText('1 overdue');
          await expect(quietRow.getByTestId('follow-up-summary')).toHaveText('No follow-up planned.');
          await expect(window.getByTestId('follow-ups-banner')).toContainText('1 overdue');
          await expectFits(table, `${where}: Applications table`);
          for (const row of [overdueRow, quietRow]) {
            const summary = row.getByTestId('follow-up-summary');
            await expect(summary).toBeVisible();
            const [summaryBox, tableBox] = [await summary.boundingBox(), await table.boundingBox()];
            expect(summaryBox!.x, `${where}: summary starts inside the table`).toBeGreaterThanOrEqual(tableBox!.x - 1);
            expect(summaryBox!.x + summaryBox!.width, `${where}: summary ends inside the table`).toBeLessThanOrEqual(tableBox!.x + tableBox!.width + 1);
          }

          // The overdue application's drawer: step, history, draft, form and confirmation.
          await overdueRow.getByRole('button', { name: /^Follow-ups for / }).focus();
          await window.keyboard.press('Enter');
          const dialog = window.getByRole('dialog', { name: `Follow-ups for ${OVERDUE_ROW.role} at ${OVERDUE_ROW.company}` });
          await expect(dialog).toBeVisible();
          const box = dialog.locator('.modal-box');
          await expect(dialog.getByTestId('follow-up-action').first()).toContainText(SEEDED_ACTION_TITLE);
          await expect(dialog.getByTestId('follow-up-action').first().getByText('Overdue')).toBeVisible();
          const draft = dialog.getByTestId('follow-up-draft');
          await expect(draft).toBeVisible();
          await expect(draft.getByTestId('draft-review-state')).toHaveText('Not reviewed yet');
          await expect(draft.getByTestId('draft-send-state')).toHaveText('Not sent');
          await expectFits(box, `${where}: drawer`);

          // The status notice is drawn in a colour that reads on the drawer, in this theme.
          await dialog.getByRole('button', { name: 'Stop suggesting follow-ups' }).click();
          const notice = dialog.getByTestId('follow-up-notice');
          await expect(notice).toHaveText('Suggestions are off for this application.');
          await expect(notice).toBeVisible();
          expect(await noticeContrast(notice), `${where}: notice text contrast`).toBeGreaterThanOrEqual(4.5);
          await dialog.getByRole('button', { name: 'Allow follow-up suggestions' }).click();
          await expect(notice).toHaveText('Suggestions are back on.');

          // History, the form and the "I sent this" confirmation fit as well.
          await dialog.getByText('History (1)').click();
          await expect(dialog.getByTestId('follow-up-action')).toHaveCount(2);
          await expectFits(box, `${where}: drawer with history`);
          await draft.getByRole('button', { name: 'I sent this' }).click();
          await expect(draft.getByLabel('I sent this message myself')).toBeFocused();
          await expectFits(box, `${where}: drawer with the sent confirmation`);
          await draft.getByRole('button', { name: 'Not yet' }).click();
          await expect(draft.getByRole('button', { name: 'I sent this' })).toBeFocused();

          await dialog.getByRole('button', { name: 'Add a follow-up' }).click();
          const form = dialog.getByRole('form', { name: 'New follow-up' });
          await expect(form.getByLabel('What')).toBeFocused();
          await form.getByLabel('At a set time').check();
          await expectFits(box, `${where}: drawer with the new follow-up form`);
          if (viewport.width === 800) await expectTabWalk(window, dialog, `${where}: drawer`);
          await form.getByRole('button', { name: 'Cancel' }).click();
          await expect(dialog.getByRole('button', { name: 'Add a follow-up' })).toBeFocused();

          await dialog.getByRole('button', { name: 'Close' }).click();
          await expect(dialog).toBeHidden();

          // The quiet application: empty states and the prompt.
          await quietRow.getByRole('button', { name: /^Follow-ups for / }).click();
          const quietDialog = window.getByRole('dialog', { name: `Follow-ups for ${QUIET_ROW.role} at ${QUIET_ROW.company}` });
          await expect(quietDialog.getByTestId('follow-ups-empty')).toBeVisible();
          await expect(quietDialog.getByTestId('drafts-empty')).toBeVisible();
          await expect(quietDialog.getByRole('button', { name: 'Plan a follow-up' })).toBeVisible();
          await expectFits(quietDialog.locator('.modal-box'), `${where}: empty drawer`);
          await quietDialog.getByRole('button', { name: 'Close' }).click();
          await expect(quietDialog).toBeHidden();
        }
      }
    }
  });
});
