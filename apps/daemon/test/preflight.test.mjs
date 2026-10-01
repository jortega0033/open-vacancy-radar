import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_NODE_RANGE,
  buildReport,
  describeNodeRange,
  isNodeVersionSupported,
  parseActivePnpmVersion,
  parseDeclaredPnpmVersion,
  parseSemver,
  pnpmVersionMatches,
} from '../../../scripts/preflight.mjs';

const scriptPath = fileURLToPath(new URL('../../../scripts/preflight.mjs', import.meta.url));

describe('parseSemver', () => {
  it('parses a v-prefixed Node version', () => {
    expect(parseSemver('v20.11.0')).toEqual({ major: 20, minor: 11, patch: 0 });
  });

  it('parses a bare version, including pre-release/build suffixes', () => {
    expect(parseSemver('10.29.2')).toEqual({ major: 10, minor: 29, patch: 2 });
    expect(parseSemver('10.29.2-beta.1')).toEqual({ major: 10, minor: 29, patch: 2 });
  });

  it('returns undefined for garbage input', () => {
    expect(parseSemver('not-a-version')).toBeUndefined();
    expect(parseSemver(undefined)).toBeUndefined();
    expect(parseSemver('')).toBeUndefined();
  });
});

describe('isNodeVersionSupported', () => {
  it('accepts every major in the declared range, using the module default', () => {
    expect(isNodeVersionSupported('v22.0.0')).toBe(true);
    expect(isNodeVersionSupported('v22.11.0')).toBe(true);
  });

  it('rejects a major below the range', () => {
    expect(isNodeVersionSupported('v18.20.0')).toBe(false);
  });

  /**
   * Node 20 specifically, not just an arbitrary below-range major: this is the exact regression
   * this range narrowed to catch. `packages/vacancy-engine`'s `better-sqlite3@13.0.3` dependency
   * declares `"engines": { "node": ">=22" }` and genuinely crashes (a native ACCESS_VIOLATION,
   * confirmed directly on Windows + Node 20.20.2) when loaded under Node 20 -- so a full
   * `pnpm install` across this workspace cannot be considered Node-20-supported, even though
   * `live-provider-smoke.yml` (ADI-19) separately pins Node 20 and stays green doing so: that
   * workflow only exercises `apps/daemon`, which has no dependency on `packages/vacancy-engine` or
   * `better-sqlite3` at all, so it never reaches the code path that actually breaks.
   */
  it('rejects Node 20, unlike an earlier version of this range that wrongly included it', () => {
    expect(isNodeVersionSupported('v20.18.1')).toBe(false);
  });

  it('rejects a major at or above the exclusive upper bound', () => {
    expect(isNodeVersionSupported('v23.0.0')).toBe(false);
    expect(isNodeVersionSupported('v25.5.0')).toBe(false);
  });

  it('respects a custom range', () => {
    expect(isNodeVersionSupported('v24.0.0', { minMajor: 20, maxMajorExclusive: 25 })).toBe(true);
  });

  it('rejects unparseable input', () => {
    expect(isNodeVersionSupported('not-a-version')).toBe(false);
  });

  /**
   * Pinned to Node 22 only, not just "whatever the module currently defaults to": this is a direct
   * claim about what a full `pnpm install` across this whole workspace actually supports, narrower
   * than simply unioning every workflow's own `node-version` value (see `SUPPORTED_NODE_RANGE`'s
   * own doc comment for why that broader reasoning was wrong). If this narrows or widens again,
   * this test failing is what catches it going stale, not a manual re-audit.
   */
  it('exposes the exact range a full workspace install actually supports', () => {
    expect(SUPPORTED_NODE_RANGE).toEqual({ minMajor: 22, maxMajorExclusive: 23 });
  });
});

describe('describeNodeRange', () => {
  it('renders a single-major range as just "N.x", not "N.x through N.x"', () => {
    expect(describeNodeRange({ minMajor: 22, maxMajorExclusive: 23 })).toBe('22.x');
  });

  it('renders a genuine multi-major range as "min.x through max.x"', () => {
    expect(describeNodeRange({ minMajor: 20, maxMajorExclusive: 23 })).toBe('20.x through 22.x');
  });

  it('defaults to the module\'s own SUPPORTED_NODE_RANGE', () => {
    expect(describeNodeRange()).toBe('22.x');
  });
});

describe('parseActivePnpmVersion', () => {
  it('extracts the version pnpm puts at the front of npm_config_user_agent', () => {
    expect(parseActivePnpmVersion('pnpm/10.29.2 npm/? node/v22.11.0 win32 x64')).toBe('10.29.2');
  });

  it('returns undefined when the user agent is missing or from a different tool', () => {
    expect(parseActivePnpmVersion(undefined)).toBeUndefined();
    expect(parseActivePnpmVersion('npm/10.2.0 node/v22.11.0 win32 x64')).toBeUndefined();
    expect(parseActivePnpmVersion('yarn/1.22.19 npm/? node/v22.11.0 win32 x64')).toBeUndefined();
  });
});

