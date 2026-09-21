import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Staging for issue #396's reviewed AI-transcription fallback: when `cv-text.ts`'s `readCvFile`
 * reports a scanned/image-only PDF, `main.ts` needs to hand that PDF's *bytes* to a provider as a
 * session attachment -- but the filesystem/IPC boundary this app keeps everywhere else (see
 * `main.ts`'s `ensureAiWorkspaceDir` and `workspace-grant.ts`) means the renderer must never see or
 * choose a real filesystem path. This module is the one place a picker-selected file's bytes are
 * copied into the app-owned AI workspace directory, keyed by an opaque, single-use id the renderer
 * is allowed to hold instead.
 *
 * Everything here is in-memory (main-process only, never persisted): a staged candidate that is
 * never consumed (the user closes the consent prompt, picks a different file, or the app crashes)
 * is cleaned up by `sweepStaleStagedAttachments`, not by anything the renderer can trigger.
 */

export interface StagedCvAttachment {
  /** Always inside `<workspaceDir>/cv-transcription-staging/<candidateId>/`. */
  path: string;
  mimeType: string;
  /** The directory to remove (recursively) once this attachment is no longer needed. */
  dir: string;
}

interface StagedEntry extends StagedCvAttachment {
  stagedAt: number;
}

const STAGING_SUBDIR = 'cv-transcription-staging';

/**
 * Generous for a user who leaves the consent prompt open while they think it over, short enough
 * that a crash between staging and either consuming or discarding a candidate cannot leave a real
 * CV's bytes on disk indefinitely.
 */
const STALE_MS = 15 * 60 * 1000;

const staged = new Map<string, StagedEntry>();

function stagingRoot(workspaceDir: string): string {
  return join(workspaceDir, STAGING_SUBDIR);
}

/**
 * Copies `bytes` into a fresh, randomly-named subdirectory of the AI workspace and returns an
 * opaque candidate id for it. `fileName` is only used for the staged file's own name (cosmetic,
 * never read back) -- it is never derived from or compared against the original path.
 */
export async function stageForTranscription(
  workspaceDir: string,
  fileName: string,
  bytes: Buffer,
): Promise<string> {
  const candidateId = randomUUID();
  const dir = join(stagingRoot(workspaceDir), candidateId);
  await mkdir(dir, { recursive: true });
  const path = join(dir, fileName);
  await writeFile(path, bytes);
  staged.set(candidateId, { path, mimeType: 'application/pdf', dir, stagedAt: Date.now() });
  return candidateId;
}

/**
 * One-shot lookup: removes and returns the entry, or `undefined` if the id is unknown, already
 * consumed, or was swept as stale. Single-use so a candidate id cannot be replayed to attach the
 * same staged file to more than one session.
 */
export function consumeStagedCvAttachment(candidateId: string): StagedCvAttachment | undefined {
  const entry = staged.get(candidateId);
  if (!entry) return undefined;
  staged.delete(candidateId);
  return entry;
}

/** Best-effort recursive delete. Never throws: cleanup racing an already-removed directory (a
 * concurrent sweep, a prior call for the same id) is not a failure worth surfacing. */
export async function cleanupStagedPath(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Discards a staged candidate that will never be used (e.g. the user declined the consent prompt,
 * or picked a different file instead). No-op if the id is unknown or already consumed.
 */
export async function discardStagedCvAttachment(candidateId: string): Promise<void> {
  const entry = staged.get(candidateId);
  staged.delete(candidateId);
  if (entry) await cleanupStagedPath(entry.dir);
}

/**
 * Startup/backstop sweep: removes every staged-attachment directory older than `STALE_MS` (or, with
 * `force`, every one of them regardless of age -- used on app shutdown). Guards against the case
 * nothing else covers: a candidate staged but never consumed or explicitly discarded at all (the
 * user simply walked away from the prompt, or the app crashed before either could run).
 */
export async function sweepStaleStagedAttachments(workspaceDir: string, opts: { force?: boolean } = {}): Promise<void> {
  const root = stagingRoot(workspaceDir);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_MS;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    if (opts.force) {
      await cleanupStagedPath(dir);
      continue;
    }
    try {
      const info = await stat(dir);
      if (info.mtimeMs < cutoff) await cleanupStagedPath(dir);
    } catch {
      // already gone
    }
  }
}
