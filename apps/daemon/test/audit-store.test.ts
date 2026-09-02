import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditEntryV2Schema } from '@agent-dock/shared';
import {
  AuditCapacityError,
  AuditStore,
  AuditUnavailableError,
  type AuditEntryInput,
} from '../src/audit-store.js';

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'agent-dock-audit-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(stateRoot, { recursive: true, force: true });
});

const WORKSPACE = 'a'.repeat(64);
const INCARNATION = 'b'.repeat(64);

function entry(overrides: Partial<AuditEntryInput> = {}): AuditEntryInput {
  return {
    event: 'grant.consumed',
    workspaceId: WORKSPACE,
    incarnation: INCARNATION,
    provider: 'claude',
    transport: 'legacy-one-shot',
    actor: 'user',
    ...overrides,
  };
}

function logPath(): string {
  return join(stateRoot, 'workspace-audit', 'audit.jsonl');
}

function quarantineFiles(): string[] {
  const dir = join(stateRoot, 'workspace-audit', 'quarantine');
  return fs.existsSync(dir) ? readdirSync(dir) : [];
}

/**
 * Every byte of file *content* under `dir`, with no filenames mixed in.
 *
 * Filenames are excluded deliberately: the store's own directory sits under a temp path that
 * contains a drive letter and separators, so including names would make a "no path ever reaches the
 * disk" assertion match on the test harness's own scaffolding instead of on anything the store
 * wrote.
 */
function readAllContents(dir: string): string {
  let out = '';
  for (const child of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, child.name);
    out += child.isDirectory() ? readAllContents(full) : readFileSync(full, 'utf8');
  }
  return out;
}

