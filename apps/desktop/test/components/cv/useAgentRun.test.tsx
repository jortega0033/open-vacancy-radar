import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBridges } from '../../cv-bridges.js';
import { useAgentRun } from '../../../src/components/cv/useAgentRun.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useAgentRun', () => {
  it('does not fail on a recoverable error, waiting for the daemon-promised terminal event', async () => {
    const { emit } = installBridges();
    const { result } = renderHook(() => useAgentRun());

    await act(async () => {
      await result.current.start('draft a letter');
    });

    act(() => {
      emit('sess-cv-1', { type: 'error', message: 'a transient hiccup', recoverable: true });
    });

    // Captured for later, but not terminal on its own: status stays non-terminal because the
    // daemon still owes a session.failed/completed for this session.
    expect(result.current.status).toBe('streaming');
    expect(result.current.error).toBe('a transient hiccup');

    act(() => {
      emit('sess-cv-1', { type: 'session.completed' });
    });
    await waitFor(() => expect(result.current.status).toBe('failed'));
    // The recoverable error's message is still surfaced once the run does turn out empty.
    expect(result.current.error).toBe('a transient hiccup');
  });

  it('fails immediately on a non-recoverable error instead of waiting for the watchdog', async () => {
    const { emit } = installBridges();
    const { result } = renderHook(() => useAgentRun());

    await act(async () => {
      await result.current.start('draft a letter');
    });

    act(() => {
      emit('sess-cv-1', {
        type: 'error',
        message: 'event stream failed: the daemon connection was lost',
        recoverable: false,
      });
    });

    // No session.failed/session.completed ever arrives here (the daemon that would send one is
    // gone) -- this must resolve on its own, not after RUN_TIMEOUT_MS's watchdog.
    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(result.current.error).toBe('event stream failed: the daemon connection was lost');
  });

  it('ignores an event for a session this run is no longer tracking', async () => {
    const { emit } = installBridges();
    const { result } = renderHook(() => useAgentRun());

    await act(async () => {
      await result.current.start('draft a letter');
    });

    act(() => {
      emit('some-other-session', {
        type: 'error',
        message: 'unrelated failure',
        recoverable: false,
      });
    });

    expect(result.current.status).toBe('streaming');
    expect(result.current.error).toBeUndefined();
  });
});
