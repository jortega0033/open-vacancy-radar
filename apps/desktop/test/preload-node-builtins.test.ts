// @vitest-environment node
//
// Pure Node work (read files, walk an import graph), no DOM, so it opts out of this package's
// default jsdom environment the way electron-builder-resources.test.ts does.
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `electron/preload.ts` must not reference a Node built-in -- transitively, through anything.
 *
 * ## The regression this exists for
 *
 * `main.ts` creates its `BrowserWindow` with `sandbox: true`. A sandboxed preload script does not
 * get Node: it gets a small polyfilled subset (`electron`, a trimmed `process`, a few others).
 * Reference `node:crypto` from one and Electron does not fail *that one call* -- it refuses to load
 * the script at all:
 *
 *     Unable to load preload script: ...\dist-electron\preload.js
 *     Error: module not found: node:crypto
 *
 * `contextBridge.exposeInMainWorld` then never runs for *any* namespace, so `window.agentDock`,
 * `window.vacancyRadar`, `window.cv`, `window.workspace`, `window.system`, `window.workspaceGrant`
 * and `window.agentWorkspace` are all undefined and every page in the app dies on
 * `Cannot read properties of undefined`. One bad import in the graph takes down the whole app,
 * which is why this is worth a dedicated test rather than trusting review.
 *
 * ADI-07 shipped exactly that. It added `content-digest.ts` (which imports `node:crypto`) to
 * `@agent-dock/shared`'s barrel, and `preload.ts` imports two zod schemas from that barrel.
 * Rollup tree-shook the digest *functions* out of `dist-electron/preload.js` but kept a bare
 * `require("node:crypto")`, because an unannotated module is assumed to have side effects. Nothing
 * caught it: it typechecks, it lints, `preload.test.ts` passes (vitest runs preload under Node,
 * where `node:crypto` exists), and it only fails in a real sandboxed Electron preload context.
 *
 * ## Why an import walk and not just a grep of the built bundle
 *
 * The built bundle is the ground truth, and the second test below checks it -- but only when one
 * has been built, so it cannot be the gate. This first test needs no build, so it runs on every
 * `vitest run` and fails in the pull request that introduces the import rather than in whatever
 * later run happens to follow a build.
 *
 * ## What it does and does not follow
 *
 * It follows relative imports and this monorepo's own workspace packages (resolved through their
 * real `package.json` `exports`/`main`, so a change there is exercised too), skipping statements
 * that are entirely `import type` / `export type` -- those are erased before bundling and cannot
 * put anything in the output. It does **not** descend into third-party `node_modules` packages:
 * that would mean walking all of zod for little gain, and a third-party Node-only dependency
 * appearing in preload would be a much more visible mistake than the first-party one above. The
 * built-bundle test covers that case whenever a build exists.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const preloadEntry = resolve(here, '../electron/preload.ts');

/** Bare specifiers the preload bundle is allowed to keep as externals. */
const ALLOWED_EXTERNALS = new Set(['electron']);

const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/**
 * Comments in this repo are long and frequently quote import specifiers ("moved to
 * `@agent-dock/shared`", "imported from './x.js'"). Scanning them would invent edges that do not
 * exist, so they are stripped from the copy this test parses. Only the scan copy is affected.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Every specifier the module pulls in at *runtime*.
 *
 * `[^;]*?` between the keyword and `from` is what keeps a match inside one statement: an import
 * clause never contains a semicolon, so the match cannot run past the end of its own statement
 * into the next one. A body starting with `type` means the whole statement is erased at build
 * time; a body of `{ type A, b }` is not, and is followed.
 */
function runtimeImportsOf(source: string): string[] {
  const scanned = stripComments(source);
  const specifiers: string[] = [];

  for (const match of scanned.matchAll(/(?:^|[\s;}])(?:import|export)\b([^;]*?)\bfrom\s*['"]([^'"]+)['"]/g)) {
    if (/^\s*type\s/.test(match[1]!)) continue; // `import type ...` / `export type ...`
    specifiers.push(match[2]!);
  }
  // Bare side-effect imports (`import './polyfill.js'`) and dynamic `import('x')`.
  for (const match of scanned.matchAll(/(?:^|[\s;}])import\s*\(?\s*['"]([^'"]+)['"]/g)) {
    specifiers.push(match[1]!);
  }
  for (const match of scanned.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    specifiers.push(match[1]!);
  }

  return [...new Set(specifiers)];
}

