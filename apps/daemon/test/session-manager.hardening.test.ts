import { describe, expect, it } from 'vitest';
import type { AgentEvent, ProviderId, ProviderStatus } from '@agent-dock/shared';
import { ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import type { AgentProvider, ProviderSessionHandle, StartSessionOptions } from '@agent-dock/agent-runtime';
import { SessionManager } from '../src/session-manager.js';

/**
 * ADI-08b (issue #126): the daemon-side half of Claude CLI hardening.
 *
 * `SessionManager.create()` is the single junction where a session's protocol version turns into
 * provider start options, so it is the only place the v1/v2 split can be asserted without standing
 * up a route. What the flag *does* once it reaches the adapter is `packages/agent-runtime`'s
 * business and is pinned in `claude-build-args.test.ts`; what matters here is strictly which
 * sessions get it.
 *
 * The load-bearing claim is the negative one: a v1 session's options object must not merely carry a
 * falsy `hardened`, it must not carry the key at all -- so the object a v1 caller produces is
 * deep-equal to the one it produced before this ticket existed.
 */

function makeIdleHandle(): ProviderSessionHandle {
  // Never yields and never ends on its own. These tests assert on what `create()` passed to the
  // provider, not on any event, so the session is simply left running and torn down with the
  // manager -- no timing, no flushing, nothing to race.
  async function* events(): AsyncGenerator<AgentEvent, void, void> {
    // The promise never settles, so the `yield` is unreachable. It is written anyway because a
    // generator with no yield is not a generator as far as lint is concerned.
    yield await new Promise<AgentEvent>(() => {});
  }
  return { events: events(), cancel: async () => {} };
}

class RecordingProvider implements AgentProvider {
  readonly id: ProviderId = 'claude';
  readonly name = 'Recording Provider';
  readonly started: StartSessionOptions[] = [];

  async detect(): Promise<ProviderStatus> {
    return {
      id: this.id,
      name: this.name,
      installed: true,
      authenticated: 'authenticated',
      capabilities: { resume: true, cancellation: true, tools: true, usage: true, thinking: true },
    };
  }

  startSession(options: StartSessionOptions): ProviderSessionHandle {
    this.started.push(options);
    return makeIdleHandle();
  }
}

function setup() {
  const provider = new RecordingProvider();
  const registry = new ProviderRegistry();
  registry.register(provider);
  // No durable store on purpose: with one, `create()` also attaches a `launchProbe`, which is
  // ADI-04's seam and would obscure the exact key set this file is here to pin.
  return { provider, sessionManager: new SessionManager(registry, noopLogger) };
}

describe('SessionManager.create: v1 start options are unchanged by ADI-08b', () => {
  it('passes no `hardened` key at all for a default (v1) create', () => {
    const { provider, sessionManager } = setup();
    // Exactly the five arguments `routes/sessions.ts` passes -- that call site is untouched by this
    // ticket, and this test fails if it ever stops being reachable with the v1 result.
    const session = sessionManager.create('claude', '/tmp/work', 'find me some roles');

    expect(provider.started).toHaveLength(1);
    const options = provider.started[0]!;
    expect('hardened' in options).toBe(false);
    expect(options).toEqual({
      sessionId: session.id,
      cwd: '/tmp/work',
      prompt: 'find me some roles',
      resumeProviderSessionId: undefined,
      model: undefined,
    });
  });

  it('passes no `hardened` key for an explicit protocolVersion of 1, with a model and a resume', () => {
    const { provider, sessionManager } = setup();
    sessionManager.create('claude', '/tmp/work', 'continue', 'thread-1', 'fable', 1);

    const options = provider.started[0]!;
    expect('hardened' in options).toBe(false);
    expect(Object.keys(options).sort()).toEqual(
      ['cwd', 'model', 'prompt', 'resumeProviderSessionId', 'sessionId'].sort(),
    );
  });
});

describe('SessionManager.create: v2 sessions are hardened (ADI-08b)', () => {
  it('sets `hardened: true` for a protocolVersion of 2', () => {
    const { provider, sessionManager } = setup();
    sessionManager.create('claude', '/tmp/work', 'find me some roles', undefined, undefined, 2);

    expect(provider.started[0]!.hardened).toBe(true);
  });

  it('sets `hardened: true` for a resumed v2 session too', () => {
    const { provider, sessionManager } = setup();
    // A resume is still a fresh CLI invocation, so it gets the same restrictions. Pinned explicitly
    // because "the thread was already started under some other configuration" is a plausible-
    // sounding reason to skip them, and it would be wrong.
    sessionManager.create('claude', '/tmp/work', 'continue', 'thread-1', 'fable', 2);

    expect(provider.started[0]!.hardened).toBe(true);
  });

  it('hardens a v2 session created the way `routes/v2-sessions-create.ts` creates one', () => {
    const { provider, sessionManager } = setup();
    // Mirrors the real v2 route's argument list, including the trailing options bag, so the two
    // cannot drift into disagreement about which positional slot the protocol version occupies.
    sessionManager.create('claude', '/tmp/work', 'find me some roles', undefined, 'fable', 2, 'ws-1', {
      sessionId: '11111111-1111-4111-8111-111111111111',
    });

    const options = provider.started[0]!;
    expect(options.hardened).toBe(true);
    expect(options.sessionId).toBe('11111111-1111-4111-8111-111111111111');
  });
});
