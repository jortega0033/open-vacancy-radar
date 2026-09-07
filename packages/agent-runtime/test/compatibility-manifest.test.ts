import { describe, expect, it } from 'vitest';
import { buildClaudeArgs } from '../src/providers/claude/build-args.js';
import { buildCodexArgs } from '../src/providers/codex/build-args.js';
import {
  acceptedWorkBoundaryFor,
  CLAUDE_LEGACY_COMPATIBILITY,
  CODEX_APP_SERVER_COMPATIBILITY,
  CODEX_APP_SERVER_TRANSPORT_ID,
  CODEX_LEGACY_COMPATIBILITY,
  findProviderCompatibility,
  LEGACY_ONE_SHOT_TRANSPORT_ID,
  PROVIDER_COMPATIBILITY_MANIFEST,
} from '../src/providers/compatibility-manifest.js';

describe('PROVIDER_COMPATIBILITY_MANIFEST', () => {
  it('pins the exact CLI versions this fork was verified against', () => {
    expect(CLAUDE_LEGACY_COMPATIBILITY.providerVersion).toBe('2.1.228');
    expect(CODEX_LEGACY_COMPATIBILITY.providerVersion).toBe('0.147.0');
    expect(CODEX_APP_SERVER_COMPATIBILITY.providerVersion).toBe('0.147.0');
  });

  it('declares exactly two transports (ADI-08 stage 6) -- the first time this repo has more than one for a provider', () => {
    const transports = new Set(PROVIDER_COMPATIBILITY_MANIFEST.map((e) => e.transportId));
    expect([...transports].sort()).toEqual([CODEX_APP_SERVER_TRANSPORT_ID, LEGACY_ONE_SHOT_TRANSPORT_ID].sort());
  });

  it('registering a second transport here does not by itself arm the fallback gate -- see fallback-gate.test.ts', () => {
    // FallbackGate has no real caller anywhere in this repo yet (ADI-08 stage 7 adds one), so a
    // second manifest entry existing is not the same claim as the gate ever returning allowed:true
    // in shipped behavior. This test exists only to point a future reader at where that claim is
    // actually proven, since it is easy to assume "two transports in the manifest" already means
    // "fallback is live".
    expect(PROVIDER_COMPATIBILITY_MANIFEST.length).toBeGreaterThan(1);
  });

  it('is frozen, entries included', () => {
    expect(Object.isFrozen(PROVIDER_COMPATIBILITY_MANIFEST)).toBe(true);
    for (const entry of PROVIDER_COMPATIBILITY_MANIFEST) expect(Object.isFrozen(entry)).toBe(true);
  });

  it('has no duplicate provider/version/transport triples', () => {
    const keys = PROVIDER_COMPATIBILITY_MANIFEST.map(
      (e) => `${e.provider}|${e.providerVersion}|${e.transportId}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  /**
   * The boundary is a claim about how each adapter actually delivers the prompt, so it is checked
   * against the adapters' real argv builders rather than restated as a literal. If a build-args
   * change moved Claude's prompt into argv (or took Codex's out of it), the manifest would be
   * silently wrong about retry safety, and this is what catches that.
   */
  describe('boundaries match how each adapter really delivers its prompt', () => {
    const prompt = 'a-distinctive-prompt-value';
    const opts = { sessionId: 's', cwd: '/w', prompt };

    it('claude keeps the prompt out of argv, so its boundary is the stdin write', () => {
      expect(buildClaudeArgs(opts).join(' ')).not.toContain(prompt);
      expect(CLAUDE_LEGACY_COMPATIBILITY.acceptedWorkBoundary).toBe('first-prompt-byte-to-stdin');
    });

    it('codex keeps the prompt out of argv too, so its boundary is the stdin write (ADI-14)', () => {
      expect(buildCodexArgs(opts).join(' ')).not.toContain(prompt);
      expect(buildCodexArgs({ ...opts, resumeProviderSessionId: 'thread-1' }).join(' ')).not.toContain(prompt);
      expect(CODEX_LEGACY_COMPATIBILITY.acceptedWorkBoundary).toBe('first-prompt-byte-to-stdin');
    });

    it('codex app-server never writes the prompt to a process stdin at all, so its boundary is the turn/start write (ADI-08 stage 6)', () => {
      // Nothing to assert against build-args.ts here: the app-server transport (transport.ts) has
      // no argv-building step comparable to buildCodexArgs -- the prompt travels as a turn/start
      // JSON-RPC param over an already-open connection, never as process argv or a raw stdin byte.
      expect(CODEX_APP_SERVER_COMPATIBILITY.acceptedWorkBoundary).toBe('turn-start-write-attempt');
    });

    it('leaves no manifest entry claiming the argv boundary, since no adapter uses it any more', () => {
      // The negative half of the same claim, so a future adapter that moves a prompt back into argv
      // without updating this table fails here rather than silently under-reporting retry safety.
      expect(
        PROVIDER_COMPATIBILITY_MANIFEST.filter((e) => e.acceptedWorkBoundary === 'process-spawn-attempt'),
      ).toEqual([]);
    });
  });
});

describe('findProviderCompatibility', () => {
  it('finds an exact provider/version/transport match', () => {
    expect(findProviderCompatibility('claude', '2.1.228', LEGACY_ONE_SHOT_TRANSPORT_ID)).toBe(
      CLAUDE_LEGACY_COMPATIBILITY,
    );
    expect(findProviderCompatibility('codex', '0.147.0', LEGACY_ONE_SHOT_TRANSPORT_ID)).toBe(
      CODEX_LEGACY_COMPATIBILITY,
    );
  });

  it('misses on an undefined version, since an undetected version proves nothing', () => {
    expect(findProviderCompatibility('claude', undefined, LEGACY_ONE_SHOT_TRANSPORT_ID)).toBeUndefined();
  });

  it.each([
    ['a newer patch', '2.1.229'],
    ['an older patch', '2.1.227'],
    ['a newer minor', '2.2.0'],
    ['a version with a suffix', '2.1.228-beta.1'],
    ['a version with surrounding whitespace', ' 2.1.228 '],
    ['the full --version output rather than the version component', '2.1.228 (Claude Code)'],
  ])('misses on %s: there is deliberately no range or fuzzy matching', (_label, version) => {
    expect(findProviderCompatibility('claude', version, LEGACY_ONE_SHOT_TRANSPORT_ID)).toBeUndefined();
  });

  it('misses when the version belongs to the other provider', () => {
    expect(findProviderCompatibility('claude', '0.147.0', LEGACY_ONE_SHOT_TRANSPORT_ID)).toBeUndefined();
  });

  it('misses on an unknown transport id', () => {
    expect(findProviderCompatibility('claude', '2.1.228', 'rich-interactive')).toBeUndefined();
  });

  it('finds the codex app-server entry by its own transport id, distinct from the legacy one', () => {
    expect(findProviderCompatibility('codex', '0.147.0', CODEX_APP_SERVER_TRANSPORT_ID)).toBe(
      CODEX_APP_SERVER_COMPATIBILITY,
    );
    // Same provider, same version, different transport id -- must not cross-match either direction.
    expect(findProviderCompatibility('codex', '0.147.0', LEGACY_ONE_SHOT_TRANSPORT_ID)).toBe(
      CODEX_LEGACY_COMPATIBILITY,
    );
  });

  it('misses on a provider with no manifest entry at all', () => {
    expect(findProviderCompatibility('fake', '1.0.0', LEGACY_ONE_SHOT_TRANSPORT_ID)).toBeUndefined();
  });
});

/**
 * The fail-closed rule, stated as a test because it is the single most consequential default in
 * this ticket: an unverified CLI must get the most conservative boundary, never the least.
 */
describe('acceptedWorkBoundaryFor fails closed on a manifest miss', () => {
  it('returns process-spawn-attempt for an unrecognized provider/version pairing', () => {
    const missed = findProviderCompatibility('claude', '99.99.99', LEGACY_ONE_SHOT_TRANSPORT_ID);
    expect(missed).toBeUndefined();
    expect(acceptedWorkBoundaryFor(missed)).toBe('process-spawn-attempt');
  });

  it('returns process-spawn-attempt for an explicit undefined entry', () => {
    expect(acceptedWorkBoundaryFor(undefined)).toBe('process-spawn-attempt');
  });

  it('never defaults to the later, more permissive stdin boundary', () => {
    // Stated separately and negatively on purpose: defaulting the other way would assume an
    // unverified CLI reads its prompt from stdin, concluding "no work accepted, safe to retry"
    // for an argv-prompt CLI that had already started acting on the user's prompt.
    expect(acceptedWorkBoundaryFor(undefined)).not.toBe('first-prompt-byte-to-stdin');
  });

  it('returns the entry boundary when there is a real match, for every shipped entry', () => {
    expect(acceptedWorkBoundaryFor(CLAUDE_LEGACY_COMPATIBILITY)).toBe('first-prompt-byte-to-stdin');
    expect(acceptedWorkBoundaryFor(CODEX_LEGACY_COMPATIBILITY)).toBe('first-prompt-byte-to-stdin');
    expect(acceptedWorkBoundaryFor(CODEX_APP_SERVER_COMPATIBILITY)).toBe('turn-start-write-attempt');
  });

  it('still fails closed to the argv boundary even though no entry declares it (ADI-14)', () => {
    // Both shipped entries now declare the stdin boundary, so the fail-closed default is no longer
    // reachable by simply reading any real entry. That is exactly why it is asserted separately:
    // the default must stay the conservative one, not drift toward "whatever the entries say".
    expect(acceptedWorkBoundaryFor(undefined)).toBe('process-spawn-attempt');
    expect(
      PROVIDER_COMPATIBILITY_MANIFEST.some((e) => e.acceptedWorkBoundary === acceptedWorkBoundaryFor(undefined)),
    ).toBe(false);
  });
});
