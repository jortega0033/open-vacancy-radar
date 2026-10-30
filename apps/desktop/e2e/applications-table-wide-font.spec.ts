import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { dismissWelcomeModalIfShown, goto, launchApp } from './fixtures.js';
import { OVERDUE_ROW, seedFollowUpsCase } from './seed-follow-ups-case.js';

/**
 * Font-metric headroom for the Applications table (#692). The first layout check only held with the
 * fonts of the machine it ran on; on the Linux runner the same row (an overdue follow-up summary with a
 * whole-day date and a time zone name, long role and company text, three action buttons) was 28px too
 * wide at 1366px. This spec forces a wide sans-serif stack so the result no longer depends on which font
 * the machine happens to resolve, and adds rows whose text has no break opportunity at all.
 *
 * It asserts no sideways scrolling, every control drawn and inside the table, no two controls drawn over
 * each other, every row's text fully visible (nothing clipped), and that the table needs clearly less than
 * its container even when asked for its narrowest possible width. It does not replace
 * `follow-ups-layout.spec.ts` or `responsive-data-tables.spec.ts` and loosens neither.
 */

const WIDE_FONTS = "Verdana, 'DejaVu Sans', 'Bitstream Vera Sans', Tahoma, sans-serif";
const VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1100, height: 720 },
  { width: 1000, height: 720 },
] as const;
/** The narrowest layout of the table must use no more than this share of what its container offers. */
const MAX_MIN_CONTENT_SHARE = 0.9;

const UNBROKEN = 'Internationalisation-Platform-Engineering-and-Operations-Holding-Group-Netherlands-BV';

test('the Applications table keeps real headroom with a wide font and long, unbroken text', async () => {
  test.setTimeout(180_000);
  const userDataDir = await mkdtemp(join(tmpdir(), 'ovr-e2e-wide-font-'));
  seedFollowUpsCase(userDataDir);
  const electronApp = await launchApp(userDataDir, { appId: `ovr-e2e-wide-font-${process.pid}` });
  try {
    const window = await electronApp.firstWindow();
    await window.waitForLoadState('domcontentloaded');
    await dismissWelcomeModalIfShown(window);
    await window.evaluate(async (unbroken) => {
      await self.workspace.createApplication({
        role: `Senior-Frontend-Engineer-for-International-Design-Systems-${unbroken}`,
        company: unbroken,
        location: 'Amsterdam-Zuidoost-Noord-Holland-Netherlands-European-Union',
        verification: 'Official employer page verified by the sponsor register',
        status: 'applied',
        appliedAt: '2024-01-02T09:00:00.000Z',
        nextStep: `Review-the-prepared-application-documents-${unbroken}`,
        contact: 'recruiting-team-with-a-long-name-for-the-hiring-process@example.invalid',
      });
    }, UNBROKEN);
    await window.addStyleTag({ content: `*, *::before, *::after { font-family: ${WIDE_FONTS} !important; }` });

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
          const container = window.getByTestId('applications-responsive-table');
          await expect(container).toBeVisible();
          await expect(container.getByTestId('follow-up-summary').first()).toBeVisible();
          await window.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

          const report = await container.evaluate((root, share) => {
            const table = root.querySelector('table') as HTMLTableElement;
            const rootRect = root.getBoundingClientRect();
            const font = getComputedStyle(table.querySelector('td') as HTMLElement).fontFamily;
            const cards = getComputedStyle(table).display === 'block';

            const controls = [...root.querySelectorAll<HTMLElement>('button, select')].flatMap((control) => {
              const rect = control.getBoundingClientRect();
              return [
                {
                  name: control.getAttribute('aria-label') ?? control.tagName,
                  left: rect.left,
                  right: rect.right,
                  top: rect.top,
                  bottom: rect.bottom,
                  drawn: rect.width > 0 && rect.height > 0,
                },
              ];
            });
            const overlaps: string[] = [];
            for (let a = 0; a < controls.length; a += 1) {
              for (let b = a + 1; b < controls.length; b += 1) {
                const x = Math.min(controls[a]!.right, controls[b]!.right) - Math.max(controls[a]!.left, controls[b]!.left);
                const y = Math.min(controls[a]!.bottom, controls[b]!.bottom) - Math.max(controls[a]!.top, controls[b]!.top);
                if (x > 1 && y > 1) overlaps.push(`${controls[a]!.name} / ${controls[b]!.name}`);
              }
            }

            // Text must be fully visible: no cell may let its own content spill past its right edge.
            const spilled = [...root.querySelectorAll<HTMLElement>('td')]
              .filter((cell) => cell.scrollWidth > cell.clientWidth + 1)
              .map((cell) => cell.getAttribute('data-label') ?? 'cell');

            // The narrowest width the table can take, measured on the live table.
            const before = table.style.width;
            let minContent = 0;
            if (!cards) {
              table.style.width = '1px';
              minContent = table.getBoundingClientRect().width;
              table.style.width = before;
            }
            return {
              font,
              cards,
              clientWidth: root.clientWidth,
              scrollWidth: root.scrollWidth,
              minContent,
              limit: rootRect.width * share,
              controls: controls.map((c) => ({ name: c.name, drawn: c.drawn, inside: c.left >= rootRect.left - 1 && c.right <= rootRect.right + 1 })),
              overlaps,
              spilled,
            };
          }, MAX_MIN_CONTENT_SHARE);

          expect(report.scrollWidth, `${where}: sideways overflow (font ${report.font})`).toBeLessThanOrEqual(report.clientWidth + 1);
          expect(report.controls.length, `${where}: has controls`).toBeGreaterThan(6);
          for (const control of report.controls) {
            expect(control.drawn, `${where}: ${control.name} is drawn`).toBe(true);
            expect(control.inside, `${where}: ${control.name} is inside the table`).toBe(true);
          }
          expect(report.overlaps, `${where}: controls overlap`).toEqual([]);
          expect(report.spilled, `${where}: text spills out of its cell`).toEqual([]);
          if (!report.cards) {
            expect(report.minContent, `${where}: narrowest table width ${report.minContent}px against ${report.clientWidth}px`).toBeLessThanOrEqual(report.limit);
          }

          // The seeded overdue row keeps its summary and every action reachable by name.
          const overdue = container.getByRole('row').filter({ hasText: OVERDUE_ROW.company });
          await expect(overdue.getByTestId('follow-up-summary')).toContainText('1 overdue');
          for (const name of [/^Follow-ups for /, /^Edit /, /^Archive /, /^Delete /]) {
            const button = overdue.getByRole('button', { name });
            await expect(button, `${where}: ${String(name)} visible`).toBeVisible();
            await button.focus();
            await expect(button, `${where}: ${String(name)} focusable`).toBeFocused();
          }
        }
      }
    }
  } finally {
    await electronApp.close();
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
