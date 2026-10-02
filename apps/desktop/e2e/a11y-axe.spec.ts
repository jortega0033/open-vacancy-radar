import AxeBuilder from '@axe-core/playwright';
import { expect, goto, test } from './fixtures.js';

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
 * Not covered here: Ctrl+= zoom (needs the zoom menu, not merged on master yet), and states behind
 * interaction (drawers, dialogs): this audits each page's resting state with an empty workspace.
 */

const PAGES = ['Search', 'Saved Jobs', 'Applications', 'CV', 'Letters', 'AI Runtime', 'Settings'] as const;
type PageName = (typeof PAGES)[number];

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const CONFIGS = [
  { name: 'light 1280x800', theme: 'openvacancyradar', width: 1280, height: 800 },
  { name: 'dark 1280x800', theme: 'openvacancyradar-dark', width: 1280, height: 800 },
  { name: 'light 760x600 (minimum)', theme: 'openvacancyradar', width: 760, height: 600 },
  { name: 'dark 760x600 (minimum)', theme: 'openvacancyradar-dark', width: 760, height: 600 },
] as const;

/** Known violations per page, one comment per rule id. Only ever remove entries. */
const BASELINE: Record<PageName, string[]> = {
  Search: [    // AppSidebar's size-7 avatar circle carries an aria attribute its role does not allow (shell, every page).
    'aria-prohibited-attr',
    // Light theme only: text-base-content/50 sidebar footer line and the page title subtitle.
    'color-contrast',
  ],
  'Saved Jobs': [    // AppSidebar's size-7 avatar circle carries an aria attribute its role does not allow (shell, every page).
    'aria-prohibited-attr',
    // Light theme only: sidebar footer line and the page title subtitle.
    'color-contrast',
  ],
  Applications: [    // AppSidebar's size-7 avatar circle carries an aria attribute its role does not allow (shell, every page).
    'aria-prohibited-attr',
    // Light theme only: sidebar footer, subtitle, inactive tabs and the Review queue button.
    'color-contrast',
  ],
  CV: [    // AppSidebar's size-7 avatar circle carries an aria attribute its role does not allow (shell, every page).
    'aria-prohibited-attr',
    // Light theme only: sidebar footer line and the page title subtitle.
    'color-contrast',
  ],
  Letters: [    // AppSidebar's size-7 avatar circle carries an aria attribute its role does not allow (shell, every page).
    'aria-prohibited-attr',
    // Light theme only: sidebar footer, subtitle and an inactive tab.
    'color-contrast',
  ],
  'AI Runtime': [    // AppSidebar's size-7 avatar circle carries an aria attribute its role does not allow (shell, every page).
    'aria-prohibited-attr',
    // Light theme only: sidebar footer, subtitle and the intro paragraphs.
    'color-contrast',
  ],
  Settings: [    // AppSidebar's size-7 avatar circle carries an aria attribute its role does not allow (shell, every page).
    'aria-prohibited-attr',
    // Light theme only: sidebar footer, a paragraph and the inactive tabs.
    'color-contrast',
  ],
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
