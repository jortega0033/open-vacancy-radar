import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execCapture } from '@agent-dock/agent-runtime';

export interface SyntheticWorkspace {
  cwd: string;
}

/** Spawns through `execCapture` (ADI-15's environment allowlist), not a bare `node:child_process`
 * call -- this repo restricts that import repo-wide precisely so a spawn like this one can't
 * silently skip the same review every provider-CLI spawn already goes through. */
async function git(cwd: string, args: string[]): Promise<void> {
  const result = await execCapture('git', args, { cwd });
  if (result.timedOut || result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (code ${result.code}, timed out ${result.timedOut}): ${result.stderr}`);
  }
}

/**
 * A throwaway, real Git workspace for one live smoke case -- ADI-19 requires a synthetic temporary
 * Git workspace, not the operator's real repository. Always removes the directory afterward, even
 * if `run` throws, so a crashed smoke case can never leave provider-touched state behind on disk.
 */
export async function withSyntheticWorkspace<T>(run: (workspace: SyntheticWorkspace) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'agent-dock-live-smoke-'));
  try {
    await git(root, ['init', '--initial-branch=main']);
    await git(root, ['config', 'user.email', 'live-smoke@agent-dock.invalid']);
    await git(root, ['config', 'user.name', 'AgentDock Live Smoke']);
    await git(root, ['commit', '--allow-empty', '-m', 'live smoke synthetic workspace']);
    return await run({ cwd: root });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
