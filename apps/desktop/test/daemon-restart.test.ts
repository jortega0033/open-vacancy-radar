import { describe, expect, it, vi } from 'vitest';
import { createDaemonRestart } from '../electron/daemon-restart.js';
import type { DaemonStatus } from '../electron/preload.js';

function harness(overrides: { quitting?: boolean; status?: DaemonStatus } = {}) {
  const order: string[] = [];
  let settle!: (status: DaemonStatus) => void;
  let releaseStop!: () => void;
  const supersede = vi.fn(() => order.push('supersede'));
  const stopChild = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        order.push('stopChild');
        releaseStop = resolve;
      }),
  );
  const spawn = vi.fn(() => order.push('spawn'));
  const nextSettledStatus = vi.fn(() => {
    order.push('nextSettledStatus');
    return new Promise<DaemonStatus>((resolve) => {
      settle = resolve;
    });
  });
  const restart = createDaemonRestart({
    isQuitting: () => overrides.quitting ?? false,
    currentStatus: () => overrides.status ?? { state: 'unavailable', error: 'down' },
    supersede,
    stopChild,
    nextSettledStatus,
    spawn,
  });
  return { restart, order, supersede, stopChild, spawn, nextSettledStatus, settle: (s: DaemonStatus) => settle(s), releaseStop: () => releaseStop() };
}

describe('createDaemonRestart', () => {
  it('supersedes the old attempt, stops the old child, then waits for a status before spawning', async () => {
    const h = harness();
    const result = h.restart.restart();
    await vi.waitFor(() => expect(h.stopChild).toHaveBeenCalled());
    expect(h.spawn).not.toHaveBeenCalled();
    h.releaseStop();
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalled());
    expect(h.order).toEqual(['supersede', 'stopChild', 'nextSettledStatus', 'spawn']);
    h.settle({ state: 'ready' });
    await expect(result).resolves.toEqual({ state: 'ready' });
  });

  it('shares one restart between repeated calls, so only one helper is ever spawned', async () => {
    const h = harness();
    const first = h.restart.restart();
    const second = h.restart.restart();
    expect(second).toBe(first);
    h.releaseStop();
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalled());
    h.settle({ state: 'unavailable', error: 'still down' });
    await expect(first).resolves.toEqual({ state: 'unavailable', error: 'still down' });
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(h.stopChild).toHaveBeenCalledTimes(1);
  });

  it('allows a new restart once the previous one has finished', async () => {
    const h = harness();
    const first = h.restart.restart();
    h.releaseStop();
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(1));
    h.settle({ state: 'unavailable', error: 'still down' });
    await first;

    const second = h.restart.restart();
    h.releaseStop();
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(2));
    h.settle({ state: 'ready' });
    await expect(second).resolves.toEqual({ state: 'ready' });
  });

  it('does nothing when the helper is already ready', async () => {
    const h = harness({ status: { state: 'ready' } });
    await expect(h.restart.restart()).resolves.toEqual({ state: 'ready' });
    expect(h.supersede).not.toHaveBeenCalled();
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('refuses while the app is quitting', async () => {
    const h = harness({ quitting: true });
    await expect(h.restart.restart()).resolves.toEqual({ state: 'unavailable', error: 'the app is closing' });
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('reports a failure from stopping the old child as an unavailable result and stays retryable', async () => {
    const h = harness();
    h.stopChild.mockRejectedValueOnce(new Error('kill failed'));
    await expect(h.restart.restart()).resolves.toEqual({ state: 'unavailable', error: 'kill failed' });
    expect(h.spawn).not.toHaveBeenCalled();
    const retry = h.restart.restart();
    h.releaseStop();
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(1));
    h.settle({ state: 'ready' });
    await expect(retry).resolves.toEqual({ state: 'ready' });
  });
});