/** `./foo.js` in TypeScript ESM source means `./foo.ts` on disk. */
function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const target = resolve(dirname(fromFile), specifier);
  for (const candidate of [target.replace(/\.js$/, '.ts'), target.replace(/\.js$/, '.tsx'), target, `${target}.ts`]) {
    if (existsSync(candidate) && !candidate.endsWith('/')) return candidate;
  }
  return undefined;
}

/**
 * Resolves a first-party workspace specifier through the package's own manifest, so that the
 * `exports` map which keeps `@agent-dock/shared/content-digest` off the barrel is the same one
 * this test walks. Returns undefined for third-party packages, which are not followed.
 */
function resolveWorkspace(specifier: string): string | undefined {
  if (!specifier.startsWith('@agent-dock/') && !specifier.startsWith('@open-vacancy-radar/')) return undefined;

  const [, name] = specifier.split('/') as [string, string];
  const subpath = specifier.split('/').slice(2).join('/');
  for (const dir of [join(repoRoot, 'packages', name), join(repoRoot, 'apps', name)]) {
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      main?: string;
      exports?: Record<string, string>;
    };
    const key = subpath === '' ? '.' : `./${subpath}`;
    const target = manifest.exports?.[key] ?? (key === '.' ? manifest.main : undefined);
    if (!target) return undefined;
    const resolved = join(dir, target);
    return existsSync(resolved) ? resolved : undefined;
  }
  return undefined;
}

interface Walk {
  /** `specifier` -> the chain of files that reached it, entry first. */
  builtins: Map<string, string[]>;
  visited: Set<string>;
}

function walkPreloadGraph(): Walk {
  const builtins = new Map<string, string[]>();
  const visited = new Set<string>();
  const queue: Array<{ file: string; chain: string[] }> = [{ file: preloadEntry, chain: [] }];

  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);

    const chainToHere = [...chain, relative(repoRoot, file).replace(/\\/g, '/')];
    for (const specifier of runtimeImportsOf(readFileSync(file, 'utf8'))) {
      if (NODE_BUILTINS.has(specifier)) {
        if (!builtins.has(specifier)) builtins.set(specifier, chainToHere);
        continue;
      }
      if (ALLOWED_EXTERNALS.has(specifier)) continue;

      const next = specifier.startsWith('.') ? resolveRelative(file, specifier) : resolveWorkspace(specifier);
      if (next) queue.push({ file: next, chain: chainToHere });
    }
  }

  return { builtins, visited };
}

describe('electron/preload.ts stays loadable in a sandboxed preload context', () => {
  it('reaches no Node built-in anywhere in its runtime import graph', () => {
    const { builtins, visited } = walkPreloadGraph();

    // A guard on the guard: if resolution silently broke, the walk would visit only preload.ts
    // itself and pass vacuously. It genuinely reaches its local modules and the shared barrel.
    expect(visited.size).toBeGreaterThan(3);
    expect([...visited].some((file) => file.replace(/\\/g, '/').endsWith('packages/shared/src/index.ts'))).toBe(true);

    // Formatted as `specifier <- file <- file` so a failure names the chain to fix, not just the
    // fact that one exists.
    const offenders = [...builtins].map(([specifier, chain]) => `${specifier} <- ${[...chain].reverse().join(' <- ')}`);
    expect(offenders).toEqual([]);
  });

  it('does not reference a Node built-in in the built bundle, when one has been built', () => {
    const bundlePath = resolve(here, '../dist-electron/preload.js');
    if (!existsSync(bundlePath)) {
      // Deliberately a pass, not a skip-with-failure: `vitest run` is not gated on a prior build,
      // and the import walk above is the check that runs unconditionally. This one is the ground
      // truth for whoever just ran `pnpm run build`, and for any job that builds before testing.
      expect(existsSync(bundlePath)).toBe(false);
      return;
    }

    const bundle = readFileSync(bundlePath, 'utf8');
    const required = [...bundle.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]!);

    expect([...new Set(required)].filter((name) => !ALLOWED_EXTERNALS.has(name))).toEqual([]);
  });
});
