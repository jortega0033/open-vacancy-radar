import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MODEL_SELECT_CAPABILITY_ID,
  agentEventEnvelopeSchema,
  createSessionV2RequestSchema,
  type AgentEventEnvelope,
} from '@agent-dock/shared';
import { buildModelSelectConstraints } from '@agent-dock/vacancy-agent-adapter';
import {
  INTERRUPTED_SESSION_V1_ERROR,
  MAX_MODEL_ID_BYTES,
  MAX_PROVIDER_SESSION_ID_BYTES,
  MAX_TOOL_CALL_ID_BYTES,
  REDACTED_V1_EVENT_TYPES,
  persistedEventRecordV1Schema,
  persistedSessionRecordV1Schema,
  redactEnvelope,
  redactSessionForPersistence,
  toV1Session,
} from '../src/persisted-session-schema.js';
import { SessionLineageStore } from '../src/session-lineage-store.js';
import { FIXTURE_SCOPE, makeRecord, makeSession, readAllText } from './support/lineage-fixtures.js';

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'agent-dock-redaction-'));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

/**
 * Pulls the real literal `type` values out of the v1 envelope schema at runtime.
 *
 * Deliberately reads the Zod schema rather than the TypeScript union: the compile-time check inside
 * persisted-session-schema.ts already covers the union, so reading it again here would test the
 * same thing twice and still leave the schema free to drift. Between the two, a variant cannot be
 * added to either declaration without one of the checks failing.
 */
function eventTypesFromSchema(): string[] {
  const union = agentEventEnvelopeSchema as unknown as {
    options: Array<z.ZodObject<{ type: z.ZodLiteral<string> }>>;
  };
  return union.options.map((option) => option.shape.type.value).sort();
}

describe('redaction exhaustiveness', () => {
  it('covers exactly the event types the v1 envelope schema declares: no more, no fewer', () => {
    expect([...REDACTED_V1_EVENT_TYPES].sort()).toEqual(eventTypesFromSchema());
  });

  it('declares all eleven v1 event types', () => {
    expect(eventTypesFromSchema()).toHaveLength(11);
  });

  it('produces a schema-valid persisted record for every declared event type', () => {
    const samples: AgentEventEnvelope[] = [
      { type: 'session.started', sessionId: 's', provider: 'claude', providerSessionId: 'p', sequence: 0, timestamp: 't' },
      { type: 'status', status: 'thinking', detail: 'detail text', sequence: 1, timestamp: 't' },
      { type: 'assistant.message', text: 'hello', sequence: 2, timestamp: 't' },
      { type: 'thinking.delta', text: 'hmm', sequence: 3, timestamp: 't' },
      { type: 'tool.started', toolName: 'Bash', toolCallId: 'c1', input: { cmd: 'ls' }, sequence: 4, timestamp: 't' },
      { type: 'tool.completed', toolName: 'Bash', toolCallId: 'c1', result: 'output', isError: false, sequence: 5, timestamp: 't' },
      { type: 'usage', inputTokens: 1, outputTokens: 2, cachedInputTokens: 3, cost: 0.5, sequence: 6, timestamp: 't' },
      { type: 'error', code: 'E_BAD', message: 'went wrong', recoverable: true, sequence: 7, timestamp: 't' },
      { type: 'session.completed', providerSessionId: 'p', sequence: 8, timestamp: 't' },
      { type: 'session.failed', message: 'fatal', sequence: 9, timestamp: 't' },
      { type: 'session.cancelled', sequence: 10, timestamp: 't' },
    ];

    expect(samples.map((sample) => sample.type).sort()).toEqual(eventTypesFromSchema());
    for (const sample of samples) {
      const parsed = persistedEventRecordV1Schema.safeParse(redactEnvelope(sample));
      expect(parsed.success, `${sample.type} produced an invalid persisted record`).toBe(true);
    }
  });
});

