import { describe, expect, it, vi } from 'vitest';
import { tryAttachToWinningDaemon, type DiscoveredDaemon } from '../electron/daemon-lock-attach.js';

/**
 * Covers the decision this process makes after its own daemon child exits with
 * `DAEMON_EXIT_CODE_LOCK_CONFLICT`: attach to the discovery file's daemon when it is actually
 * reachable, fall back to the ordinary failure path otherwise. Pulled out of `main.ts` for the same
 * reason `daemon-respawn.test.ts` covers `daemon-respawn.ts`: `main.ts` cannot be imported by a
 * test.
 */

const DAEMON: DiscoveredDaemon = { baseUrl: 'http://127.0.0.1:4321', token: 'tok' };

describe('tryAttachToWinningDaemon', () => {
  it('attaches when the discovery file is present and the daemon answers health()', async () => {
    const checkHealth = vi.fn().mockResolvedValue({ daemonInstanceId: 'inst-1' });

    const result = await tryAttachToWinningDaemon({
      readDiscoveryFile: () => DAEMON,
      checkHealth,
    });

    expect(result).toEqual({ daemon: DAEMON, health: { daemonInstanceId: 'inst-1' } });
    expect(checkHealth).toHaveBeenCalledWith(DAEMON);
  });

  it('reports nothing to attach to when there is no discovery file at all', async () => {
    const checkHealth = vi.fn();

    const result = await tryAttachToWinningDaemon({
      readDiscoveryFile: () => undefined,
      checkHealth,
    });

    expect(result).toBeUndefined();
    expect(checkHealth).not.toHaveBeenCalled(); // nothing to check health of
  });

  it('reports nothing to attach to when the discovered daemon is not actually reachable', async () => {
    // The discovery file can be stale (its daemon already exited) or mid-write by one that hasn't
    // finished starting -- either way this is the "fall back to the ordinary failure" case, not a
    // thrown error, since a lock conflict with nothing reachable behind it is still informative.
    const result = await tryAttachToWinningDaemon({
      readDiscoveryFile: () => DAEMON,
      checkHealth: async () => undefined,
    });

    expect(result).toBeUndefined();
  });
});
