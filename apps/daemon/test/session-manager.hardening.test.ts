import { describe, expect, it } from 'vitest';
import type { AgentEvent, ProviderId, ProviderStatus } from '@agent-dock/shared';
import { ProviderRegistry, noopLogger } from '@agent-dock/agent-runtime';
import type { AgentProvider, ProviderSessionHandle, StartSessionOptions } from '@agent-dock/agent-runtime';
import { SessionManager } from '../src/session-manager.js';

/**
 * ADI-08b (issue #126) hardened only v2 sessions. Issue #173 found that left every v1 caller
 * (GapAnalysis/CoverLetter/CvAssistant/TailorCv, via `routes/sessions.ts`) unhardened in
 * production, with untrusted scraped vacancy text in the prompt and Bash/PowerShell/MCP/hooks/
 * slash-commands all live. The v1/v2 split was incidental plumbing, not a security boundary, so
 * `SessionManager.create()` now hardens every session regardless of protocol version.
 *
 * `SessionManager.create()` is the single junction where start options are built, so it is the
 * only place "every session gets `hardened: true`" can be asserted without standing up a route.
 * What the flag *does* once it reaches the adapter is `packages/agent-runtime`'s business and is
 * pinned in `claude-build-args.test.ts`; what matters here is strictly that no call shape --
 * default v1, explicit v1, resumed, v2, v2 with a workspace lease -- produces a session without it.
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

describe('SessionManager.create: v1 sessions are hardened too (issue #173)', () => {
  it('sets `hardened: true` for a default (v1) create, the exact shape `routes/sessions.ts` uses', () => {
    const { provider, sessionManager } = setup();
    // Exactly the five arguments `routes/sessions.ts` passes -- the real call site every shipped
    // CV feature (GapAnalysis/CoverLetter/CvAssistant/TailorCv) reaches today.
    const session = sessionManager.create('claude', '/tmp/work', 'find me some roles');

    expect(provider.started).toHaveLength(1);
    const options = provider.started[0]!;
    expect(options).toEqual({
      sessionId: session.id,
      cwd: '/tmp/work',
      prompt: 'find me some roles',
      resumeProviderSessionId: undefined,
      model: undefined,
      hardened: true,
    });
  });

  it('sets `hardened: true` for an explicit protocolVersion of 1, with a model and a resume', () => {
    const { provider, sessionManager } = setup();
    sessionManager.create('claude', '/tmp/work', 'continue', 'thread-1', 'fable', 1);

    const options = provider.started[0]!;
    expect(options.hardened).toBe(true);
    expect(Object.keys(options).sort()).toEqual(
      ['cwd', 'hardened', 'model', 'prompt', 'resumeProviderSessionId', 'sessionId'].sort(),
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