describe('redactEnvelope: digests, not content', () => {
  it('replaces assistant text with a genuine sha256 and byte count', () => {
    const text = 'the quick brown fox';
    const record = redactEnvelope({ type: 'assistant.message', text, sequence: 0, timestamp: 't' });
    expect(record).toEqual({
      v: 1,
      sequence: 0,
      timestamp: 't',
      type: 'assistant.message',
      bytes: Buffer.byteLength(text, 'utf8'),
      sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    });
  });

  it('counts UTF-8 bytes, not code units', () => {
    const record = redactEnvelope({ type: 'thinking.delta', text: 'naïve 😀', sequence: 0, timestamp: 't' });
    expect((record as { bytes: number }).bytes).toBe(Buffer.byteLength('naïve 😀', 'utf8'));
  });

  it('digests a tool input by its JSON encoding rather than storing it', () => {
    const input = { command: 'rm -rf /secret', cwd: '/home/user' };
    const record = redactEnvelope({ type: 'tool.started', toolName: 'Bash', input, sequence: 0, timestamp: 't' });
    expect(record).not.toHaveProperty('input');
    expect((record as { inputSha256: string }).inputSha256).toBe(
      createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex'),
    );
  });

  it('digests an unserializable tool result to a constant sentinel rather than dropping the field', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const record = redactEnvelope({ type: 'tool.completed', result: circular, sequence: 0, timestamp: 't' });
    expect((record as { resultSha256: string }).resultSha256).toBe(
      createHash('sha256').update('<unserializable>', 'utf8').digest('hex'),
    );
  });

  it('keeps only the bounded status label and digests its free-form detail', () => {
    const record = redactEnvelope({
      type: 'status',
      status: 'x'.repeat(1_000),
      detail: 'a secret path /home/user/private',
      sequence: 0,
      timestamp: 't',
    });
    expect((record as { status: string }).status).toHaveLength(256);
    expect(record).not.toHaveProperty('detail');
    expect(record).toHaveProperty('detailSha256');
  });

  it('sanitizes an error code to an identifier charset and drops it entirely if nothing survives', () => {
    const withProse = redactEnvelope({
      type: 'error',
      code: 'E_BAD/../{injected}',
      message: 'boom',
      recoverable: false,
      sequence: 0,
      timestamp: 't',
    });
    expect((withProse as { code?: string }).code).toBe('E_BAD..injected');

    const allStripped = redactEnvelope({
      type: 'error',
      code: '///',
      message: 'boom',
      recoverable: false,
      sequence: 0,
      timestamp: 't',
    });
    expect(allStripped).not.toHaveProperty('code');
  });

  it('never carries a message field for error or session.failed', () => {
    for (const envelope of [
      { type: 'error', message: 'secret', recoverable: true, sequence: 0, timestamp: 't' },
      { type: 'session.failed', message: 'secret', sequence: 1, timestamp: 't' },
    ] as AgentEventEnvelope[]) {
      const record = redactEnvelope(envelope);
      expect(record).not.toHaveProperty('message');
      expect(JSON.stringify(record)).not.toContain('secret');
    }
  });
});

describe('persisted schemas are strict', () => {
  it('rejects a session record carrying a prompt', () => {
    const record = makeRecord();
    const withPrompt = { ...record, session: { ...record.session, prompt: 'leaked' } };
    expect(persistedSessionRecordV1Schema.safeParse(withPrompt).success).toBe(false);
  });

  it('rejects a session record carrying an error message', () => {
    const record = makeRecord();
    const withError = { ...record, session: { ...record.session, error: 'leaked' } };
    expect(persistedSessionRecordV1Schema.safeParse(withError).success).toBe(false);
  });

  it('rejects an acceptedWork of not_accepted on disk: it is a safety claim that cannot be persisted', () => {
    const record = makeRecord();
    const downgraded = { ...record, session: { ...record.session, acceptedWork: 'not_accepted' } };
    expect(persistedSessionRecordV1Schema.safeParse(downgraded).success).toBe(false);
  });

  it('rejects an event record carrying raw text alongside its digest', () => {
    expect(
      persistedEventRecordV1Schema.safeParse({
        v: 1,
        sequence: 0,
        timestamp: 't',
        type: 'assistant.message',
        bytes: 5,
        sha256: 'a'.repeat(64),
        text: 'leaked',
      }).success,
    ).toBe(false);
  });

  it('accepts a well-formed record produced by the redactor', () => {
    const session = makeSession({ prompt: 'sensitive prompt', error: 'sensitive error' });
    const record = redactSessionForPersistence(session, {
      protocolVersion: 2,
      status: 'running',
      acceptedWork: 'unknown',
      rootSessionId: session.id,
      continuationKind: 'fresh',
      earliestSequence: 0,
      eventCount: 0,
      eventsTruncated: false,
      scope: FIXTURE_SCOPE,
      unknownFrames: [],
    });

    expect(record.session).not.toHaveProperty('prompt');
    expect(record.session).not.toHaveProperty('error');
    expect(persistedSessionRecordV1Schema.safeParse(record).success).toBe(true);
  });
});

