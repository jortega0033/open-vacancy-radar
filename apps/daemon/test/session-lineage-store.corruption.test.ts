import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `node:fs` is wrapped (rather than spied on: its ESM namespace is not configurable) so the
 * corrupt-tail repair's *syscall order* can be asserted, the same way `atomic-fs.test.ts` asserts
 * it for `atomicWriteJson`. Every wrapper calls the real function, so the rest of this file behaves
 * exactly as it did before and observes the true sequence rather than a simulated one.
 */
const { calls, WRAPPED } = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; args: unknown[]; result?: unknown }>,
  WRAPPED: ['openSync', 'writeFileSync', 'writeSync', 'fsyncSync', 'closeSync', 'renameSync', 'unlinkSync'] as const,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const wrapper: Record<string, unknown> = { ...actual };
  for (const name of WRAPPED) {
    const original = actual[name] as unknown as (...args: unknown[]) => unknown;
    wrapper[name] = (...args: unknown[]) => {
      // Recorded before the call, so a throw (a directory fsync on win32, say) still shows up as
      // the attempt it was.
      const entry = { fn: name, args };
      calls.push(entry);
      const result = original(...args);
      (entry as { result?: unknown }).result = result;
      return result;
    };
  }
  return { ...wrapper, default: wrapper };
});

const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { basename, dirname, join, resolve } = await import('node:path');
const { SessionLineageStore } = await import('../src/session-lineage-store.js');
const { PERSISTED_SCHEMA_VERSION } = await import('../src/persisted-session-schema.js');
const { eventLine, listFiles, makeRecord, readAllText, seedManifest, seedRecord } = await import(
  './support/lineage-fixtures.js'
);

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'agent-dock-corruption-'));
  // Seeded at the version this build writes. A manifest at an OLDER readable version is a
  // legitimate state too, and ADI-13 upgrades it in place -- but that rewrite is a mutation, and the
  // "nothing ever disappears" sweep below compares raw lines, so exercising it here would make an
  // intended upgrade look like data loss. `session-lineage-store.upgrade.test.ts` covers it instead.
  seedManifest(stateRoot, { schemaVersion: PERSISTED_SCHEMA_VERSION });
  calls.length = 0;
});

afterEach(() => {
  calls.length = 0;
  rmSync(stateRoot, { recursive: true, force: true });
});

function storeDir(): string {
  return join(stateRoot, 'sessions-v1');
}

function recordPath(rootId: string, sessionId: string): string {
  return join(storeDir(), 'lineages', rootId, 'records', `${sessionId}.json`);
}

function eventLogPath(rootId: string, sessionId: string): string {
  return join(storeDir(), 'lineages', rootId, 'events', `${sessionId}.jsonl`);
}

/**
 * Every non-empty line under the store, as a set.
 *
 * Compared line-by-line rather than file-by-file, because corruption handling legitimately *moves*
 * and *splits* content: a torn log ends up as a truncated file plus a quarantined tail. Neither
 * path-keyed nor whole-file comparison could express the invariant that actually matters, which is
 * that no byte the store was holding stops existing.
 */
function allLines(): Set<string> {
  const lines = new Set<string>();
  for (const relPath of listFiles(storeDir())) {
    for (const line of readFileSync(join(storeDir(), relPath), 'utf8').split('\n')) {
      if (line.trim().length > 0) lines.add(line);
    }
  }
  return lines;
}

