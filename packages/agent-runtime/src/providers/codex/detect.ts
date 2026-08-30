import type { AuthStatus, ProviderStatus } from '@agent-dock/shared';
import { execCapture } from '../../process/exec-capture.js';
import { findExecutable } from '../../detect-executable.js';
import type { Logger } from '../../logger.js';
import { CODEX_CAPABILITIES } from './capabilities.js';

const EXECUTABLE_NAMES = ['codex'];

/**
 * Parses the combined stdout and stderr from `codex login status` (AD-16). Kept separate from
 * `detectCodex` so it's testable with captured output strings, no CLI or account needed. `codex
 * login status` has no `--json` flag, so this is a conservative regex match against short
 * human-readable lines rather than guessing: falls back to `'unknown'` for anything that doesn't
 * clearly say one way or the other, since a wrong "authenticated: 'authenticated'" is far worse
 * than an honest "unknown".
 */
export function parseCodexLoginStatus(output: string): AuthStatus {
  if (/logged in/i.test(output) && !/not logged in/i.test(output)) return 'authenticated';
  if (/not logged in|not authenticated|no credentials/i.test(output)) return 'unauthenticated';
  return 'unknown';
}

/**
 * Detects the Codex CLI and its login state via `codex login status`, which prints a short
 * human-readable line ("Logged in using ChatGPT" / "Logged in using API key" / not-logged-in
 * variants) rather than JSON. We pattern-match conservatively and fall back to 'unknown' rather
 * than guessing, since a wrong "authenticated: 'authenticated'" is far worse than an honest "unknown".
 */
export async function detectCodex(logger: Logger): Promise<ProviderStatus> {
  const base = { id: 'codex' as const, name: 'Codex', capabilities: CODEX_CAPABILITIES };

  const executablePath = await findExecutable(EXECUTABLE_NAMES);
  if (!executablePath) {
    return { ...base, installed: false, authenticated: 'unknown' };
  }

  const versionResult = await execCapture(executablePath, ['--version'], { timeoutMs: 8_000 });
  if (versionResult.code !== 0) {
    logger.warn('codex: --version failed', { code: versionResult.code });
    return {
      ...base,
      installed: true,
      authenticated: 'unknown',
      executablePath,
      error: 'codex --version failed.',
    };
  }
  const versionMatch = versionResult.stdout.trim().match(/[\d.]+/);
  const version = versionMatch?.[0];

  const statusResult = await execCapture(executablePath, ['login', 'status'], { timeoutMs: 15_000 });
  if (statusResult.timedOut) {
    return {
      ...base,
      installed: true,
      authenticated: 'unknown',
      executablePath,
      version,
      error: 'Login status check timed out.',
    };
  }

  const output = `${statusResult.stdout}\n${statusResult.stderr}`.trim();
  const authenticated = parseCodexLoginStatus(output);
  if (authenticated !== 'unknown') {
    return { ...base, installed: true, authenticated, executablePath, version };
  }

  return {
    ...base,
    installed: true,
    authenticated: 'unknown',
    executablePath,
    version,
    error: output.slice(0, 200) || 'Could not determine Codex login status.',
  };
}
