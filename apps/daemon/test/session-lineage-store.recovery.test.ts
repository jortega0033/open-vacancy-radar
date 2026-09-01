import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noopLogger, ProviderRegistry } from '@agent-dock/agent-runtime';
import { FAKE_PROVIDER_CAPABILITIES, FakeProvider } from '@agent-dock/agent-runtime';
import { ActiveSessionLimiter } from '../src/active-session-limiter.js';
import { INTERRUPTED_SESSION_V1_ERROR, toV1Session } from '../src/persisted-session-schema.js';
import { SessionLineageStore } from '../src/session-lineage-store.js';
import { SessionManager } from '../src/session-manager.js';
import { FIXTURE_SCOPE, eventLine, makeRecord, makeSession, seedManifest, seedRecord } from './support/lineage-fixtures.js';

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'agent-dock-recovery-'));
  seedManifest(stateRoot, { schemaVersion: 1 });
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

function eventLogPath(rootId: string, sessionId: string): string {
  return join(stateRoot, 'sessions-v1', 'lineages', rootId, 'events', `${sessionId}.jsonl`);
}

describe('recovering sessions left non-terminal by a restart', () => {
  it.each(['starting', 'running'] as const)('recovers a %s session as interrupted / daemon_restart', (status) => {
    const record = makeRecord({ status, eventCount: 1 });
    seedRecord(stateRoot, record, [eventLine(0)]);

    const store = new SessionLineageStore({ stateRoot });
    const recovered = store.get(record.session.id);

    expect(recovered?.session.status).toBe('interrupted');
    expect(recovered?.session.terminalReason).toBe('daemon_restart');
    expect(recovered?.session.completedAt).toBeDefined();
  });

  it('appends exactly one synthetic session.interrupted event, after the last real one', () => {
    const record = makeRecord({ status: 'running', eventCount: 2 });
    seedRecord(stateRoot, record, [eventLine(0), eventLine(1)]);

    const store = new SessionLineageStore({ stateRoot });

    const events = store.listEvents(record.session.id).events;
    expect(events.map((event) => event.type)).toEqual([
      'assistant.message',
      'assistant.message',
      'session.interrupted',
    ]);
    const last = events[2] as { reason: string; sequence: number };
    expect(last.reason).toBe('daemon_restart');
    expect(last.sequence).toBe(2);
  });

  it('is idempotent across a second restart: it does not stack interrupted events', () => {
    const record = makeRecord({ status: 'running' });
    seedRecord(stateRoot, record, [eventLine(0)]);

    new SessionLineageStore({ stateRoot });
    const second = new SessionLineageStore({ stateRoot });

    const types = second.listEvents(record.session.id).events.map((event) => event.type);
    expect(types.filter((type) => type === 'session.interrupted')).toHaveLength(1);
  });

  it('leaves an already-terminal record completely untouched', () => {
    const record = makeRecord({
      status: 'completed',
      terminalReason: 'provider_completed',
      completedAt: '2026-08-30T10:00:00.000Z',
      eventCount: 1,
    });
    seedRecord(stateRoot, record, [eventLine(0, 'session.failed')]);
    const before = readFileSync(eventLogPath(record.session.rootSessionId, record.session.id), 'utf8');

    const store = new SessionLineageStore({ stateRoot });

    const loaded = store.get(record.session.id);
    expect(loaded?.session.status).toBe('completed');
    expect(loaded?.session.terminalReason).toBe('provider_completed');
    expect(loaded?.session.completedAt).toBe('2026-08-30T10:00:00.000Z');
    expect(readFileSync(eventLogPath(record.session.rootSessionId, record.session.id), 'utf8')).toBe(before);
  });

  it('believes the log over the record when the log already ended terminally', () => {
    // The metadata record is only checkpointed, so a crash can leave `running` on disk over a log
    // whose final line is a real terminal event. Synthesizing an interruption there would invent a
    // restart that never affected this session.
    const record = makeRecord({ status: 'running' });
    seedRecord(stateRoot, record, [eventLine(0), eventLine(1, 'session.failed')]);

    const store = new SessionLineageStore({ stateRoot });

    expect(store.get(record.session.id)?.session.status).toBe('failed');
    expect(store.get(record.session.id)?.session.terminalReason).toBe('provider_error');
    expect(
      store.listEvents(record.session.id).events.filter((event) => event.type === 'session.interrupted'),
    ).toHaveLength(0);
  });
});

