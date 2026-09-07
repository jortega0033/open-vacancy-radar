import { describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@agent-dock/shared';
import { runCancellationCase, runFreshRunCase, type LiveSmokeClient } from '../../src/live-smoke/run-case.js';

function fakeSession(id: string, overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
    provider: 'claude',
    cwd: '/tmp/fixture',
    prompt: 'hello',
    status: 'completed',
    startedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function* iterableFrom(items: unknown[]): AsyncGenerator<unknown> {
  for (const item of items) yield item;
}

// eslint-disable-next-line require-yield -- deliberately never yields, to simulate a real hang
async function* neverYields(): AsyncGenerator<unknown> {
  await new Promise(() => {});
}

describe('runFreshRunCase', () => {
  it('creates a session with no resumeProviderSessionId, then reports success', async () => {
    const create = vi.fn().mockResolvedValue(fakeSession('s1'));
    const client: LiveSmokeClient = {
      create,
      get: vi.fn().mockResolvedValue(fakeSession('s1')),
      events: () => iterableFrom([{ type: 'assistant.message', text: 'hi' }, { type: 'session.completed' }]),
      cancel: vi.fn(),
    };
    const outcome = await runFreshRunCase(client, { provider: 'claude', cwd: '/tmp/fixture', prompt: 'hello', timeoutMs: 5_000 });
    expect(create).toHaveBeenCalledWith({ provider: 'claude', cwd: '/tmp/fixture', prompt: 'hello' });
    expect(outcome.resultCode).toBe('success');
  });

  it('passes resumeProviderSessionId through to create() only when supplied', async () => {
    const create = vi.fn().mockResolvedValue(fakeSession('s2'));
    const client: LiveSmokeClient = {
      create,
      get: vi.fn().mockResolvedValue(fakeSession('s2')),
      events: () => iterableFrom([{ type: 'assistant.message', text: 'ok' }, { type: 'session.completed' }]),
      cancel: vi.fn(),
    };
    await runFreshRunCase(client, { provider: 'claude', cwd: '/tmp/fixture', prompt: 'continue', timeoutMs: 5_000, resumeProviderSessionId: 'thread-1' });
    expect(create).toHaveBeenCalledWith({ provider: 'claude', cwd: '/tmp/fixture', prompt: 'continue', resumeProviderSessionId: 'thread-1' });
  });

  it('reports failure when the terminal event carries no normalized content', async () => {
    const client: LiveSmokeClient = {
      create: vi.fn().mockResolvedValue(fakeSession('s3')),
      get: vi.fn().mockResolvedValue(fakeSession('s3')),
      events: () => iterableFrom([{ type: 'session.completed' }]),
      cancel: vi.fn(),
    };
    const outcome = await runFreshRunCase(client, { provider: 'claude', cwd: '/tmp/fixture', prompt: 'hello', timeoutMs: 5_000 });
    expect(outcome.resultCode).toBe('failed_protocol_violation');
  });

  it('reports a timeout distinctly from a protocol violation', async () => {
    const client: LiveSmokeClient = {
      create: vi.fn().mockResolvedValue(fakeSession('s4')),
      get: vi.fn(),
      events: () => neverYields(),
      cancel: vi.fn(),
    };
    const outcome = await runFreshRunCase(client, { provider: 'claude', cwd: '/tmp/fixture', prompt: 'hello', timeoutMs: 25 });
    expect(outcome.resultCode).toBe('failed_timeout');
  });

  it('re-fetches the session after a successful terminal outcome, so a providerSessionId populated only asynchronously by the daemon is actually returned', async () => {
    const create = vi.fn().mockResolvedValue(fakeSession('s5'));
    const get = vi.fn().mockResolvedValue(fakeSession('s5', { providerSessionId: 'thread-populated-after-completion' }));
    const client: LiveSmokeClient = {
      create,
      get,
      events: () => iterableFrom([{ type: 'assistant.message', text: 'hi' }, { type: 'session.completed' }]),
      cancel: vi.fn(),
    };
    const outcome = await runFreshRunCase(client, { provider: 'claude', cwd: '/tmp/fixture', prompt: 'hello', timeoutMs: 5_000 });
    expect(get).toHaveBeenCalledWith('s5');
    expect(outcome.resultCode).toBe('success');
    expect(outcome.session?.providerSessionId).toBe('thread-populated-after-completion');
  });

  it('does not re-fetch the session on a failed or timed-out outcome', async () => {
    const get = vi.fn();
    const failedClient: LiveSmokeClient = {
      create: vi.fn().mockResolvedValue(fakeSession('s6')),
      get,
      events: () => iterableFrom([{ type: 'session.completed' }]),
      cancel: vi.fn(),
    };
    await runFreshRunCase(failedClient, { provider: 'claude', cwd: '/tmp/fixture', prompt: 'hello', timeoutMs: 5_000 });
    expect(get).not.toHaveBeenCalled();
  });
});

describe('runCancellationCase', () => {
  it('reports success only when the terminal type is session.cancelled', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const client: LiveSmokeClient = {
      create: vi.fn(),
      get: vi.fn(),
      events: () => iterableFrom([{ type: 'session.cancelled' }]),
      cancel,
    };
    const outcome = await runCancellationCase(client, fakeSession('s1'), 5_000);
    expect(cancel).toHaveBeenCalledWith('s1');
    expect(outcome.resultCode).toBe('success');
  });

  it('treats completing normally instead of cancelling as a protocol violation for this case', async () => {
    const client: LiveSmokeClient = {
      create: vi.fn(),
      get: vi.fn(),
      events: () => iterableFrom([{ type: 'session.completed' }]),
      cancel: vi.fn().mockResolvedValue(undefined),
    };
    const outcome = await runCancellationCase(client, fakeSession('s1'), 5_000);
    expect(outcome.resultCode).toBe('failed_protocol_violation');
  });

  it('never lets a rejecting cancel() call escape (best-effort, matching the real client contract)', async () => {
    const client: LiveSmokeClient = {
      create: vi.fn(),
      get: vi.fn(),
      events: () => iterableFrom([{ type: 'session.cancelled' }]),
      cancel: vi.fn().mockRejectedValue(new Error('already terminal')),
    };
    await expect(runCancellationCase(client, fakeSession('s1'), 5_000)).resolves.toMatchObject({ resultCode: 'success' });
  });
});
