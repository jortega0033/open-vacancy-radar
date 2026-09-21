import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_NOT_INSTALLED, CODEX_INSTALLED, installBridges } from '../../cv-bridges.js';
import { installWorkspaceBridge } from '../../workspace-bridge.js';
import { useAgentRun } from '../../../src/components/cv/useAgentRun.js';

afterEach(() => {
  vi.restoreAllMocks();
});

interface CreatedSession {
  id: string;
  provider: 'claude';
  cwd: string;
  prompt: string;
  status: 'starting';
  startedAt: string;
}

function deferredSession(): {
  promise: Promise<CreatedSession>;
  resolve: (id: string) => void;
} {
  let resolveFn!: (session: CreatedSession) => void;
  const promise = new Promise<CreatedSession>((resolve) => {
    resolveFn = resolve;
  });
  return {
    promise,
    resolve: (id: string) =>
      resolveFn({ id, provider: 'claude', cwd: '/x', prompt: 'ignored', status: 'starting', startedAt: new Date().toISOString() }),
  };
}

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

  describe('provider resolution when start() is called with no explicit provider (issue #400)', () => {
    it('resolves the effective provider from settings + live detection instead of hardcoding Claude Code', async () => {
      const bridges = installBridges({
        agentDock: { listProviders: vi.fn().mockResolvedValue([CLAUDE_NOT_INSTALLED, CODEX_INSTALLED]) },
      });
      installWorkspaceBridge({ getSettings: vi.fn().mockResolvedValue({ defaultProvider: 'claude' }) });
      const { result } = renderHook(() => useAgentRun());

      await act(async () => {
        await result.current.start('draft a letter');
      });

      expect(bridges.agentDock.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'codex' }),
      );
    });

    it('still uses the preference directly when it is the provider that is actually installed', async () => {
      const bridges = installBridges();
      installWorkspaceBridge({ getSettings: vi.fn().mockResolvedValue({ defaultProvider: 'claude' }) });
      const { result } = renderHook(() => useAgentRun());

      await act(async () => {
        await result.current.start('draft a letter');
      });

      expect(bridges.agentDock.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'claude' }),
      );
    });

    it('never resolves a provider, or reads settings/providers at all, when the caller already passed one explicitly', async () => {
      const bridges = installBridges();
      const workspace = installWorkspaceBridge();
      const { result } = renderHook(() => useAgentRun());

      await act(async () => {
        await result.current.start('draft a letter', { provider: 'codex' });
      });

      expect(bridges.agentDock.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'codex' }),
      );
      expect(workspace.getSettings).not.toHaveBeenCalled();
      expect(bridges.agentDock.listProviders).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle invalidation races (issue #362)', () => {
    it('never installs a session whose creation resolves after reset() already invalidated the start, and best-effort cancels it', async () => {
      const created = deferredSession();
      const bridges = installBridges({
        agentDock: { createSession: vi.fn().mockReturnValue(created.promise) },
      });
      const { result } = renderHook(() => useAgentRun());

      let startPromise!: Promise<void>;
      act(() => {
        startPromise = result.current.start('draft a letter');
      });
      expect(result.current.status).toBe('starting');

      act(() => {
        result.current.reset();
      });
      expect(result.current.status).toBe('idle');

      await act(async () => {
        created.resolve('sess-late-1');
        await startPromise;
      });

      // The late session was never adopted: still idle, no text installed.
      expect(result.current.status).toBe('idle');
      expect(result.current.text).toBe('');
      await waitFor(() => expect(bridges.agentDock.cancelSession).toHaveBeenCalledWith('sess-late-1'));

      // Its own late events are ignored too, since it was never adopted into state.
      act(() => {
        bridges.emit('sess-late-1', { type: 'assistant.message', text: 'stale text' });
      });
      expect(result.current.text).toBe('');
    });

    it('never installs a session superseded by a second start() before the first resolves', async () => {
      const first = deferredSession();
      const bridges = installBridges({
        agentDock: { createSession: vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({
          id: 'sess-second',
          provider: 'claude',
          cwd: '/x',
          prompt: 'ignored',
          status: 'starting',
          startedAt: new Date().toISOString(),
        }) },
      });
      const { result } = renderHook(() => useAgentRun());

      let firstStartPromise!: Promise<void>;
      act(() => {
        firstStartPromise = result.current.start('first prompt');
      });

      await act(async () => {
        await result.current.start('second prompt');
      });
      expect(result.current.status).toBe('streaming');

      await act(async () => {
        first.resolve('sess-first-late');
        await firstStartPromise;
      });

      // The first (now-superseded) session must not have clobbered the second's state, and must
      // have been best-effort cancelled instead of left running unattended.
      expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(2);
      await waitFor(() =>
        expect(bridges.agentDock.cancelSession).toHaveBeenCalledWith('sess-first-late'),
      );
      expect(bridges.agentDock.cancelSession).not.toHaveBeenCalledWith('sess-second');

      act(() => {
        bridges.emit('sess-second', { type: 'assistant.message', text: 'second run text' });
      });
      expect(result.current.text).toBe('second run text');
    });

    it('a cancel clicked before the session id exists yet shows cancelled immediately and invalidates the pending start', async () => {
      const created = deferredSession();
      const bridges = installBridges({
        agentDock: { createSession: vi.fn().mockReturnValue(created.promise) },
      });
      const { result } = renderHook(() => useAgentRun());

      let startPromise!: Promise<void>;
      act(() => {
        startPromise = result.current.start('draft a letter');
      });
      expect(result.current.status).toBe('starting');

      await act(async () => {
        await result.current.cancel();
      });
      // No real session existed yet, so there is nothing to send a cancel request for -- but the
      // cancellation is still reflected immediately rather than leaving the UI on "starting".
      expect(bridges.agentDock.cancelSession).not.toHaveBeenCalled();
      expect(result.current.status).toBe('cancelled');

      await act(async () => {
        created.resolve('sess-late-2');
        await startPromise;
      });

      // The late-arriving session is best-effort cancelled and never resurrects the run.
      await waitFor(() => expect(bridges.agentDock.cancelSession).toHaveBeenCalledWith('sess-late-2'));
      expect(result.current.status).toBe('cancelled');
      expect(result.current.text).toBe('');
    });

    it('unmounting while a start() is still awaiting session creation invalidates it too', async () => {
      const created = deferredSession();
      const bridges = installBridges({
        agentDock: { createSession: vi.fn().mockReturnValue(created.promise) },
      });
      const { result, unmount } = renderHook(() => useAgentRun());

      let startPromise!: Promise<void>;
      act(() => {
        startPromise = result.current.start('draft a letter');
      });

      unmount();

      await act(async () => {
        created.resolve('sess-late-3');
        await startPromise;
      });

      await waitFor(() => expect(bridges.agentDock.cancelSession).toHaveBeenCalledWith('sess-late-3'));
    });
  });
});
