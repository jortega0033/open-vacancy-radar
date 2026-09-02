import { describe, expect, it } from 'vitest';
import { agentEventEnvelopeSchema, type AgentEventEnvelope } from '@agent-dock/shared';
import { createHash } from 'node:crypto';
import {
  MAX_TEXT_BYTES_PER_ENTRY,
  SANITIZED_EVENT_TYPES,
  aliasForToolCall,
  toActivityEntry,
  toHistoryEntry,
} from '../electron/agent-activity-sanitize.js';

/**
 * The single most important correctness test in ADI-07, and a direct copy of ADI-05's discipline
 * for `redactEnvelope` (apps/daemon/test/persisted-session-schema.test.ts).
 *
 * `toActivityEntry` is the only code path in this app that sees a raw `AgentEventEnvelope` and
 * decides what of it may reach the renderer. Its `default` branch is a `never` assertion, so a
 * variant added to the TypeScript union without a branch here is already a compile error. That
 * still leaves one gap: the *Zod schema* in packages/shared can gain a variant independently of the
 * union, and a build that never re-derives the union would not notice. So this reads the literal
 * `type` values out of `agentEventEnvelopeSchema` at runtime and requires the switch's own declared
 * inventory to match exactly, in both directions.
 *
 * Between the compile-time `never` and this, a variant cannot be added to either declaration
 * without something failing.
 */
/**
 * Reaches into the discriminated union structurally rather than through Zod's own types: `zod` is a
 * dependency of `@agent-dock/shared`, not of the desktop app, and adding one here so a test can
 * name `z.ZodLiteral` would be a production dependency bought for a type annotation. The shape
 * being read is a documented part of Zod's discriminated-union API, and the assertions below fail
 * loudly (an empty list) if it ever stops being.
 */
interface LiteralTypedOption {
  shape: { type: { value: string } };
}

function eventTypesFromSchema(): string[] {
  const union = agentEventEnvelopeSchema as unknown as { options: LiteralTypedOption[] };
  return union.options.map((option) => option.shape.type.value).sort();
}

const ALL_SAMPLES: AgentEventEnvelope[] = [
  {
    type: 'session.started',
    sessionId: 'ses-1',
    provider: 'claude',
    providerSessionId: 'native-thread-abc',
    sequence: 0,
    timestamp: '2026-09-02T10:00:00.000Z',
  },
  { type: 'status', status: 'thinking', detail: 'reading C:/Users/someone/.ssh/id_rsa', sequence: 1, timestamp: 't' },
  { type: 'assistant.message', text: 'hello there', sequence: 2, timestamp: 't' },
  { type: 'thinking.delta', text: 'hmm', sequence: 3, timestamp: 't' },
  { type: 'tool.started', toolName: 'Bash', toolCallId: 'native-call-1', input: { cmd: 'ls' }, sequence: 4, timestamp: 't' },
  {
    type: 'tool.completed',
    toolName: 'Bash',
    toolCallId: 'native-call-1',
    result: 'output',
    isError: false,
    sequence: 5,
    timestamp: 't',
  },
  { type: 'usage', inputTokens: 1, outputTokens: 2, cachedInputTokens: 3, cost: 0.5, sequence: 6, timestamp: 't' },
  { type: 'error', code: 'E_BAD', message: 'failed reading C:/Users/someone/secrets', recoverable: true, sequence: 7, timestamp: 't' },
  { type: 'session.completed', providerSessionId: 'native-thread-abc', sequence: 8, timestamp: 't' },
  { type: 'session.failed', message: 'fatal: /var/run/agent.sock', sequence: 9, timestamp: 't' },
  { type: 'session.cancelled', sequence: 10, timestamp: 't' },
];

describe('sanitizer exhaustiveness (ADI-07)', () => {
  it('covers exactly the event types the v1 envelope schema declares: no more, no fewer', () => {
    expect([...SANITIZED_EVENT_TYPES].sort()).toEqual(eventTypesFromSchema());
  });

  it('declares all eleven v1 event types', () => {
    expect(eventTypesFromSchema()).toHaveLength(11);
    expect(SANITIZED_EVENT_TYPES).toHaveLength(11);
  });

  it('the sample set below exercises every declared type, so the behavioral tests are exhaustive too', () => {
    expect(ALL_SAMPLES.map((sample) => sample.type).sort()).toEqual(eventTypesFromSchema());
  });

  it('produces an entry for every declared type, and never throws its unhandled-variant error', () => {
    for (const sample of ALL_SAMPLES) {
      const entry = toActivityEntry(sample, new Map());
      expect(entry, `${sample.type} produced no entry`).not.toBeNull();
      expect(entry?.kind).toBe(sample.type);
      expect(entry?.origin).toBe('live');
    }
  });
});

