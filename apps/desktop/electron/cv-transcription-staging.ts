import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import type { ProviderId } from '@agent-dock/shared';

/**
 * Staging for issue #396's reviewed AI-transcription fallback: when `cv-text.ts`'s `readCvFile`
 * reports a scanned/image-only PDF, `main.ts` needs to hand that PDF's *bytes* to a provider as a
 * session attachment -- but the filesystem/IPC boundary this app keeps everywhere else (see
 * `main.ts`'s `ensureAiWorkspaceDir` and `workspace-grant.ts`) means the renderer must never see or
 * choose a real filesystem path. This module is the one place a picker-selected file's bytes are
 * copied into the app-owned AI workspace directory, keyed by an opaque, single-use id the renderer
 * is allowed to hold instead.
 *
 * `stageForTranscription` is only ever called from `cv:select-and-read`, and only *after* the
 * user has answered a native `dialog.showMessageBox` consent prompt (see
 * `workspace-confirm.ts`'s `buildCvTranscriptionConsentOptions`) -- never before, and never from
 * anything the renderer can trigger on its own. A candidate id therefore always represents a
 * decision the user has already made, not a capability waiting for one.
 *
 * Everything here is in-memory (main-process only, never persisted): a staged candidate that is
 * never consumed (a crash between staging and session creation, which should otherwise be near-
 * instantaneous -- see `daemon:create-session`) is cleaned up by `sweepStaleStagedAttachments`.
 */

export interface StagedCvAttachment {
  /** Always inside `<workspaceDir>/cv-transcription-staging/<candidateId>/`. */
  path: string;
  mimeType: string;
  /** The directory to remove (recursively) once this attachment is no longer needed. */
  dir: string;
  /** The provider the user consented to send this file to (issue #396's security review): pinned
   * at staging time from the same resolution the consent dialog named, so a session created from
   * this candidate cannot be redirected to a different provider than the one the user approved. */
  provider: ProviderId;
}

interface StagedEntry extends StagedCvAttachment {
  stagedAt: number;
}

const STAGING_SUBDIR = 'cv-transcription-staging';

/**
 * Backstop for a candidate that is staged but never consumed (a crash between the consent dialog
 * resolving and `daemon:create-session` running). Consumption now follows staging near-
 * instantaneously (both happen inside the same `cv:select-and-read` IPC call, before anything is
 * returned to the renderer), so this is a generous margin for that gap, not a "user thinking it
 * over" window the way a much longer value would be needed for. It is deliberately kept longer
 * than `main.ts`'s own `ATTACHMENT_CLEANUP_BACKSTOP_MS` (the per-session cleanup backstop once a
 * candidate *has* been consumed): that ordering means this sweep can never race a still-running,
 * already-consumed session's own cleanup -- the session-level backstop always fires first.
 */
const STALE_MS = 15 * 60 * 1000;

const staged = new Map<string, StagedEntry>();

function stagingRoot(workspaceDir: string): string {
  return join(workspaceDir, STAGING_SUBDIR);
}

/**
 * Copies `bytes` into a fresh, randomly-named subdirectory of the AI workspace and returns an
 * opaque candidate id for it. `fileName` is only used for the staged file's own name (cosmetic,
 * never read back) -- re-derived via `basename` here too, defense in depth against any future
 * caller that hands this function something other than the already-`basename`d name
 * `cv-text.ts`'s `readCvFile` produces today.
 */
export async function stageForTranscription(
  workspaceDir: string,
  fileName: string,
  bytes: Buffer,
  provider: ProviderId,
): Promise<string> {
  const candidateId = randomUUID();
  const dir = join(stagingRoot(workspaceDir), candidateId);
  await mkdir(dir, { recursive: true });
  const safeName = basename(fileName) || 'cv.pdf';
  const path = join(dir, safeName);
  await writeFile(path, bytes);
  staged.set(candidateId, { path, mimeType: 'application/pdf', dir, provider, stagedAt: Date.now() });
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
 * Startup/backstop sweep: removes every staged-attachment directory older than `STALE_MS` (or, with
 * `force`, every one of them regardless of age -- used on app shutdown). Guards against the one
 * case nothing else covers: a candidate staged but never consumed at all (a crash between staging
 * and the immediately-following `daemon:create-session` call -- see this module's own doc comment
 * on why that gap is now expected to be brief, not the "user thinking it over" window it once was).
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
    // `entry.name` is the candidateId `stageForTranscription` minted for this directory. Removed
    // from `staged` here too, not just from disk: otherwise a swept candidate's map entry survives
    // with a `path` pointing at a now-deleted directory, and `consumeStagedCvAttachment` would hand
    // it back as if still valid instead of correctly reporting it gone.
    if (opts.force) {
      staged.delete(entry.name);
      await cleanupStagedPath(dir);
      continue;
    }
    try {
      const info = await stat(dir);
      if (info.mtimeMs < cutoff) {
        staged.delete(entry.name);
        await cleanupStagedPath(dir);
      }
    } catch {
      // already gone
    }
  }
}
