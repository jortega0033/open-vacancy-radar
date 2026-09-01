import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Crash-safe filesystem primitives for the durable session store.
 *
 * Everything here is **synchronous**, on purpose and not as an oversight. The store's whole
 * correctness argument rests on there being no `await` between "we decided to record this" and
 * "it is recorded" -- an async gap is a window in which the daemon can exit, a second write can
 * interleave, or a caller can observe a half-updated store. Synchronous IO on a local file, for
 * records measured in kilobytes, is a few hundred microseconds; that cost buys an invariant that
 * would otherwise need a lock manager to recover.
 *
 * Ported in shape from upstream AgentDock's durable-store primitives (write-temp/fsync/rename/
 * fsync-parent, the quarantine-never-delete rule); the containment guard and the short-write loop
 * are this repo's own. See docs/adr-agentdock-v2-provenance.md#adi-05.
 */

/**
 * Errors a directory fsync can legitimately raise on Windows, where a directory is not an openable
 * file in the POSIX sense at all.
 *
 * This list is applied **only** on win32. On every other platform a failing directory fsync is
 * rethrown, because there it means the durability barrier this function exists to place did not get
 * placed -- and silently swallowing that would turn "the rename is durable" into an unverified
 * claim. Windows genuinely cannot offer the barrier; that is a documented platform limitation
 * (NTFS orders metadata operations through its own journal), not an error to hide elsewhere.
 */
const WINDOWS_DIR_FSYNC_TOLERATED = new Set(['EACCES', 'EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM']);

/**
 * Opens `dirPath` read-only and fsyncs it, so a preceding `rename`/`create` is durable in the
 * *directory entry*, not merely in the file's own data. Without this a crash can leave a renamed
 * file invisible even though its contents were fsynced.
 */
export function syncDirectory(dirPath: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dirPath, constants.O_RDONLY);
    fsyncSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (process.platform === 'win32' && WINDOWS_DIR_FSYNC_TOLERATED.has(code)) return;
    throw err;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Closing a descriptor we are done with cannot fail in a way the caller can act on.
      }
    }
  }
}

/**
 * Defense-in-depth containment guard, called before every rename and unlink the store issues.
 *
 * Every path the store builds is composed from values it validated itself (a UUID, a fixed
 * directory name), so in principle none of them can escape the store root. This asserts that
 * anyway, because "in principle" is doing a lot of work in a module whose operations are
 * `renameSync` and `unlinkSync`: one future call site that interpolates an id read back off disk
 * -- from a record another process could have written -- is all it takes, and the guard costs a
 * string comparison. It throws rather than returning a boolean so a caller cannot forget to check.
 */
export function assertContainedIn(root: string, target: string): void {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedRoot, resolvedTarget);
  const contained = rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
  if (!contained) {
    throw new Error(`refusing to operate on ${resolvedTarget}: it is outside the store root ${resolvedRoot}`);
  }
}

/**
 * Atomically replaces `filePath` with the JSON encoding of `value`.
 *
 * The sequence is the standard durable-replace dance, and the order matters at every step:
 *
 * 1. `open(tmp, 'wx', 0600)` -- `wx` fails rather than truncating if the temp name somehow exists,
 *    and the temp name embeds both the pid and a UUID so two writers (or two writes from one
 *    process) can never pick the same one.
 * 2. `write` then `fsync` -- the *contents* are on stable storage before anything points at them.
 * 3. `close`, then `rename` -- rename is atomic within a filesystem, so a reader at any instant
 *    sees either the entire old file or the entire new one, never a partial write. This is why the
 *    store never needs a lock file for readers.
 * 4. `fsync` the containing directory -- makes the rename itself durable (see `syncDirectory`).
 *
 * If anything throws before the rename, the temp file is removed in `finally`. If the rename
 * succeeded, the temp name no longer exists and the cleanup is a no-op.
 */
export function atomicWriteJson(filePath: string, value: unknown): void {
  const directory = dirname(filePath);
  const tmpPath = join(directory, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);

  let renamed = false;
  let fd: number | undefined;
  try {
    fd = openSync(tmpPath, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    renameSync(tmpPath, filePath);
    renamed = true;

    syncDirectory(directory);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing actionable: the temp cleanup below is what matters.
      }
    }
    if (!renamed) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Best-effort, and deliberately silent even for a non-ENOENT failure. This runs in a
        // `finally` that may be unwinding a real error from the write above, and throwing here
        // would replace that error with a far less useful one about a temp file. A temp that
        // survives is not lost state either -- it is quarantined on the next startup (see
        // `SessionLineageStore`'s stray-temp sweep), which is exactly where it belongs.
      }
    }
  }
}

/**
 * Appends one line to `filePath`, durably.
 *
 * `O_APPEND` is what makes this safe without a lock: the kernel resolves the write offset and the
 * write itself as one operation, so an appended line is never interleaved into the middle of
 * another. `O_NOFOLLOW` refuses to follow a symlink at the final path component, so a pre-staged
 * symlink cannot redirect the store's appends somewhere else. `O_CREAT` with 0600 covers the
 * first write to a session's log.
 *
 * The write is a loop, not a single `writeSync`: a short write is rare but entirely legal
 * (a signal arriving mid-write, a pipe-like target), and a single call that silently wrote 4 KB of
 * a 6 KB line would leave a torn record in an append-only log that has no way to go back and fix
 * it. The loop is the difference between "torn tail recovered on next startup" and "torn tail
 * written by us on purpose".
 */
export function appendDurably(filePath: string, line: string): void {
  const directory = dirname(filePath);
  const isFirstWrite = !existsSync(filePath);
  const payload = Buffer.from(`${line}\n`, 'utf8');

  let fd: number | undefined;
  try {
    fd = openSync(
      filePath,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );

    let written = 0;
    while (written < payload.length) {
      const n = writeSync(fd, payload, written, payload.length - written);
      if (n <= 0) throw new Error(`append to ${filePath} made no progress after ${written} bytes`);
      written += n;
    }

    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }

  // Only the first append creates a directory entry; later ones only change an existing file's
  // length, which the file's own fsync above already covers.
  if (isFirstWrite) syncDirectory(directory);
}

/** Characters allowed in the `reason` component of a quarantined filename. */
const QUARANTINE_REASON_PATTERN = /[^a-z0-9_-]+/gi;

/**
 * Moves a corrupt file or directory into `quarantineDir` instead of deleting it.
 *
 * Never deletes, ever, and that is the entire point. Corruption in this store is by definition
 * something the daemon did not understand, and "did not understand" is not the same as "is
 * worthless" -- it may be the only remaining evidence of what a session did, and it is exactly what
 * a bug report needs attached. The quarantined name keeps the original basename (so a human can
 * tell what it was), adds a UUID (so repeated quarantines of the same name never collide), and
 * encodes the reason (so the directory listing itself explains what happened).
 */
export function quarantine(filePath: string, quarantineDir: string, reason: string): string {
  mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
  const safeReason = reason.replace(QUARANTINE_REASON_PATTERN, '-').slice(0, 64) || 'unknown';
  const target = join(quarantineDir, `${basename(filePath)}.${randomUUID()}.${safeReason}`);
  assertContainedIn(quarantineDir, target);
  renameSync(filePath, target);
  syncDirectory(quarantineDir);
  return target;
}