describe('corrupt event-log tail', () => {
  it('truncates a torn final line and keeps every good line before it', () => {
    const record = makeRecord({ eventCount: 3 });
    seedRecord(stateRoot, record, [eventLine(0), eventLine(1)]);
    // A crash mid-append: a partial JSON line with no trailing newline.
    writeFileSync(
      eventLogPath(record.session.rootSessionId, record.session.id),
      `${eventLine(0)}\n${eventLine(1)}\n{"v":1,"sequence":2,"timestamp`,
    );

    const store = new SessionLineageStore({ stateRoot });

    const events = store.listEvents(record.session.id).events;
    expect(events.map((event) => event.sequence)).toEqual([0, 1]);
    expect(readFileSync(eventLogPath(record.session.rootSessionId, record.session.id), 'utf8')).toBe(
      `${eventLine(0)}\n${eventLine(1)}\n`,
    );
  });

  it('quarantines the discarded tail rather than deleting it', () => {
    const record = makeRecord();
    seedRecord(stateRoot, record, [eventLine(0)]);
    writeFileSync(
      eventLogPath(record.session.rootSessionId, record.session.id),
      `${eventLine(0)}\n{"v":1,"sequence":1,"trunca`,
    );

    new SessionLineageStore({ stateRoot });

    const quarantined = listFiles(join(storeDir(), 'quarantine'));
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]).toMatch(/torn-event-tail$/);
    expect(readFileSync(join(storeDir(), 'quarantine', quarantined[0] as string), 'utf8')).toContain('"trunca');
  });

  it('treats garbage in the middle of the log as the start of the bad tail', () => {
    const record = makeRecord();
    seedRecord(stateRoot, record, [eventLine(0), 'total garbage, not json', eventLine(2)]);

    const store = new SessionLineageStore({ stateRoot });

    expect(store.listEvents(record.session.id).events.map((event) => event.sequence)).toEqual([0]);
    // Both the garbage line and the otherwise-valid line after it are quarantined together: once
    // ordering is broken, the remainder cannot be trusted to be in sequence.
    const quarantined = readAllText(join(storeDir(), 'quarantine'));
    expect(quarantined).toContain('total garbage, not json');
    expect(quarantined).toContain('"sequence":2');
  });

  it('treats an out-of-sequence line as corruption even when it parses perfectly', () => {
    const record = makeRecord();
    seedRecord(stateRoot, record, [eventLine(0), eventLine(5), eventLine(3)]);

    const store = new SessionLineageStore({ stateRoot });

    expect(store.listEvents(record.session.id).events.map((event) => event.sequence)).toEqual([0, 5]);
    expect(readAllText(join(storeDir(), 'quarantine'))).toContain('"sequence":3');
  });

  it('keeps the lineage itself: a torn tail is not a reason to lose the session record', () => {
    const record = makeRecord({ acceptedWork: 'accepted' });
    seedRecord(stateRoot, record, [eventLine(0)]);
    writeFileSync(eventLogPath(record.session.rootSessionId, record.session.id), `${eventLine(0)}\n{"broken`);

    const store = new SessionLineageStore({ stateRoot });

    const loaded = store.get(record.session.id);
    expect(loaded).toBeDefined();
    expect(loaded?.session.acceptedWork).toBe('accepted');
  });
});

describe('corrupt-tail repair is itself crash-safe', () => {
  /** True for the temp name `atomicWriteText` picks for `target`. */
  function isTempFor(candidate: string, target: string): boolean {
    return candidate.startsWith(join(dirname(target), `.${basename(target)}.`)) && candidate.endsWith('.tmp');
  }

  /**
   * Asserts the full durable-replace sequence landed on `target`: the bytes were written and
   * fsynced to a temp, the descriptor was closed, the temp was renamed over the target, and only
   * then was the containing directory fsynced.
   *
   * The repair path is the one place in this store that used a bare `writeFileSync` + `renameSync`
   * with no fsync between them. That is a durability hole precisely where it matters most: this
   * code only ever runs on a machine that has *already* proven it can die mid-write, and the write
   * it commits is the one that shortens a log after copying its tail elsewhere.
   */
  function expectDurableReplace(target: string): void {
    const openIndex = calls.findIndex(
      (call) => call.fn === 'openSync' && isTempFor(String(call.args[0]), target),
    );
    expect(openIndex, `no temp file was opened for ${target}`).toBeGreaterThanOrEqual(0);

    const open = calls[openIndex] as { args: unknown[]; result?: unknown };
    const after = calls.slice(openIndex + 1);
    const onTheDescriptor = after.filter((call) => call.args[0] === open.result).map((call) => call.fn);
    expect(onTheDescriptor.slice(0, 3)).toEqual(['writeFileSync', 'fsyncSync', 'closeSync']);

    const closeIndex = after.findIndex((call) => call.fn === 'closeSync' && call.args[0] === open.result);
    const renameIndex = after.findIndex(
      (call) => call.fn === 'renameSync' && call.args[0] === open.args[0],
    );
    expect(renameIndex, `the temp for ${target} was never renamed into place`).toBeGreaterThanOrEqual(0);
    expect(after[renameIndex]?.args[1]).toBe(target);
    expect(closeIndex, 'the rename happened before the descriptor was closed').toBeLessThan(renameIndex);

    const directoryOpen = after
      .slice(renameIndex + 1)
      .find((call) => call.fn === 'openSync' && resolve(String(call.args[0])) === resolve(dirname(target)));
    expect(directoryOpen, `the directory holding ${target} was not fsynced after the rename`).toBeDefined();
    // On win32 that open can legitimately fail (a directory is not an openable file there), which
    // is why the attempt is the assertion and the fsync itself is only checked when it can happen.
    if (directoryOpen?.result !== undefined) {
      expect(after.some((call) => call.fn === 'fsyncSync' && call.args[0] === directoryOpen.result)).toBe(true);
    }
  }

  it('writes, fsyncs, renames, then fsyncs the directory, for both the quarantine copy and the truncated log', () => {
    const record = makeRecord();
    seedRecord(stateRoot, record, [eventLine(0)]);
    const logPath = eventLogPath(record.session.rootSessionId, record.session.id);
    writeFileSync(logPath, `${eventLine(0)}\n{"v":1,"sequence":1,"tim`);
    calls.length = 0;

    new SessionLineageStore({ stateRoot });

    expectDurableReplace(logPath);

    const quarantined = listFiles(join(storeDir(), 'quarantine'));
    expect(quarantined).toHaveLength(1);
    expectDurableReplace(join(storeDir(), 'quarantine', quarantined[0] as string));
  });

  it('fsyncs the quarantine copy before the truncated log replaces the original', () => {
    // The ordering that makes the repair survive a *second* crash: if the shortened log committed
    // first, a crash before the copy was durable would leave the discarded tail in neither file.
    const record = makeRecord();
    seedRecord(stateRoot, record, [eventLine(0)]);
    const logPath = eventLogPath(record.session.rootSessionId, record.session.id);
    writeFileSync(logPath, `${eventLine(0)}\n{"v":1,"sequence":1,"tim`);
    calls.length = 0;

    new SessionLineageStore({ stateRoot });

    const quarantined = listFiles(join(storeDir(), 'quarantine'))[0] as string;
    const quarantineRename = calls.findIndex(
      (call) => call.fn === 'renameSync' && String(call.args[1]).endsWith(quarantined),
    );
    const logRename = calls.findIndex((call) => call.fn === 'renameSync' && call.args[1] === logPath);
    expect(quarantineRename).toBeGreaterThanOrEqual(0);
    expect(logRename).toBeGreaterThan(quarantineRename);
  });
});