describe('v1 projection of a recovered session', () => {
  it('presents an interrupted session as failed with the exact documented message', () => {
    const record = makeRecord({ status: 'interrupted', terminalReason: 'daemon_restart' });
    const v1 = toV1Session(record);
    expect(v1.status).toBe('failed');
    expect(v1.error).toBe(INTERRUPTED_SESSION_V1_ERROR);
    expect(INTERRUPTED_SESSION_V1_ERROR).toBe('daemon restarted before the session completed');
  });

  it('returns an empty prompt rather than fabricating a placeholder that could be mistaken for one', () => {
    expect(toV1Session(makeRecord()).prompt).toBe('');
  });

  it('leaves a genuinely completed session alone', () => {
    const record = makeRecord({ status: 'completed', terminalReason: 'provider_completed' });
    const v1 = toV1Session(record);
    expect(v1.status).toBe('completed');
    expect(v1.error).toBeUndefined();
  });
});

describe('sentinel sweep: no content reaches the disk', () => {
  /**
   * Three fields are kept verbatim rather than digested (`model`, `providerSessionId`,
   * `toolCallId`), because a reader acts on them: which model ran, which thread a resume attaches
   * to, which call a result belongs to. That makes them the one place an oversized value could
   * carry content past the redactor, so each is planted here at fifteen times its cap. The
   * assertion for these is different in kind from the one below -- bounded passthrough, not
   * absence: the marker is expected to survive, and everything past the byte cap is not.
   */
  const OVERSIZED_PADDING = 'x'.repeat(4_000);
  const SENTINEL_MODEL = `SENTINEL_MODEL_0009_${OVERSIZED_PADDING}`;
  const SENTINEL_PROVIDER_SESSION = `SENTINEL_PROVIDER_SESSION_0010_${OVERSIZED_PADDING}`;
  const SENTINEL_TOOL_CALL = `SENTINEL_TOOL_CALL_0011_${OVERSIZED_PADDING}`;
  /**
   * ADI-13's `selection` is the fourth thing written verbatim rather than digested, and the only
   * one that is caller-supplied *structure* rather than a single bounded identifier: `enabled`
   * records each requested capability exactly as it arrived, constraint payload included. So it
   * gets the same treatment as the three above -- an oversized sentinel that must never reach the
   * store, and a real bounded value that must survive intact.
   */
  const SENTINEL_SELECTION = `SENTINEL_SELECTION_0012_${OVERSIZED_PADDING}`;

  it('never writes any string field of any event variant into the store tree', () => {
    const store = new SessionLineageStore({ stateRoot });
    const session = makeSession({ prompt: 'SENTINEL_PROMPT_0001', cwd: '/workspace' });
    store.create(session, { protocolVersion: 2, scope: FIXTURE_SCOPE });

    // One unique sentinel per content-bearing field of every variant. Any of them appearing
    // anywhere under the store root is a leak, regardless of which code path put it there.
    const sentinels = [
      'SENTINEL_PROMPT_0001',
      'SENTINEL_STATUS_DETAIL_0002',
      'SENTINEL_ASSISTANT_0003',
      'SENTINEL_THINKING_0004',
      'SENTINEL_TOOL_INPUT_0005',
      'SENTINEL_TOOL_RESULT_0006',
      'SENTINEL_ERROR_MESSAGE_0007',
      'SENTINEL_FAILED_MESSAGE_0008',
    ];

    const events: AgentEventEnvelope[] = [
      { type: 'session.started', sessionId: session.id, provider: 'claude', sequence: 0, timestamp: 't0' },
      { type: 'status', status: 'thinking', detail: 'SENTINEL_STATUS_DETAIL_0002', sequence: 1, timestamp: 't1' },
      { type: 'assistant.message', text: 'SENTINEL_ASSISTANT_0003', sequence: 2, timestamp: 't2' },
      { type: 'thinking.delta', text: 'SENTINEL_THINKING_0004', sequence: 3, timestamp: 't3' },
      { type: 'tool.started', toolName: 'Bash', input: { cmd: 'SENTINEL_TOOL_INPUT_0005' }, sequence: 4, timestamp: 't4' },
      { type: 'tool.completed', toolName: 'Bash', result: 'SENTINEL_TOOL_RESULT_0006', sequence: 5, timestamp: 't5' },
      { type: 'usage', inputTokens: 10, outputTokens: 20, sequence: 6, timestamp: 't6' },
      { type: 'error', code: 'E_X', message: 'SENTINEL_ERROR_MESSAGE_0007', recoverable: true, sequence: 7, timestamp: 't7' },
      { type: 'session.failed', message: 'SENTINEL_FAILED_MESSAGE_0008', sequence: 8, timestamp: 't8' },
    ];
    for (const event of events) store.appendEvent(session.id, event);
    store.finalize(session.id, 'failed', 'provider_error');

    const everything = readAllText(stateRoot);
    for (const sentinel of sentinels) {
      expect(everything, `${sentinel} leaked to disk`).not.toContain(sentinel);
    }
  });

  it('bounds the three identifier fields it keeps verbatim, in both the record and the event log', () => {
    const store = new SessionLineageStore({ stateRoot });
    const session = makeSession({ model: SENTINEL_MODEL });
    store.create(session, { protocolVersion: 2, scope: FIXTURE_SCOPE });

    store.appendEvent(session.id, {
      type: 'session.started',
      sessionId: session.id,
      provider: 'claude',
      providerSessionId: SENTINEL_PROVIDER_SESSION,
      sequence: 0,
      timestamp: 't0',
    });
    // The store's own copy, which does not go through `redactEnvelope` at all and therefore needs
    // its own bound: this is the value a later resume matches a lineage on.
    store.setProviderSessionId(session.id, SENTINEL_PROVIDER_SESSION);
    store.appendEvent(session.id, {
      type: 'tool.started',
      toolName: 'Bash',
      toolCallId: SENTINEL_TOOL_CALL,
      sequence: 1,
      timestamp: 't1',
    });
    store.appendEvent(session.id, {
      type: 'tool.completed',
      toolName: 'Bash',
      toolCallId: SENTINEL_TOOL_CALL,
      sequence: 2,
      timestamp: 't2',
    });
    store.appendEvent(session.id, {
      type: 'session.completed',
      providerSessionId: SENTINEL_PROVIDER_SESSION,
      sequence: 3,
      timestamp: 't3',
    });
    store.finalize(session.id, 'completed', 'provider_completed');

    const persisted = store.get(session.id)?.session;
    const events = store.listEvents(session.id).events;
    const started = events[0] as { providerSessionId: string };
    const toolStarted = events[1] as { toolCallId: string };
    const toolCompleted = events[2] as { toolCallId: string };
    const completed = events[3] as { providerSessionId: string };

    const bounded: Array<[string, string | undefined, number]> = [
      ['record.model', persisted?.model, MAX_MODEL_ID_BYTES],
      ['record.providerSessionId', persisted?.providerSessionId, MAX_PROVIDER_SESSION_ID_BYTES],
      ['session.started.providerSessionId', started.providerSessionId, MAX_PROVIDER_SESSION_ID_BYTES],
      ['tool.started.toolCallId', toolStarted.toolCallId, MAX_TOOL_CALL_ID_BYTES],
      ['tool.completed.toolCallId', toolCompleted.toolCallId, MAX_TOOL_CALL_ID_BYTES],
      ['session.completed.providerSessionId', completed.providerSessionId, MAX_PROVIDER_SESSION_ID_BYTES],
    ];

    for (const [where, value, cap] of bounded) {
      expect(value, `${where} is missing`).toBeDefined();
      expect(Buffer.byteLength(value as string, 'utf8'), `${where} exceeds its cap`).toBe(cap);
      // Truncated, not hashed away: the leading marker is still there, which is what makes these
      // fields worth keeping in the first place.
      expect(value as string).toContain('SENTINEL_');
    }

    // And nothing anywhere under the store carries the value at its original, unbounded length.
    const everything = readAllText(stateRoot);
    for (const sentinel of [SENTINEL_MODEL, SENTINEL_PROVIDER_SESSION, SENTINEL_TOOL_CALL]) {
      expect(everything, 'an unbounded identifier reached the disk').not.toContain(sentinel);
    }
    expect(everything).not.toContain('x'.repeat(MAX_MODEL_ID_BYTES + 1));
  });

  it('refuses an unbounded selection at every gate that guards the store, and never writes one', () => {
    // The oversized ask, well-formed in shape and hostile only in size: a model-select constraint
    // whose payload string is fifteen times the wire cap.
    const oversized = {
      id: MODEL_SELECT_CAPABILITY_ID,
      constraints: { kind: 'opaque' as const, value: { model: SENTINEL_SELECTION } },
    };

    // Gate one, the request boundary: `POST /v2/sessions` is the store's only caller that can put a
    // `selection` on a record at all, and its body schema reuses `opaqueExtensionListSchema`. The
    // sentinel never becomes a `create()` argument, because the request carrying it is a 400.
    expect(
      createSessionV2RequestSchema.safeParse({
        provider: 'claude',
        cwd: '/workspace',
        workspaceId: 'a'.repeat(64),
        incarnation: 'b'.repeat(64),
        prompt: 'do the thing',
        capabilities: [oversized],
      }).success,
    ).toBe(false);

    // Gate two, the store's own schema, which is checked here rather than trusted to gate one:
    // `persistedSessionRecordV1Schema` is what every record is parsed against on load, so a record
    // that somehow acquired an unbounded selection would be quarantined rather than served.
    expect(
      persistedSessionRecordV1Schema.safeParse(
        makeRecord({ selection: { enabled: [oversized], unavailableOptional: [] } }),
      ).success,
    ).toBe(false);

    // And a bounded selection of exactly the same shape is accepted, so the refusals above are
    // about the size and not about the field existing.
    expect(
      persistedSessionRecordV1Schema.safeParse(
        makeRecord({
          selection: {
            enabled: [{ id: MODEL_SELECT_CAPABILITY_ID, constraints: buildModelSelectConstraints('x') }],
            unavailableOptional: [],
          },
        }),
      ).success,
    ).toBe(true);

    // Finally the sweep itself: a real, properly bounded selection goes through `create()` and is
    // persisted verbatim, and nothing anywhere under the store root carries the sentinel or its
    // padding.
    const store = new SessionLineageStore({ stateRoot });
    const session = makeSession();
    const selection = {
      enabled: [{ id: MODEL_SELECT_CAPABILITY_ID, constraints: buildModelSelectConstraints('x') }],
      unavailableOptional: [{ id: 'ext.acme.turbo', reason: 'unsupported_capability' as const }],
    };
    store.create(session, { protocolVersion: 2, scope: FIXTURE_SCOPE, selection });

    // Verbatim, because a selection is what a later resume inherits: a digested one would be
    // useless to compare a subsequent request against.
    expect(store.get(session.id)?.session.selection).toEqual(selection);

    const everything = readAllText(stateRoot);
    expect(everything).toContain('"model":"x"');
    expect(everything, 'an unbounded selection reached the disk').not.toContain(SENTINEL_SELECTION);
    expect(everything).not.toContain(OVERSIZED_PADDING);
  });

  it('writes the genuine digest of the redacted content, not an opaque placeholder', () => {
    const store = new SessionLineageStore({ stateRoot });
    const session = makeSession();
    store.create(session, { protocolVersion: 2, scope: FIXTURE_SCOPE });
    store.appendEvent(session.id, {
      type: 'assistant.message',
      text: 'SENTINEL_ASSISTANT_0003',
      sequence: 0,
      timestamp: 't',
    });

    const page = store.listEvents(session.id);
    expect(page.events).toHaveLength(1);
    const entry = page.events[0] as { sha256: string; bytes: number };
    expect(entry.sha256).toBe(
      createHash('sha256').update('SENTINEL_ASSISTANT_0003', 'utf8').digest('hex'),
    );
    expect(entry.bytes).toBe(Buffer.byteLength('SENTINEL_ASSISTANT_0003', 'utf8'));
    // A hash is only useful for correlation if two different payloads never collide into the same
    // stored value, so confirm a different payload really does produce a different digest.
    expect(entry.sha256).not.toBe(createHash('sha256').update('something else', 'utf8').digest('hex'));
  });

  it('keeps the prompt out of the record even though AgentSession carries it', () => {
    const store = new SessionLineageStore({ stateRoot });
    const session = makeSession({ prompt: 'SENTINEL_PROMPT_0001' });
    const record = store.create(session, { protocolVersion: 1, scope: FIXTURE_SCOPE });
    expect(JSON.stringify(record)).not.toContain('SENTINEL_PROMPT_0001');
    expect(readAllText(stateRoot)).not.toContain('SENTINEL_PROMPT_0001');
  });
});
