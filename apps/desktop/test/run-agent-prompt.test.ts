import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@agent-dock/shared';
import { runAgentPrompt } from '../src/components/cv/run-agent-prompt.js';

/** The batch assessment's one model call. Driven through a scripted `window.agentDock`. */

let listeners: ((sessionId: string, event: AgentEvent) => void)[];
let cancelSession: ReturnType<typeof vi.fn>;
let createSession: ReturnType<typeof vi.fn>;

const emit = (id: string, event: Partial<AgentEvent> & { type: string }) => listeners.forEach((listener) => listener(id, event as AgentEvent));
const session = (id: string) => ({ id, provider: 'claude' as const, cwd: '/x', prompt: 'p', status: 'starting' as const, startedAt: '2026-10-20T00:00:00.000Z' });

beforeEach(() => {
  vi.useFakeTimers();
  listeners = [];
  cancelSession = vi.fn().mockResolvedValue(undefined);
  createSession = vi.fn(async () => session('s1'));
  (window as unknown as { agentDock: unknown }).agentDock = {
    createSession,
    cancelSession,
    onSessionEvent: (cb: (sessionId: string, event: AgentEvent) => void) => {
      listeners.push(cb);
      return () => {
        listeners = listeners.filter((listener) => listener !== cb);
      };
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
});

const options = (signal = new AbortController().signal) => ({ signal, timeoutMs: 10_000 });

describe('runAgentPrompt', () => {
  it('joins message chunks exactly and resolves on completion', async () => {
    const run = runAgentPrompt('prompt', options());
    await vi.advanceTimersByTimeAsync(0);
    emit('s1', { type: 'assistant.message', text: '{"requirements": ' } as never);
    emit('s1', { type: 'assistant.message', text: '[]}' } as never);
    emit('s1', { type: 'session.completed' });
    await expect(run).resolves.toEqual({ ok: true, text: '{"requirements": []}' });
    expect(listeners).toHaveLength(0); // unsubscribed
  });

  it('keeps events that arrive before the session id is known, and ignores another session’s events', async () => {
    let release: (value: ReturnType<typeof session>) => void = () => undefined;
    createSession.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const run = runAgentPrompt('prompt', options());
    emit('s1', { type: 'assistant.message', text: 'early' } as never);
    emit('other', { type: 'assistant.message', text: 'NOT MINE' } as never);
    emit('s1', { type: 'session.completed' });
    release(session('s1'));
    await expect(run).resolves.toEqual({ ok: true, text: 'early' });
  });

  it('an empty "success" is a failure, never an empty answer', async () => {
    const run = runAgentPrompt('prompt', options());
    await vi.advanceTimersByTimeAsync(0);
    emit('s1', { type: 'session.completed' });
    await expect(run).resolves.toMatchObject({ ok: false, reason: 'failed' });
  });

  it('a provider failure resolves with its message', async () => {
    const run = runAgentPrompt('prompt', options());
    await vi.advanceTimersByTimeAsync(0);
    emit('s1', { type: 'session.failed', message: 'provider unavailable' } as never);
    await expect(run).resolves.toEqual({ ok: false, reason: 'failed', error: 'provider unavailable' });
  });

  it('times out, cancels the live session and says so', async () => {
    const run = runAgentPrompt('prompt', options());
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(run).resolves.toMatchObject({ ok: false, reason: 'timeout' });
    expect(cancelSession).toHaveBeenCalledWith('s1');
  });

  it('abort cancels the live session; an abort before the session exists never lets it run', async () => {
    const controller = new AbortController();
    const run = runAgentPrompt('prompt', options(controller.signal));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await expect(run).resolves.toEqual({ ok: false, reason: 'cancelled', error: 'cancelled' });
    expect(cancelSession).toHaveBeenCalledWith('s1');

    cancelSession.mockClear();
    let release: (value: ReturnType<typeof session>) => void = () => undefined;
    createSession.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const early = new AbortController();
    const second = runAgentPrompt('prompt', options(early.signal));
    early.abort();
    await expect(second).resolves.toMatchObject({ ok: false, reason: 'cancelled' });
    release(session('s2'));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelSession).toHaveBeenCalledWith('s2');

    const already = new AbortController();
    already.abort();
    createSession.mockClear();
    await expect(runAgentPrompt('prompt', options(already.signal))).resolves.toMatchObject({ reason: 'cancelled' });
    expect(createSession).not.toHaveBeenCalled();
  });
});