describe('corrupt metadata record', () => {
  it('quarantines the whole lineage', () => {
    const broken = makeRecord();
    seedRecord(stateRoot, broken, [eventLine(0)]);
    writeFileSync(recordPath(broken.session.rootSessionId, broken.session.id), '{ not json at all');

    const store = new SessionLineageStore({ stateRoot });

    expect(store.get(broken.session.id)).toBeUndefined();
    expect(store.stats().lineages).toBe(0);
    const quarantined = readAllText(join(storeDir(), 'quarantine'));
    expect(quarantined).toContain('{ not json at all');
    // The lineage's event log travels with it: quarantine keeps the evidence together.
    expect(quarantined).toContain('"sequence":0');
  });

  it('quarantines a record whose shape is valid JSON but not a valid record', () => {
    const broken = makeRecord();
    seedRecord(stateRoot, broken);
    writeFileSync(
      recordPath(broken.session.rootSessionId, broken.session.id),
      JSON.stringify({ schemaVersion: 1, protocolVersion: 1, session: { id: 'not-a-uuid' } }),
    );

    const store = new SessionLineageStore({ stateRoot });
    expect(store.stats().lineages).toBe(0);
    expect(readAllText(join(storeDir(), 'quarantine'))).toContain('not-a-uuid');
  });

  it('quarantines a record carrying an unexpected extra field, rather than loading it', () => {
    const broken = makeRecord();
    seedRecord(stateRoot, broken);
    const smuggled = { ...broken, session: { ...broken.session, prompt: 'smuggled prompt text' } };
    writeFileSync(recordPath(broken.session.rootSessionId, broken.session.id), JSON.stringify(smuggled));

    const store = new SessionLineageStore({ stateRoot });
    expect(store.stats().lineages).toBe(0);
  });

  it('leaves sibling lineages completely unaffected', () => {
    const healthyA = makeRecord({ acceptedWork: 'accepted' });
    const healthyB = makeRecord();
    const broken = makeRecord();
    seedRecord(stateRoot, healthyA, [eventLine(0), eventLine(1)]);
    seedRecord(stateRoot, healthyB, [eventLine(0)]);
    seedRecord(stateRoot, broken);
    writeFileSync(recordPath(broken.session.rootSessionId, broken.session.id), 'corrupted');

    const store = new SessionLineageStore({ stateRoot });

    expect(store.get(healthyA.session.id)?.session.acceptedWork).toBe('accepted');
    expect(store.listEvents(healthyA.session.id).events).toHaveLength(2);
    expect(store.get(healthyB.session.id)).toBeDefined();
    expect(store.get(broken.session.id)).toBeUndefined();
    expect(store.stats().lineages).toBe(2);
  });

  it('quarantines only the corrupt member lineage when one lineage has several sessions', () => {
    const root = makeRecord({ acceptedWork: 'accepted' });
    const child = makeRecord({
      rootId: root.session.rootSessionId,
      parentSessionId: root.session.id,
      continuationKind: 'resume',
    });
    seedRecord(stateRoot, root);
    seedRecord(stateRoot, child);
    writeFileSync(recordPath(child.session.rootSessionId, child.session.id), 'corrupt');

    const store = new SessionLineageStore({ stateRoot });

    // One corrupt member takes the whole lineage: a half-loaded lineage would serve a record whose
    // parent link points at a session the store cannot describe.
    expect(store.get(root.session.id)).toBeUndefined();
    expect(store.get(child.session.id)).toBeUndefined();
    expect(store.stats().lineages).toBe(0);
  });
});