describe('acceptedWork survives recovery verbatim', () => {
  it.each(['unknown', 'accepted'] as const)('preserves acceptedWork=%s through an interruption', (acceptedWork) => {
    const record = makeRecord({ status: 'running', acceptedWork });
    seedRecord(stateRoot, record, [eventLine(0)]);

    const store = new SessionLineageStore({ stateRoot });

    expect(store.get(record.session.id)?.session.acceptedWork).toBe(acceptedWork);
  });

  it('never downgrades accepted to unknown, even across repeated restarts', () => {
    const record = makeRecord({ status: 'running', acceptedWork: 'accepted' });
    seedRecord(stateRoot, record, [eventLine(0)]);

    for (let restart = 0; restart < 3; restart++) {
      const store = new SessionLineageStore({ stateRoot });
      expect(store.get(record.session.id)?.session.acceptedWork).toBe('accepted');
    }
  });

  it('refuses to write not_accepted: only unknown -> accepted is expressible', () => {
    const store = new SessionLineageStore({ stateRoot });
    const created = store.create(makeSession(), { protocolVersion: 2, scope: FIXTURE_SCOPE });

    // Fail-closed at creation: a fresh record can never claim "provably nothing was delivered".
    expect(created.session.acceptedWork).toBe('unknown');

    store.markAcceptedWork(created.session.id, 'accepted');
    expect(store.get(created.session.id)?.session.acceptedWork).toBe('accepted');

    // A downgrade is not part of the signature, and is refused if forced through an untyped path.
    (store.markAcceptedWork as (id: string, state: string) => void)(created.session.id, 'not_accepted');
    expect(store.get(created.session.id)?.session.acceptedWork).toBe('accepted');
  });
});

describe('the v1 view of a recovered session', () => {
  it('reports failed with the exact restart error string', () => {
    const record = makeRecord({ status: 'running' });
    seedRecord(stateRoot, record, [eventLine(0)]);

    const store = new SessionLineageStore({ stateRoot });
    const v1 = toV1Session(store.get(record.session.id)!);

    expect(v1.status).toBe('failed');
    expect(v1.error).toBe('daemon restarted before the session completed');
    expect(v1.error).toBe(INTERRUPTED_SESSION_V1_ERROR);
  });

  it('is reachable through SessionManager.get, so a v1 client gets an answer instead of a 404', () => {
    const record = makeRecord({ status: 'running' });
    seedRecord(stateRoot, record, [eventLine(0)]);

    const store = new SessionLineageStore({ stateRoot });
    const registry = new ProviderRegistry();
    registry.register(
      new FakeProvider('claude', {
        id: 'claude',
        name: 'Claude Code',
        installed: true,
        authenticated: 'authenticated',
        capabilities: FAKE_PROVIDER_CAPABILITIES,
      }),
    );
    const manager = new SessionManager(registry, noopLogger, undefined, new ActiveSessionLimiter(), store);

    const v1 = manager.get(record.session.id);
    expect(v1?.status).toBe('failed');
    expect(v1?.error).toBe(INTERRUPTED_SESSION_V1_ERROR);
  });
});

describe('the limiter is empty after recovery', () => {
  it('holds no reservations for recovered sessions, so the full budget is immediately available', async () => {
    for (let i = 0; i < 6; i++) {
      seedRecord(stateRoot, makeRecord({ status: 'running' }), [eventLine(0)]);
    }

    const store = new SessionLineageStore({ stateRoot });
    const limiter = new ActiveSessionLimiter();
    const registry = new ProviderRegistry();
    registry.register(
      new FakeProvider('claude', {
        id: 'claude',
        name: 'Claude Code',
        installed: true,
        authenticated: 'authenticated',
        capabilities: FAKE_PROVIDER_CAPABILITIES,
      }),
    );
    registry.register(
      new FakeProvider('codex', {
        id: 'codex',
        name: 'Codex',
        installed: true,
        authenticated: 'authenticated',
        capabilities: FAKE_PROVIDER_CAPABILITIES,
      }),
    );
    const manager = new SessionManager(registry, noopLogger, undefined, limiter, store);

    expect(limiter.snapshot()).toEqual({ global: 0, byProvider: {} });

    // Four fresh sessions (the full global budget, two per provider) start with no refusal.
    expect(() => {
      manager.create('claude', '/tmp', 'a');
      manager.create('claude', '/tmp', 'b');
      manager.create('codex', '/tmp', 'c');
      manager.create('codex', '/tmp', 'd');
    }).not.toThrow();
    expect(limiter.snapshot().global).toBe(4);

    // Let the four fake sessions drain before the temp directory is torn down, so this test does
    // not leave writes racing the next one's cleanup.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(limiter.snapshot().global).toBe(0);
  });
});
