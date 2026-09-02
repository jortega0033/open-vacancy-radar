import { describe, expect, it } from 'vitest';
import { toCapacity, toSessionSummary } from '../electron/agent-workspace-view.js';

/**
 * Main's rebuild of the daemon's v2 session read view (ADI-07).
 *
 * The one property worth testing hard is that `cwd`, `providerSessionId`, and
 * `scope.executablePath` are **absent keys**, not undefined values. `{ cwd: undefined }` and `{}`
 * serialize identically over IPC and are different objects to every in-memory check that follows,
 * and only the second passes `expect(summary).not.toHaveProperty('cwd')`.
 */

/** A payload shaped like a real `AgentSessionV2View`, including everything that must not cross. */
const FULL_VIEW = {
  id: '11111111-2222-4333-8444-555555555555',
  provider: 'claude',
  protocolVersion: 1,
  transportId: 'legacy-one-shot',
  model: 'opus',
  status: 'running',
  acceptedWork: 'prompt',
  rootSessionId: '11111111-2222-4333-8444-555555555555',
  continuationKind: 'fresh',
  startedAt: '2026-09-02T10:00:00.000Z',
  earliestSequence: 0,
  eventCount: 12,
  eventsTruncated: false,
  unknownFrames: [{ kind: 'unparseable_line', bytes: 40, sha256: 'a'.repeat(64), occurrences: 2 }],
  scope: {
    executablePath: 'C:/Users/someone/AppData/npm/claude.cmd',
    providerVersion: '1.2.3',
    authenticated: 'authenticated',
    platform: 'win32',
    accountEvidence: 'cli_owned',
  },
  // The two the boundary exists for.
  cwd: 'C:/Users/someone/my-project',
  providerSessionId: 'native-thread-abc',
};

describe('toSessionSummary: no location, ever', () => {
  it('omits cwd, providerSessionId and scope.executablePath as absent keys', () => {
    const summary = toSessionSummary(FULL_VIEW);
    expect(summary).not.toBeNull();
    expect(summary).not.toHaveProperty('cwd');
    expect(summary).not.toHaveProperty('providerSessionId');
    expect(summary?.scope).not.toHaveProperty('executablePath');

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('Users');
    expect(serialized).not.toContain('my-project');
    expect(serialized).not.toContain('native-thread-abc');
    expect(serialized).not.toContain('claude.cmd');
  });

  it('does not carry a path-shaped field a future daemon build might add beside cwd', () => {
    // The whole reason this is a name-by-name rebuild rather than a spread minus omissions.
    const summary = toSessionSummary({
      ...FULL_VIEW,
      workspacePath: 'C:/Users/someone/other',
      stateDirectory: 'C:/Users/someone/.agent-dock',
      logFile: '/var/log/agent.log',
    });
    expect(JSON.stringify(summary)).not.toContain('Users');
    expect(JSON.stringify(summary)).not.toContain('/var/log');
    expect(summary).not.toHaveProperty('workspacePath');
    expect(summary).not.toHaveProperty('stateDirectory');
    expect(summary).not.toHaveProperty('logFile');
  });

  it('copies the fields the UI actually renders', () => {
    expect(toSessionSummary(FULL_VIEW)).toEqual({
      id: '11111111-2222-4333-8444-555555555555',
      provider: 'claude',
      protocolVersion: 1,
      transportId: 'legacy-one-shot',
      model: 'opus',
      status: 'running',
      acceptedWork: 'prompt',
      rootSessionId: '11111111-2222-4333-8444-555555555555',
      continuationKind: 'fresh',
      startedAt: '2026-09-02T10:00:00.000Z',
      earliestSequence: 0,
      eventCount: 12,
      eventsTruncated: false,
      scope: {
        providerVersion: '1.2.3',
        authenticated: 'authenticated',
        platform: 'win32',
        accountEvidence: 'cli_owned',
      },
      // A count, not the frames: they carry structure nothing in this UI acts on.
      unknownFrameCount: 1,
    });
  });

  it('never echoes an accountEvidence value the daemon sent', () => {
    // A stronger identity claim reaching the UI would be a false statement (see the ADR's note on
    // `accountEvidence: 'cli_owned'` not being an account fingerprint).
    const summary = toSessionSummary({ ...FULL_VIEW, scope: { ...FULL_VIEW.scope, accountEvidence: 'verified_account' } });
    expect(summary?.scope.accountEvidence).toBe('cli_owned');
  });
});

describe('toSessionSummary: fail-closed on a payload it cannot read', () => {
  it('returns null for anything that does not even name a session', () => {
    for (const payload of [null, undefined, [], 'x', 42, {}, { id: '' }, { id: 42 }]) {
      expect(toSessionSummary(payload), JSON.stringify(payload)).toBeNull();
    }
  });

  it('substitutes safe defaults rather than rendering a malformed value', () => {
    const summary = toSessionSummary({ id: 'abc', status: 42, eventCount: -5, earliestSequence: 1.5 });
    expect(summary?.status).toBe('starting');
    expect(summary?.provider).toBe('');
    expect(summary?.rootSessionId).toBe('abc');
    expect(summary?.eventCount).toBe(0);
    expect(summary?.earliestSequence).toBe(0);
    expect(summary?.scope).toEqual({ authenticated: 'unknown', platform: 'unknown', accountEvidence: 'cli_owned' });
    expect(summary?.unknownFrameCount).toBe(0);
  });

  it('bounds every string it copies', () => {
    const summary = toSessionSummary({ id: 'a'.repeat(5_000), provider: 'p'.repeat(5_000) });
    expect((summary?.id ?? '').length).toBeLessThanOrEqual(256);
    expect((summary?.provider ?? '').length).toBeLessThanOrEqual(64);
  });

  it('omits the optional fields rather than writing them as undefined', () => {
    const summary = toSessionSummary({ id: 'abc' });
    expect(summary).not.toHaveProperty('model');
    expect(summary).not.toHaveProperty('terminalReason');
    expect(summary).not.toHaveProperty('parentSessionId');
    expect(summary).not.toHaveProperty('completedAt');
    expect(summary?.scope).not.toHaveProperty('providerVersion');
  });
});

describe('toCapacity', () => {
  it('rebuilds both buckets', () => {
    expect(toCapacity({ global: { active: 2, limit: 4 }, provider: { active: 1, limit: 2 } })).toEqual({
      global: { active: 2, limit: 4 },
      provider: { active: 1, limit: 2 },
    });
  });

  it('reports zeroes rather than throwing for a missing or malformed aggregate', () => {
    for (const payload of [undefined, null, {}, 'x', { global: 'nonsense' }]) {
      expect(toCapacity(payload)).toEqual({ global: { active: 0, limit: 0 }, provider: { active: 0, limit: 0 } });
    }
  });

  it('clamps a negative or fractional count to zero rather than rendering it', () => {
    expect(toCapacity({ global: { active: -3, limit: 1.5 } }).global).toEqual({ active: 0, limit: 0 });
  });
});