describe('corrupt manifest and stray temps', () => {
  it('rebuilds a corrupt manifest and quarantines the old one', () => {
    writeFileSync(join(storeDir(), 'manifest.json'), 'not json');
    seedRecord(stateRoot, makeRecord());

    const store = new SessionLineageStore({ stateRoot });

    expect(JSON.parse(readFileSync(join(storeDir(), 'manifest.json'), 'utf8'))).toEqual({
      schemaVersion: PERSISTED_SCHEMA_VERSION,
    });
    expect(readAllText(join(storeDir(), 'quarantine'))).toContain('not json');
    expect(store.stats().records).toBe(1);
  });

  it('quarantines a stray temp file left by an interrupted atomic write', () => {
    writeFileSync(join(storeDir(), '.manifest.json.1234.abcd.tmp'), '{"schemaVersion":1,"partial"');

    new SessionLineageStore({ stateRoot });

    const quarantined = listFiles(join(storeDir(), 'quarantine'));
    expect(quarantined.some((name) => name.endsWith('stray-temp'))).toBe(true);
  });
});

describe('nothing under the store is ever deleted by corruption handling', () => {
  const scenarios: Array<{ name: string; seed: () => void }> = [
    {
      name: 'torn event tail',
      seed: () => {
        const record = makeRecord();
        seedRecord(stateRoot, record, [eventLine(0)]);
        writeFileSync(eventLogPath(record.session.rootSessionId, record.session.id), `${eventLine(0)}\n{"tor`);
      },
    },
    {
      name: 'corrupt metadata record',
      seed: () => {
        const record = makeRecord();
        seedRecord(stateRoot, record, [eventLine(0)]);
        writeFileSync(recordPath(record.session.rootSessionId, record.session.id), 'UNIQUE-CORRUPT-RECORD');
      },
    },
    {
      name: 'corrupt manifest',
      seed: () => {
        writeFileSync(join(storeDir(), 'manifest.json'), 'UNIQUE-CORRUPT-MANIFEST');
        seedRecord(stateRoot, makeRecord());
      },
    },
    {
      name: 'corrupt tombstone',
      seed: () => {
        const tombstones = join(storeDir(), 'tombstones');
        mkdirSync(tombstones, { recursive: true });
        writeFileSync(join(tombstones, 'x.json'), 'UNIQUE-CORRUPT-TOMBSTONE');
      },
    },
    {
      name: 'stray temp',
      seed: () => {
        writeFileSync(join(storeDir(), '.record.json.1.a.tmp'), 'UNIQUE-STRAY-TEMP');
      },
    },
  ];

  for (const scenario of scenarios) {
    it(`retains every byte after: ${scenario.name}`, () => {
      scenario.seed();
      const before = allLines();

      new SessionLineageStore({ stateRoot });

      const after = allLines();
      // Every line the store was holding still exists somewhere underneath it (possibly under
      // quarantine/, possibly relocated out of a truncated log). Startup may ADD files -- the
      // rebuilt manifest, a quarantine copy -- but must never make one disappear.
      for (const line of before) {
        expect(after.has(line), `line disappeared after "${scenario.name}": ${line.slice(0, 60)}`).toBe(true);
      }
    });
  }
});
