import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two audit-store properties that can only be proven by instrumenting `node:fs` itself:
 *
 * 1. **fsync happens before an append resolves.** The trust routes return "allowed" only after
 *    awaiting an append, so this is what makes "the record is durable before access is granted" a
 *    fact about ordering rather than a claim about intent.
 * 2. **A failed write latches the store permanently unhealthy.** Injecting the failure at the
 *    syscall is the only way to exercise the latch without a real disk fault.
 *
 * Split into its own file because `vi.mock('node:fs', ...)` is file-global, and because the ESM
 * namespace is not configurable -- `vi.spyOn(fs, 'fsyncSync')` throws. This is the same treatment
 * `session-lineage-store.schema.test.ts` and `durable-store/atomic-fs.test.ts` already use.
 */

const { calls, failOpen } = vi.hoisted(() => ({
  calls: [] as string[],
  failOpen: { active: false },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const wrapper: Record<string, unknown> = { ...actual };

  wrapper.fsyncSync = (...args: unknown[]) => {
    calls.push('fsyncSync');
    return (actual.fsyncSync as (...a: unknown[]) => unknown)(...args);
  };
  wrapper.openSync = (...args: unknown[]) => {
    calls.push('openSync');
    if (failOpen.active) throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
    return (actual.openSync as (...a: unknown[]) => unknown)(...args);
  };
  wrapper.renameSync = (...args: unknown[]) => {
    calls.push('renameSync');
    return (actual.renameSync as (...a: unknown[]) => unknown)(...args);
  };

  return { ...wrapper, default: wrapper };
});

const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { AuditStore, AuditUnavailableError } = await import('../src/audit-store.js');

let stateRoot: string;

beforeEach(() => {
  calls.length = 0;
  failOpen.active = false;
  stateRoot = mkdtempSync(join(tmpdir(), 'agent-dock-audit-durability-'));
});

afterEach(() => {
  failOpen.active = false;
  rmSync(stateRoot, { recursive: true, force: true });
});

const ENTRY = {
  event: 'grant.consumed',
  workspaceId: 'a'.repeat(64),
  incarnation: 'b'.repeat(64),
  provider: 'claude',
  transport: 'legacy-one-shot',
  actor: 'user',
} as const;

describe('audit durability: fsync precedes the resolved promise', () => {
  it('has already fsynced by the time append() resolves', async () => {
    const store = new AuditStore({ stateRoot });
    calls.length = 0;

    let fsyncsAtResolution = -1;
    await store.append({ ...ENTRY }).then(() => {
      fsyncsAtResolution = calls.filter((name) => name === 'fsyncSync').length;
    });

    // At least one: the file's own fsync. The very first append also fsyncs the directory (the
    // entry's creation), so this is a lower bound, not an exact count.
    expect(fsyncsAtResolution).toBeGreaterThanOrEqual(1);
  });

  it('has not resolved before the fsync when the two are observed in the same turn', async () => {
    const store = new AuditStore({ stateRoot });
    calls.length = 0;

    const order: string[] = [];
    const appended = store.append({ ...ENTRY }).then(() => order.push('resolved'));
    // Queued behind the append's own microtask chain; if the store resolved before writing, this
    // would run with no fsync recorded at all.
    await appended;
    order.push(`fsyncs=${calls.filter((name) => name === 'fsyncSync').length}`);

    expect(order[0]).toBe('resolved');
    expect(order[1]).not.toBe('fsyncs=0');
  });
});

describe('audit durability: the unhealthy latch', () => {
  it('makes every later append throw, even after the underlying fault clears', async () => {
    const store = new AuditStore({ stateRoot });
    await store.append({ ...ENTRY });
    const afterFirst = readFileSync(join(stateRoot, 'workspace-audit', 'audit.jsonl'), 'utf8');

    failOpen.active = true;
    await expect(store.append({ ...ENTRY })).rejects.toBeInstanceOf(AuditUnavailableError);
    expect(store.unhealthy).toBe(true);

    // The fault is gone, and the store still refuses. This is the point of a latch: after one
    // failed write, the position of the next entry on disk is unknowable, so continuing would make
    // the sequence-contiguity check meaningless for every entry after it.
    failOpen.active = false;
    await expect(store.append({ ...ENTRY })).rejects.toBeInstanceOf(AuditUnavailableError);
    await expect(store.append({ ...ENTRY })).rejects.toBeInstanceOf(AuditUnavailableError);

    // And nothing was written in the meantime.
    expect(readFileSync(join(stateRoot, 'workspace-audit', 'audit.jsonl'), 'utf8')).toBe(afterFirst);
  });
});
