import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { ApplicationTargetPolicy } from '@agent-dock/application-executor';
import * as workspace from './workspace/repository.js';
import type { WorkspaceDb } from './workspace/client.js';

/**
 * Artifact resolution for the file-upload half of the application bridge (#273).
 *
 * `application-review-session.ts` used to hand `validateFieldMap` a permanently empty
 * `ownedArtifactIds` array, so rule 5 (`artifact_not_owned`) refused every single `artifact`
 * assignment by construction -- an attempt could never attach even its own CV. This module is what
 * feeds that rule real data, and what re-verifies a resolved artifact against the bytes actually on
 * disk before the executor's own `attach` (whose MIME/size checks are unchanged) is ever called.
 *
 * The local file path never leaves the main process: `UploadReadyArtifact` is main-process-only and
 * only its `fileName`/`byteSize` are ever echoed back to the renderer, the same "main-owned native
 * selection, renderer metadata-only contract" rule #129's lifecycle design writes down. No refusal
 * detail below ever contains a path either -- an artifact is identified by its id and its own
 * recorded file name.
 */

export type ArtifactUploadRefusalReason =
  | 'artifact_not_owned'
  | 'artifact_not_staged'
  | 'artifact_outside_attempt_staging'
  | 'artifact_too_large'
  | 'artifact_mime_not_allowed'
  | 'artifact_file_unreadable'
  | 'artifact_content_changed';

/** A staged artifact that has passed every ownership, integrity, and policy check, ready to hand
 * to `ApplicationExecutor.attach`. Main-process only -- `localFilePath` must never cross IPC. */
export interface UploadReadyArtifact {
  artifactId: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  localFilePath: string;
}

export interface ResolveUploadArtifactResult {
  ok: boolean;
  reason?: ArtifactUploadRefusalReason;
  detail?: string;
  /** Present only when `ok` is true. */
  file?: UploadReadyArtifact;
}

/**
 * Every artifact id registered against `attemptId`, and nothing else -- the real set
 * `validateFieldMap`'s rule 5 was always meant to be given. Ownership is the query itself:
 * `listApplicationArtifacts` is scoped by `attemptId` in SQL, so another attempt's artifact id is
 * absent from this set rather than filtered out of it afterwards.
 *
 * Deliberately includes artifacts that are registered but not usable (never staged to disk, bytes
 * since changed, oversized for this target): those are not ownership failures, and collapsing them
 * into one would report "this artifact belongs to another attempt" about an attempt's own CV.
 * `resolveUploadArtifact` below is where each of those gets its own specific refusal.
 */
export function listOwnedArtifactIds(db: WorkspaceDb, attemptId: string): string[] {
  return workspace.listApplicationArtifacts(db, attemptId).map((artifact) => artifact.id);
}

/**
 * Whether `storagePath` sits in `attemptId`'s own staging directory, the layout
 * `application-artifact-staging.ts`'s `stagedArtifactPath` always produces
 * (`<storageRoot>/<attemptId>/<contentHash>-<fileName>`).
 *
 * This is the structural half of #273's "a retry ... never coincidentally grabs the newest file in
 * a Downloads folder" requirement: a path is only ever usable here because a staging write put it
 * under this exact attempt's own folder, never because it happened to be the freshest file in some
 * ambient location. Compared against the parent directory's own name rather than a configured
 * storage root so it holds regardless of where `app.getPath('userData')` resolves on a given
 * machine, and so no caller can widen it by passing a different root.
 */
export function isStagedUnderAttempt(storagePath: string, attemptId: string): boolean {
  return basename(dirname(storagePath)) === attemptId;
}

function refuse(reason: ArtifactUploadRefusalReason, detail: string): ResolveUploadArtifactResult {
  return { ok: false, reason, detail };
}

/**
 * Resolves one `artifactId` to a file the executor may actually attach, or refuses with a specific
 * reason. Checked in this order, cheapest and most structural first, so nothing is ever read off
 * disk for an artifact that was going to be refused anyway:
 *
 * 1. ownership -- the artifact must be registered against this exact attempt (#196 §2.4 rule 5);
 * 2. staging -- it must have a real staged file with a real name, not a bare manifest row;
 * 3. location -- that file must live under this attempt's own staging folder (see
 *    `isStagedUnderAttempt`);
 * 4. the target's own upload constraints, from the artifact's recorded size/type;
 * 5. readability -- a file that has since been moved or deleted refuses here, never at upload time;
 * 6. integrity -- the bytes on disk must still hash to exactly what was registered at staging time.
 *
 * Step 6 is a full re-hash on every call rather than a cached or mtime-based check: the whole point
 * is to catch content that changed *since* staging, and a cheaper signal is exactly the one an
 * edited-in-place file defeats. Artifacts here are single-digit-megabyte PDFs bounded by both
 * `APPLICATION_ARTIFACT_QUOTA` and the policy's own `maxBytes`, so this reads a bounded amount.
 *
 * Steps 4's checks are deliberately a duplicate of the ones `ApplicationExecutor.attach` performs
 * for itself: that method is the last line of defense and stays exactly as it is, but refusing here
 * first is what lets a caller report *which* artifact was wrong, and why, before any CDP call.
 */
export async function resolveUploadArtifact(
  db: WorkspaceDb,
  attemptId: string,
  artifactId: string,
  policy: ApplicationTargetPolicy,
): Promise<ResolveUploadArtifactResult> {
  const record = workspace.listApplicationArtifacts(db, attemptId).find((artifact) => artifact.id === artifactId);
  if (!record) return refuse('artifact_not_owned', `artifact ${artifactId} is not registered against this attempt`);

  if (record.storagePath.length === 0 || record.fileName.length === 0) {
    return refuse('artifact_not_staged', `artifact ${artifactId} has no staged file to attach`);
  }
  if (!isStagedUnderAttempt(record.storagePath, attemptId)) {
    return refuse('artifact_outside_attempt_staging', `artifact ${artifactId} is not staged under this attempt's own folder`);
  }

  const { maxBytes, mimeTypes } = policy.uploadConstraints;
  if (record.byteSize > maxBytes) {
    return refuse('artifact_too_large', `artifact ${artifactId} (${record.byteSize} bytes) exceeds target policy "${policy.id}"'s ${maxBytes}-byte limit`);
  }
  if (!mimeTypes.includes(record.mimeType)) {
    return refuse('artifact_mime_not_allowed', `artifact ${artifactId}'s type "${record.mimeType}" is not accepted by target policy "${policy.id}"`);
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(record.storagePath);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // The message can name the path the read failed on, which must not cross IPC -- report only
    // which artifact it was. The full reason stays in this process's own log.
    console.warn('[application-executor] a staged artifact could not be read', { attemptId, artifactId, detail });
    return refuse('artifact_file_unreadable', `artifact ${artifactId}'s staged file could not be read`);
  }

  if (bytes.byteLength !== record.byteSize) {
    return refuse('artifact_content_changed', `artifact ${artifactId} is ${bytes.byteLength} bytes on disk, ${record.byteSize} when it was staged`);
  }
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  if (contentHash !== record.contentHash) {
    return refuse('artifact_content_changed', `artifact ${artifactId}'s bytes no longer match the hash recorded when it was staged`);
  }

  return {
    ok: true,
    file: {
      artifactId: record.id,
      fileName: record.fileName,
      mimeType: record.mimeType,
      byteSize: record.byteSize,
      localFilePath: record.storagePath,
    },
  };
}
