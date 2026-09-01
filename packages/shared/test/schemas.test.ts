import { describe, expect, it } from 'vitest';
import {
  agentEventEnvelopeSchema,
  createSessionRequestSchema,
  healthResponseSchema,
  providerCapabilitiesSchema,
  providerIdSchema,
  providerStatusSchema,
  sessionIdParamSchema,
} from '../src/schemas.js';

describe('providerIdSchema', () => {
  it('accepts known provider ids', () => {
    expect(providerIdSchema.parse('claude')).toBe('claude');
    expect(providerIdSchema.parse('codex')).toBe('codex');
  });

  it('rejects unknown provider ids', () => {
    expect(providerIdSchema.safeParse('gemini').success).toBe(false);
  });
});

describe('createSessionRequestSchema', () => {
  it('accepts a valid request', () => {
    const result = createSessionRequestSchema.safeParse({ provider: 'claude', cwd: '/tmp', prompt: 'hi' });
    expect(result.success).toBe(true);
  });

  it('rejects a missing prompt', () => {
    const result = createSessionRequestSchema.safeParse({ provider: 'claude', cwd: '/tmp', prompt: '' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing cwd', () => {
    const result = createSessionRequestSchema.safeParse({ provider: 'claude', prompt: 'hi' });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown provider', () => {
    const result = createSessionRequestSchema.safeParse({ provider: 'gpt', cwd: '/tmp', prompt: 'hi' });
    expect(result.success).toBe(false);
  });

  it('accepts an optional resumeProviderSessionId', () => {
    const result = createSessionRequestSchema.safeParse({
      provider: 'claude',
      cwd: '/tmp',
      prompt: 'hi',
      resumeProviderSessionId: 'thread-123',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty resumeProviderSessionId', () => {
    const result = createSessionRequestSchema.safeParse({
      provider: 'claude',
      cwd: '/tmp',
      prompt: 'hi',
      resumeProviderSessionId: '',
    });
    expect(result.success).toBe(false);
  });

  it('accepts an optional model, e.g. one of a provider\'s availableModels', () => {
    const result = createSessionRequestSchema.safeParse({ provider: 'claude', cwd: '/tmp', prompt: 'hi', model: 'fable' });
    expect(result.success).toBe(true);
  });

  it('rejects an empty model rather than silently ignoring it', () => {
    const result = createSessionRequestSchema.safeParse({ provider: 'claude', cwd: '/tmp', prompt: 'hi', model: '' });
    expect(result.success).toBe(false);
  });
});

describe('providerCapabilitiesSchema', () => {
  it('accepts every known capability explicitly set to a boolean', () => {
    const valid = { resume: true, cancellation: true, tools: false, usage: true, thinking: false };
    expect(providerCapabilitiesSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a non-boolean value for a known capability', () => {
    const invalid = { resume: 'yes', cancellation: true, tools: false, usage: true, thinking: false };
    expect(providerCapabilitiesSchema.safeParse(invalid).success).toBe(false);
  });

  // AD-15: every known key is optional (absent means unsupported, the same as `false`), so a
  // client built against a newer @agent-dock/shared can still validate an older daemon's
  // response that predates a since-added capability, without that capability being present.
  it('accepts a status with a capability key omitted entirely', () => {
    const incomplete = { resume: true, cancellation: true, tools: false, usage: true };
    const result = providerCapabilitiesSchema.safeParse(incomplete);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.thinking).toBeUndefined();
  });

  it('accepts an entirely empty capabilities object', () => {
    expect(providerCapabilitiesSchema.safeParse({}).success).toBe(true);
  });

  // AD-15: unknown keys survive validation (via `.catchall`) rather than being silently stripped
  // or rejected, so a client one version behind a daemon that's grown a 6th capability still gets
  // to see it, instead of losing the information.
  it('preserves an unknown future capability key rather than stripping or rejecting it', () => {
    const withFutureCapability = { resume: true, modelSelection: true };
    const result = providerCapabilitiesSchema.safeParse(withFutureCapability);
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as Record<string, unknown>).modelSelection).toBe(true);
  });

  it('still rejects a non-boolean value for an unknown future capability key', () => {
    const invalid = { modelSelection: 'sonnet' };
    expect(providerCapabilitiesSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('providerStatusSchema', () => {
  it('accepts a full provider status with capabilities', () => {
    const status = {
      id: 'claude',
      name: 'Claude Code',
      installed: true,
      authenticated: 'authenticated',
      capabilities: { resume: true, cancellation: true, tools: true, usage: true, thinking: true },
      version: '1.0.0',
    };
    expect(providerStatusSchema.safeParse(status).success).toBe(true);
  });

  it('accepts authenticated: "unknown"', () => {
    const status = {
      id: 'codex',
      name: 'Codex',
      installed: false,
      authenticated: 'unknown',
      capabilities: { resume: true, cancellation: true, tools: true, usage: true, thinking: true },
    };
    expect(providerStatusSchema.safeParse(status).success).toBe(true);
  });

  it('rejects authenticated: "yes" (not a valid tri-state value)', () => {
    const status = {
      id: 'codex',
      name: 'Codex',
      installed: true,
      authenticated: 'yes',
      capabilities: { resume: true, cancellation: true, tools: true, usage: true, thinking: true },
    };
    expect(providerStatusSchema.safeParse(status).success).toBe(false);
  });

  it('rejects a status missing capabilities', () => {
    const status = { id: 'claude', name: 'Claude Code', installed: true, authenticated: 'authenticated' };
    expect(providerStatusSchema.safeParse(status).success).toBe(false);
  });
});

describe('agentEventEnvelopeSchema', () => {
  it('accepts a valid session.started envelope', () => {
    const event = { type: 'session.started', sessionId: 's1', provider: 'claude', sequence: 0, timestamp: '2026-01-01T00:00:00.000Z' };
    expect(agentEventEnvelopeSchema.safeParse(event).success).toBe(true);
  });

  it('accepts every documented event type', () => {
    const base = { sequence: 0, timestamp: '2026-01-01T00:00:00.000Z' };
    const events = [
      { ...base, type: 'session.started', sessionId: 's1', provider: 'claude' },
      { ...base, type: 'status', status: 'running' },
      { ...base, type: 'assistant.message', text: 'hi' },
      { ...base, type: 'thinking.delta', text: 'pondering' },
      { ...base, type: 'tool.started', toolName: 'Bash' },
      { ...base, type: 'tool.completed', toolName: 'Bash', isError: false },
      { ...base, type: 'usage', inputTokens: 1, outputTokens: 2 },
      { ...base, type: 'error', message: 'boom', recoverable: true },
      { ...base, type: 'session.completed' },
      { ...base, type: 'session.failed', message: 'nope' },
      { ...base, type: 'session.cancelled' },
    ];
    for (const event of events) {
      const result = agentEventEnvelopeSchema.safeParse(event);
      expect(result.success, `expected ${event.type} to validate`).toBe(true);
    }
  });

  it('rejects an unrecognized event type', () => {
    const event = { type: 'provider.raw_jsonl', sequence: 0, timestamp: '2026-01-01T00:00:00.000Z' };
    expect(agentEventEnvelopeSchema.safeParse(event).success).toBe(false);
  });

  // AD-14: assistant.delta was removed from protocol v1 before any adapter ever emitted it: see
  // packages/shared/src/events.ts. This pins the removal so it can't silently come back.
  it('rejects assistant.delta (removed from protocol v1, AD-14), never re-add without deliberately updating this test', () => {
    const event = { type: 'assistant.delta', text: 'hi', sequence: 0, timestamp: '2026-01-01T00:00:00.000Z' };
    expect(agentEventEnvelopeSchema.safeParse(event).success).toBe(false);
  });

  it('rejects an event missing sequence/timestamp', () => {
    const event = { type: 'session.cancelled' };
    expect(agentEventEnvelopeSchema.safeParse(event).success).toBe(false);
  });

  it('rejects a required field with the wrong type (message as a number)', () => {
    const event = { type: 'error', message: 42, recoverable: true, sequence: 0, timestamp: '2026-01-01T00:00:00.000Z' };
    expect(agentEventEnvelopeSchema.safeParse(event).success).toBe(false);
  });
});

describe('healthResponseSchema', () => {
  it('accepts a well-formed health response', () => {
    expect(healthResponseSchema.safeParse({ status: 'ok', uptimeSeconds: 5, protocolVersion: 1 }).success).toBe(true);
  });

  it('rejects a response without protocolVersion', () => {
    expect(healthResponseSchema.safeParse({ status: 'ok', uptimeSeconds: 5 }).success).toBe(false);
  });

  it('accepts a pre-v2 response with no supportedProtocolVersions field at all, and does not add one', () => {
    const result = healthResponseSchema.safeParse({ status: 'ok', uptimeSeconds: 5, protocolVersion: 1 });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).not.toHaveProperty('supportedProtocolVersions');
  });

  it('accepts a v1/v2 daemon response, keeping the legacy protocolVersion at 1', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      uptimeSeconds: 5,
      protocolVersion: 1,
      supportedProtocolVersions: [1, 2],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.protocolVersion).toBe(1);
      expect(result.data.supportedProtocolVersions).toEqual([1, 2]);
    }
  });

  it('rejects a self-contradictory response where supportedProtocolVersions omits protocolVersion', () => {
    // A daemon claiming protocolVersion: 1 but listing only [2] as supported is internally
    // inconsistent -- this must be a clean ValidationError at the boundary, not a response that
    // parses successfully and then confusingly fails every v1 request downstream.
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      uptimeSeconds: 5,
      protocolVersion: 1,
      supportedProtocolVersions: [2],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a self-consistent v2-only response, where both fields agree v1 is gone', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      uptimeSeconds: 5,
      protocolVersion: 2,
      supportedProtocolVersions: [2],
    });
    expect(result.success).toBe(true);
  });
});

describe('supportedProtocolVersionsSchema (via healthResponseSchema)', () => {
  function parse(supportedProtocolVersions: unknown) {
    return healthResponseSchema.safeParse({ status: 'ok', uptimeSeconds: 5, protocolVersion: 1, supportedProtocolVersions });
  }

  it('rejects an empty array', () => {
    expect(parse([]).success).toBe(false);
  });

  it('rejects duplicate versions', () => {
    expect(parse([1, 1]).success).toBe(false);
  });

  it('rejects a non-integer version', () => {
    expect(parse([1.5]).success).toBe(false);
  });

  it('rejects a non-positive version', () => {
    expect(parse([0]).success).toBe(false);
    expect(parse([-1]).success).toBe(false);
  });

  it('rejects a non-number entry', () => {
    expect(parse([1, '2']).success).toBe(false);
  });

  it('accepts up to 16 unique versions and rejects a 17th, so an unbounded array cannot pass', () => {
    const sixteen = Array.from({ length: 16 }, (_, index) => index + 1);
    expect(parse(sixteen).success).toBe(true);
    expect(parse([...sixteen, 17]).success).toBe(false);
  });
});

describe('sessionIdParamSchema', () => {
  it('accepts a valid uuid', () => {
    expect(sessionIdParamSchema.safeParse({ sessionId: '123e4567-e89b-12d3-a456-426614174000' }).success).toBe(true);
  });

  it('rejects a non-uuid string', () => {
    expect(sessionIdParamSchema.safeParse({ sessionId: 'not-a-uuid' }).success).toBe(false);
  });
});
