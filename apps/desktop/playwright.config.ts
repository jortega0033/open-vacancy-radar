import { defineConfig } from '@playwright/test';

/**
 * Drives the real, built Electron app (`dist-electron/main.js` + the `dist/` renderer) rather than
 * a browser: there is no `webServer` to start here, so `pnpm build` must have already produced
 * both before `pnpm test:e2e` runs (the e2e CI job does this in one job, in order).
 *
 * Screenshot baselines are committed under `e2e/**\/*-snapshots/`, named per-platform by Playwright
 * itself (`-win32-`/`-linux-` suffixes). The CI job runs on the same `ubuntu-latest` runner as
 * `ci.yml`'s main build, so its baselines stay meaningful across contributors regardless of what OS
 * they develop on locally.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  // Each test's --user-data-dir is isolated, but the daemon every launch spawns (electron/main.ts's
  // spawnDaemon) writes its discovery file to a fixed path keyed only by AGENT_DOCK_APP_ID, the
  // same id for every test process. Two Electron instances running at once would race on that file
  // (assertNoLiveDaemon in apps/desktop/electron/discovery-file.ts throws if it finds another one's
  // PID still alive), so tests must run one at a time, not just isolated from each other's data.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['github']] : 'list',
  expect: {
    // Electron's own chrome (menu bar, title bar) and minor anti-aliasing differences are not
    // worth chasing pixel-for-pixel; this catches real layout/content regressions without flaking
    // on sub-pixel rendering noise between runs on the same machine.
    toHaveScreenshot: { maxDiffPixelRatio: 0.02 },
  },
});
