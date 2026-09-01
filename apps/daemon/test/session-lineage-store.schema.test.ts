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
