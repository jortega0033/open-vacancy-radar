import { describe, expect, it, vi } from 'vitest';
import { waitWithOneRetry } from '../electron/daemon-ready-retry.js';

/**
 * Covers the one-retry policy for a daemon that is slow to start but alive (agentdock#174, #427).
 * Pulled out of `main.ts` for the same reason `daemon-lock-attach.test.ts` covers its module:
 * `main.ts` cannot be imported by a test.
 */

describe('waitWithOneRetry', () => {
  it('makes a single attempt when the daemon is ready in time', async () => {
    const attempt = vi.fn().mockResolvedValue(undefined);

    await waitWithOneRetry(attempt, () => true);

    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('succeeds when the daemon becomes ready inside the second window', async () => {
    const attempt = vi.fn().mockRejectedValueOnce(new Error('timed out')).mockResolvedValueOnce(undefined);

    await expect(waitWithOneRetry(attempt, () => true)).resolves.toBeUndefined();

    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('rejects with the second failure, and never tries a third time', async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error('first timeout'))
      .mockRejectedValueOnce(new Error('second timeout'));

    await expect(waitWithOneRetry(attempt, () => true)).rejects.toThrow('second timeout');

    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('does not retry, and does not fail, when a respawn already superseded this attempt', async () => {
    const attempt = vi.fn().mockRejectedValue(new Error('timed out'));

    await expect(waitWithOneRetry(attempt, () => false)).resolves.toBeUndefined();

    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
