import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  STATE_DIR_ENV_VAR,
  assertNotColocatedWithProductData,
  resolveStateDirectory,
} from '../src/state-directory.js';

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'agent-dock-state-dir-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('resolveStateDirectory', () => {
  it('prefers the environment override and creates the directory', () => {
    const target = join(base, 'agentdock-state');
    const resolved = resolveStateDirectory({ env: { [STATE_DIR_ENV_VAR]: target } });
    expect(resolved).toBe(target);
    expect(existsSync(target)).toBe(true);
  });

  it('is idempotent: opening an existing directory is not an error', () => {
    const target = join(base, 'agentdock-state');
    resolveStateDirectory({ env: { [STATE_DIR_ENV_VAR]: target } });
    expect(() => resolveStateDirectory({ env: { [STATE_DIR_ENV_VAR]: target } })).not.toThrow();
  });

  it('falls back to a per-app-id platform location when no override is set', () => {
    const resolved = resolveStateDirectory({
      appId: 'some-app',
      env: { LOCALAPPDATA: join(base, 'Local'), XDG_STATE_HOME: join(base, 'state') },
    });
    expect(resolved.endsWith(join('', 'some-app'))).toBe(true);
    expect(existsSync(resolved)).toBe(true);
  });

  it('rejects an app id that is not safe to use as a path segment', () => {
    // Reuses discovery-file.ts's `sanitizeAppId` rather than a second, independently-maintained
    // rule: two "is this safe as a filename" checks is how one of them ends up weaker.
    for (const appId of ['../escape', 'a/b', 'has space', '-leading-dash', 'a'.repeat(65)]) {
      expect(() => resolveStateDirectory({ appId, env: { [STATE_DIR_ENV_VAR]: join(base, 'x') } })).toThrow(
        /invalid app id/,
      );
    }
  });

  it('treats an empty or whitespace app id as "use the default", not as an error', () => {
    // Matches how index.ts reads AGENT_DOCK_APP_ID: an unset or blank variable means the default
    // app id, and only a *present but malformed* value is a failure worth refusing to start over.
    expect(() => resolveStateDirectory({ appId: '   ', env: { [STATE_DIR_ENV_VAR]: join(base, 'x') } })).not.toThrow();
  });
});

describe('assertNotColocatedWithProductData', () => {
  it('accepts a state root that is a sibling of the product databases', () => {
    expect(() =>
      assertNotColocatedWithProductData(join(base, 'agentdock-state'), [
        join(base, 'workspace.db'),
        join(base, 'vacancy-engine.db'),
      ]),
    ).not.toThrow();
  });

  it('rejects a state root that contains a product database', () => {
    expect(() =>
      assertNotColocatedWithProductData(base, [join(base, 'workspace.db')]),
    ).toThrow(/overlaps the product data path/);
  });

  it('rejects a state root nested inside a product data directory', () => {
    expect(() =>
      assertNotColocatedWithProductData(join(base, 'db', 'agentdock-state'), [join(base, 'db')]),
    ).toThrow(/overlaps the product data path/);
  });

  it('rejects a state root equal to a product data path', () => {
    expect(() => assertNotColocatedWithProductData(base, [base])).toThrow(/overlaps the product data path/);
  });

  it('ignores empty reserved entries rather than treating them as the current directory', () => {
    expect(() => assertNotColocatedWithProductData(join(base, 'state'), ['', ''])).not.toThrow();
  });

  it('is enforced by resolveStateDirectory before anything is created', () => {
    const target = join(base, 'agentdock-state');
    expect(() =>
      resolveStateDirectory({
        env: { [STATE_DIR_ENV_VAR]: target },
        reservedPaths: [join(target, 'workspace.db')],
      }),
    ).toThrow(/overlaps the product data path/);
    expect(existsSync(target)).toBe(false);
  });
});
