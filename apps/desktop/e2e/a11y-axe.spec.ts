import AxeBuilder from '@axe-core/playwright';
import { ensureLightTheme, expect, goto, launchApp, test } from './fixtures.js';
import { APPLY_COMPANY, APPLY_ROLE, seedApplyWorkspace } from './apply-workspace-seed.js';

/**
 * Issue #501: runs axe-core (WCAG 2.0/2.1 A and AA) over all seven pages, at a roomy size and at
 * the window's minimum size (`minWidth`/`minHeight` in electron/main.ts), in both themes.
 *
 * Violations that exist today must not fail CI, so each page has a BASELINE of rule ids that are
 * known to fire somewhere on it. The assertion is "found rule ids are a subset of the baseline":
 * a NEW rule fails, and when a fix removes the last occurrence of a rule, delete its baseline entry
 * (the stale-entry test below fails until you do, so the baseline can only shrink).
 *
 * The baseline is a union across the four size/theme runs, recorded from a real run (Windows,
 * Electron under Playwright). CI runs on Linux under xvfb, where fonts and rendering differ, so
 * color-contrast in particular can differ between platforms. If this spec fails on CI only, with
 * a rule id that is already in another page's baseline or a contrast result, add it with a comment
 * rather than weakening the check. Set AXE_RECORD=1 to record instead of assert: it prints the observed ids per page and the
 * offending selectors, to regenerate the baseline.
 *
 * Not covered here: Ctrl+= zoom (needs the zoom menu, not merged on master yet), and most states
 * behind interaction (drawers, dialogs): this audits each page's resting state with an empty
 * workspace. The Review & apply workspace (#657) is audited open, with a seeded application, below
 * and in `manual-application-review.spec.ts` (Search host).
 */

const PAGES = ['Search', 'Saved jobs', 'Applications', 'CV', 'Letters', 'AI runtime', 'Settings'] as const;
type PageName = (typeof PAGES)[number];

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const CONFIGS = [
  { name: 'light 1280x800', theme: 'openvacancyradar', width: 1280, height: 800 },
  { name: 'dark 1280x800', theme: 'openvacancyradar-dark', width: 1280, height: 800 },
  { name: 'light 760x600 (minimum)', theme: 'openvacancyradar', width: 760, height: 600 },
  { name: 'dark 760x600 (minimum)', theme: 'openvacancyradar-dark', width: 760, height: 600 },
] as const;

/**
 * Known violations. None: the sidebar avatar that used to fire `aria-prohibited-attr` on every page
 * is gone (#477). Only ever add an entry for an existing, tracked problem; a new one fails.
 */
const BASELINE: Record<PageName, string[]> = {
  Search: [],
  'Saved jobs': [],
  Applications: [],
  CV: [],
  Letters: [],
  'AI runtime': [],
  Settings: [],
};

const observed: Record<string, Set<string>> = Object.fromEntries(PAGES.map((p) => [p, new Set<string>()]));