describe('toActivityEntry: what never crosses', () => {
  it('drops providerSessionId from every variant that carries one', () => {
    for (const sample of ALL_SAMPLES) {
      const entry = toActivityEntry(sample, new Map());
      expect(entry).not.toHaveProperty('providerSessionId');
      expect(JSON.stringify(entry)).not.toContain('native-thread-abc');
    }
  });

  it('drops the native toolCallId and replaces it with a stable local alias', () => {
    const aliases = new Map<string, string>();
    const started = toActivityEntry(ALL_SAMPLES[4] as AgentEventEnvelope, aliases);
    const completed = toActivityEntry(ALL_SAMPLES[5] as AgentEventEnvelope, aliases);

    expect(started).not.toHaveProperty('toolCallId');
    expect(completed).not.toHaveProperty('toolCallId');
    expect(JSON.stringify([started, completed])).not.toContain('native-call-1');
    // The pair is still pairable, which is the whole reason an alias exists at all.
    expect((started as { toolAlias?: string }).toolAlias).toBe('t1');
    expect((completed as { toolAlias?: string }).toolAlias).toBe('t1');
  });

  it('never collides two different native ids onto one alias', () => {
    const aliases = new Map<string, string>();
    expect(aliasForToolCall(aliases, 'a')).toBe('t1');
    expect(aliasForToolCall(aliases, 'b')).toBe('t2');
    expect(aliasForToolCall(aliases, 'a')).toBe('t1');
    expect(new Set(aliases.values()).size).toBe(2);
  });

  it("drops a status event's free-form detail, keeping only the bounded label", () => {
    const entry = toActivityEntry(ALL_SAMPLES[1] as AgentEventEnvelope, new Map());
    expect(entry).toEqual({ seq: 1, at: 't', origin: 'live', kind: 'status', status: 'thinking' });
    expect(JSON.stringify(entry)).not.toContain('.ssh');
  });

  it("never passes an error or session.failed message through, only a bounded identifier code", () => {
    const error = toActivityEntry(ALL_SAMPLES[7] as AgentEventEnvelope, new Map());
    expect(error).toEqual({ seq: 7, at: 't', origin: 'live', kind: 'error', code: 'E_BAD', recoverable: true });
    expect(JSON.stringify(error)).not.toContain('Users');

    const failed = toActivityEntry(ALL_SAMPLES[9] as AgentEventEnvelope, new Map());
    expect(failed).toEqual({ seq: 9, at: 't', origin: 'live', kind: 'session.failed' });
    expect(JSON.stringify(failed)).not.toContain('agent.sock');
  });

  it('drops an error code that is not already a clean identifier rather than laundering it', () => {
    const entry = toActivityEntry(
      { type: 'error', code: 'read C:/Users/someone failed', message: 'x', recoverable: false, sequence: 0, timestamp: 't' },
      new Map(),
    );
    expect(entry).not.toHaveProperty('code');
    expect(JSON.stringify(entry)).not.toContain('Users');
  });

  it('digests tool input and result instead of forwarding them', () => {
    const input = { command: 'cat C:/Users/someone/.ssh/id_rsa' };
    const entry = toActivityEntry(
      { type: 'tool.started', toolName: 'Bash', input, sequence: 0, timestamp: 't' },
      new Map(),
    );
    expect(entry).not.toHaveProperty('input.command');
    expect((entry as { input?: { sha256: string } }).input?.sha256).toBe(
      createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex'),
    );
    expect(JSON.stringify(entry)).not.toContain('id_rsa');
  });
});

