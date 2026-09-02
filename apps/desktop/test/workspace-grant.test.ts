import { describe, expect, it } from 'vitest';
import type { WorkspaceTrustView } from '@agent-dock/shared';
import {
  GRANT_HANDLE_LENGTH,
  GRANT_TTL_MS,
  WorkspaceGrantManager,
  WorkspaceGrantRefusedError,
  type DaemonConsumeOutcome,
  type WorkspaceGrantDeps,
} from '../electron/workspace-grant.js';

/**
 * The grant state machine, tested against a stub daemon.
 *
 * A stub rather than a live daemon on purpose: what these tests are about is the main-process half
 * of the contract (binding, single use, expiry, and the fact that no path ever reaches the caller),
 * and the daemon half has its own end-to-end coverage in
 * apps/daemon/test/v2-workspaces.routes.test.ts. Splitting them keeps each set able to fail for
 * exactly one reason.
 */

const WORKSPACE_ID = 'a'.repeat(64);
const INCARNATION = 'b'.repeat(64);
const SECRET_PATH = 'C:\\Users\\someone\\SENTINEL_SECRET_PROJECT';
const DAEMON_A = '11111111-1111-4111-8111-111111111111';
const DAEMON_B = '22222222-2222-4222-8222-222222222222';

const RENDERER = 7;
const OTHER_RENDERER = 9;

interface Harness {
  manager: WorkspaceGrantManager;
  calls: {
    inspect: { path: string; provider: string }[];
    consume: Record<string, unknown>[];
    events: Record<string, unknown>[];
    confirm: Record<string, unknown>[];
  };
  setNow: (value: number) => void;
  setDaemon: (value: string | undefined) => void;
  setPickResult: (value: string | null) => void;
  setConfirmResult: (value: boolean) => void;
  setConsumeOutcome: (value: DaemonConsumeOutcome) => void;
  failEventRecording: (fail: boolean) => void;
}

function view(overrides: Partial<WorkspaceTrustView> = {}): WorkspaceTrustView {
  return {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    incarnation: INCARNATION,
    displayName: 'SENTINEL_SECRET_PROJECT',
    branch: 'main',
    dirty: false,
    reusable: true,
    state: 'untrusted',
    ...overrides,
  };
}

function harness(overrides: Partial<WorkspaceGrantDeps> = {}, trustView = view()): Harness {
  const calls: Harness['calls'] = { inspect: [], consume: [], events: [], confirm: [] };
  let now = 1_000_000;
  let daemon: string | undefined = DAEMON_A;
  let pickResult: string | null = SECRET_PATH;
  let confirmResult = true;
  let consumeOutcome: DaemonConsumeOutcome = { ok: true };
  let eventFailure = false;

  const manager = new WorkspaceGrantManager({
    inspectWorkspace: async (input) => {
      calls.inspect.push(input);
      return trustView;
    },
    consumeGrant: async (input) => {
      calls.consume.push(input as unknown as Record<string, unknown>);
      return consumeOutcome;
    },
    recordGrantEvent: async (input) => {
      calls.events.push(input as unknown as Record<string, unknown>);
      if (eventFailure) throw new WorkspaceGrantRefusedError('audit unavailable', 'audit_failure');
    },
    pickDirectory: async () => pickResult,
    confirm: async (input) => {
      calls.confirm.push(input as unknown as Record<string, unknown>);
      return confirmResult;
    },
    daemonInstanceId: () => daemon,
    providerName: () => 'Claude Code',
    now: () => now,
    ...overrides,
  });

  return {
    manager,
    calls,
    setNow: (value) => {
      now = value;
    },
    setDaemon: (value) => {
      daemon = value;
    },
    setPickResult: (value) => {
      pickResult = value;
    },
    setConfirmResult: (value) => {
      confirmResult = value;
    },
    setConsumeOutcome: (value) => {
      consumeOutcome = value;
    },
    failEventRecording: (fail) => {
      eventFailure = fail;
    },
  };
}