test.describe('axe accessibility audit (issue #501)', () => {
  test.describe.configure({ mode: 'serial' });

  for (const config of CONFIGS) {
    test(`no new axe rule violations: ${config.name}`, async ({ electronApp, window }) => {
      test.setTimeout(120_000);
      await electronApp.evaluate(({ BrowserWindow }, bounds) => {
        BrowserWindow.getAllWindows()[0]?.setBounds(bounds);
      }, { x: 0, y: 0, width: config.width, height: config.height });
      await window.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, config.theme);

      const newViolations: string[] = [];
      for (const name of PAGES) {
        await goto(window, name);
        // Let the page's own async loads (counts, lists, runtime status) settle before auditing.
        await window.waitForTimeout(750);
        const results = await new AxeBuilder({ page: window })
          // Legacy mode: the default opens a second page, which Electron windows do not support.
          .setLegacyMode(true)
          .withTags(TAGS).analyze();
        for (const violation of results.violations) {
          observed[name]?.add(violation.id);
          if (process.env.AXE_RECORD) {
            console.log('AXE_NODES', config.name, name, violation.id, JSON.stringify(violation.nodes.map((n) => n.target)));
          }
          if (!BASELINE[name].includes(violation.id)) {
            newViolations.push(`${name}: ${violation.id} (${violation.nodes.length} nodes) ${violation.helpUrl}`);
          }
        }
      }
      if (process.env.AXE_RECORD) return;
      expect(newViolations, 'New axe rule violations, fix them or justify a baseline entry').toEqual([]);
    });
  }

  test('Saved jobs first-run hint meets contrast rules in both themes', async ({ window }) => {
    test.setTimeout(120_000);
    await goto(window, 'Saved jobs');
    await window.getByRole('button', { name: /add job manually/i }).first().click();
    const addDialog = window.getByRole('dialog', { name: /add saved job/i });
    await addDialog.getByLabel('Role').fill('Frontend Engineer');
    await addDialog.getByLabel('Company').fill('Example Company');
    await addDialog.getByRole('button', { name: /^save$/i }).click();
    await expect(addDialog).toBeHidden();

    const hint = window.getByRole('note').filter({ hasText: 'Get ready to apply' });
    await expect(hint).toBeVisible();
    for (const theme of ['openvacancyradar', 'openvacancyradar-dark']) {
      await window.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      const results = await new AxeBuilder({ page: window })
        .setLegacyMode(true)
        .include('[role="note"]')
        .withTags(TAGS)
        .analyze();
      expect(results.violations, `${theme} first-run hint accessibility violations`).toEqual([]);
    }
  });

  test('the Review & apply workspace opened from Ready to apply has no axe violations (#657)', async () => {
    test.setTimeout(120_000);
    const seeded = await seedApplyWorkspace('ovr-axe-apply-workspace');
    try {
      const app = await launchApp(seeded.userDataDir, {
        appId: `ovr-e2e-axe-apply-${process.pid}`,
        vacancyEngineDataRoot: seeded.vacancyEngineDataRoot,
      });
      try {
        const page = await app.firstWindow();
        await page.waitForLoadState('domcontentloaded');
        await ensureLightTheme(page);
        // With a seeded application the sidebar button's name carries its badge counts.
        await page.getByRole('complementary', { name: 'Main' }).getByRole('button', { name: /^Applications/ }).first().click();
        await page.getByRole('tab', { name: /^Ready to apply/ }).click();
        await page.getByRole('row', { name: new RegExp(APPLY_COMPANY) }).click();
        const region = page.getByRole('region', { name: `${APPLY_ROLE} at ${APPLY_COMPANY}` });
        await expect(region.getByRole('button', { name: 'Approve package' })).toBeVisible();
        await expect(region.getByRole('heading', { level: 2 })).toBeFocused();
        for (const config of CONFIGS) {
          await app.evaluate(({ BrowserWindow }, bounds) => {
            BrowserWindow.getAllWindows()[0]?.setBounds(bounds);
          }, { x: 0, y: 0, width: config.width, height: config.height });
          await page.evaluate((theme) => {
            document.documentElement.dataset.theme = theme;
          }, config.theme);
          await page.waitForTimeout(250);
          const results = await new AxeBuilder({ page }).setLegacyMode(true).withTags(TAGS).analyze();
          expect(
            results.violations.map((violation) => `${violation.id} ${JSON.stringify(violation.nodes.map((n) => n.target))}`),
            `${config.name}: Review & apply workspace axe violations`,
          ).toEqual([]);
        }
      } finally {
        await app.close();
      }
    } finally {
      await seeded.cleanup();
    }
  });

  test('baseline has no stale entries', () => {
    if (process.env.AXE_RECORD) {
      console.log('AXE_OBSERVED', JSON.stringify(Object.fromEntries(PAGES.map((p) => [p, [...(observed[p] ?? [])].sort()]))));
    }
    const stale = PAGES.flatMap((name) =>
      BASELINE[name].filter((id) => !observed[name]?.has(id)).map((id) => `${name}: ${id}`),
    );
    expect(stale, 'Remove these baseline entries, they no longer fire').toEqual([]);
  });
});
