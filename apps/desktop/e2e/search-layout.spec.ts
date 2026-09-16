import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { dismissWelcomeModalIfShown, ensureLightTheme, goto, launchApp } from './fixtures.js';

const REPORT = {
  runId: 'e2e-search-layout',
  generatedAt: '2026-09-12T00:00:00.000Z',
  profileVersion: 'global-remote-profile-v1',
  criteria: {
    role: 'frontend',
    fullyRemote: true,
    applicantLocation: 'anywhere-outside-us-nl',
    usCitizenshipRequired: false,
    minimumAnnualBaseUsd: 100_000,
    currency: 'USD',
  },
  statistics: {
    discoveryRequests: 1,
    discoveryListings: 30,
    discoveryUniqueListings: 30,
    discoveryOfficialReviewCandidates: 30,
    officialBoardsOrPagesAttempted: 0,
    officialRequests: 0,
    strictMatches: 0,
    manualReview: 0,
    nearMisses: 0,
    excludedOrInactive: 0,
    blockedOrErrored: 0,
    registrySources: 0,
    activeRegistrySources: 0,
    gatedRegistrySources: 0,
    manualOrProhibitedRegistrySources: 0,
  },
  sourceRegistry: [],
  discoverySources: [],
  strictMatches: [],
  manualReview: [],
  nearMisses: [],
  excludedOrInactive: [],
  blockedOrErrored: [],
  officialAudit: [],
  discoveryAudit: Array.from({ length: 30 }, (_, index) => ({
    key: `layout-vacancy-${index + 1}`,
    provider: 'remotive',
    company:
      index === 0
        ? 'Northstar Labs International Product Engineering and Platform Operations'
        : 'Northstar Labs',
    title:
      index === 0
        ? 'Senior Frontend Engineer, Design Systems and Developer Experience for International Products'
        : `Frontend Engineer ${index + 1}`,
    url: `https://example.invalid/jobs/layout-vacancy-${index + 1}`,
    location: 'Netherlands',
    employmentType: 'full_time',
    currency: 'EUR',
    salaryPeriod: 'year',
    advertisedMinimum: 70_000,
    annualizedMinimumUsd: 82_000,
    decision: 'official_review_candidate',
    reasons: ['Frontend role'],
    contentHash: `layout-content-hash-${index + 1}`,
    description: 'Build accessible interfaces. '.repeat(120),
    postedAt: '2026-09-01T00:00:00.000Z',
    profileScore: 82,
    worldwideSponsorMatch: null,
  })),
  methodology: [],
  attribution: [],
};

