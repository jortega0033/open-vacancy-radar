import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_HARDENED_DISALLOWED_TOOLS,
  CLAUDE_HARDENED_TOOLS,
  CLAUDE_HARDENING_ARGS,
  buildClaudeArgs,
} from '../src/providers/claude/build-args.js';
import type { StartSessionOptions } from '../src/types.js';

/**
 * ADI-08b (issue #126): the enforcement behind the "never use --bare" decision.
 *
 * The reasoning lives in `build-args.ts`'s doc comment; the short version is that the flag's own
 * help text on the pinned `claude` 2.1.228 build says "Anthropic auth is strictly ANTHROPIC_API_KEY
 * or apiKeyHelper via --settings (OAuth and keychain are never read)", which would force this
 * daemon to obtain and pass an API key -- the exact thing SECURITY.md's "What the daemon will never
 * do" list forbids, and the exact thing `providers/claude/adapter.ts` promises it does not do.
 *
 * A comment cannot stop a future maintainer from adding a flag. These two tests can.
 */

/** The flag, assembled at runtime so this file contains no quoted occurrence of it to find. */
const BARE_FLAG = `--${'bare'}`;

describe('--bare is never constructed into a Claude argv (ADI-08b)', () => {
  /**
   * Every shape `StartSessionOptions` can take that `buildClaudeArgs` actually branches on. This is
   * the behavioral half of the rule: whatever the source says, no combination of inputs may produce
   * the flag.
   */
  const shapes: StartSessionOptions[] = [];
  for (const resumeProviderSessionId of [undefined, 'thread-1']) {
    for (const model of [undefined, 'fable']) {
      for (const hardened of [undefined, false, true]) {
        shapes.push({
          sessionId: 'sess-1',
          cwd: '/tmp',
          prompt: 'hi',
          ...(resumeProviderSessionId === undefined ? {} : { resumeProviderSessionId }),
          ...(model === undefined ? {} : { model }),
          ...(hardened === undefined ? {} : { hardened }),
        });
      }
    }
  }

  it.each(shapes.map((shape, index) => [index, shape] as const))(
    'shape %i produces no --bare',
    (_index, shape) => {
      const args = buildClaudeArgs(shape);
      expect(args).not.toContain(BARE_FLAG);
      // Also as a substring, so it cannot arrive glued into a combined element such as
      // "--safe-mode --bare" or as part of a comma-joined tool value.
      expect(args.join(' ')).not.toContain(BARE_FLAG);
    },
  );

  it('is absent from the frozen hardening constant and from both tool lists', () => {
    expect(CLAUDE_HARDENING_ARGS).not.toContain(BARE_FLAG);
    expect(CLAUDE_HARDENING_ARGS.join(' ')).not.toContain(BARE_FLAG);
    expect([...CLAUDE_HARDENED_TOOLS, ...CLAUDE_HARDENED_DISALLOWED_TOOLS].join(',')).not.toContain('bare');
  });
});

/**
 * The static half. The behavioral test above only covers the one function that exists today; this
 * one covers a maintainer adding the flag anywhere at all -- a second adapter, a spawn helper, a
 * detection probe, a script.
 *
 * It searches for the flag only in **quoted** form. That is not a weaker check: an argv element is a
 * string, so the flag cannot reach a spawned process without being quoted somewhere. Restricting the
 * search this way is what lets `build-args.ts` discuss the prohibition at length in prose (where it
 * is written unquoted and without backticks) without tripping its own test, and it avoids the
 * fragile alternative of trying to strip comments out of TypeScript with a regex.
 */
describe('--bare appears in no quoted string anywhere in this repo (ADI-08b)', () => {
  const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const SKIP_DIRS = new Set([
    'node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.turbo', '.next', '.vite', 'release',
  ]);
  const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

  function collectSourceFiles(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      let isDirectory: boolean;
      try {
        isDirectory = statSync(full).isDirectory();
      } catch {
        continue; // a dangling symlink or a file racing a build; neither can hold source we own
      }
      if (isDirectory) collectSourceFiles(full, found);
      else if (CODE_EXTENSIONS.some((ext) => entry.endsWith(ext))) found.push(full);
    }
    return found;
  }

  const sourceFiles = collectSourceFiles(REPO_ROOT);

  it('actually scanned a meaningful number of files, including this package and the daemon', () => {
    // Guards the test against silently passing because the walk found nothing (a wrong root, an
    // over-eager skip list). A prohibition test that scans zero files is worse than no test.
    expect(sourceFiles.length).toBeGreaterThan(50);
    const relativePaths = sourceFiles.map((file) => relative(REPO_ROOT, file).split(sep).join('/'));
    expect(relativePaths).toContain('packages/agent-runtime/src/providers/claude/build-args.ts');
    expect(relativePaths.some((path) => path.startsWith('apps/daemon/src/'))).toBe(true);
  });

  it('finds no quoted --bare in any source file', () => {
    const quotedForms = [`'${BARE_FLAG}'`, `"${BARE_FLAG}"`, `\`${BARE_FLAG}\``];
    const offenders: string[] = [];

    for (const file of sourceFiles) {
      const contents = readFileSync(file, 'utf8');
      // Cheap pre-filter: the overwhelming majority of files contain the substring nowhere.
      if (!contents.includes(BARE_FLAG)) continue;
      for (const form of quotedForms) {
        if (contents.includes(form)) {
          offenders.push(relative(REPO_ROOT, file).split(sep).join('/'));
          break;
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
