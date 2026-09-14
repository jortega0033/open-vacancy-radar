import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidCursorError, SessionLineageStore } from '../src/session-lineage-store.js';
import { FIXTURE_SCOPE, makeSession } from './support/lineage-fixtures.js';

/**
 * `searchEvents` (ADI-28): bounded, case-insensitive literal search over the small set of
 * already-plaintext fields the durable store persists unredacted. See `searchableFields`'s own doc
 * comment in session-lineage-store.ts for why this can never search conversation content -- ADI-05's
 * store keeps assistant/thinking text and tool input/result as SHA-256 digests only.
 */

let stateRoot: string;
let store: SessionLineageStore;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'agent-dock-search-'));
  store = new SessionLineageStore({ stateRoot });
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

function createSession(overrides: Parameters<typeof makeSession>[0] = {}) {
  const session = makeSession(overrides);
  store.create(session, { protocolVersion: 2, scope: FIXTURE_SCOPE });
  return session;
}

describe('searchEvents: matches only allowlisted plaintext fields', () => {
  it('matches a tool.completed toolName', () => {
    const session = createSession();
    store.appendEvent(session.id, { type: 'tool.completed', toolName: 'Bash', sequence: 0, timestamp: 't' });

    const page = store.searchEvents('bash');
    expect(page.matches).toEqual([
      { sessionId: session.id, sequence: 0, eventType: 'tool.completed', field: 'toolName', excerpt: 'Bash' },
    ]);
  });

  it('matches a status word, case-insensitively', () => {
    const session = createSession();
    store.appendEvent(session.id, { type: 'status', status: 'Thinking', sequence: 0, timestamp: 't' });

    const page = store.searchEvents('THINK');
    expect(page.matches).toEqual([
      { sessionId: session.id, sequence: 0, eventType: 'status', field: 'status', excerpt: 'Thinking' },
    ]);
  });

  it('matches an error code', () => {
    const session = createSession();
    store.appendEvent(session.id, { type: 'error', code: 'E_TIMEOUT', message: 'timed out', recoverable: true, sequence: 0, timestamp: 't' });

    expect(store.searchEvents('timeout').matches).toHaveLength(1);
  });

  it('matches usage.rate_limits limitName', () => {
    const session = createSession();
    store.appendEvent(session.id, {
      type: 'usage.rate_limits',
      limitName: 'Weekly Limit',
      primary: { usedPercent: 50 },
      sequence: 0,
      timestamp: 't',
    });

    expect(store.searchEvents('weekly').matches).toHaveLength(1);
  });

  it('never matches assistant.message or thinking.delta text -- there is none to match', () => {
    const session = createSession();
    store.appendEvent(session.id, { type: 'assistant.message', text: 'the secret password is hunter2', sequence: 0, timestamp: 't' });
    store.appendEvent(session.id, { type: 'thinking.delta', text: 'hunter2 again', sequence: 1, timestamp: 't' });

    expect(store.searchEvents('hunter2').matches).toEqual([]);
    expect(store.searchEvents('secret').matches).toEqual([]);
  });

  it('never matches tool.started/tool.completed input or result content', () => {
    const session = createSession();
    store.appendEvent(session.id, { type: 'tool.started', toolName: 'Bash', input: { cmd: 'cat secrets.env' }, sequence: 0, timestamp: 't' });
    store.appendEvent(session.id, { type: 'tool.completed', toolName: 'Bash', result: 'API_KEY=super-secret', sequence: 1, timestamp: 't' });

    expect(store.searchEvents('secrets').matches).toEqual([]);
    expect(store.searchEvents('super-secret').matches).toEqual([]);
    // The tool name itself is still searchable -- it's an allowlisted field, not content.
    expect(store.searchEvents('bash').matches).toHaveLength(2);
  });

  it('never matches status.detail or error.message -- both digest-only', () => {
    const session = createSession();
    store.appendEvent(session.id, { type: 'status', status: 'thinking', detail: 'reading /etc/shadow', sequence: 0, timestamp: 't' });
    store.appendEvent(session.id, { type: 'error', message: 'failed reading /etc/shadow', recoverable: true, sequence: 1, timestamp: 't' });

    expect(store.searchEvents('shadow').matches).toEqual([]);
  });
});