test('populated Search owns its desktop edges and keeps narrow gutters', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'ovr-search-layout-'));
  const vacancyEngineDataRoot = await mkdtemp(join(tmpdir(), 'ovr-search-layout-engine-'));
  const reportPath = join(vacancyEngineDataRoot, 'reports', 'global-remote', 'latest.json');
  try {
    await mkdir(join(vacancyEngineDataRoot, 'reports', 'global-remote'), { recursive: true });
    await writeFile(reportPath, JSON.stringify(REPORT), 'utf8');

    const electronApp = await launchApp(userDataDir, {
      appId: `ovr-e2e-search-layout-${process.pid}`,
      vacancyEngineDataRoot,
    });
    try {
      const window = await electronApp.firstWindow();
      await window.waitForLoadState('domcontentloaded');
      // No CV exists yet at this point (the one below is created after, live) and this launch's
      // user-data dir is fresh, so `WelcomeModal` will be showing -- unlike
      // `manual-application-review.spec.ts`, which seeds its CV before `launchApp` ever runs.
      await dismissWelcomeModalIfShown(window);
      await ensureLightTheme(window);
      await window.evaluate(() =>
        self.workspace.createCvDocument({
          name: 'Layout QA CV',
          kind: 'manual',
          text: 'Senior Frontend Engineer with eight years building Angular and TypeScript interfaces.',
          profile: {
            title: 'Senior Frontend Engineer',
            years: '8',
            skills: ['Angular', 'TypeScript', 'Accessibility'],
            summary: 'Builds accessible product interfaces and design systems.',
          },
        }),
      );
      await goto(window, 'Search');
      await expect(window.getByText('Connecting to local daemon…')).toBeHidden({ timeout: 20_000 });
      await expect(window.getByText(/^Daemon unavailable:/)).toHaveCount(0);
      await expect(window.getByLabel('Vacancy details')).toBeVisible();

      let sidebarCollapsed = false;
      for (const theme of ['openvacancyradar', 'openvacancyradar-dark']) {
        await window.evaluate((nextTheme) => {
          document.documentElement.dataset.theme = nextTheme;
        }, theme);
        for (const collapsed of [false, true]) {
          if (collapsed !== sidebarCollapsed) {
            await window
              .getByRole('button', {
                name: collapsed ? 'Collapse sidebar' : 'Expand sidebar',
              })
              .click();
            sidebarCollapsed = collapsed;
          }
          for (const viewport of [
            { name: 'default', width: 1000, height: 720, desktop: false },
            { name: 'expanded-details', width: 800, height: 600, desktop: false },
            { name: 'wide', width: 1440, height: 900, desktop: true },
            { name: 'narrow', width: 760, height: 820, desktop: false },
          ]) {
            await electronApp.evaluate(
              ({ BrowserWindow }, bounds) => {
                BrowserWindow.getAllWindows()[0]?.setBounds(bounds);
              },
              { width: viewport.width, height: viewport.height },
            );
            await window.waitForTimeout(100);

            const geometry = await window.evaluate(() => {
              const main = document.querySelector('main')?.getBoundingClientRect();
              const controls = document
                .querySelector<HTMLInputElement>('[role="searchbox"]')
                ?.getBoundingClientRect();
              const resultsScroller = document.querySelector<HTMLElement>(
                '[aria-label="Vacancy results"]',
              );
              const detailScroller = document.querySelector<HTMLElement>(
                '[aria-label="Vacancy details"]',
              );
              const results = resultsScroller?.parentElement?.getBoundingClientRect();
              const detail = detailScroller?.getBoundingClientRect();
              const workspace =
                resultsScroller?.parentElement?.parentElement?.getBoundingClientRect();
              const summaryGrid =
                detailScroller?.querySelector<HTMLElement>(':scope > div > div.grid');
              const footer = [...document.querySelectorAll('p')]
                .find((element) => element.textContent?.startsWith('Run e2e-search-layout'))
                ?.parentElement?.getBoundingClientRect();
              if (
                !main ||
                !controls ||
                !resultsScroller ||
                !detailScroller ||
                !results ||
                !detail ||
                !summaryGrid
              )
                throw new Error('Search layout is incomplete');
              resultsScroller.scrollTop = 80;
              detailScroller.scrollTop = 80;
              return {
                mainLeft: main.left,
                mainRight: main.right,
                controlsLeft: controls.left,
                resultsLeft: results.left,
                detailRight: detail.right,
                horizontalOverflow:
                  document.documentElement.scrollWidth - document.documentElement.clientWidth,
                listHorizontalOverflow: resultsScroller.scrollWidth - resultsScroller.clientWidth,
                detailHorizontalOverflow: detailScroller.scrollWidth - detailScroller.clientWidth,
                summaryColumnCount: (() => {
                  const top = Math.round(summaryGrid.children[0]?.getBoundingClientRect().top ?? 0);
                  return [...summaryGrid.children].filter(
                    (child) => Math.round(child.getBoundingClientRect().top) === top,
                  ).length;
                })(),
                listScrollTop: resultsScroller.scrollTop,
                detailScrollTop: detailScroller.scrollTop,
                mainScrollTop: document.querySelector('main')?.scrollTop ?? -1,
                footerGap: workspace && footer ? footer.top - workspace.bottom : -1,
                listOverflow: getComputedStyle(resultsScroller).overflowY,
                detailOverflow: getComputedStyle(detailScroller).overflowY,
              };
            });

            expect(geometry.controlsLeft - geometry.mainLeft).toBeCloseTo(24, 0);
            expect(geometry.horizontalOverflow).toBeLessThanOrEqual(0);
            expect(geometry.listHorizontalOverflow).toBeLessThanOrEqual(0);
            expect(geometry.detailHorizontalOverflow).toBeLessThanOrEqual(0);
            expect(geometry.listScrollTop).toBeGreaterThan(0);
            expect(geometry.detailScrollTop).toBeGreaterThan(0);
            expect(geometry.mainScrollTop).toBe(0);
            expect(geometry.footerGap).toBeGreaterThanOrEqual(0);
            expect(geometry.listOverflow).toBe('auto');
            expect(geometry.detailOverflow).toBe('auto');
            if (viewport.name === 'expanded-details' && !collapsed)
              expect(geometry.summaryColumnCount).toBe(1);
            if (viewport.desktop) {
              expect(geometry.resultsLeft).toBeCloseTo(geometry.mainLeft, 0);
              expect(geometry.detailRight).toBeCloseTo(geometry.mainRight, 0);
            } else {
              expect(geometry.resultsLeft - geometry.mainLeft).toBeCloseTo(24, 0);
              expect(geometry.mainRight - geometry.detailRight).toBeCloseTo(24, 0);
            }

            const screenshotPath = test
              .info()
              .outputPath(
                `search-layout-${theme}-${collapsed ? 'collapsed' : 'expanded'}-${viewport.name}.png`,
              );
            await window.screenshot({ animations: 'disabled', path: screenshotPath });
            await test
              .info()
              .attach(
                `search-layout-${theme}-${collapsed ? 'collapsed' : 'expanded'}-${viewport.name}`,
                {
                  path: screenshotPath,
                  contentType: 'image/png',
                },
              );
          }
        }
      }

      await window.getByRole('button', { name: 'Use for AI' }).click();
      await expect(window.getByRole('heading', { name: 'CV assistant' })).toBeVisible();
      await expect(window.getByRole('heading', { name: 'CV-only tools' })).toBeVisible();
      await expect(window.getByRole('heading', { name: 'Vacancy tools' })).toBeVisible();
      await expect(window.getByRole('tab', { name: 'Resume audit' })).toBeVisible();
      await expect(window.getByRole('tab', { name: 'Improve achievements' })).toBeVisible();
      await expect(window.getByRole('tab', { name: 'Best-fit roles' })).toBeVisible();
      await expect(window.getByRole('button', { name: 'Check ATS fit' })).toBeVisible();
      await expect(window.getByRole('button', { name: 'Draft tailored CV' })).toBeVisible();

      for (const viewport of [
        { name: 'assistant-minimum', width: 640, height: 480 },
        { name: 'assistant-desktop', width: 1000, height: 720 },
      ]) {
        await electronApp.evaluate(
          ({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0]?.setBounds(bounds),
          viewport,
        );
        await window.waitForTimeout(100);
        const tablist = window.getByRole('tablist', { name: 'CV review mode' });
        await tablist.scrollIntoViewIfNeeded();
        const geometry = await tablist.evaluate((tablist) => {
          const rect = tablist.getBoundingClientRect();
          const buttons = [...tablist.querySelectorAll('button')];
          return {
            left: rect.left,
            right: rect.right,
            viewportWidth: document.documentElement.clientWidth,
            pageOverflow:
              document.documentElement.scrollWidth - document.documentElement.clientWidth,
            tabOverflow: tablist.scrollWidth - tablist.clientWidth,
            buttonOverflow: buttons.some((button) => button.scrollWidth > button.clientWidth),
          };
        });
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
        expect(geometry.pageOverflow).toBeLessThanOrEqual(0);
        expect(geometry.tabOverflow).toBeLessThanOrEqual(0);
        expect(geometry.buttonOverflow).toBe(false);

        const screenshotPath = test.info().outputPath(`${viewport.name}.png`);
        await window.screenshot({ animations: 'disabled', path: screenshotPath });
        await test.info().attach(viewport.name, { path: screenshotPath, contentType: 'image/png' });
      }
    } finally {
      await electronApp.close();
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
    await rm(vacancyEngineDataRoot, { recursive: true, force: true });
  }
});

