import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTick } from '../electron/tick.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('createTick', () => {
  it('runs the given work and reports not in-flight once it settles', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const tick = createTick({ label: 'test', run });
    expect(tick.inFlight).toBe(false);
    await tick.runOnce();
    expect(run).toHaveBeenCalledTimes(1);
    expect(tick.inFlight).toBe(false);
  });

  it('ignores a second runOnce while the first is still in flight, and picks it up on the next call', async () => {
    let release: (() => void) | undefined;
    const run = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
      .mockResolvedValueOnce(undefined);
    const tick = createTick({ label: 'test', run });

    const first = tick.runOnce();
    expect(tick.inFlight).toBe(true);
    await tick.runOnce(); // arrives mid-turn -- a deliberate, silent no-op
    expect(run).toHaveBeenCalledTimes(1);

    release?.();
    await first;
    expect(tick.inFlight).toBe(false);

    await tick.runOnce();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('catches a rejection from run() and still frees the in-flight guard for the next call', async () => {
    const onError = vi.fn();
    const run = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);
    const tick = createTick({ label: 'test', run, onError });

    await tick.runOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
    expect(tick.inFlight).toBe(false);

    await tick.runOnce();
    expect(run).toHaveBeenCalledTimes(2);
  });

  /**
   * The regression test for the incident this module exists to prevent a repeat of: a turn that
   * hangs forever (no error, no resolution -- exactly what a stuck CDP call, an untimed AI session,
   * or the daemonFetch-without-a-timeout bug fixed earlier this session all look like from the
   * tick's point of view) must not leave the in-flight guard permanently `true`. Before this module
   * existed, that is precisely what happened: `applicationPipelineTickInFlight` stayed `true`
   * forever and every later tick silently no-op'd with no error ever logged.
   */
  it('recovers from a run() that never settles, once hardTimeoutMs elapses', async () => {
    vi.useFakeTimers();
    const neverResolves = new Promise<void>(() => {});
    const run = vi.fn().mockReturnValueOnce(neverResolves).mockResolvedValueOnce(undefined);
    const onError = vi.fn();
    const tick = createTick({ label: 'stuck-worker', run, hardTimeoutMs: 5000, onError });

    const stuck = tick.runOnce();
    expect(tick.inFlight).toBe(true);

    await vi.advanceTimersByTimeAsync(5000);
    await stuck;

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'stuck-worker tick exceeded its hard timeout' }),
    );
    // The guard is free again -- a later, unrelated tick is not permanently disabled by the earlier
    // hang, which is the entire point of the hard timeout.
    expect(tick.inFlight).toBe(false);
    await tick.runOnce();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('with no hardTimeoutMs, a hung run() leaves the guard true -- the exact prior behavior this replaces', async () => {
    const run = vi.fn().mockReturnValue(new Promise<void>(() => {}));
    const tick = createTick({ label: 'unbounded', run });

    void tick.runOnce();
    await Promise.resolve();
    expect(tick.inFlight).toBe(true);
    await tick.runOnce(); // a second call while stuck is still a silent no-op, not a second run
    expect(run).toHaveBeenCalledTimes(1);
  });
});
