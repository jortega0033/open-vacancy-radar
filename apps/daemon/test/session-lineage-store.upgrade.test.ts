import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionLineageStore } from '../src/session-lineage-store.js';
import {
  PERSISTED_SCHEMA_VERSION,
  READABLE_SCHEMA_VERSIONS,
  persistedSessionRecordV1Schema,
} from '../src/persisted-session-schema.js';
import { eventLine, makeRecord, makeSession, seedManifest, seedRecord } from './support/lineage-fixtures.js';

/**
 * **The single most important test ADI-13 adds.**
 *
 * ADI-13 bumped `PERSISTED_SCHEMA_VERSION` from 1 to 2 to make room for a new optional `selection`
 * field. The obvious way to do that -- change `z.literal(1)` to `z.literal(2)` in
 * `persistedSessionRecordV1Schema`, and `version === 1` to `version === 2` in `#loadManifest` --
 * would have shipped a silent catastrophe: on the first launch after upgrading, *every existing
 * record on every user's disk* would have failed to parse, `#loadLineages` would have read that as
 * corruption, and the whole session history would have been quarantined as "corrupt" alongside a
 * quarantined manifest. Nothing would have crashed. Nothing would have logged an error a user would
 * see. The history would simply be gone from the app and sitting in a `quarantine/` folder.
 *
 * So this file seeds a store exactly as a pre-ADI-13 build wrote one -- `schemaVersion: 1` manifest,
 * `schemaVersion: 1` records, no `selection` anywhere -- opens it with the post-ADI-13 code, and
 * asserts that nothing was quarantined, everything is still readable, no `selection` was invented,
 * and the manifest (and only the manifest) moved to the current version.
 *
 * If a future ticket narrows either reader to a single literal again, these fail.
 */

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'agent-dock-upgrade-'));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

function storeDir(): string {
  return join(stateRoot, 'sessions-v1');
}

function quarantineEntries(): string[] {
  const dir = join(storeDir(), 'quarantine');
  return existsSync(dir) ? readdirSync(dir) : [];
}

function manifestVersion(): unknown {
  return (JSON.parse(readFileSync(join(storeDir(), 'manifest.json'), 'utf8')) as { schemaVersion?: unknown })
    .schemaVersion;
}

/** A store written by any build before ADI-13: version 1 throughout, no `selection` field. */
function seedPreAdi13Store(): ReturnType<typeof makeRecord>[] {
  seedManifest(stateRoot, { schemaVersion: 1 });
  const root = makeRecord({
    schemaVersion: 1,
    status: 'completed',
    terminalReason: 'provider_completed',
    acceptedWork: 'accepted',
    providerSessionId: 'thread-abc',
    eventCount: 2,
  });
  const child = makeRecord({
    schemaVersion: 1,
    rootId: root.session.rootSessionId,
    parentSessionId: root.session.id,
    continuationKind: 'resume',
    status: 'completed',
    terminalReason: 'provider_completed',
  });
  const other = makeRecord({ schemaVersion: 1, status: 'cancelled', terminalReason: 'cancelled_by_client' });
  seedRecord(stateRoot, root, [eventLine(0), eventLine(1)]);
  seedRecord(stateRoot, child);
  seedRecord(stateRoot, other);
  return [root, child, other];
}