/**
 * Regression for open-vacancy-radar#385: below `lg` (1024px), `SearchPage` stacks the vacancy
 * list above the detail/empty-state pane in a column flex. When no vacancy is selected -- the
 * default state whenever `visible` (the filtered result set) is empty, since the page's own
 * auto-select effect only ever has something to select from a non-empty list -- the empty-state
 * pane used to have no `min-h-0` of its own, so `EmptyState`'s hard `min-h-64` (256px) claimed the
 * limited column height first and the list pane (the only side that already had `min-h-0`)
 * absorbed the shortage, collapsing to a sliver. A report with zero vacancies is a stable, always-
 * empty `visible` -- `worldwideReport` is still non-null (`hasReport` stays true, so this is the
 * same "a report is loaded" rendering path the real bug was reported against, not the "no report
 * yet" onboarding state), but there is nothing for the auto-select effect to ever select, so
 * `selected` stays permanently `null`. That statelessness is exactly what makes this reachable for
 * an automated assertion at all: the exact moment right after a *non-empty* report first loads is
 * also `selected === null` for a single render, but the auto-select effect corrects it before
 * anything can observe it, which is why this test uses a report that never gives it anything to
 * correct into.
 */
test('a zero-vacancy Search report at narrow widths keeps both panes at a real, non-collapsed height', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'ovr-search-layout-empty-'));
  const vacancyEngineDataRoot = await mkdtemp(join(tmpdir(), 'ovr-search-layout-empty-engine-'));
  const reportPath = join(vacancyEngineDataRoot, 'reports', 'global-remote', 'latest.json');
  try {
    await mkdir(join(vacancyEngineDataRoot, 'reports', 'global-remote'), { recursive: true });
    await writeFile(reportPath, JSON.stringify({ ...REPORT, discoveryAudit: [] }), 'utf8');

    const electronApp = await launchApp(userDataDir, {
      appId: `ovr-e2e-search-layout-zero-${process.pid}`,
      vacancyEngineDataRoot,
    });
    try {
      const window = await electronApp.firstWindow();
      await window.waitForLoadState('domcontentloaded');
      await dismissWelcomeModalIfShown(window);
      await goto(window, 'Search');
      await expect(window.getByText('Connecting to local daemon…')).toBeHidden({ timeout: 20_000 });

      await electronApp.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0]?.setBounds(bounds), {
        width: 800,
        height: 600,
      });
      await window.waitForTimeout(100);

      // `SearchResultList` (the list pane) shows its own "No vacancies found" `EmptyState` when
      // the loaded report has zero rows (`SearchResultList.tsx:163`), so both stacked panes carry
      // real, hard-minimum content (`EmptyState`'s own `min-h-64`) at once -- exactly the shape
      // that exposes the bug: before this fix, only the list pane had `min-h-0` of its own, so it
      // alone absorbed the deficit down to a sliver while the (unfixed) detail/empty-state pane
      // kept its full natural height. With both panes carrying `min-h-0`, the column's shortage
      // splits between them instead, matching `SearchResultList.tsx`'s own comment on the sibling
      // `VacancyDetail` fix ("gives the two panes an even split of the column").
      await expect(window.getByRole('heading', { name: 'No vacancies found' })).toBeVisible();
      await expect(window.getByRole('heading', { name: 'Select a vacancy' })).toBeVisible();

      const heights = await window.evaluate(() => {
        const heightOf = (headingText: string) => {
          const heading = [...document.querySelectorAll('h2')].find((el) => el.textContent === headingText);
          return heading?.closest('.min-h-0')?.getBoundingClientRect().height ?? -1;
        };
        return { list: heightOf('No vacancies found'), detail: heightOf('Select a vacancy') };
      });

      // Real, measured before/after values at this exact window size (800x600, well below `lg`):
      // pre-fix the list pane was crushed to literally 0px while the detail pane kept ~185px; with
      // the fix both panes get a real, comfortably-nonzero share (~55-95px here -- the two
      // EmptyStates' combined minimums genuinely exceed what an 800x600 window has left after its
      // own header/filter-bar chrome, so neither pane reaching its full ~256px content height is
      // expected and fine; the bug was one side getting *none* of the shortfall, not both sides
      // being finite). The ratio check is the one that actually distinguishes "evenly shared" from
      // "one pane crushed": pre-fix it was 0, post-fix it is close to 1.
      expect(heights.list).toBeGreaterThan(30);
      expect(heights.detail).toBeGreaterThan(30);
      expect(heights.list / heights.detail).toBeGreaterThan(0.4);
      expect(heights.list / heights.detail).toBeLessThan(2.5);
    } finally {
      await electronApp.close();
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
    await rm(vacancyEngineDataRoot, { recursive: true, force: true });
  }
});
