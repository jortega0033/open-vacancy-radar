// Surfaces, before pnpm resolves or links anything, when the active Node/pnpm toolchain isn't one
// this repo's own CI actually tests. Wired as package.json's "preinstall" script, so it runs
// automatically as the first step of `pnpm install` -- not an opt-in step someone can skip.
// Advisory only (see `main()`'s own doc comment for why this repo's version deliberately never
// fails the install, unlike upstream AgentDock's equivalent script).
//
// Deliberately no `#!/usr/bin/env node` shebang, even though this is a CLI-style script: it is
// never invoked as a standalone executable (package.json's "preinstall" always runs it via
// `node scripts/preflight.mjs`), and a shebang line breaks this file the moment anything imports
// it as a plain ES module dependency rather than running it directly -- Node's own loader strips
// a shebang for both cases, but Vite/esbuild's transform (what actually loads this file when
// apps/daemon/test/preflight.test.mjs imports its exported pure functions) does not extend that
// same stripping to a file reached as an ordinary dependency, only to its own designated entry
// points. Confirmed directly: this exact file with a shebang reproducibly threw `SyntaxError:
// Invalid or unexpected token` from Vitest, on Windows, the moment a test imported it -- not a
// transient CI flake.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = join(scriptDir, '..', 'package.json');

/**
 * Node 22 only. `ci.yml`, `e2e.yml`, `package-windows.yml`, and `release.yml` all pin Node 22;
 * `live-provider-smoke.yml` (ADI-19) pins Node 20 instead -- but that workflow only exercises
 * `apps/daemon`, which has no dependency on `packages/vacancy-engine`/`better-sqlite3` at all.
 * `packages/vacancy-engine`'s own `better-sqlite3@13.0.3` dependency declares `"engines": { "node":
 * ">=22" }` and genuinely crashes (a native `ACCESS_VIOLATION`, confirmed directly on Windows +
 * Node 20.20.2, not a configuration issue) when loaded under Node 20 -- so a *full* `pnpm install`
 * across this whole workspace cannot actually be considered Node-20-supported, even though one
 * narrow workflow happens to get away with it.
 *
 * This range used to be `20-22`, on the reasoning that `live-provider-smoke.yml`'s own Node 20 pin
 * proved this repo tests that version. That reasoning was the actual mistake, caught only once
 * ADI-09 stage 4's windows-test.yml ran `pnpm test` (the whole workspace, `packages/vacancy-engine`
 * included) on Windows + Node 20 for the first time and it genuinely crashed. Widen this again only
 * after re-verifying every workspace package's own dependencies against whatever Node range is
 * proposed -- not by re-reading `.github/workflows/*.yml` node-version values alone, which is
 * exactly the check that missed this the first time.
 */
export const SUPPORTED_NODE_RANGE = Object.freeze({ minMajor: 22, maxMajorExclusive: 23 });

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

/** Renders a range as "22.x" when it names exactly one supported major (the common case now that
 * `packages/vacancy-engine`'s own `better-sqlite3` dependency floor narrowed this to Node 22
 * only), or "20.x through 22.x" for a genuine multi-major range -- rather than the redundant
 * "22.x through 22.x" a single-version range would otherwise produce. */
export function describeNodeRange(range = SUPPORTED_NODE_RANGE) {
  const { minMajor, maxMajorExclusive } = range;
  const maxMajor = maxMajorExclusive - 1;
  return minMajor === maxMajor ? `${minMajor}.x` : `${minMajor}.x through ${maxMajor}.x`;
}

export function buildReport({ nodeVersion, userAgent, declaredPnpmField, platform, arch }) {
  const nodeOk = isNodeVersionSupported(nodeVersion);
  const activePnpm = parseActivePnpmVersion(userAgent);
  const declaredPnpm = parseDeclaredPnpmVersion(declaredPnpmField);
  const pnpmOk = activePnpm !== undefined && pnpmVersionMatches(activePnpm, declaredPnpm);
  const rangeDescription = describeNodeRange();

  const lines = [
    `Node:     ${nodeVersion} (${nodeOk ? 'supported' : 'UNSUPPORTED'} -- this repo tests ${rangeDescription})`,
    `pnpm:     ${activePnpm ?? 'not detected (are you running "pnpm install", not npm/yarn?)'} (${pnpmOk ? 'matches packageManager' : `expected ${declaredPnpm ?? 'unknown'}`})`,
    `Platform: ${platform} (${arch})`,
  ];

  const fixes = [];
  if (!nodeOk) {
    fixes.push(
      `Unsupported Node version. Install Node ${rangeDescription} from https://nodejs.org/, or switch with a version manager (nvm/fnm/volta).`,
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
