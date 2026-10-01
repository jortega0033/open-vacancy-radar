import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ATTACHMENT_TTL_MS,
  AttachmentMimeTypeRejectedError,
  AttachmentQuotaExceededError,
  AttachmentStore,
  AttachmentTooLargeError,
  InvalidSessionIdError,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_SESSION,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from '../src/attachment-store.js';

/**
 * `AttachmentStore` (ADI-29): the one deliberate, documented exception to `agentdock-state/`'s
 * content-free rule (see the module's own doc comment and docs/privacy.md). These tests exist to
 * prove every safety property that justifies the exception actually holds -- bounded size, bounded
 * count, bounded total, narrow MIME scope, session-scoped retrieval, TTL expiry, and durable
 * round-tripping -- not just the happy path.
 */

let stateRoot: string;

beforeEach(() => {
  stateRoot = mkdtempSync(join(tmpdir(), 'agent-dock-attachments-'));
});

afterEach(() => {
  rmSync(stateRoot, { recursive: true, force: true });
});

function sessionId(): string {
  return randomUUID();
}

describe('AttachmentStore: put/get round trip', () => {
  it('stores and retrieves content, with correct metadata', () => {
    const store = new AttachmentStore({ stateRoot });
    const id = sessionId();
    const content = '{"exitCode":1,"output":"a very long command result"}';

    const metadata = store.put(id, 'application/json', content);

    expect(metadata.sessionId).toBe(id);
    expect(metadata.mimeType).toBe('application/json');
    expect(metadata.bytes).toBe(Buffer.byteLength(content, 'utf8'));
    expect(metadata.id).toMatch(/^[0-9a-f-]{36}$/);

    const fetched = store.get(id, metadata.id);
    expect(fetched?.content).toBe(content);
    expect(fetched?.metadata).toEqual(metadata);
  });

  it('accepts text/plain as well as application/json', () => {
    const store = new AttachmentStore({ stateRoot });
    const id = sessionId();
    const metadata = store.put(id, 'text/plain', 'plain output');
    expect(store.get(id, metadata.id)?.content).toBe('plain output');
  });

  it('survives a fresh store instance reading the same state root', () => {
    const id = sessionId();
    const first = new AttachmentStore({ stateRoot });
    const metadata = first.put(id, 'text/plain', 'durable content');

    const second = new AttachmentStore({ stateRoot });
    expect(second.get(id, metadata.id)?.content).toBe('durable content');
  });

  it('computes a real sha256 over the content', () => {
    const store = new AttachmentStore({ stateRoot });
    const id = sessionId();
    const metadata = store.put(id, 'text/plain', 'hash me');
    expect(metadata.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('AttachmentStore: session-scoped retrieval', () => {
  it('refuses to return an attachment for a session that did not create it', () => {
    const store = new AttachmentStore({ stateRoot });
    const owner = sessionId();
    const other = sessionId();
    const metadata = store.put(owner, 'text/plain', 'owner content');

    expect(store.get(other, metadata.id)).toBeUndefined();
    // The real owner can still read it -- proves the refusal above was ownership, not corruption.
    expect(store.get(owner, metadata.id)?.content).toBe('owner content');
  });

  it('returns undefined for an unknown attachment id, a malformed one, and an unknown session', () => {
    const store = new AttachmentStore({ stateRoot });
    const id = sessionId();
    store.put(id, 'text/plain', 'x');

    expect(store.get(id, randomUUID())).toBeUndefined();
    expect(store.get(id, '../../etc/passwd')).toBeUndefined();
    expect(store.get(sessionId(), randomUUID())).toBeUndefined();
  });

  it('rejects a malformed session id outright, for both put and get', () => {
    const store = new AttachmentStore({ stateRoot });
    expect(() => store.put('../../etc/passwd', 'text/plain', 'x')).toThrow(InvalidSessionIdError);
    expect(() => store.get('not-a-uuid', randomUUID())).toThrow(InvalidSessionIdError);
  });
});

describe('AttachmentStore: bounds', () => {
  it('rejects an oversized attachment rather than truncating it', () => {
    const store = new AttachmentStore({ stateRoot });
    const id = sessionId();
    const oversized = 'x'.repeat(MAX_ATTACHMENT_BYTES + 1);
    expect(() => store.put(id, 'text/plain', oversized)).toThrow(AttachmentTooLargeError);
    expect(store.listMetadata(id)).toEqual([]);
  });

  it('accepts content at exactly the byte limit', () => {
    const store = new AttachmentStore({ stateRoot });
    const id = sessionId();
    const atLimit = 'x'.repeat(MAX_ATTACHMENT_BYTES);
    expect(() => store.put(id, 'text/plain', atLimit)).not.toThrow();
  });

  it('rejects a MIME type outside the allowed set', () => {
    const store = new AttachmentStore({ stateRoot });
    const id = sessionId();
    expect(() => store.put(id, 'application/octet-stream', 'x')).toThrow(AttachmentMimeTypeRejectedError);
    expect(() => store.put(id, 'text/html', '<script>x</script>')).toThrow(AttachmentMimeTypeRejectedError);
  });

  it('rejects a new attachment once a session reaches its per-session cap', () => {
    const store = new AttachmentStore({ stateRoot });
    const id = sessionId();
    for (let i = 0; i < MAX_ATTACHMENTS_PER_SESSION; i++) {
      store.put(id, 'text/plain', `entry ${i}`);
    }
    expect(() => store.put(id, 'text/plain', 'one too many')).toThrow(AttachmentQuotaExceededError);
    expect(store.listMetadata(id)).toHaveLength(MAX_ATTACHMENTS_PER_SESSION);
  });

  it('refuses a write that would push the store past its global byte budget, across sessions', { timeout: 20_000 }, () => {
    const store = new AttachmentStore({ stateRoot });
    // Fill the global budget with large attachments across different sessions -- a new session
    // each time so the per-session count cap (well below this many puts) is never what trips,
    // only the global byte budget. Each on-disk record also carries JSON envelope overhead beyond
    // its raw content bytes, so the exact number of max-size puts the budget admits is slightly
    // fewer than `MAX_TOTAL_ATTACHMENT_BYTES / MAX_ATTACHMENT_BYTES`; looping until the store
    // itself refuses (rather than assuming a precomputed count) is what actually proves the bound,
    // without the test needing to duplicate the store's own accounting.
    const chunk = 'x'.repeat(MAX_ATTACHMENT_BYTES);
    const generousUpperBound = Math.ceil(MAX_TOTAL_ATTACHMENT_BYTES / MAX_ATTACHMENT_BYTES) + 1;
    let refused = false;
    for (let i = 0; i < generousUpperBound; i++) {
      try {
        store.put(sessionId(), 'text/plain', chunk);
      } catch (err) {
        expect(err).toBeInstanceOf(AttachmentQuotaExceededError);
        expect((err as InstanceType<typeof AttachmentQuotaExceededError>).scope).toBe('store');
        refused = true;
        break;
      }
    }
    expect(refused, 'expected the global byte budget to eventually refuse a write').toBe(true);
  });
});

describe('AttachmentStore: deleteForSession', () => {
  it('removes every attachment for one session, and leaves other sessions untouched', () => {
    const store = new AttachmentStore({ stateRoot });
    const target = sessionId();
    const other = sessionId();
    store.put(target, 'text/plain', 'a');
    store.put(target, 'text/plain', 'b');
    const otherMeta = store.put(other, 'text/plain', 'c');

    store.deleteForSession(target);

    expect(store.listMetadata(target)).toEqual([]);
    expect(store.get(other, otherMeta.id)?.content).toBe('c');
  });

  it('is a no-op for a session with no attachments', () => {
    const store = new AttachmentStore({ stateRoot });
    expect(() => store.deleteForSession(sessionId())).not.toThrow();
  });
});

describe('AttachmentStore: listMetadata', () => {
  it('never includes content, and orders newest first', () => {
    let currentMs = 1_000;
    const store = new AttachmentStore({ stateRoot, now: () => new Date(currentMs) });
    const id = sessionId();

    const first = store.put(id, 'text/plain', 'first');
    currentMs = 2_000;
    const second = store.put(id, 'text/plain', 'second');

    const list = store.listMetadata(id);
    expect(list.map((m) => m.id)).toEqual([second.id, first.id]);
    for (const entry of list) {
      expect(entry).not.toHaveProperty('content');
    }
  });
});

describe('AttachmentStore: filesystem safety', () => {
  it('creates the store directory and session directories with private (0700) permissions', () => {
    if (process.platform === 'win32') return; // POSIX mode bits are not meaningful on Windows.
    const store = new AttachmentStore({ stateRoot });
    const id = sessionId();
    store.put(id, 'text/plain', 'x');

    const storeDir = join(stateRoot, 'attachments-v1');
    const sessionDir = join(storeDir, id);
    expect(existsSync(storeDir)).toBe(true);
    expect(statSync(storeDir).mode & 0o777).toBe(0o700);
    expect(statSync(sessionDir).mode & 0o777).toBe(0o700);
  });

  it('skips a record it cannot parse, rather than throwing', () => {
    const id = sessionId();
    mkdirSync(join(stateRoot, 'attachments-v1', id), { recursive: true, mode: 0o700 });
    writeFileSync(join(stateRoot, 'attachments-v1', id, 'not-json.json'), 'not valid json{{{');

    const store = new AttachmentStore({ stateRoot });
    expect(store.listMetadata(id)).toEqual([]);
    expect(() => store.put(id, 'text/plain', 'still works')).not.toThrow();
  });

  it('does not follow a symlink planted under the store root -- never reads it as a record, never deletes through it', () => {
    let canSymlink = true;
    const externalDir = mkdtempSync(join(tmpdir(), 'agent-dock-attachments-external-'));
    const externalFile = join(externalDir, 'secret.txt');
    writeFileSync(externalFile, 'external content that must never be touched');

    const id = sessionId();
    const dir = join(stateRoot, 'attachments-v1', id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const linkPath = join(dir, `${randomUUID()}.json`);
    try {
      symlinkSync(externalFile, linkPath, 'file');
    } catch {
      canSymlink = false;
    }
    if (!canSymlink) {
      rmSync(externalDir, { recursive: true, force: true });
      return; // No symlink privilege on this machine (e.g. unprivileged Windows) -- nothing to test.
    }

    const store = new AttachmentStore({ stateRoot });
    // listMetadata never returns a record for the symlink: `#readRecord`'s `isRealEntry` check
    // rejects it before ever reading through it, so it is not a real, readable attachment.
    expect(store.listMetadata(id)).toEqual([]);

    // pruneExpired() walks every entry under the store root, including this symlink. If it followed
    // the link instead of skipping it, the external file (never a valid attachment record) would
    // either be deleted outright (via unlinkSync on the resolved path) or corrupt the sweep.
    expect(() => store.pruneExpired()).not.toThrow();
    expect(existsSync(externalFile)).toBe(true);
    expect(readFileSync(externalFile, 'utf8')).toBe('external content that must never be touched');

    rmSync(externalDir, { recursive: true, force: true });
  });
});

describe('AttachmentStore: TTL retention sweep', () => {
  it('removes an attachment whose recorded createdAt is older than the TTL, and keeps a fresh one', () => {
    const id = sessionId();
    // TTL eligibility is compared against each record's own `createdAt`, stamped from this store's
    // injected clock -- never a filesystem timestamp (a real bug a review caught: mixing an
    // injected clock for `createdAt` with the OS's own mtime for the sweep would make the two drift
    // arbitrarily far apart whenever a test, or a future caller, injects a clock that disagrees
    // with real time). So both "old" and "fresh" here are produced on the one clock the sweep
    // itself will read.
    let currentMs = 0;
    const first = new AttachmentStore({ stateRoot, now: () => new Date(currentMs) });
    const old = first.put(id, 'text/plain', 'old content');
    currentMs = ATTACHMENT_TTL_MS + 10_000;
    const fresh = first.put(id, 'text/plain', 'fresh content');

    const second = new AttachmentStore({ stateRoot, now: () => new Date(currentMs) });
    expect(second.get(id, old.id)).toBeUndefined();
    expect(second.get(id, fresh.id)?.content).toBe('fresh content');
  });

  it('removes a now-empty session directory once its last attachment expires', () => {
    const id = sessionId();
    let currentMs = 0;
    const first = new AttachmentStore({ stateRoot, now: () => new Date(currentMs) });
    first.put(id, 'text/plain', 'only entry');

    currentMs = ATTACHMENT_TTL_MS + 10_000;
    new AttachmentStore({ stateRoot, now: () => new Date(currentMs) });

    expect(existsSync(join(stateRoot, 'attachments-v1', id))).toBe(false);
    expect(readdirSync(join(stateRoot, 'attachments-v1'))).toEqual([]);
  });

  it('does not delete a record whose createdAt cannot be parsed, leaving it (and evidence of it) in place', () => {
    const id = sessionId();
    const store = new AttachmentStore({ stateRoot });
    const kept = store.put(id, 'text/plain', 'kept content');
    const path = join(stateRoot, 'attachments-v1', id, `${kept.id}.json`);
    const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    record.createdAt = 'not-a-real-date';
    writeFileSync(path, JSON.stringify(record));

    const currentMs = ATTACHMENT_TTL_MS * 10;
    new AttachmentStore({ stateRoot, now: () => new Date(currentMs) });

    expect(existsSync(path)).toBe(true);
  });

  it('exposes pruneExpired() as a callable escape hatch, not only a construction-time sweep', () => {
    const id = sessionId();
    let currentMs = 0;
    const store = new AttachmentStore({ stateRoot, now: () => new Date(currentMs) });
    const old = store.put(id, 'text/plain', 'old content');

    currentMs = ATTACHMENT_TTL_MS + 10_000;
    expect(store.get(id, old.id)).toBeDefined(); // still present -- no sweep has run since it aged out
    store.pruneExpired();
    expect(store.get(id, old.id)).toBeUndefined();
  });
});
