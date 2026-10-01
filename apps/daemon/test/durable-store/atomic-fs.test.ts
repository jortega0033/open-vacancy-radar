import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `node:fs`'s ESM namespace is not configurable, so `vi.spyOn(fs, 'openSync')` cannot work here.
 * Instead the module is replaced once with a thin pass-through wrapper whose behavior each test
 * adjusts through `hooks`. Every wrapped function calls the real one by default, so this observes
 * the true syscall sequence rather than simulating one -- which matters, because the thing under
 * test *is* the syscall sequence.
 */
const { hooks, WRAPPED } = vi.hoisted(() => ({
  hooks: {} as Record<string, ((original: (...a: unknown[]) => unknown, ...args: unknown[]) => unknown) | undefined>,
  WRAPPED: [
    'openSync',
    'writeFileSync',
    'writeSync',
    'fsyncSync',
    'closeSync',
    'renameSync',
    'unlinkSync',
  ] as const,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const wrapper: Record<string, unknown> = { ...actual };
  for (const name of WRAPPED) {
    const original = actual[name] as unknown as (...args: unknown[]) => unknown;
    wrapper[name] = (...args: unknown[]) => {
      const hook = hooks[name];
      return hook ? hook(original, ...args) : original(...args);
    };
  }
  return { ...wrapper, default: wrapper };
});

const { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { appendDurably, assertContainedIn, atomicWriteJson, quarantine } = await import(
  '../../src/durable-store/atomic-fs.js'
);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-dock-atomic-fs-'));
});

afterEach(() => {
  for (const name of WRAPPED) delete hooks[name];
  rmSync(dir, { recursive: true, force: true });
});

/** Records the *order* of the fs primitives, which is the entire correctness argument here. */
function recordCallOrder(): string[] {
  const order: string[] = [];
  for (const name of WRAPPED) {
    hooks[name] = (original, ...args) => {
      order.push(name);
      return original(...args);
    };
  }
  return order;
}

describe('atomicWriteJson: write ordering', () => {
  it('writes, fsyncs, closes, renames, then fsyncs the containing directory, in that order', () => {
    const order = recordCallOrder();
    const target = join(dir, 'record.json');

    atomicWriteJson(target, { hello: 'world' });

    // The first five calls are the durability sequence itself. Anything reordered here breaks the
    // guarantee: fsync after rename would publish an unsynced file, and rename before close would
    // publish a file with writes still outstanding on the descriptor.
    expect(order.slice(0, 5)).toEqual(['openSync', 'writeFileSync', 'fsyncSync', 'closeSync', 'renameSync']);
    // ...and then the directory fsync is attempted. On win32 that open can legitimately fail (a
    // directory is not an openable file there), which is why this asserts the attempt, not success.
    expect(order[5]).toBe('openSync');
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ hello: 'world' });
  });

  it('writes the payload with a trailing newline, so a truncated file is detectable', () => {
    const target = join(dir, 'record.json');
    atomicWriteJson(target, { a: 1 });
    expect(readFileSync(target, 'utf8')).toBe('{"a":1}\n');
  });

  it('never writes directly to the target path: the target only ever appears via rename', () => {
    const opened: string[] = [];
    hooks.openSync = (original, ...args) => {
      opened.push(String(args[0]));
      return original(...args);
    };
    const target = join(dir, 'record.json');

    atomicWriteJson(target, { a: 1 });

    expect(opened).not.toContain(target);
    expect(opened.some((path) => path.startsWith(join(dir, '.record.json.')))).toBe(true);
  });
});

