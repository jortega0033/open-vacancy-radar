import { defineConfig } from 'vitest/config';

/**
 * Added by ADI-04 purely for `globalSetup`. Everything else is vitest's default, which is what
 * this package ran on before.
 *
 * The setup exists because `spawnProcess` now routes every Windows spawn through the shipped Job
 * Object host (`apps/daemon/dist/agent-dock-job-host.exe`). Without it, *every* process-spawning
 * test on Windows would fail with ENOENT — not just the new ones — in any checkout where
 * `pnpm build` has not been run yet, which includes a fresh clone and a cold CI runner. Building
 * it here keeps that dependency invisible to the existing test files, none of which had to change.
 */
export default defineConfig({
  test: {
    globalSetup: ['./test/support/global-setup.ts'],
  },
});
