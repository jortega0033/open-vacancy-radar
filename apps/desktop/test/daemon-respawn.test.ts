import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonRespawn, decideDaemonRespawn, type DaemonRespawnPolicy } from '../electron/daemon-respawn.js';

/**
 * The decision logic behind the daemon's bounded respawn-with-backoff, pulled out of `main.ts`
 * for the same reason `tick.ts` and `application-queue-port.ts` were: `main.ts` cannot be imported
 * by a test, so this exact logic -- attempt counting, the backoff formula, the `isQuitting` gate,
 * and the generation guard -- had shipped with no automated coverage of its own. See
 * .claude/ticket-drafts/draft-daemon-respawn-test-coverage.md.
 */

const POLICY: DaemonRespawnPolicy = { maxAttempts: 4, baseDelayMs: 1_000, maxDelayMs: 8_000 };

afterEach(() => {
  vi.useRealTimers();
});

describe('decideDaemonRespawn', () => {
  it('doubles the delay from the base up to the cap, matching the real 1s/2s/4s/8s policy', () => {
    expect(decideDaemonRespawn(0, false, POLICY)).toEqual({ kind: 'retry', attempt: 1, delayMs: 1_000 });
    expect(decideDaemonRespawn(1, false, POLICY)).toEqual({ kind: 'retry', attempt: 2, delayMs: 2_000 });
    expect(decideDaemonRespawn(2, false, POLICY)).toEqual({ kind: 'retry', attempt: 3, delayMs: 4_000 });
    expect(decideDaemonRespawn(3, false, POLICY)).toEqual({ kind: 'retry', attempt: 4, delayMs: 8_000 });
  });

  it('caps the delay rather than letting it keep doubling past maxDelayMs', () => {
    const wideBudget: DaemonRespawnPolicy = { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 8_000 };
    expect(decideDaemonRespawn(4, false, wideBudget)).toEqual({ kind: 'retry', attempt: 5, delayMs: 8_000 });
    expect(decideDaemonRespawn(8, false, wideBudget)).toEqual({ kind: 'retry', attempt: 9, delayMs: 8_000 });
  });

  it('gives up once the max attempt count is already reached', () => {
    expect(decideDaemonRespawn(4, false, POLICY)).toEqual({ kind: 'exhausted', maxAttempts: 4 });
    expect(decideDaemonRespawn(9, false, POLICY)).toEqual({ kind: 'exhausted', maxAttempts: 4 });
  });

  it('never retries while the app is quitting, even with budget left', () => {
    expect(decideDaemonRespawn(0, true, POLICY)).toEqual({ kind: 'quitting' });
  });

  it('quitting wins over an already-exhausted budget too -- there is nothing to report either way', () => {
    expect(decideDaemonRespawn(4, true, POLICY)).toEqual({ kind: 'quitting' });
  });
});

function harness(overrides: Partial<{ isQuitting: boolean; policy: DaemonRespawnPolicy }> = {}) {
  let isQuitting = overrides.isQuitting ?? false;
  const spawnDaemon = vi.fn();
  const onExhausted = vi.fn();
  const onScheduled = vi.fn();
  const respawn = createDaemonRespawn({
    policy: overrides.policy ?? POLICY,
    isQuitting: () => isQuitting,
    spawnDaemon,
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    onExhausted,
    onScheduled,
  });
  return {
    respawn,
    spawnDaemon,
    onExhausted,
    onScheduled,
    setQuitting: (value: boolean) => {
      isQuitting = value;
    },
  };
}

describe('createDaemonRespawn: scheduleRespawn', () => {
  it('schedules a respawn after the real backoff delay elapses', async () => {
    vi.useFakeTimers();
    const { respawn, spawnDaemon, onScheduled } = harness();

    respawn.scheduleRespawn('daemon process exited unexpectedly (code 1, signal null)');
    expect(onScheduled).toHaveBeenCalledWith('daemon process exited unexpectedly (code 1, signal null)', 1, 4, 1_000);
    expect(spawnDaemon).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnDaemon).toHaveBeenCalledTimes(1);
  });

  it('gives up after the real max attempt count, never calling spawnDaemon on the exhausted attempt', async () => {
    vi.useFakeTimers();
    const { respawn, spawnDaemon, onExhausted } = harness();

    for (let i = 0; i < 4; i += 1) {
      respawn.scheduleRespawn(`exit ${i}`);
      await vi.advanceTimersByTimeAsync(8_000);
    }
    expect(spawnDaemon).toHaveBeenCalledTimes(4);

    respawn.scheduleRespawn('exit 4');
    expect(onExhausted).toHaveBeenCalledWith('exit 4', 4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawnDaemon).toHaveBeenCalledTimes(4); // the 5th failure never gets its own timer at all
  });

  it('never retries when isQuitting is already true at schedule time', () => {
    const { respawn, spawnDaemon, onScheduled, onExhausted } = harness({ isQuitting: true });

    respawn.scheduleRespawn('daemon process exited unexpectedly');

    expect(spawnDaemon).not.toHaveBeenCalled();
    expect(onScheduled).not.toHaveBeenCalled();
    expect(onExhausted).not.toHaveBeenCalled();
  });

  /**
   * Matches the real implementation's comment: "isQuitting may have flipped true while this timer
   * was pending (the user quit mid-backoff)." A respawn can be scheduled while the app is still
   * running and then have the user quit before the delay elapses -- the delayed callback must catch
   * that itself, not just trust the check it already passed when it was scheduled.
   */
  it('never retries when isQuitting flips true after scheduling but before the delay elapses', async () => {
    vi.useFakeTimers();
    const { respawn, spawnDaemon, setQuitting } = harness();

    respawn.scheduleRespawn('daemon process exited unexpectedly');
    setQuitting(true);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(spawnDaemon).not.toHaveBeenCalled();
  });

  it('resetAttempts gives a daemon that later crashes again a fresh budget instead of inheriting exhaustion', async () => {
    vi.useFakeTimers();
    const { respawn, spawnDaemon, onExhausted } = harness();

    for (let i = 0; i < 4; i += 1) {
      respawn.scheduleRespawn(`exit ${i}`);
      await vi.advanceTimersByTimeAsync(8_000);
    }
    respawn.scheduleRespawn('exit 4');
    expect(onExhausted).toHaveBeenCalledTimes(1);

    respawn.resetAttempts(); // the equivalent of waitForDaemonReady reaching 'ready'
    respawn.scheduleRespawn('a later, unrelated crash');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnDaemon).toHaveBeenCalledTimes(5); // 4 from the exhausted run + 1 from the fresh budget
  });
});

describe('createDaemonRespawn: generation guard', () => {
  it('counts generations up from a real spawn, and only the latest one reads as current', () => {
    const { respawn } = harness();

    const first = respawn.nextGeneration();
    expect(first).toBe(1);
    expect(respawn.isCurrentGeneration(1)).toBe(true);

    const second = respawn.nextGeneration();
    expect(second).toBe(2);
    expect(respawn.isCurrentGeneration(1)).toBe(false); // superseded by the second spawn
    expect(respawn.isCurrentGeneration(2)).toBe(true);
  });

  it("a stale generation's late resolution is correctly a no-op: only the most recent spawn's generation is current", () => {
    const { respawn } = harness();

    const stale = respawn.nextGeneration(); // an attempt that will crash immediately
    const current = respawn.nextGeneration(); // the respawn that superseded it

    expect(respawn.isCurrentGeneration(stale)).toBe(false);
    expect(respawn.isCurrentGeneration(current)).toBe(true);
  });
});
