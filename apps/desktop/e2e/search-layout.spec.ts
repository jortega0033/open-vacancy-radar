import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { ensureLightTheme, goto, launchApp } from './fixtures.js';

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
    company: 'Northstar Labs',
    title: `Frontend Engineer ${index + 1}`,
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
      await ensureLightTheme(window);
      await goto(window, 'Search');
      await expect(window.getByText('Connecting to local daemon…')).toBeHidden({ timeout: 20_000 });
      await expect(window.getByText(/^Daemon unavailable:/)).toHaveCount(0);
      await expect(window.getByLabel('Vacancy details')).toBeVisible();

      for (const viewport of [
        { name: 'default', width: 1000, height: 720, desktop: false },
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
          const workspace = resultsScroller?.parentElement?.parentElement?.getBoundingClientRect();
          const footer = [...document.querySelectorAll('p')]
            .find((element) => element.textContent?.startsWith('Run e2e-search-layout'))
            ?.parentElement?.getBoundingClientRect();
          if (!main || !controls || !resultsScroller || !detailScroller || !results || !detail)
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
        if (viewport.desktop) {
          expect(geometry.resultsLeft).toBeCloseTo(geometry.mainLeft, 0);
          expect(geometry.detailRight).toBeCloseTo(geometry.mainRight, 0);
        } else {
          expect(geometry.resultsLeft - geometry.mainLeft).toBeCloseTo(24, 0);
          expect(geometry.mainRight - geometry.detailRight).toBeCloseTo(24, 0);
        }

        const screenshotPath = test.info().outputPath(`search-layout-${viewport.name}.png`);
        await window.screenshot({ animations: 'disabled', path: screenshotPath });
        await test.info().attach(`search-layout-${viewport.name}`, {
          path: screenshotPath,
          contentType: 'image/png',
        });
      }
    } finally {
      await electronApp.close();
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
    await rm(vacancyEngineDataRoot, { recursive: true, force: true });
  }
});