describe('atomicWriteJson: crash mid-write', () => {
  it('leaves the previous file completely intact and removes the temp when the write fails', () => {
    const target = join(dir, 'record.json');
    atomicWriteJson(target, { generation: 1 });

    let failed = false;
    hooks.fsyncSync = (original, ...args) => {
      if (!failed) {
        failed = true;
        throw new Error('simulated power loss before the rename');
      }
      return original(...args);
    };

    expect(() => atomicWriteJson(target, { generation: 2 })).toThrow(/simulated power loss/);

    // The old content survives byte-for-byte: the target was never opened for writing at all.
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ generation: 1 });
    // And no temp file is left behind to be mistaken for state on the next startup.
    expect(readdirSync(dir)).toEqual(['record.json']);
  });

  it('removes the temp when the rename itself fails', () => {
    const target = join(dir, 'record.json');
    hooks.renameSync = () => {
      throw new Error('simulated rename failure');
    };

    expect(() => atomicWriteJson(target, { generation: 1 })).toThrow(/simulated rename failure/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('tolerates the temp already being gone during cleanup rather than masking the real error', () => {
    const target = join(dir, 'record.json');
    hooks.renameSync = (_original, ...args) => {
      // Simulates an external cleaner racing us: the real error must still be what surfaces.
      rmSync(String(args[0]), { force: true });
      throw new Error('simulated rename failure');
    };

    expect(() => atomicWriteJson(target, { generation: 1 })).toThrow(/simulated rename failure/);
  });
});

describe('appendDurably', () => {
  it('appends one newline-terminated line per call, in order', () => {
    const log = join(dir, 'events.jsonl');
    appendDurably(log, '{"a":1}');
    appendDurably(log, '{"a":2}');
    expect(readFileSync(log, 'utf8')).toBe('{"a":1}\n{"a":2}\n');
  });

  it('fsyncs after every append, not only the first', () => {
    const log = join(dir, 'events.jsonl');
    let fsyncs = 0;
    hooks.fsyncSync = (original, ...args) => {
      fsyncs += 1;
      return original(...args);
    };

    appendDurably(log, 'one');
    const afterFirst = fsyncs;
    appendDurably(log, 'two');

    expect(afterFirst).toBeGreaterThan(0);
    expect(fsyncs).toBeGreaterThan(afterFirst);
  });

  it('completes a short write instead of leaving a torn line', () => {
    const log = join(dir, 'events.jsonl');
    let shortened = false;
    hooks.writeSync = (original, ...args) => {
      const [fd, buffer, offset, length] = args as [number, Buffer, number, number];
      if (!shortened) {
        shortened = true;
        // A legal short write: the kernel accepted only part of the buffer. Without the retry loop
        // in appendDurably this would silently truncate the record.
        return original(fd, buffer, offset, Math.max(1, Math.floor(length / 3)));
      }
      return original(fd, buffer, offset, length);
    };

    appendDurably(log, '{"sequence":0,"payload":"a-reasonably-long-line-to-split"}');

    expect(shortened).toBe(true);
    expect(readFileSync(log, 'utf8')).toBe('{"sequence":0,"payload":"a-reasonably-long-line-to-split"}\n');
  });

  it('throws rather than looping forever if a write makes no progress at all', () => {
    const log = join(dir, 'events.jsonl');
    hooks.writeSync = () => 0;
    expect(() => appendDurably(log, 'stuck')).toThrow(/made no progress/);
  });
});

describe('quarantine', () => {
  it('moves the file into the quarantine directory and never deletes it', () => {
    const victim = join(dir, 'broken.json');
    writeFileSync(victim, 'not json at all');
    const quarantineDir = join(dir, 'quarantine');

    const target = quarantine(victim, quarantineDir, 'corrupt record');

    expect(existsSync(victim)).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('not json at all');
    expect(target).toContain('broken.json');
    // The reason is sanitized into the filename so a directory listing explains itself.
    expect(target).toMatch(/corrupt-record$/);
  });

  it('never collides when the same name is quarantined twice', () => {
    const quarantineDir = join(dir, 'quarantine');
    writeFileSync(join(dir, 'dupe.json'), 'first');
    quarantine(join(dir, 'dupe.json'), quarantineDir, 'x');
    writeFileSync(join(dir, 'dupe.json'), 'second');
    quarantine(join(dir, 'dupe.json'), quarantineDir, 'x');

    const contents = readdirSync(quarantineDir).map((name) => readFileSync(join(quarantineDir, name), 'utf8'));
    expect(contents.sort()).toEqual(['first', 'second']);
  });
});

describe('assertContainedIn', () => {
  it('accepts a path inside the root', () => {
    expect(() => assertContainedIn(dir, join(dir, 'a', 'b.json'))).not.toThrow();
  });

  it('rejects the root itself, a sibling, and a traversal escape', () => {
    expect(() => assertContainedIn(dir, dir)).toThrow(/outside the store root/);
    expect(() => assertContainedIn(join(dir, 'a'), join(dir, 'b'))).toThrow(/outside the store root/);
    expect(() => assertContainedIn(dir, join(dir, '..', 'elsewhere'))).toThrow(/outside the store root/);
  });
});