describe('searchEvents: bounds', () => {
  it('rejects a cursor pointing at a session that no longer exists', () => {
    createSession();
    expect(() => store.searchEvents('x', { cursor: Buffer.from('not-a-real-id', 'utf8').toString('base64url') })).toThrow(
      InvalidCursorError,
    );
  });

  it('finishes scanning the session in progress before honoring the match limit, never cutting one off mid-file', () => {
    const session = createSession();
    for (let i = 0; i < 5; i++) {
      store.appendEvent(session.id, { type: 'tool.completed', toolName: 'Bash', sequence: i, timestamp: 't' });
    }

    const page = store.searchEvents('bash', { limit: 2 });
    // All 5 matches from this one session are returned, not cut off at the limit=2 boundary --
    // the bound only decides when to STOP scanning further sessions, never mid-session.
    expect(page.matches).toHaveLength(5);
    expect(page.nextCursor).toBeUndefined();
  });

  it('returns a nextCursor when more sessions remain unscanned, and resumes correctly from it', () => {
    const first = createSession();
    store.appendEvent(first.id, { type: 'tool.completed', toolName: 'Bash', sequence: 0, timestamp: 't' });
    const second = createSession();
    store.appendEvent(second.id, { type: 'tool.completed', toolName: 'Bash', sequence: 0, timestamp: 't' });

    const page1 = store.searchEvents('bash', { limit: 1 });
    expect(page1.matches).toHaveLength(1);
    expect(page1.nextCursor).toBeDefined();

    const page2 = store.searchEvents('bash', { limit: 1, cursor: page1.nextCursor });
    expect(page2.matches).toHaveLength(1);
    expect(page2.matches[0]?.sessionId).not.toBe(page1.matches[0]?.sessionId);
    expect(page2.nextCursor).toBeUndefined();
  });

  it('clamps an oversized limit to MAX_SEARCH_MATCHES rather than returning everything', () => {
    const session = createSession();
    for (let i = 0; i < 10; i++) {
      store.appendEvent(session.id, { type: 'tool.completed', toolName: 'Bash', sequence: i, timestamp: 't' });
    }
    const page = store.searchEvents('bash', { limit: 100_000 });
    expect(page.matches).toHaveLength(10);
  });

  it('a query matching nothing across many sessions still returns cleanly with no matches', () => {
    for (let i = 0; i < 3; i++) {
      const session = createSession();
      store.appendEvent(session.id, { type: 'status', status: 'thinking', sequence: 0, timestamp: 't' });
    }
    expect(store.searchEvents('nonexistent-term').matches).toEqual([]);
  });

  it('an excerpt is bounded, and still actually contains the match, for a field longer than the excerpt window', () => {
    const session = createSession();
    // `redactEnvelope` bounds limitName to 256 bytes at write time (persisted-session-schema.ts), so
    // "needle" is placed well inside that cap (~byte 220) but past the 200-byte excerpt window: a
    // naive "keep the first 200 bytes" truncation would cut the excerpt before the match ever
    // appears in it, which is exactly the bug this test guards against.
    const longName = `${'x'.repeat(220)}needle${'y'.repeat(220)}`;
    store.appendEvent(session.id, { type: 'usage.rate_limits', limitName: longName, sequence: 0, timestamp: 't' });

    const page = store.searchEvents('needle');
    expect(page.matches).toHaveLength(1);
    const excerpt = page.matches[0]!.excerpt;
    expect(Buffer.byteLength(excerpt, 'utf8')).toBeLessThanOrEqual(200);
    expect(excerpt.toLowerCase()).toContain('needle');
  });

  it('centers the excerpt on the match rather than always keeping the field prefix', () => {
    const session = createSession();
    const longName = `${'a'.repeat(150)}needle${'b'.repeat(150)}`;
    store.appendEvent(session.id, { type: 'usage.rate_limits', limitName: longName, sequence: 0, timestamp: 't' });

    const excerpt = store.searchEvents('needle').matches[0]!.excerpt;
    expect(excerpt).toContain('needle');
    // Context from both sides of the match survives, not just a prefix run of "a"s.
    expect(excerpt).toContain('a');
    expect(excerpt).toContain('b');
  });
});
