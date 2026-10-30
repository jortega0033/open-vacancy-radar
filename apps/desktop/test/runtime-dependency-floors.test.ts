import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Security floors for the two dependencies that ship inside the packaged app (#716).
 *
 * - Electron is a devDependency, so `pnpm audit --prod` never sees it, yet electron-builder packages
 *   the runtime from the installed `electron` package. 44.9.1 fixes GHSA-jr5w-w6x2-84p9 and every
 *   earlier 44.x advisory. The major stays 44 (`^44.0.0`).
 * - DOMPurify reaches the renderer bundle as jsPDF's optional dependency (Vite emits it as its own
 *   `purify.es-*.js` chunk). 3.4.17 fixes GHSA-cg2g-xh64-v4q7 and GHSA-mrv2-3pqr-j5jr.
 *
 * Raise a floor when a newer advisory lands; never lower one.
 */
type Version = readonly [major: number, minor: number, patch: number];

const FLOORS: Record<'electron' | 'dompurify', Version> = {
  electron: [44, 9, 1],
  dompurify: [3, 4, 17],
};

const DESKTOP = join(__dirname, '..');
const LOCKFILE = readFileSync(join(DESKTOP, '..', '..', 'pnpm-lock.yaml'), 'utf8').replace(
  /\r\n/g,
  '\n',
);
const SNAPSHOTS = LOCKFILE.slice(LOCKFILE.indexOf('\nsnapshots:\n'));

/** The first capture group of the first match, or a thrown error naming what was missing. */
function capture(pattern: RegExp, text: string, what: string): string {
  const group = pattern.exec(text)?.[1];
  if (group === undefined) throw new Error(`not found: ${what}`);
  return group;
}

function parse(version: string): Version {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`not a plain release version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(version: string, floor: Version): boolean {
  const [major, minor, patch] = parse(version);
  const [floorMajor, floorMinor, floorPatch] = floor;
  if (major !== floorMajor) return major > floorMajor;
  if (minor !== floorMinor) return minor > floorMinor;
  return patch >= floorPatch;
}

/** Every `  <name>@<version>:` key in the lockfile's `packages:` and `snapshots:` sections. */
function lockedVersions(name: string): string[] {
  const keys = LOCKFILE.matchAll(new RegExp(`^ {2}'?${name}@([^:'(]+)'?:`, 'gm'));
  return [...new Set([...keys].map((match) => match[1] ?? ''))];
}

function installedVersion(packageJson: string): string {
  return (JSON.parse(readFileSync(packageJson, 'utf8')) as { version: string }).version;
}

/** Walk up from a resolved entry file to the package's own package.json. */
function packageJsonFor(entry: string, name: string): string {
  let dir = dirname(entry);
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string };
      if (pkg.name === name) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no package.json for ${name} above ${entry}`);
    dir = parent;
  }
}

describe('runtime dependency security floors', () => {
  it('locks apps/desktop electron inside major 44 at or above the floor', () => {
    const importer = capture(
      /\n {2}apps\/desktop:\n[\s\S]*?\n {6}electron:\n( {8}specifier: \S+\n {8}version: \S+)\n/,
      LOCKFILE,
      'apps/desktop electron importer entry',
    );
    const specifier = capture(/specifier: (\S+)/, importer, 'electron specifier');
    const version = capture(/version: (\S+)/, importer, 'electron version');
    expect(specifier).toMatch(/^\^44\./);
    expect(parse(version)[0]).toBe(44);
    expect(atLeast(version, FLOORS.electron), `electron ${version}`).toBe(true);
  });

  it.each(Object.entries(FLOORS))('has no locked %s below the floor', (name, floor) => {
    const versions = lockedVersions(name);
    expect(versions.length, `${name} entries in pnpm-lock.yaml`).toBeGreaterThan(0);
    expect(versions.filter((version) => !atLeast(version, floor))).toEqual([]);
  });

  it('locks the dompurify jsPDF bundles at or above the floor', () => {
    const snapshot = capture(/(\n {2}jspdf@[^:\n]+:\n(?: {4}.*\n)*)/, SNAPSHOTS, 'jspdf snapshot');
    const dompurify = capture(/ {6}dompurify: (\S+)\n/, snapshot, 'jspdf -> dompurify reference');
    expect(atLeast(dompurify, FLOORS.dompurify), `dompurify ${dompurify}`).toBe(true);
  });

  it('resolves the installed packages the build actually uses at or above the floors', () => {
    const fromDesktop = createRequire(join(DESKTOP, 'package.json'));
    const electron = installedVersion(fromDesktop.resolve('electron/package.json'));
    expect(atLeast(electron, FLOORS.electron), `installed electron ${electron}`).toBe(true);

    // Vite bundles whatever jsPDF itself resolves, so resolve from jsPDF's own location.
    const fromJspdf = createRequire(fromDesktop.resolve('jspdf/package.json'));
    const dompurify = installedVersion(packageJsonFor(fromJspdf.resolve('dompurify'), 'dompurify'));
    expect(atLeast(dompurify, FLOORS.dompurify), `jsPDF's dompurify ${dompurify}`).toBe(true);
  });
});
