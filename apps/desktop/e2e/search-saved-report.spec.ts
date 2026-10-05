import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { dismissWelcomeModalIfShown, goto, launchApp } from './fixtures.js';

const REPORT = {
  runId: 'e2e-saved-report',
  generatedAt: '2026-10-02T00:23:00.000Z',
  profileVersion: 'global-remote-profile-v1',
  scanBounds: { mode: 'focused', resultCap: null, resultCountBeforeCap: 1, complete: true, completenessReason: null },
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
    discoveryListings: 1,
    discoveryUniqueListings: 1,
    discoveryOfficialReviewCandidates: 1,
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
  discoverySources: [
    {
      id: 'remotive:all',
      provider: 'remotive',
      url: 'https://example.invalid/remotive',
      requests: 1,
      listings: 1,
      status: 'success',
      error: null,
      networkAttempts: 1,
      retries: 0,
      complete: true,
      completenessReason: null,
      continuationCursor: null,
      focusedScan: { requested: { role: 'Frontend Engineer' }, applied: [], deferred: [], unsupported: [] },
    },
  ],
  strictMatches: [],
  manualReview: [],
  nearMisses: [],
  excludedOrInactive: [],
  blockedOrErrored: [],
  officialAudit: [],
  discoveryAudit: [
    {
      key: 'saved-report-1',
      provider: 'remotive',
      company: 'Northstar Labs',
      title: 'Frontend Engineer',
      url: 'https://example.invalid/jobs/saved-report-1',
      location: 'Worldwide',
      postedAt: null,
      profileScore: 80,
      worldwideSponsorMatch: null,
    },
  ],
  methodology: [],
  attribution: [],
};

test('a saved focused report reopens with its role and search date', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'ovr-saved-report-'));
  const vacancyEngineDataRoot = await mkdtemp(join(tmpdir(), 'ovr-saved-report-engine-'));
  try {
    await mkdir(join(vacancyEngineDataRoot, 'reports', 'global-remote'), { recursive: true });
    await writeFile(
      join(vacancyEngineDataRoot, 'reports', 'global-remote', 'latest.json'),
      JSON.stringify(REPORT),
      'utf8',
    );
    const electronApp = await launchApp(userDataDir, {
      appId: `ovr-e2e-saved-report-${process.pid}`,
      vacancyEngineDataRoot,
    });
    try {
      const window = await electronApp.firstWindow();
      await window.waitForLoadState('domcontentloaded');
      await dismissWelcomeModalIfShown(window);
      await goto(window, 'Search');
      await expect(window.getByRole('searchbox', { name: 'Role or keywords' })).toHaveValue('Frontend Engineer', {
        timeout: 20_000,
      });
      await expect(window.getByText(/1 vacancy for Frontend Engineer · searched /)).toBeVisible();
    } finally {
      await electronApp.close();
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
    await rm(vacancyEngineDataRoot, { recursive: true, force: true });
  }
});
