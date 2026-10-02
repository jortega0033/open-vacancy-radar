import type { ProviderId } from '@agent-dock/shared';

export type DesktopPlatform = 'windows' | 'macos' | 'linux' | 'unknown';

export function detectPlatform(userAgent: string): DesktopPlatform {
  if (/windows/i.test(userAgent)) return 'windows';
  if (/macintosh|mac os x/i.test(userAgent)) return 'macos';
  if (/linux|x11/i.test(userAgent)) return 'linux';
  return 'unknown';
}

export interface InstallCommand {
  /** What to paste. */
  command: string;
  /** Where to run it, e.g. "PowerShell" or "a terminal". */
  shell: string;
}

export interface ProviderGuidance {
  /** Official installation page. Always an https URL. */
  guideUrl: string;
  /** Absent when no command is verified for this platform: the guide is shown instead. */
  install?: InstallCommand;
  /** Typed in a terminal to sign in. */
  loginCommand: string;
}

// Commands and pages below are copied from each vendor's own current install documentation
// (Claude Code: code.claude.com/docs/en/setup, Codex: learn.chatgpt.com/docs/codex/cli). Add a
// platform here only after checking it against those pages; a missing entry falls back to the guide.
const CLAUDE_GUIDE = 'https://code.claude.com/docs/en/setup';
const CODEX_GUIDE = 'https://learn.chatgpt.com/docs/codex/cli';

export function providerGuidance(provider: ProviderId, platform: DesktopPlatform): ProviderGuidance {
  if (provider === 'claude') {
    const install: InstallCommand | undefined =
      platform === 'windows'
        ? { command: 'irm https://claude.ai/install.ps1 | iex', shell: 'PowerShell' }
        : platform === 'macos' || platform === 'linux'
          ? { command: 'curl -fsSL https://claude.ai/install.sh | bash', shell: 'a terminal' }
          : undefined;
    return { guideUrl: CLAUDE_GUIDE, ...(install ? { install } : {}), loginCommand: 'claude' };
  }
  const install: InstallCommand | undefined =
    platform === 'macos' || platform === 'linux'
      ? { command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh', shell: 'a terminal' }
      : undefined;
  return { guideUrl: CODEX_GUIDE, ...(install ? { install } : {}), loginCommand: 'codex login' };
}