/** Recursively collects every string anywhere in a value. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) allStrings(item, out);
  return out;
}

describe('requestGrant: the renderer never learns a path', () => {
  it('returns only an opaque handle and a bounded display object', async () => {
    const { manager } = harness();
    const offer = await manager.requestGrant('claude', RENDERER);

    expect(offer).not.toBeNull();
    expect(offer?.grantHandle).toHaveLength(GRANT_HANDLE_LENGTH);
    expect(offer?.grantHandle).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(offer?.display).toEqual({
      name: 'SENTINEL_SECRET_PROJECT',
      branch: 'main',
      dirty: false,
      effects: 'unbounded_cli',
    });
  });

  it('deep-walks the whole response and finds no path, no drive letter, and no separator', async () => {
    const { manager } = harness();
    const offer = await manager.requestGrant('claude', RENDERER);

    for (const value of allStrings(offer)) {
      expect(value).not.toContain(SECRET_PATH);
      expect(value).not.toContain('C:\\');
      expect(value).not.toContain('\\');
      expect(value).not.toContain('/');
    }
    // The one human-readable string is the folder's own name, which is what a confirmation dialog
    // has to be able to show. It is a basename, never a path.
    expect(JSON.stringify(offer)).toContain('SENTINEL_SECRET_PROJECT');
    expect(JSON.stringify(offer)).not.toContain('Users');
  });

  it('never returns the workspaceId or the incarnation: they are the daemon`s trust keys', async () => {
    const { manager } = harness();
    const offer = await manager.requestGrant('claude', RENDERER);
    const serialized = JSON.stringify(offer);
    expect(serialized).not.toContain(WORKSPACE_ID);
    expect(serialized).not.toContain(INCARNATION);
  });

  it('takes no path argument at all: the folder can only come from the native picker', async () => {
    const { manager, calls } = harness();
    // The signature has nowhere to put a path, so even a caller determined to supply one cannot.
    await (manager.requestGrant as (p: string, id: number, sneaky?: string) => Promise<unknown>)(
      'claude',
      RENDERER,
      'C:\\Users\\someone\\.ssh',
    );
    expect(calls.inspect).toEqual([{ path: SECRET_PATH, provider: 'claude' }]);
  });

  it('shows the confirmation dialog with the effects disclosure, not a narrowed claim', async () => {
    const { manager, calls } = harness();
    await manager.requestGrant('claude', RENDERER);
    expect(calls.confirm[0]).toMatchObject({
      displayName: 'SENTINEL_SECRET_PROJECT',
      branch: 'main',
      dirty: false,
      effects: 'unbounded_cli',
    });
  });
});

describe('requestGrant: refusals write nothing', () => {
  it('issues no grant and records no audit entry when the picker is cancelled', async () => {
    const { manager, calls, setPickResult } = harness();
    setPickResult(null);

    expect(await manager.requestGrant('claude', RENDERER)).toBeNull();
    expect(calls.inspect).toEqual([]);
    expect(calls.confirm).toEqual([]);
    expect(calls.events).toEqual([]);
    expect(manager.outstanding).toBe(0);
  });

  it('issues no grant and records no audit entry when the user cancels the confirmation', async () => {
    const { manager, calls, setConfirmResult } = harness();
    setConfirmResult(false);

    expect(await manager.requestGrant('claude', RENDERER)).toBeNull();
    expect(calls.confirm).toHaveLength(1);
    // Deliberately nothing: an entry for "asked and declined" records a non-decision, and would let
    // anyone fill a log whose cap denies real actions just by opening and dismissing a dialog.
    expect(calls.events).toEqual([]);
    expect(manager.outstanding).toBe(0);
  });

  it('refuses a non-reusable workspace before ever showing the dialog', async () => {
    const { manager, calls } = harness({}, view({ reusable: false }));
    await expect(manager.requestGrant('claude', RENDERER)).rejects.toBeInstanceOf(
      WorkspaceGrantRefusedError,
    );
    expect(calls.confirm).toEqual([]);
    expect(manager.outstanding).toBe(0);
  });

  it('refuses when no daemon is connected, rather than minting a grant nothing can honor', async () => {
    const { manager, setDaemon } = harness();
    setDaemon(undefined);
    await expect(manager.requestGrant('claude', RENDERER)).rejects.toBeInstanceOf(
      WorkspaceGrantRefusedError,
    );
  });

  it('never lets a filesystem error message reach the caller when the audit write fails', async () => {
    // What a real audit-store failure looks like by the time it gets here: the daemon's log path,
    // quoted verbatim by the OS. `requestGrant` used to call `recordGrantEvent` with no catch at
    // all, so this string became the IPC rejection the renderer sees -- in the one module whose
    // entire job is that the renderer never learns where anything is on disk.
    const AUDIT_LOG_PATH = 'C:\\Users\\someone\\AppData\\Roaming\\agentdock-state\\workspace-audit\\audit.jsonl';
    const { manager } = harness({
      recordGrantEvent: async () => {
        throw new Error(`EACCES: permission denied, open '${AUDIT_LOG_PATH}'`);
      },
    });

    const err = await manager.requestGrant('claude', RENDERER).catch((caught: unknown) => caught);

    expect(err).toBeInstanceOf(WorkspaceGrantRefusedError);
    const message = (err as WorkspaceGrantRefusedError).message;
    expect(message).toBe(
      'this approval could not be recorded in the security log, so no workspace was granted',
    );
    for (const sentinel of [AUDIT_LOG_PATH, 'audit.jsonl', 'agentdock-state', 'C:\\', 'EACCES']) {
      expect(message, `${sentinel} leaked to the renderer`).not.toContain(sentinel);
    }
    expect((err as WorkspaceGrantRefusedError).code).toBe('audit_failure');
    expect(manager.outstanding).toBe(0);
  });

  it('issues no usable grant when the audit entry for the issuance cannot be written', async () => {
    const { manager, failEventRecording } = harness();
    failEventRecording(true);
    await expect(manager.requestGrant('claude', RENDERER)).rejects.toThrow();
    // The record is added to the map only after the audit write resolves, so a failure leaves
    // nothing behind that a later consumption could find.
    expect(manager.outstanding).toBe(0);
  });
});

describe('consumeGrant: single use, bound to one WebContents', () => {
  it('rejects a forged handle of the right length', async () => {
    const { manager, calls } = harness();
    await manager.requestGrant('claude', RENDERER);

    const forged = 'F'.repeat(GRANT_HANDLE_LENGTH);
    expect(await manager.consumeGrant(forged, RENDERER)).toEqual({ ok: false, reason: 'unknown_handle' });
    expect(calls.consume).toEqual([]);
  });

  it('rejects handles of the wrong shape without touching the daemon', async () => {
    const { manager, calls } = harness();
    for (const bad of ['', 'short', 'x'.repeat(200), null, undefined, 42, { grantHandle: 'x' }]) {
      expect(await manager.consumeGrant(bad, RENDERER)).toEqual({ ok: false, reason: 'unknown_handle' });
    }
    expect(calls.consume).toEqual([]);
  });

  it('rejects a grant issued to WebContents A when WebContents B presents it', async () => {
    const { manager, calls } = harness();
    const offer = await manager.requestGrant('claude', RENDERER);

    expect(await manager.consumeGrant(offer?.grantHandle, OTHER_RENDERER)).toEqual({
      ok: false,
      reason: 'wrong_webcontents',
    });
    expect(calls.consume).toEqual([]);

    // And the legitimate holder's grant is untouched: a wrong-caller attempt must not become a way
    // to destroy someone else's approval.
    expect(await manager.consumeGrant(offer?.grantHandle, RENDERER)).toEqual({ ok: true });
  });

  it('yields exactly one success for two genuinely concurrent consumptions of the same handle', async () => {
    // The delete-before-await critical section. Without it, both calls find the record, both call
    // the daemon, and the grant is spent twice.
    const { manager, calls } = harness();
    const offer = await manager.requestGrant('claude', RENDERER);

    const [first, second] = await Promise.all([
      manager.consumeGrant(offer?.grantHandle, RENDERER),
      manager.consumeGrant(offer?.grantHandle, RENDERER),
    ]);

    const successes = [first, second].filter((result) => result.ok);
    expect(successes).toHaveLength(1);
    expect([first, second].find((result) => !result.ok)).toEqual({
      ok: false,
      reason: 'already_consumed',
    });
    // One daemon round trip, not two.
    expect(calls.consume).toHaveLength(1);
  });

  it('survives a burst of concurrent attempts with exactly one winner', async () => {
    const { manager, calls } = harness();
    const offer = await manager.requestGrant('claude', RENDERER);

    const results = await Promise.all(
      Array.from({ length: 20 }, () => manager.consumeGrant(offer?.grantHandle, RENDERER)),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(calls.consume).toHaveLength(1);
  });

  it('hands the daemon the path it kept, and the pair the grant vouches for', async () => {
    const { manager, calls } = harness();
    const offer = await manager.requestGrant('claude', RENDERER);
    await manager.consumeGrant(offer?.grantHandle, RENDERER);

    expect(calls.consume[0]).toEqual({
      path: SECRET_PATH,
      provider: 'claude',
      workspaceId: WORKSPACE_ID,
      incarnation: INCARNATION,
    });
  });

  it('reports the daemon`s refusal reason verbatim, and spends the grant either way', async () => {
    const { manager, setConsumeOutcome } = harness();
    setConsumeOutcome({ ok: false, reason: 'identity_drift' });
    const offer = await manager.requestGrant('claude', RENDERER);

    expect(await manager.consumeGrant(offer?.grantHandle, RENDERER)).toEqual({
      ok: false,
      reason: 'identity_drift',
    });
    // Single-use means single-use: a refused consumption still spends the handle, so a caller
    // cannot retry against a changed filesystem until it succeeds.
    expect(await manager.consumeGrant(offer?.grantHandle, RENDERER)).toEqual({
      ok: false,
      reason: 'already_consumed',
    });
  });
});

describe('expiry', () => {
  it('succeeds just before the TTL and fails just after it', async () => {
    const { manager, setNow } = harness();
    const first = await manager.requestGrant('claude', RENDERER);
    setNow(1_000_000 + GRANT_TTL_MS - 1);
    expect(await manager.consumeGrant(first?.grantHandle, RENDERER)).toEqual({ ok: true });

    setNow(2_000_000);
    const second = await manager.requestGrant('claude', RENDERER);
    setNow(2_000_000 + GRANT_TTL_MS);
    expect(await manager.consumeGrant(second?.grantHandle, RENDERER)).toEqual({
      ok: false,
      reason: 'timeout',
    });
  });

  it('expires every grant belonging to a navigating WebContents, and only those', async () => {
    const { manager } = harness();
    const mine = await manager.requestGrant('claude', RENDERER);
    const theirs = await manager.requestGrant('claude', OTHER_RENDERER);

    const expired = manager.expireForWebContents(RENDERER, 'navigation');

    expect(expired).toHaveLength(1);
    expect(await manager.consumeGrant(mine?.grantHandle, RENDERER)).toEqual({
      ok: false,
      reason: 'navigation',
    });
    expect(await manager.consumeGrant(theirs?.grantHandle, OTHER_RENDERER)).toEqual({ ok: true });
  });

  it('expires grants when the WebContents is destroyed', async () => {
    const { manager } = harness();
    const offer = await manager.requestGrant('claude', RENDERER);
    manager.expireForWebContents(RENDERER, 'webcontents_destroyed');
    expect(await manager.consumeGrant(offer?.grantHandle, RENDERER)).toEqual({
      ok: false,
      reason: 'webcontents_destroyed',
    });
  });

  it('expires every outstanding grant when the daemon generation changes', async () => {
    const { manager } = harness();
    const a = await manager.requestGrant('claude', RENDERER);
    const b = await manager.requestGrant('claude', OTHER_RENDERER);

    expect(manager.expireAll('daemon_generation')).toHaveLength(2);
    expect(await manager.consumeGrant(a?.grantHandle, RENDERER)).toEqual({
      ok: false,
      reason: 'daemon_generation',
    });
    expect(await manager.consumeGrant(b?.grantHandle, OTHER_RENDERER)).toEqual({
      ok: false,
      reason: 'daemon_generation',
    });
  });

  it('refuses a grant whose daemon has been replaced, even if nothing expired it explicitly', async () => {
    // Belt and braces: the consumption path re-checks the instance id itself, so a grant survives
    // neither an explicit expiry sweep nor a silent daemon swap.
    const { manager, setDaemon, calls } = harness();
    const offer = await manager.requestGrant('claude', RENDERER);
    setDaemon(DAEMON_B);

    expect(await manager.consumeGrant(offer?.grantHandle, RENDERER)).toEqual({
      ok: false,
      reason: 'daemon_generation',
    });
    expect(calls.consume).toEqual([]);
  });

  it('expires every grant for a revoked workspace', async () => {
    const { manager } = harness();
    const offer = await manager.requestGrant('claude', RENDERER);
    expect(manager.expireForWorkspace(WORKSPACE_ID)).toHaveLength(1);
    expect(await manager.consumeGrant(offer?.grantHandle, RENDERER)).toEqual({
      ok: false,
      reason: 'trust_revoked',
    });
  });

  it('reports expiries to the audit log without letting a failed write break the expiry itself', async () => {
    const { manager, calls, failEventRecording } = harness();
    const offer = await manager.requestGrant('claude', RENDERER);
    calls.events.length = 0;

    const expired = manager.expireForWebContents(RENDERER, 'navigation');
    failEventRecording(true);
    // An unrecorded DE-authorization is not the same as an unrecorded authorization: the grant is
    // already gone from memory and can never be used again, whatever the log says.
    await expect(manager.reportExpiries(expired, 'navigation', 'navigation')).resolves.toBeUndefined();
    expect(calls.events[0]).toMatchObject({ event: 'grant.denied', reason: 'navigation' });
    expect(await manager.consumeGrant(offer?.grantHandle, RENDERER)).toEqual({
      ok: false,
      reason: 'navigation',
    });
  });
});

describe('grantStatus', () => {
  it('reports an active grant with its remaining time, and never a path', async () => {
    const { manager, setNow } = harness();
    const offer = await manager.requestGrant('claude', RENDERER);
    setNow(1_000_000 + 60_000);

    const status = manager.grantStatus(offer?.grantHandle);
    expect(status).toEqual({ state: 'active', expiresInMs: GRANT_TTL_MS - 60_000 });
    for (const value of allStrings(status)) expect(value).not.toContain('C:\\');
  });

  it('reports why a gone grant is gone, using the reason vocabulary and nothing else', async () => {
    const { manager } = harness();
    const offer = await manager.requestGrant('claude', RENDERER);
    manager.expireForWebContents(RENDERER, 'trust_revoked');
    expect(manager.grantStatus(offer?.grantHandle)).toEqual({ state: 'gone', reason: 'trust_revoked' });
    expect(manager.grantStatus('unknown')).toEqual({ state: 'gone', reason: 'unknown_handle' });
  });

  it('sweeps a TTL-expired grant on a status read rather than reporting it active forever', async () => {
    const { manager, setNow } = harness();
    const offer = await manager.requestGrant('claude', RENDERER);
    setNow(1_000_000 + GRANT_TTL_MS + 1);
    expect(manager.grantStatus(offer?.grantHandle)).toEqual({ state: 'gone', reason: 'timeout' });
    expect(manager.outstanding).toBe(0);
  });
});

describe('handle generation', () => {
  it('mints 32 random bytes as 43 base64url characters, and never repeats one', async () => {
    const { manager } = harness();
    const handles = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const offer = await manager.requestGrant('claude', RENDERER);
      expect(offer?.grantHandle).toHaveLength(43);
      handles.add(offer?.grantHandle ?? '');
    }
    expect(handles.size).toBe(50);
  });

  it('bounds its tombstone map, so a long-running process does not grow one entry per grant', async () => {
    const { manager } = harness();
    const first = await manager.requestGrant('claude', RENDERER);
    await manager.consumeGrant(first?.grantHandle, RENDERER);
    expect(manager.grantStatus(first?.grantHandle)).toEqual({ state: 'gone', reason: 'already_consumed' });

    for (let i = 0; i < WorkspaceGrantManager.MAX_TOMBSTONES + 5; i++) {
      const offer = await manager.requestGrant('claude', RENDERER);
      await manager.consumeGrant(offer?.grantHandle, RENDERER);
    }

    // Evicted, so the oldest handle degrades from a specific reason to the generic one. That is the
    // right direction to lose precision in: the answer is still a refusal.
    expect(manager.grantStatus(first?.grantHandle)).toEqual({ state: 'gone', reason: 'unknown_handle' });
    expect(manager.outstanding).toBe(0);
  });
});
