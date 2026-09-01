import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionLineageStore, StorageFullError } from '../src/session-lineage-store.js';
import { FIXTURE_SCOPE, eventLine, listFiles, makeRecord, makeSession, seedManifest, seedRecord } from './support/lineage-fixtures.js';

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'agent-dock-retention-'));
  seedManifest(stateRoot, { schemaVersion: 1 });
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

function storeDir(): string {
  return join(stateRoot, 'sessions-v1');
}

const NOW = new Date('2026-09-01T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

function tombstoneIds(): string[] {
  return readdirSync(join(storeDir(), 'tombstones')).sort();
}

describe('age-based eviction', () => {
  it('evicts a lineage older than maxAge and keeps one inside the window', () => {
    const old = makeRecord({ startedAt: daysAgo(45), completedAt: daysAgo(45) });
    const recent = makeRecord({ startedAt: daysAgo(2), completedAt: daysAgo(2) });
    seedRecord(stateRoot, old, [eventLine(0)]);
    seedRecord(stateRoot, recent, [eventLine(0)]);

    const store = new SessionLineageStore({ stateRoot, now: () => NOW });

    expect(store.get(old.session.id)).toBeUndefined();
    expect(store.get(recent.session.id)).toBeDefined();
    expect(tombstoneIds()).toEqual([`${old.session.rootSessionId}.json`]);
  });

  it('writes a tombstone naming every session the evicted lineage held', () => {
    const root = makeRecord({ startedAt: daysAgo(60), completedAt: daysAgo(60) });
    const child = makeRecord({
      rootId: root.session.rootSessionId,
      parentSessionId: root.session.id,
      continuationKind: 'resume',
      startedAt: daysAgo(59),
      completedAt: daysAgo(59),
    });
    seedRecord(stateRoot, root);
    seedRecord(stateRoot, child);

    new SessionLineageStore({ stateRoot, now: () => NOW });

    const tombstone = JSON.parse(
      readFileSync(join(storeDir(), 'tombstones', `${root.session.rootSessionId}.json`), 'utf8'),
    );
    expect(tombstone.schemaVersion).toBe(1);
    expect(tombstone.reason).toBe('retention_age');
    expect([...tombstone.sessionIds].sort()).toEqual([root.session.id, child.session.id].sort());
    expect(tombstone.records).toBe(2);
  });

  it('evicts a lineage as one unit: a resumed child never survives its evicted root', () => {
    const root = makeRecord({ startedAt: daysAgo(60), completedAt: daysAgo(60) });
    const child = makeRecord({
      rootId: root.session.rootSessionId,
      parentSessionId: root.session.id,
      continuationKind: 'resume',
      // Deliberately recent: only the *lineage's* newest activity decides, so a fresh child keeps
      // its ancient root alive rather than the root dragging the child down separately.
      startedAt: daysAgo(1),
      completedAt: daysAgo(1),
    });
    seedRecord(stateRoot, root);
    seedRecord(stateRoot, child);

    const store = new SessionLineageStore({ stateRoot, now: () => NOW });

    expect(store.get(root.session.id)).toBeDefined();
    expect(store.get(child.session.id)).toBeDefined();
    expect(tombstoneIds()).toEqual([]);
  });

  it('respects a custom maxAgeMs', () => {
    const record = makeRecord({ startedAt: daysAgo(2), completedAt: daysAgo(2) });
    seedRecord(stateRoot, record);

    const store = new SessionLineageStore({ stateRoot, now: () => NOW, retention: { maxAgeMs: DAY_MS } });
    expect(store.get(record.session.id)).toBeUndefined();
  });
});

describe('record-count quota', () => {
  it('evicts oldest-first until the record count is within budget', () => {
    const records = [3, 2, 1].map((days) =>
      makeRecord({ startedAt: daysAgo(days), completedAt: daysAgo(days) }),
    );
    for (const record of records) seedRecord(stateRoot, record);

    const store = new SessionLineageStore({ stateRoot, now: () => NOW, retention: { maxRecords: 2 } });

    expect(store.stats().records).toBe(2);
    expect(store.get((records[0] as (typeof records)[number]).session.id)).toBeUndefined();
    expect(store.get((records[1] as (typeof records)[number]).session.id)).toBeDefined();
    expect(store.get((records[2] as (typeof records)[number]).session.id)).toBeDefined();
  });

  it('makes room for a new session by evicting, then admits it', () => {
    const old = makeRecord({ startedAt: daysAgo(5), completedAt: daysAgo(5) });
    seedRecord(stateRoot, old);
    const store = new SessionLineageStore({ stateRoot, now: () => NOW, retention: { maxRecords: 1 } });

    const created = store.create(makeSession(), { protocolVersion: 2, scope: FIXTURE_SCOPE });

    expect(store.get(old.session.id)).toBeUndefined();
    expect(store.get(created.session.id)).toBeDefined();
    expect(store.stats().records).toBe(1);
  });
});

describe('byte quota', () => {
  it('evicts oldest-first until the byte total is within budget', () => {
    const big = 'x'.repeat(2_000);
    const older = makeRecord({ startedAt: daysAgo(3), completedAt: daysAgo(3) });
    const newer = makeRecord({ startedAt: daysAgo(1), completedAt: daysAgo(1) });
    // Pad both logs so each lineage is comfortably over the tiny budget below on its own.
    seedRecord(stateRoot, older, [JSON.stringify({ v: 1, sequence: 0, timestamp: big, type: 'session.cancelled' })]);
    seedRecord(stateRoot, newer, [JSON.stringify({ v: 1, sequence: 0, timestamp: big, type: 'session.cancelled' })]);

    const store = new SessionLineageStore({ stateRoot, now: () => NOW, retention: { maxBytes: 3_000 } });

    expect(store.stats().lineages).toBe(1);
    expect(store.get(older.session.id)).toBeUndefined();
    expect(store.get(newer.session.id)).toBeDefined();
  });
});

describe('active lineages are never evicted', () => {
  it('skips a lineage holding a live session even when it is the oldest', () => {
    // A record only stays `running` in-memory for a live session; seeding one and then creating a
    // fresh session models "the daemon is mid-session and retention runs".
    const store = new SessionLineageStore({ stateRoot, now: () => NOW, retention: { maxRecords: 2 } });
    const live = store.create(makeSession({ startedAt: daysAgo(90) }), {
      protocolVersion: 2,
      scope: FIXTURE_SCOPE,
    });
    const second = store.create(makeSession(), { protocolVersion: 2, scope: FIXTURE_SCOPE });
    store.finalize(second.session.id, 'completed', 'provider_completed');

    const third = store.create(makeSession(), { protocolVersion: 2, scope: FIXTURE_SCOPE });

    // The 90-day-old lineage is by far the oldest, but it is still `starting`, so the merely
    // completed one is evicted instead.
    expect(store.get(live.session.id)).toBeDefined();
    expect(store.get(second.session.id)).toBeUndefined();
    expect(store.get(third.session.id)).toBeDefined();
  });

  it('throws StorageFullError when every remaining lineage is active', () => {
    const store = new SessionLineageStore({ stateRoot, now: () => NOW, retention: { maxRecords: 2 } });
    store.create(makeSession(), { protocolVersion: 2, scope: FIXTURE_SCOPE });
    store.create(makeSession(), { protocolVersion: 2, scope: FIXTURE_SCOPE });

    let thrown: unknown;
    try {
      store.create(makeSession(), { protocolVersion: 2, scope: FIXTURE_SCOPE });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(StorageFullError);
    expect((thrown as StorageFullError).code).toBe('storage_full');
    expect((thrown as StorageFullError).statusCode).toBe(507);
    // The refused session left nothing behind, which is what makes it safe for the caller to have
    // not yet spawned a provider process.
    expect(store.stats().records).toBe(2);
  });

  it('never evicts the lineage the new session is joining', () => {
    const store = new SessionLineageStore({ stateRoot, now: () => NOW, retention: { maxRecords: 2 } });
    const root = store.create(makeSession({ startedAt: daysAgo(80) }), {
      protocolVersion: 2,
      scope: FIXTURE_SCOPE,
    });
    store.setProviderSessionId(root.session.id, 'thread-1');
    store.finalize(root.session.id, 'completed', 'provider_completed');

    const other = store.create(makeSession(), { protocolVersion: 2, scope: FIXTURE_SCOPE });
    store.finalize(other.session.id, 'completed', 'provider_completed');

    const resumed = store.create(makeSession(), {
      protocolVersion: 2,
      scope: FIXTURE_SCOPE,
      resumeProviderSessionId: 'thread-1',
    });

    // The resumed session joins the 80-day-old lineage, which is the oldest and would otherwise be
    // the first eviction candidate. Evicting it here would delete the parent of the record being
    // written in the same call.
    expect(resumed.session.rootSessionId).toBe(root.session.rootSessionId);
    expect(resumed.session.continuationKind).toBe('resume');
    expect(resumed.session.parentSessionId).toBe(root.session.id);
    expect(store.get(root.session.id)).toBeDefined();
    expect(store.get(other.session.id)).toBeUndefined();
  });
});

describe('interrupted eviction transactions', () => {
  function stageTrash(rootId: string, sessionId: string): string {
    const lineageDir = join(storeDir(), 'lineages', rootId);
    const trashDir = join(storeDir(), '.trash');
    mkdirSync(trashDir, { recursive: true });
    const trashPath = join(trashDir, `evict--${rootId}--${randomUUID()}`);
    renameSync(lineageDir, trashPath);
    void sessionId;
    return trashPath;
  }

  it('rolls an uncommitted eviction back into lineages/ when no tombstone exists', () => {
    const record = makeRecord({ acceptedWork: 'accepted' });
    seedRecord(stateRoot, record, [eventLine(0)]);
    // Bootstrap the skeleton so .trash exists, then simulate a crash between the rename and the
    // tombstone write.
    new SessionLineageStore({ stateRoot, now: () => NOW });
    const trashPath = stageTrash(record.session.rootSessionId, record.session.id);

    const store = new SessionLineageStore({ stateRoot, now: () => NOW });

    expect(existsSync(trashPath)).toBe(false);
    const restored = store.get(record.session.id);
    expect(restored).toBeDefined();
    // The accepted-work claim survives the rollback: losing it is the outcome the two-phase
    // protocol exists to prevent.
    expect(restored?.session.acceptedWork).toBe('accepted');
    expect(store.listEvents(record.session.id).events).toHaveLength(1);
  });

  it('completes a committed eviction by removing the trashed copy when a valid tombstone exists', () => {
    const record = makeRecord();
    seedRecord(stateRoot, record);
    new SessionLineageStore({ stateRoot, now: () => NOW });
    const trashPath = stageTrash(record.session.rootSessionId, record.session.id);
    writeFileSync(
      join(storeDir(), 'tombstones', `${record.session.rootSessionId}.json`),
      JSON.stringify({
        schemaVersion: 1,
        rootSessionId: record.session.rootSessionId,
        evictedAt: NOW.toISOString(),
        reason: 'quota_records',
        sessionIds: [record.session.id],
        records: 1,
        bytes: 0,
      }),
    );

    const store = new SessionLineageStore({ stateRoot, now: () => NOW });

    expect(existsSync(trashPath)).toBe(false);
    expect(store.get(record.session.id)).toBeUndefined();
    expect(store.stats().records).toBe(0);
  });

  it('quarantines rather than merging when the restore target already exists', () => {
    const record = makeRecord();
    seedRecord(stateRoot, record);
    new SessionLineageStore({ stateRoot, now: () => NOW });

    const trashDir = join(storeDir(), '.trash');
    mkdirSync(join(trashDir, `evict--${record.session.rootSessionId}--${randomUUID()}`), { recursive: true });

    new SessionLineageStore({ stateRoot, now: () => NOW });

    expect(readdirSync(trashDir)).toEqual([]);
    expect(listFiles(storeDir()).some((path) => path.includes('quarantine'))).toBe(false);
    // An empty directory has no files, so assert on the directory listing instead.
    expect(readdirSync(join(storeDir(), 'quarantine')).length).toBeGreaterThan(0);
  });

  it('leaves a real eviction with no trace in .trash once it commits', () => {
    const old = makeRecord({ startedAt: daysAgo(90), completedAt: daysAgo(90) });
    seedRecord(stateRoot, old, [eventLine(0)]);

    new SessionLineageStore({ stateRoot, now: () => NOW });

    expect(readdirSync(join(storeDir(), '.trash'))).toEqual([]);
    expect(existsSync(join(storeDir(), 'lineages', old.session.rootSessionId))).toBe(false);
    expect(tombstoneIds()).toEqual([`${old.session.rootSessionId}.json`]);
  });
});
