import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The zero-mutation guarantee is asserted two independent ways, because either one alone could be
 * satisfied by a bug the other would catch:
 *
 * 1. a recursive content + mtime snapshot before and after, which catches a write that happens to
 *    reproduce identical bytes as well as any create/delete/rename; and
 * 2. spies on the mutating `node:fs` primitives, which catch a write to a path outside the snapshot
 *    root, or one that is undone before the snapshot is taken.
 *
 * The spies need the same `vi.mock` treatment `atomic-fs.test.ts` uses: `node:fs`'s ESM namespace
 * is not configurable, so `vi.spyOn` cannot be used on it.
 */
const { calls, MUTATORS } = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; args: unknown[] }>,
  MUTATORS: [
    'writeFileSync',
    'writeSync',
    'renameSync',
    'unlinkSync',
    'rmSync',
    'rmdirSync',
    'truncateSync',
    'ftruncateSync',
    'appendFileSync',
    'copyFileSync',
  ] as const,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const wrapper: Record<string, unknown> = { ...actual };
  for (const name of MUTATORS) {
    const original = actual[name] as unknown as (...args: unknown[]) => unknown;
    wrapper[name] = (...args: unknown[]) => {
      calls.push({ fn: name, args });
      return original(...args);
    };
  }
  return { ...wrapper, default: wrapper };
});

const { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { SessionLineageStore, UnsupportedStateSchemaVersionError } = await import(
  '../src/session-lineage-store.js'
);
const { makeRecord, seedManifest, seedRecord, snapshotTree, eventLine } = await import(
  './support/lineage-fixtures.js'
);

let stateRoot: string;

beforeEach(() => {
  calls.length = 0;
  stateRoot = mkdtempSync(join(tmpdir(), 'agent-dock-schema-'));
});

afterEach(() => {
  // rmSync is one of the wrapped mutators; clearing first keeps teardown out of the assertions.
  calls.length = 0;
  rmSync(stateRoot, { recursive: true, force: true });
});

/** The mutating calls that actually landed inside the store tree, ignoring unrelated temp churn. */
function mutationsInsideStore(): Array<{ fn: string; args: unknown[] }> {
  return calls.filter(({ args }) => args.some((arg) => typeof arg === 'string' && arg.startsWith(stateRoot)));
}

function expectThrowsUntouched(seed: () => void, expectedVersion: number): void {
  seed();
  const before = snapshotTree(stateRoot);
  calls.length = 0;

  let thrown: unknown;
  try {
    new SessionLineageStore({ stateRoot });
  } catch (err) {
    thrown = err;
  }

  expect(thrown).toBeInstanceOf(UnsupportedStateSchemaVersionError);
  expect((thrown as InstanceType<typeof UnsupportedStateSchemaVersionError>).foundVersion).toBe(expectedVersion);
  expect(snapshotTree(stateRoot)).toEqual(before);
  expect(mutationsInsideStore()).toEqual([]);
}

describe('future schema version: the store refuses without touching anything', () => {
  it('throws on a future manifest, with zero filesystem mutations', () => {
    expectThrowsUntouched(() => {
      seedManifest(stateRoot, { schemaVersion: 2 });
      seedRecord(stateRoot, makeRecord());
    }, 2);
  });

  it('throws on a future session record, with zero filesystem mutations', () => {
    expectThrowsUntouched(() => {
      seedManifest(stateRoot, { schemaVersion: 1 });
      const record = makeRecord();
      seedRecord(stateRoot, { ...record, schemaVersion: 3 as 1 });
    }, 3);
  });

  it('throws on a future tombstone, with zero filesystem mutations', () => {
    expectThrowsUntouched(() => {
      seedManifest(stateRoot, { schemaVersion: 1 });
      const tombstones = join(stateRoot, 'sessions-v1', 'tombstones');
      mkdirSync(tombstones, { recursive: true });
      writeFileSync(
        join(tombstones, '11111111-1111-4111-8111-111111111111.json'),
        JSON.stringify({ schemaVersion: 4, rootSessionId: '11111111-1111-4111-8111-111111111111' }),
      );
    }, 4);
  });

  it('throws on a future version inside a stray temp file, with zero filesystem mutations', () => {
    // The stray temp matters specifically because a stray temp is what the *next* startup step
    // quarantines. If the preflight did not look here, a newer build's half-written record would be
    // renamed into quarantine before anything noticed the version -- a mutation on a tree that must
    // stay untouched.
    expectThrowsUntouched(() => {
      seedManifest(stateRoot, { schemaVersion: 1 });
      writeFileSync(
        join(stateRoot, 'sessions-v1', '.manifest.json.999.abc.tmp'),
        JSON.stringify({ schemaVersion: 5 }),
      );
    }, 5);
  });

  it('throws on the future version even when corruption is present too, without touching the corrupt file', () => {
    const storeDir = join(stateRoot, 'sessions-v1');
    seedManifest(stateRoot, { schemaVersion: 2 });
    const corrupt = makeRecord();
    seedRecord(stateRoot, corrupt);
    const corruptPath = join(storeDir, 'lineages', corrupt.session.rootSessionId, 'records', `${corrupt.session.id}.json`);
    writeFileSync(corruptPath, '{ this is not json');

    const before = snapshotTree(stateRoot);
    calls.length = 0;

    expect(() => new SessionLineageStore({ stateRoot })).toThrow(UnsupportedStateSchemaVersionError);

    // The corrupt record is still exactly where it was, un-quarantined: corruption handling is a
    // mutation, and the future-version stop condition outranks it.
    expect(snapshotTree(stateRoot)).toEqual(before);
    expect(existsSync(corruptPath)).toBe(true);
    expect(existsSync(join(storeDir, 'quarantine'))).toBe(false);
    expect(mutationsInsideStore()).toEqual([]);
  });

  it('throws on a future-version line inside an event log, with zero filesystem mutations', () => {
    // An event log carries `v` per line, not a top-level `schemaVersion`, so a preflight that only
    // knew how to read whole-file JSON would sail straight past a newer build's log -- and then
    // `#repairEventLog` would find lines that do not validate against *this* build's schema, call
    // them a torn tail, and rewrite the file. That rewrite is the mutation this asserts cannot
    // happen: a version we do not understand is not corruption.
    expectThrowsUntouched(() => {
      seedManifest(stateRoot, { schemaVersion: 1 });
      const record = makeRecord();
      seedRecord(stateRoot, record, [
        eventLine(0),
        JSON.stringify({ v: 2, sequence: 1, timestamp: 't', type: 'something.new' }),
      ]);
    }, 2);
  });

  it('throws on a future-version line in a stray temp beside an event log', () => {
    expectThrowsUntouched(() => {
      seedManifest(stateRoot, { schemaVersion: 1 });
      const record = makeRecord();
      seedRecord(stateRoot, record, [eventLine(0)]);
      const events = join(stateRoot, 'sessions-v1', 'lineages', record.session.rootSessionId, 'events');
      writeFileSync(
        join(events, `.${record.session.id}.jsonl.999.abc.tmp`),
        `${JSON.stringify({ v: 7, sequence: 1, timestamp: 't', type: 'something.new' })}\n`,
      );
    }, 7);
  });

  it('does not mistake a torn or unparseable event-log line for a future version', () => {
    // The other half of the same rule: only a numeric `v` above this build's own counts. Garbage,
    // and a half-written final line, stay the corruption path's business -- which is allowed to
    // mutate, and does.
    seedManifest(stateRoot, { schemaVersion: 1 });
    const record = makeRecord();
    seedRecord(stateRoot, record, [eventLine(0)]);
    const log = join(
      stateRoot,
      'sessions-v1',
      'lineages',
      record.session.rootSessionId,
      'events',
      `${record.session.id}.jsonl`,
    );
    writeFileSync(log, `${eventLine(0)}\nnot json at all\n{"v":"2","sequence":2`);

    const store = new SessionLineageStore({ stateRoot });
    expect(store.listEvents(record.session.id).events.map((event) => event.sequence)).toEqual([0]);
  });

  it('throws on a future-schema record staged under .trash, and neither restores nor quarantines it', () => {
    // A trashed lineage is an eviction the newer build had not yet committed. Recovery would either
    // rename it back into lineages/ (no tombstone) or delete it (tombstone present), and both are
    // mutations on state belonging to software this build does not understand.
    const trashed = makeRecord();
    const trashEntry = join(
      stateRoot,
      'sessions-v1',
      '.trash',
      `evict--${trashed.session.rootSessionId}--00000000-0000-4000-8000-00000000ffff`,
    );

    expectThrowsUntouched(() => {
      seedManifest(stateRoot, { schemaVersion: 1 });
      mkdirSync(join(trashEntry, 'records'), { recursive: true });
      mkdirSync(join(trashEntry, 'events'), { recursive: true });
      writeFileSync(
        join(trashEntry, 'records', `${trashed.session.id}.json`),
        JSON.stringify({ ...trashed, schemaVersion: 6 }),
      );
    }, 6);

    // Still in .trash, still not in lineages/, still not in quarantine.
    expect(existsSync(join(trashEntry, 'records', `${trashed.session.id}.json`))).toBe(true);
    expect(existsSync(join(stateRoot, 'sessions-v1', 'lineages', trashed.session.rootSessionId))).toBe(false);
    expect(existsSync(join(stateRoot, 'sessions-v1', 'quarantine'))).toBe(false);
  });

  it('throws on a future-version event log staged under .trash', () => {
    const trashed = makeRecord();
    expectThrowsUntouched(() => {
      seedManifest(stateRoot, { schemaVersion: 1 });
      const trashEntry = join(
        stateRoot,
        'sessions-v1',
        '.trash',
        `evict--${trashed.session.rootSessionId}--00000000-0000-4000-8000-00000000eeee`,
      );
      mkdirSync(join(trashEntry, 'events'), { recursive: true });
      writeFileSync(
        join(trashEntry, 'events', `${trashed.session.id}.jsonl`),
        `${JSON.stringify({ v: 9, sequence: 0, timestamp: 't', type: 'something.new' })}\n`,
      );
    }, 9);
  });

  it('does not create the store skeleton at all when a future version is found', () => {
    seedManifest(stateRoot, { schemaVersion: 2 });
    expect(() => new SessionLineageStore({ stateRoot })).toThrow(UnsupportedStateSchemaVersionError);
    for (const dir of ['lineages', 'tombstones', 'quarantine', '.trash']) {
      expect(existsSync(join(stateRoot, 'sessions-v1', dir))).toBe(false);
    }
  });
});

describe('current and older schema versions are accepted', () => {
  it('opens a store whose manifest declares schemaVersion 1', () => {
    seedManifest(stateRoot, { schemaVersion: 1 });
    const store = new SessionLineageStore({ stateRoot });
    expect(store.stats().records).toBe(0);
  });

  it('creates a fresh store when nothing exists yet', () => {
    const store = new SessionLineageStore({ stateRoot });
    expect(existsSync(join(stateRoot, 'sessions-v1', 'manifest.json'))).toBe(true);
    expect(store.stats()).toEqual({ lineages: 0, records: 0, bytes: 0 });
  });

  it('ignores a non-numeric or absent schemaVersion rather than treating it as future', () => {
    seedManifest(stateRoot, { schemaVersion: 'two' });
    expect(() => new SessionLineageStore({ stateRoot })).not.toThrow();
  });

  it('loads a valid seeded lineage with its event log', () => {
    seedManifest(stateRoot, { schemaVersion: 1 });
    const record = makeRecord({ status: 'completed', terminalReason: 'provider_completed', eventCount: 2 });
    seedRecord(stateRoot, record, [eventLine(0), eventLine(1)]);

    const store = new SessionLineageStore({ stateRoot });
    expect(store.get(record.session.id)?.session.status).toBe('completed');
    expect(store.listEvents(record.session.id).events).toHaveLength(2);
  });
});