describe('opening a pre-ADI-13 store with the post-ADI-13 build', () => {
  it('quarantines nothing at all', () => {
    seedPreAdi13Store();

    new SessionLineageStore({ stateRoot });

    // The assertion that would have failed against a naive `z.literal(2)` bump, for every record
    // and for the manifest.
    expect(quarantineEntries()).toEqual([]);
  });

  it('keeps every record readable, with its accepted-work claim and lineage intact', () => {
    const [root, child, other] = seedPreAdi13Store();

    const store = new SessionLineageStore({ stateRoot });

    expect(store.stats().records).toBe(3);
    expect(store.get(root!.session.id)?.session.acceptedWork).toBe('accepted');
    expect(store.get(child!.session.id)?.session.parentSessionId).toBe(root!.session.id);
    expect(store.get(child!.session.id)?.session.continuationKind).toBe('resume');
    expect(store.get(other!.session.id)?.session.status).toBe('cancelled');
    expect(store.listEvents(root!.session.id).events.map((event) => event.sequence)).toEqual([0, 1]);
  });

  it('leaves `selection` absent on every migrated record: no key, not an empty object', () => {
    const seeded = seedPreAdi13Store();

    const store = new SessionLineageStore({ stateRoot });

    for (const record of seeded) {
      const loaded = store.get(record.session.id);
      expect(loaded).toBeDefined();
      // `toBeUndefined` alone would also pass for `selection: undefined`, which is a different fact:
      // absent means "no negotiation happened", and an explicitly-present key would say otherwise to
      // anything that checks with `in`.
      expect('selection' in loaded!.session).toBe(false);
    }
  });

  it('rewrites the manifest to the current version, and does not rewrite the records', () => {
    const seeded = seedPreAdi13Store();
    const recordPaths = seeded.map((record) =>
      join(storeDir(), 'lineages', record.session.rootSessionId, 'records', `${record.session.id}.json`),
    );
    const before = recordPaths.map((path) => readFileSync(path, 'utf8'));

    new SessionLineageStore({ stateRoot });

    expect(manifestVersion()).toBe(PERSISTED_SCHEMA_VERSION);
    // No record migration pass exists, and none is needed: the only new field is optional. A build
    // that rewrote every record on startup would be doing unnecessary IO on state it did not change,
    // and would be a far riskier thing to run against a disk that might be full.
    expect(recordPaths.map((path) => readFileSync(path, 'utf8'))).toEqual(before);
  });

  it('survives a second open, now that the manifest says 2 and the records still say 1', () => {
    const seeded = seedPreAdi13Store();

    new SessionLineageStore({ stateRoot });
    const reopened = new SessionLineageStore({ stateRoot });

    // The mixed state -- current manifest, older records -- is the state every upgraded user is left
    // in, and it has to be stable rather than merely survivable once.
    expect(quarantineEntries()).toEqual([]);
    expect(reopened.stats().records).toBe(3);
    expect(reopened.get(seeded[0]!.session.id)?.session.acceptedWork).toBe('accepted');
  });

  it('writes new records at the current version alongside the older ones', () => {
    seedPreAdi13Store();

    const store = new SessionLineageStore({ stateRoot });
    const created = store.create(makeSession(), {
      protocolVersion: 2,
      scope: { authenticated: 'unknown', platform: 'linux', accountEvidence: 'cli_owned' },
    });

    expect(created.schemaVersion).toBe(PERSISTED_SCHEMA_VERSION);
    expect(store.stats().records).toBe(4);
    expect(quarantineEntries()).toEqual([]);
  });
});

describe('the readable-version set is wider than the written one, on purpose', () => {
  it('names every version this build accepts, and the written one is the highest of them', () => {
    expect([...READABLE_SCHEMA_VERSIONS].sort()).toEqual([1, 2]);
    expect(Math.max(...READABLE_SCHEMA_VERSIONS)).toBe(PERSISTED_SCHEMA_VERSION);
  });

  it('parses a record at every readable version, with and without a selection', () => {
    for (const schemaVersion of READABLE_SCHEMA_VERSIONS) {
      const plain = makeRecord({ schemaVersion: schemaVersion as 1 | 2 });
      expect(persistedSessionRecordV1Schema.safeParse(plain).success, `v${schemaVersion} plain`).toBe(true);

      const negotiated = makeRecord({
        schemaVersion: schemaVersion as 1 | 2,
        selection: { enabled: [], unavailableOptional: [] },
      });
      expect(persistedSessionRecordV1Schema.safeParse(negotiated).success, `v${schemaVersion} selection`).toBe(true);
    }
  });

  it('still refuses a version above the written one', () => {
    const ahead = { ...makeRecord(), schemaVersion: PERSISTED_SCHEMA_VERSION + 1 };
    expect(persistedSessionRecordV1Schema.safeParse(ahead).success).toBe(false);
  });
});
