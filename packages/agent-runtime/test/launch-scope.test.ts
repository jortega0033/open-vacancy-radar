import { describe, expect, it } from 'vitest';
import type { ProviderStatus } from '@agent-dock/shared';
import {
  freezeLaunchScope,
  launchScopesEqual,
  LAUNCH_SCOPE_FIELDS,
  LAUNCH_SCOPE_FIELDS_EXCLUDED_FROM_EQUALITY,
  type FrozenLaunchScope,
} from '../src/providers/common/launch-scope.js';
import type { StartSessionOptions } from '../src/types.js';

const status: ProviderStatus = {
  id: 'claude',
  name: 'Claude Code',
  installed: true,
  authenticated: 'authenticated',
  capabilities: { resume: true, cancellation: true, tools: true, usage: true, thinking: true },
  executablePath: '/usr/local/bin/claude',
  version: '2.1.228',
};

const start: StartSessionOptions = {
  sessionId: 'scope-session',
  cwd: '/workspace/project',
  prompt: 'hello',
  model: 'opus',
};

function scope(): FrozenLaunchScope {
  return freezeLaunchScope(status, start, 'legacy-one-shot');
}

/** A distinct value of the right type for each field, used to build the mutation matrix. */
const MUTATIONS: Record<keyof FrozenLaunchScope, unknown> = {
  provider: 'codex',
  cwd: '/workspace/other-project',
  executablePath: '/opt/homebrew/bin/claude',
  providerVersion: '2.1.229',
  authenticated: 'unauthenticated',
  model: 'sonnet',
  platform: 'freebsd',
  transportId: 'some-other-transport',
  accountEvidence: 'something-else',
};

describe('freezeLaunchScope', () => {
  it('captures the identity-relevant fields from status and start options', () => {
    expect(scope()).toMatchObject({
      provider: 'claude',
      cwd: '/workspace/project',
      executablePath: '/usr/local/bin/claude',
      providerVersion: '2.1.228',
      authenticated: 'authenticated',
      model: 'opus',
      transportId: 'legacy-one-shot',
      accountEvidence: 'cli_owned',
    });
  });

  it('is actually frozen at runtime, not merely readonly in the type system', () => {
    const frozen = scope();
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(() => {
      (frozen as unknown as Record<string, unknown>).cwd = '/tmp/attacker';
    }).toThrow();
    expect(frozen.cwd).toBe('/workspace/project');
  });

  it('records accountEvidence as cli_owned, the documented limit of what this repo can bind to', () => {
    // Pinned as an explicit assertion rather than left implicit: the literal is a documented
    // limitation marker (ProviderStatus carries no account identifier), and a future change that
    // starts claiming stronger identity must have to update this test to do so.
    expect(scope().accountEvidence).toBe('cli_owned');
  });

  it('preserves undefined for absent optional fields rather than dropping them', () => {
    const bare = freezeLaunchScope(
      { ...status, executablePath: undefined, version: undefined },
      { sessionId: 's', cwd: '/w', prompt: 'p' },
      'legacy-one-shot',
    );
    expect(bare.executablePath).toBeUndefined();
    expect(bare.providerVersion).toBeUndefined();
    expect(bare.model).toBeUndefined();
  });
});

describe('launchScopesEqual', () => {
  it('considers two independently built scopes for the same launch equal', () => {
    expect(launchScopesEqual(scope(), scope())).toBe(true);
  });

  it('is insensitive to key insertion order', () => {
    const original = scope();
    // Rebuild with the keys deliberately reversed. A JSON-stringify comparison would fail here.
    const reordered = Object.freeze(
      Object.fromEntries([...Object.entries(original)].reverse()),
    ) as unknown as FrozenLaunchScope;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(original));
    expect(launchScopesEqual(original, reordered)).toBe(true);
  });

  /**
   * The mutation matrix. Every *compared* field is mutated in isolation and must break equality.
   *
   * `LAUNCH_SCOPE_FIELDS` (the compared fields) plus `LAUNCH_SCOPE_FIELDS_EXCLUDED_FROM_EQUALITY`
   * (deliberately not compared -- currently just `transportId`, see that export's own doc comment)
   * together must equal every real key `Object.keys` reports on a live scope -- not hand-written
   * here -- so adding a field to `FrozenLaunchScope` without either comparing it or explicitly
   * excluding it fails this test rather than passing unnoticed (the module's own compile-time
   * exhaustiveness check catches the same gap at build time; this is the runtime half of the same
   * claim).
   */
  describe('mutation matrix', () => {
    const fields = Object.keys(scope()) as (keyof FrozenLaunchScope)[];

    it('every real field is accounted for by exactly one of: compared, or explicitly excluded', () => {
      const accountedFor = [...LAUNCH_SCOPE_FIELDS, ...LAUNCH_SCOPE_FIELDS_EXCLUDED_FROM_EQUALITY];
      expect([...fields].sort()).toEqual([...accountedFor].sort());
      expect(new Set(accountedFor).size).toBe(accountedFor.length);
      // Every field must have a mutation defined, or a row below would be vacuous.
      for (const field of fields) {
        expect(MUTATIONS[field], `no mutation defined for new field: ${field}`).toBeDefined();
        expect(MUTATIONS[field]).not.toEqual(scope()[field]);
      }
    });

    it.each(LAUNCH_SCOPE_FIELDS)('reports a difference in %s', (field) => {
      const candidate = {
        ...scope(),
        [field]: MUTATIONS[field as keyof FrozenLaunchScope],
      } as FrozenLaunchScope;
      expect(launchScopesEqual(scope(), candidate)).toBe(false);
    });

    it('reports a difference when an optional field goes from a value to undefined', () => {
      const candidate = { ...scope(), model: undefined } as FrozenLaunchScope;
      expect(launchScopesEqual(scope(), candidate)).toBe(false);
    });

    /**
     * The exact bug ADI-08 stage 7 found: `transportId` is real, frozen, and part of the scope --
     * but comparing it here would make `FallbackGate.authorize()`'s `scope_mismatch` check fire on
     * every legitimate cross-transport fallback, unconditionally, since a fallback's whole premise
     * is "same launch context, different transport". This is the regression test for that fix.
     */
    it.each(LAUNCH_SCOPE_FIELDS_EXCLUDED_FROM_EQUALITY)('does NOT report a difference in %s -- excluded from equality on purpose', (field) => {
      const candidate = {
        ...scope(),
        [field]: MUTATIONS[field as keyof FrozenLaunchScope],
      } as FrozenLaunchScope;
      expect(launchScopesEqual(scope(), candidate)).toBe(true);
    });
  });
});