describe('parseDeclaredPnpmVersion', () => {
  it('extracts the version from a "pnpm@<version>" packageManager field', () => {
    expect(parseDeclaredPnpmVersion('pnpm@10.29.2')).toBe('10.29.2');
  });

  it('returns undefined for a non-pnpm or malformed field', () => {
    expect(parseDeclaredPnpmVersion('yarn@4.0.0')).toBeUndefined();
    expect(parseDeclaredPnpmVersion(undefined)).toBeUndefined();
  });
});

describe('pnpmVersionMatches', () => {
  it('matches on exact major/minor/patch', () => {
    expect(pnpmVersionMatches('10.29.2', '10.29.2')).toBe(true);
  });

  it('rejects any component mismatch', () => {
    expect(pnpmVersionMatches('10.29.1', '10.29.2')).toBe(false);
    expect(pnpmVersionMatches('9.29.2', '10.29.2')).toBe(false);
    expect(pnpmVersionMatches(undefined, '10.29.2')).toBe(false);
  });
});

describe('buildReport', () => {
  it('reports ok and no fixes when Node and pnpm both match', () => {
    const report = buildReport({
      nodeVersion: 'v22.11.0',
      userAgent: 'pnpm/10.29.2 npm/? node/v22.11.0 linux x64',
      declaredPnpmField: 'pnpm@10.29.2',
      platform: 'linux',
      arch: 'x64',
    });
    expect(report.ok).toBe(true);
    expect(report.fixes).toEqual([]);
    expect(report.lines[0]).toContain('supported');
    expect(report.lines[1]).toContain('matches packageManager');
  });

  it('reports an unsupported Node release with no active pnpm detected', () => {
    const report = buildReport({
      nodeVersion: 'v25.5.0',
      userAgent: undefined,
      declaredPnpmField: 'pnpm@10.29.2',
      platform: 'win32',
      arch: 'x64',
    });
    expect(report.ok).toBe(false);
    expect(report.lines[0]).toContain('UNSUPPORTED');
    expect(report.fixes.join('\n')).toContain('Unsupported Node version');
    expect(report.fixes.join('\n')).toContain('corepack enable');
    expect(report.fixes.join('\n')).toContain('npm install -g corepack');
    expect(report.fixes.join('\n')).toContain('npm install -g pnpm@10.29.2');
  });

  it('flags only the pnpm mismatch when Node is supported but pnpm drifted', () => {
    const report = buildReport({
      nodeVersion: 'v22.11.0',
      userAgent: 'pnpm/9.1.0 npm/? node/v22.11.0 darwin arm64',
      declaredPnpmField: 'pnpm@10.29.2',
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(report.ok).toBe(false);
    expect(report.lines[0]).toContain('supported');
    expect(report.fixes).toHaveLength(1);
    expect(report.fixes[0]).toContain('9.1.0');
    expect(report.fixes[0]).toContain('10.29.2');
  });

  /**
   * live-provider-smoke.yml (ADI-19) really does run successfully on Node 20 -- but only because
   * it never touches packages/vacancy-engine/better-sqlite3 (see SUPPORTED_NODE_RANGE's own doc
   * comment). This script's own advisory range describes what a FULL workspace install supports,
   * so it correctly reports Node 20 as unsupported here even though one narrow, real workflow gets
   * away with it -- this is a deliberate scope difference, not a contradiction to reconcile.
   */
  it('reports Node 20 as unsupported, even though live-provider-smoke.yml separately runs on it', () => {
    const report = buildReport({
      nodeVersion: 'v20.18.1',
      userAgent: 'pnpm/10.29.2 npm/? node/v20.18.1 win32 x64',
      declaredPnpmField: 'pnpm@10.29.2',
      platform: 'win32',
      arch: 'x64',
    });
    expect(report.ok).toBe(false);
    expect(report.lines[0]).toContain('UNSUPPORTED');
  });

  it('renders a single-major range without the redundant "22.x through 22.x" a naive min/max template would produce', () => {
    const report = buildReport({
      nodeVersion: 'v22.11.0',
      userAgent: 'pnpm/10.29.2 npm/? node/v22.11.0 win32 x64',
      declaredPnpmField: 'pnpm@10.29.2',
      platform: 'win32',
      arch: 'x64',
    });
    expect(report.lines[0]).toContain('this repo tests 22.x)');
    expect(report.lines[0]).not.toContain('through');
  });
});

/**
 * The actual behavior that matters, verified against the real script as a subprocess rather than
 * only against its exported pure functions: this repo's own version deliberately never fails
 * `pnpm install` over a Node/pnpm mismatch (unlike upstream AgentDock's equivalent), because doing
 * so would have blocked installs on real, already-working developer environments -- see
 * `main()`'s own doc comment in preflight.mjs. This doesn't need to mock an unsupported Node
 * version: run under whatever Node this test suite itself is executing on, which may or may not be
 * in `SUPPORTED_NODE_RANGE` -- either way, the script must exit 0.
 */
describe('running the real script as a subprocess', () => {
  it('always exits 0, regardless of whether the current Node/pnpm toolchain is one this repo tests', () => {
    let output;
    let threw = false;
    try {
      output = execFileSync(process.execPath, [scriptPath], { encoding: 'utf8' });
    } catch (error) {
      threw = true;
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    }
    expect(threw).toBe(false);
    expect(output).toContain('Node:');
    expect(output).toContain('Platform:');
  });
});