describe('toActivityEntry: what deliberately does cross', () => {
  it('keeps assistant prose verbatim, because the renderer is what it is for', () => {
    const entry = toActivityEntry(ALL_SAMPLES[2] as AgentEventEnvelope, new Map());
    expect(entry).toEqual({ seq: 2, at: 't', origin: 'live', kind: 'assistant.message', text: 'hello there' });
  });

  it('caps oversized prose and flags the cut rather than showing a partial answer as whole', () => {
    const text = 'x'.repeat(MAX_TEXT_BYTES_PER_ENTRY + 500);
    const entry = toActivityEntry(
      { type: 'assistant.message', text, sequence: 0, timestamp: 't' },
      new Map(),
    ) as { text: string; textTruncated?: boolean };
    expect(Buffer.byteLength(entry.text, 'utf8')).toBeLessThanOrEqual(MAX_TEXT_BYTES_PER_ENTRY);
    expect(entry.textTruncated).toBe(true);
  });

  it('never splits a multi-byte character when capping', () => {
    const entry = toActivityEntry(
      { type: 'assistant.message', text: '😀'.repeat(MAX_TEXT_BYTES_PER_ENTRY), sequence: 0, timestamp: 't' },
      new Map(),
    ) as { text: string };
    expect(entry.text).not.toContain('\uFFFD');
    expect(Buffer.byteLength(entry.text, 'utf8')).toBeLessThanOrEqual(MAX_TEXT_BYTES_PER_ENTRY);
  });

  it('drops NaN and Infinity from usage rather than rendering them', () => {
    const entry = toActivityEntry(
      { type: 'usage', inputTokens: Number.NaN, outputTokens: Number.POSITIVE_INFINITY, cost: 1, sequence: 0, timestamp: 't' },
      new Map(),
    );
    expect(entry).toEqual({ seq: 0, at: 't', origin: 'live', kind: 'usage', cost: 1 });
  });
});

describe('toActivityEntry: fail-closed inputs', () => {
  it('returns null for an envelope whose sequence cannot order a timeline', () => {
    for (const sequence of [-1, 1.5, Number.NaN, 'x' as unknown as number, undefined as unknown as number]) {
      const entry = toActivityEntry(
        { type: 'session.cancelled', sequence, timestamp: 't' } as AgentEventEnvelope,
        new Map(),
      );
      expect(entry, `sequence ${String(sequence)} should be rejected`).toBeNull();
    }
  });

  it('tolerates a missing timestamp rather than throwing', () => {
    const entry = toActivityEntry(
      { type: 'session.cancelled', sequence: 0 } as unknown as AgentEventEnvelope,
      new Map(),
    );
    expect(entry?.at).toBe('');
  });
});

describe('toHistoryEntry: the durable half', () => {
  it('maps a persisted record onto the same shape the live path produces', () => {
    const entry = toHistoryEntry(
      { v: 1, type: 'assistant.message', sequence: 3, timestamp: 't', bytes: 11, sha256: 'a'.repeat(64) },
      new Map(),
    );
    expect(entry).toEqual({
      seq: 3,
      at: 't',
      origin: 'history',
      kind: 'assistant.message',
      digest: { bytes: 11, sha256: 'a'.repeat(64) },
    });
  });

  it('shares the caller alias map with the live path, so both agree on t1', () => {
    const aliases = new Map<string, string>();
    toActivityEntry(ALL_SAMPLES[4] as AgentEventEnvelope, aliases);
    const history = toHistoryEntry(
      { type: 'tool.completed', sequence: 5, timestamp: 't', toolCallId: 'native-call-1' },
      aliases,
    );
    expect((history as { toolAlias?: string }).toolAlias).toBe('t1');
    expect(JSON.stringify(history)).not.toContain('native-call-1');
  });

  it('drops the persisted status detail digest so a history row matches its live twin exactly', () => {
    const entry = toHistoryEntry(
      { type: 'status', sequence: 1, timestamp: 't', status: 'thinking', detailBytes: 40, detailSha256: 'b'.repeat(64) },
      new Map(),
    );
    expect(entry).toEqual({ seq: 1, at: 't', origin: 'history', kind: 'status', status: 'thinking' });
  });

  it('reads session.interrupted, which has no live counterpart at all', () => {
    const entry = toHistoryEntry({ type: 'session.interrupted', sequence: 2, timestamp: 't' }, new Map());
    expect(entry?.kind).toBe('session.interrupted');
  });

  it('skips a record from a newer daemon build instead of crashing the timeline', () => {
    // Deliberately NOT a compile error, unlike the live switch: the durable log may be written by a
    // different build, and an unreadable row is a thing to skip.
    expect(toHistoryEntry({ type: 'something.new', sequence: 0, timestamp: 't' }, new Map())).toBeNull();
    expect(toHistoryEntry(null, new Map())).toBeNull();
    expect(toHistoryEntry([], new Map())).toBeNull();
    expect(toHistoryEntry({ type: 'status', sequence: -1 }, new Map())).toBeNull();
  });
});
