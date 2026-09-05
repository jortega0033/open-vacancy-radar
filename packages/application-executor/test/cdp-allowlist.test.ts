import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALLOWED_CDP_METHODS, DENIED_CDP_DOMAINS, assertAllowedCdpMethod, isAllowedCdpMethod } from '../src/cdp-allowlist.js';

/**
 * Two layers, mirroring `packages/agent-runtime/test/claude-bare-prohibition.test.ts`'s own
 * two-layer structure:
 *
 * 1. A behavioral check that the allowlist itself denies every CDP domain #196 §4.4 excludes.
 * 2. A static source scan proving `Runtime.evaluate` -- the single most load-bearing exclusion,
 *    since with it every other control here is decorative -- does not appear as a quoted literal
 *    anywhere in this package's *production* source (`src/`), so a future edit can't reintroduce
 *    it by construction. Scoped to `src/` specifically, not `test/`: this file's own tests below
 *    legitimately reference the literal string `'Runtime.evaluate'` as test data (to prove
 *    `isAllowedCdpMethod`/`assertAllowedCdpMethod` actually deny it) -- that is a test asserting
 *    the denial works, not a production call site issuing it, and the two must not be conflated.
 *
 * The scan target itself is assembled at runtime (`RUNTIME_EVALUATE` below) purely so this
 * doc comment can name it without ever writing the quoted form the assembled constant searches
 * for, matching the "prose is bare/unquoted, only production code is scanned" split above.
 */

describe('ALLOWED_CDP_METHODS', () => {
  it('is frozen, so no caller can compose a wider allowlist', () => {
    expect(Object.isFrozen(ALLOWED_CDP_METHODS)).toBe(true);
  });

  it('allows every method the executor actually needs', () => {
    for (const method of [
      'DOM.getDocument',
      'DOM.querySelectorAll',
      'DOM.getAttributes',
      'DOM.describeNode',
      'DOM.getBoxModel',
      'DOM.focus',
      'DOM.setFileInputFiles',
      'Accessibility.getFullAXTree',
      'Input.insertText',
      'Input.dispatchKeyEvent',
      'Input.dispatchMouseEvent',
      'Page.navigate',
      'Page.captureScreenshot',
      'Page.getFrameTree',
    ]) {
      expect(isAllowedCdpMethod(method), method).toBe(true);
    }
  });

  it('denies every method in a structurally excluded domain', () => {
    const deniedExamples = [
      'Runtime.evaluate',
      'Runtime.callFunctionOn',
      'Runtime.awaitPromise',
      'Network.getResponseBody',
      'Network.setRequestInterception',
      'Fetch.continueRequest',
      'Storage.getCookies',
      'Target.createTarget',
      'Browser.close',
      'Emulation.setUserAgentOverride',
      'Debugger.enable',
      'Security.setIgnoreCertificateErrors',
      'Page.addScriptToEvaluateOnNewDocument',
    ];
    for (const method of deniedExamples) {
      expect(isAllowedCdpMethod(method), method).toBe(false);
    }
  });

  it('every denied-example domain above is actually named in DENIED_CDP_DOMAINS', () => {
    for (const domain of ['Runtime', 'Network', 'Fetch', 'Storage', 'Target', 'Browser', 'Emulation', 'Debugger', 'Security']) {
      expect(DENIED_CDP_DOMAINS).toContain(domain);
    }
  });

  it('denies an unrecognized method that happens to share a prefix with an allowed one', () => {
    expect(isAllowedCdpMethod('DOM.removeNode')).toBe(false);
    expect(isAllowedCdpMethod('Page.navigateToHistoryEntry')).toBe(false);
  });

  it('assertAllowedCdpMethod throws for a denied method and returns for an allowed one', () => {
    expect(() => assertAllowedCdpMethod('Runtime.evaluate')).toThrow(/not on the executor's allowlist/);
    expect(() => assertAllowedCdpMethod('Page.navigate')).not.toThrow();
  });
});

// Assembled, never written as a quoted literal: see this file's own header comment.
const RUNTIME_DOMAIN = 'Runtime';
const EVALUATE_METHOD = 'evaluate';
const RUNTIME_EVALUATE = `${RUNTIME_DOMAIN}.${EVALUATE_METHOD}`;

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** Scanned root: production source only. See this file's own header comment for why `test/`
 * (which legitimately references the banned string as literal test data) must not be included. */
const SCAN_ROOT = join(PACKAGE_ROOT, 'src');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git']);
const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs'];

function collectSourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let isDirectory: boolean;
    try {
      isDirectory = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDirectory) collectSourceFiles(full, found);
    else if (CODE_EXTENSIONS.some((ext) => entry.endsWith(ext))) found.push(full);
  }
  return found;
}

describe('Runtime.evaluate prohibition', () => {
  const sourceFiles = collectSourceFiles(SCAN_ROOT);

  it('actually scanned a meaningful number of production files', () => {
    // A prohibition test that scans zero files is worse than no test.
    expect(sourceFiles.length).toBeGreaterThan(5);
    const relativePaths = sourceFiles.map((file) => relative(PACKAGE_ROOT, file).split(sep).join('/'));
    expect(relativePaths).toContain('src/cdp-allowlist.ts');
    expect(relativePaths).toContain('src/executor.ts');
    // The whole point of scoping to src/: this test file's own literal references never appear.
    expect(relativePaths.some((path) => path.startsWith('test/'))).toBe(false);
  });

  it('finds no quoted Runtime.evaluate anywhere in this package', () => {
    const quotedForms = [`'${RUNTIME_EVALUATE}'`, `"${RUNTIME_EVALUATE}"`, `\`${RUNTIME_EVALUATE}\``];
    const offenders: string[] = [];

    for (const file of sourceFiles) {
      const contents = readFileSync(file, 'utf8');
      if (!contents.includes(RUNTIME_EVALUATE)) continue; // cheap pre-filter
      for (const form of quotedForms) {
        if (contents.includes(form)) {
          offenders.push(relative(PACKAGE_ROOT, file).split(sep).join('/'));
          break;
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