describe('AuditStore: sequencing and durability', () => {
  it('assigns contiguous sequences from zero and persists every entry as one JSON line', async () => {
    const store = new AuditStore({ stateRoot });
    await store.append(entry({ event: 'grant.issued' }));
    await store.append(entry({ event: 'grant.consumed' }));
    await store.append(entry({ event: 'trust.granted' }));

    const lines = readFileSync(logPath(), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => auditEntryV2Schema.parse(JSON.parse(line)).sequence)).toEqual([0, 1, 2]);
  });

  it('serializes concurrent appends: no gap, no duplicate, no swap', async () => {
    const store = new AuditStore({ stateRoot });
    const written = await Promise.all(
      Array.from({ length: 25 }, (_unused, index) =>
        store.append(entry({ sessionId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` })),
      ),
    );

    expect(written.map((record) => record.sequence)).toEqual([...Array(25).keys()]);
    const onDisk = readFileSync(logPath(), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { sequence: number });
    expect(onDisk.map((record) => record.sequence)).toEqual([...Array(25).keys()]);
  });

  it('reloads its sequence counter from disk, so a restart continues rather than restarting at zero', async () => {
    const first = new AuditStore({ stateRoot });
    await first.append(entry());
    await first.append(entry());

    const second = new AuditStore({ stateRoot });
    const next = await second.append(entry());
    expect(next.sequence).toBe(2);
    expect(second.entryCount).toBe(3);
  });
});

describe('AuditStore: the byte cap denies rather than evicting', () => {
  it('throws AuditCapacityError instead of dropping the oldest entry', async () => {
    // Sized so a couple of entries fit and the next does not.
    const store = new AuditStore({ stateRoot, maxBytes: 900 });
    const first = await store.append(entry({ event: 'grant.issued' }));

    let denied: unknown;
    for (let i = 0; i < 20; i++) {
      try {
        await store.append(entry());
      } catch (err) {
        denied = err;
        break;
      }
    }

    expect(denied).toBeInstanceOf(AuditCapacityError);
    // The opposite of SessionLineageStore's policy, and the point of this test: the OLDEST entry is
    // still there. Nothing was evicted to make room, because forgetting an audited decision is a
    // worse outcome than refusing the next one.
    const onDisk = readFileSync(logPath(), 'utf8');
    expect(onDisk).toContain(first.entryId);
  });

  it('does not latch unhealthy on a capacity refusal: a full log is recoverable, a broken one is not', async () => {
    const store = new AuditStore({ stateRoot, maxBytes: 400 });
    await expect(store.append(entry())).resolves.toBeDefined();
    await expect(store.append(entry())).rejects.toBeInstanceOf(AuditCapacityError);
    expect(store.unhealthy).toBe(false);
  });
});

describe('AuditStore: the unhealthy latch', () => {
  it('refuses every append after close(), so a shutdown cannot record a decision it will not honor', async () => {
    const store = new AuditStore({ stateRoot });
    await store.append(entry());
    store.close();
    await expect(store.append(entry())).rejects.toBeInstanceOf(AuditUnavailableError);
  });
});

describe('AuditStore: corruption is quarantined, never deleted', () => {
  it('detects a deleted middle entry (a sequence gap) and quarantines the whole file', async () => {
    const store = new AuditStore({ stateRoot });
    await store.append(entry({ event: 'grant.issued' }));
    await store.append(entry({ event: 'grant.consumed' }));
    await store.append(entry({ event: 'trust.granted' }));

    const lines = readFileSync(logPath(), 'utf8').trim().split('\n');
    const tampered = [lines[0], lines[2]].join('\n');
    writeFileSync(logPath(), `${tampered}\n`);

    const reopened = new AuditStore({ stateRoot });
    expect(reopened.entryCount).toBe(0);
    expect(quarantineFiles()).toHaveLength(1);
    // Never deleted: the quarantined copy still holds both surviving entries, which is exactly the
    // evidence an investigation needs.
    const preserved = readFileSync(join(stateRoot, 'workspace-audit', 'quarantine', quarantineFiles()[0] as string), 'utf8');
    expect(preserved).toBe(`${tampered}\n`);
  });

  it('detects a truncated head (a non-zero first sequence), which a naive "each is +1" check would miss', async () => {
    const store = new AuditStore({ stateRoot });
    await store.append(entry());
    await store.append(entry());
    await store.append(entry());

    const lines = readFileSync(logPath(), 'utf8').trim().split('\n');
    // Entries 1 and 2 are still perfectly consecutive with each other.
    writeFileSync(logPath(), `${lines.slice(1).join('\n')}\n`);

    const reopened = new AuditStore({ stateRoot });
    expect(reopened.entryCount).toBe(0);
    expect(quarantineFiles()).toHaveLength(1);
  });

  it('quarantines an unparseable line and an entry that fails the strict schema', async () => {
    const store = new AuditStore({ stateRoot });
    await store.append(entry());
    writeFileSync(logPath(), `${readFileSync(logPath(), 'utf8')}{not json\n`);
    expect(new AuditStore({ stateRoot }).entryCount).toBe(0);
    expect(quarantineFiles()).toHaveLength(1);

    const second = new AuditStore({ stateRoot });
    await second.append(entry());
    const line = readFileSync(logPath(), 'utf8').trim();
    const parsed = JSON.parse(line) as Record<string, unknown>;
    writeFileSync(logPath(), `${JSON.stringify({ ...parsed, surprise: 'extra key' })}\n`);
    expect(new AuditStore({ stateRoot }).entryCount).toBe(0);
    expect(quarantineFiles()).toHaveLength(2);
  });

  it('starts a fresh, valid log after quarantining, rather than appending onto a distrusted prefix', async () => {
    const store = new AuditStore({ stateRoot });
    await store.append(entry());
    writeFileSync(logPath(), 'garbage\n');

    const reopened = new AuditStore({ stateRoot });
    const written = await reopened.append(entry());
    expect(written.sequence).toBe(0);
    expect(readFileSync(logPath(), 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('AuditStore: paging', () => {
  it('pages oldest-first and stops emitting a cursor at the end', async () => {
    const store = new AuditStore({ stateRoot });
    for (let i = 0; i < 7; i++) await store.append(entry());

    const first = store.list({ limit: 3 });
    expect(first.entries.map((record) => record.sequence)).toEqual([0, 1, 2]);
    expect(first.nextCursor).toBe('2');

    const second = store.list({ limit: 3, cursor: first.nextCursor });
    expect(second.entries.map((record) => record.sequence)).toEqual([3, 4, 5]);

    const third = store.list({ limit: 3, cursor: second.nextCursor });
    expect(third.entries.map((record) => record.sequence)).toEqual([6]);
    expect(third.nextCursor).toBeUndefined();
  });

  it('returns nothing for a cursor past the end, and for a non-numeric one', async () => {
    const store = new AuditStore({ stateRoot });
    await store.append(entry());
    expect(store.list({ cursor: '99' }).entries).toEqual([]);
    expect(store.list({ cursor: 'not-a-number' }).entries).toEqual([]);
  });
});

describe('AuditStore: the sentinel sweep (no content, no paths, on disk)', () => {
  it('writes only digests and enums, never a path, a folder name, or a branch label', async () => {
    // Mirrors persisted-session-schema.test.ts's sweep: unique markers everywhere a caller could
    // plausibly try to put content, then a grep of the entire on-disk tree.
    const store = new AuditStore({ stateRoot });

    const sentinelWorkspace = createHash('sha256').update('SENTINEL_WORKSPACE').digest('hex');
    const sentinelIncarnation = createHash('sha256').update('SENTINEL_INCARNATION').digest('hex');

    await store.append({
      event: 'grant.consumed',
      workspaceId: sentinelWorkspace,
      incarnation: sentinelIncarnation,
      provider: 'claude',
      transport: 'legacy-one-shot',
      sessionId: '11111111-2222-4333-8444-555555555555',
      actor: 'user',
    });

    // Everything a caller might have wanted to attach. The schema is `.strict()`, so the store
    // refuses them outright rather than storing them: that refusal IS the protection.
    await expect(
      store.append({
        event: 'grant.consumed',
        workspaceId: sentinelWorkspace,
        incarnation: sentinelIncarnation,
        provider: 'claude',
        transport: 'legacy-one-shot',
        actor: 'user',
        // @ts-expect-error the entry schema has no path field, deliberately
        path: 'C:\\Users\\someone\\SENTINEL_PATH_0001',
      }),
    ).rejects.toThrow();

    await expect(
      store.append({
        event: 'grant.consumed',
        workspaceId: sentinelWorkspace,
        incarnation: sentinelIncarnation,
        provider: 'claude',
        transport: 'legacy-one-shot',
        actor: 'user',
        // @ts-expect-error the entry schema has no displayName field, deliberately (ADI-05 rule)
        displayName: 'SENTINEL_DISPLAY_NAME_0002',
      }),
    ).rejects.toThrow();

    const everything = readAllContents(join(stateRoot, 'workspace-audit'));
    for (const sentinel of ['SENTINEL_PATH_0001', 'SENTINEL_DISPLAY_NAME_0002']) {
      expect(everything, `${sentinel} leaked to disk`).not.toContain(sentinel);
    }
    // Nothing path-shaped at all: no drive letter, no separator of either flavor. An audit line is
    // digests, enums, a uuid, and a timestamp, and none of those can contain one.
    expect(everything).not.toMatch(/[A-Za-z]:\\/);
    expect(everything).not.toContain('\\');
    expect(everything).not.toContain('/');
    // The refused entries left nothing behind either: still exactly one line.
    expect(readFileSync(logPath(), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('rejects a workspaceId that is not a digest, so a path cannot be smuggled through that field', async () => {
    const store = new AuditStore({ stateRoot });
    await expect(
      store.append(entry({ workspaceId: 'C:\\Users\\someone\\project' } as Partial<AuditEntryInput>)),
    ).rejects.toThrow();
    expect(fs.existsSync(logPath())).toBe(false);
  });
});
