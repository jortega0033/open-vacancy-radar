#!/usr/bin/env node
// Surfaces, before pnpm resolves or links anything, when the active Node/pnpm toolchain isn't one
// this repo's own CI actually tests. Wired as package.json's "preinstall" script, so it runs
// automatically as the first step of `pnpm install` -- not an opt-in step someone can skip.
// Advisory only (see `main()`'s own doc comment for why this repo's version deliberately never
// fails the install, unlike upstream AgentDock's equivalent script).
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(scriptDir, '..', 'package.json');

/**
 * The Node major versions this repo's own CI actually exercises today, collectively across every
 * workflow that runs `pnpm install` -- not copied from upstream's own range, even though it
 * happens to land on the same numbers. `ci.yml`, `e2e.yml`, `package-windows.yml`, and
 * `release.yml` all pin Node 22; `live-provider-smoke.yml` (ADI-19) deliberately pins Node 20
 * instead. Narrowing this to "22 only" would make this preflight check itself fail that one real,
 * currently-green workflow the moment it runs `pnpm install` -- the exact kind of blind-port
 * mistake this repo's own review discipline exists to catch. Widen or narrow this only after
 * checking every `.github/workflows/*.yml` `node-version` value again, not by assumption.
 */
export const SUPPORTED_NODE_RANGE = Object.freeze({ minMajor: 20, maxMajorExclusive: 23 });

export function parseSemver(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  if (!match) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function isNodeVersionSupported(version, range = SUPPORTED_NODE_RANGE) {
  const parsed = parseSemver(version);
  return (
    parsed !== undefined && parsed.major >= range.minMajor && parsed.major < range.maxMajorExclusive
  );
}

/** Parses `pnpm/<version> ...` out of the npm_config_user_agent pnpm itself sets for every
 * lifecycle script it runs -- reading this avoids spawning a child process to ask "which pnpm is
 * this," which would need shell:true (and its own quoting risk) to resolve pnpm.cmd on Windows. */
export function parseActivePnpmVersion(userAgent) {
  const match = /^pnpm\/(\S+)/.exec(String(userAgent ?? ''));
  return match?.[1];
}

export function pnpmVersionMatches(activeVersion, declaredVersion) {
  const active = parseSemver(activeVersion);
  const declared = parseSemver(declaredVersion);
  return (
    active !== undefined &&
    declared !== undefined &&
    active.major === declared.major &&
    active.minor === declared.minor &&
    active.patch === declared.patch
  );
}

export function parseDeclaredPnpmVersion(packageManagerField) {
  const match = /^pnpm@(\S+)$/.exec(String(packageManagerField ?? ''));
  return match?.[1];
}

export function buildReport({ nodeVersion, userAgent, declaredPnpmField, platform, arch }) {
  const nodeOk = isNodeVersionSupported(nodeVersion);
  const activePnpm = parseActivePnpmVersion(userAgent);
  const declaredPnpm = parseDeclaredPnpmVersion(declaredPnpmField);
  const pnpmOk = activePnpm !== undefined && pnpmVersionMatches(activePnpm, declaredPnpm);
  const { minMajor, maxMajorExclusive } = SUPPORTED_NODE_RANGE;

  const lines = [
    `Node:     ${nodeVersion} (${nodeOk ? 'supported' : 'UNSUPPORTED'} -- this repo tests ${minMajor}.x through ${maxMajorExclusive - 1}.x)`,
    `pnpm:     ${activePnpm ?? 'not detected (are you running "pnpm install", not npm/yarn?)'} (${pnpmOk ? 'matches packageManager' : `expected ${declaredPnpm ?? 'unknown'}`})`,
    `Platform: ${platform} (${arch})`,
  ];

  const fixes = [];
  if (!nodeOk) {
    fixes.push(
      `Unsupported Node version. Install Node ${minMajor}.x or ${maxMajorExclusive - 1}.x from https://nodejs.org/, or switch with a version manager (nvm/fnm/volta).`,
    );
  }
  if (!pnpmOk) {
    fixes.push(
      [
        `pnpm ${activePnpm ?? '(not detected)'} does not match this repo's pinned pnpm@${declaredPnpm ?? 'unknown'} ("packageManager" in package.json).`,
        '  corepack enable',
        `  corepack prepare pnpm@${declaredPnpm ?? '<version>'} --activate`,
        '  pnpm install',
        '',
        "If Corepack itself isn't available (some newer Node releases no longer bundle it by default):",
        '  npm install -g corepack',
        '  corepack enable',
        '',
        'Or skip Corepack entirely and install pnpm directly:',
        `  npm install -g pnpm@${declaredPnpm ?? '10'}`,
      ].join('\n'),
    );
  }

  return { ok: nodeOk && pnpmOk, lines, fixes };
}

/**
 * Advisory only, unlike upstream's own hard-failing equivalent: this repo's own CI matrix (see
 * `SUPPORTED_NODE_RANGE`'s doc comment) is narrower than what real contributors demonstrably run
 * successfully today -- confirmed directly, not assumed, against a machine on Node v25.5.0 that
 * had already built, tested, and packaged this entire repo dozens of times before this script was
 * ever added. A hard-failing `preinstall` would block `pnpm install` on exactly that kind of
 * already-working environment for a mismatch that has not actually caused a problem, which is a
 * worse outcome than the check being silent. This still prints the same report upstream's does
 * (so a real Node/pnpm mismatch is visible immediately, not just discovered later as a confusing
 * downstream failure), it simply never sets a failing exit code on its own account.
 */
function main() {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const report = buildReport({
    nodeVersion: process.version,
    userAgent: process.env.npm_config_user_agent,
    declaredPnpmField: pkg.packageManager,
    platform: process.platform,
    arch: process.arch,
  });

  console.log(report.lines.join('\n'));
  if (!report.ok) {
    console.error('');
    for (const fix of report.fixes) console.error(fix);
    console.error('');
    // Deliberately no `process.exitCode = 1` here -- see this function's own doc comment.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
