import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { draftArtifactKind, draftContentHash } from './application-critique.js';
import { APPLY_COPY_LIMITS, type ApplyCopyUnavailable, type ApplyCopyView } from './apply-copy-types.js';
import { currentDrafts, type DraftRecord } from './workspace/application-critique-store.js';
import type { WorkspaceDb } from './workspace/client.js';
import { getApplicationAttempt, listApplicationArtifacts } from './workspace/repository.js';
import type { ApplicationArtifactRecord } from './workspace/types.js';

/**
 * #660: the values a person retypes into an employer form, read from the prepared package itself.
 *
 * Everything returned is pinned to one staged document version. A value is offered ONLY when a
 * `current` #690 draft still hashes to its recorded content hash, its `artifactHash` names a staged
 * PDF of this very attempt, and the file on disk still has those bytes. Any mismatch hides the
 * whole document's values; nothing falls back to the live letter or the live CV source, which may
 * have been edited since preparation. Read-only: no write, no render, no model, no network.
 */

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** The letter body exactly as `renderLetterHtml` lays paragraphs out in the PDF: split on blank
 * lines, trimmed, joined with one blank line. The heading and the signature line the renderer may
 * add are not part of the body and are not copied. */
export function normalizeLetterBody(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .join('\n\n');
}

type Verified = { ok: true; artifact: ApplicationArtifactRecord } | { ok: false; reason: ApplyCopyUnavailable };

async function verifyDraft(draft: DraftRecord, artifacts: readonly ApplicationArtifactRecord[]): Promise<Verified> {
  if (draftContentHash(draft.content) !== draft.contentHash) return { ok: false, reason: 'changed' };
  const artifact = artifacts.find((row) => row.kind === draftArtifactKind(draft.kind) && row.contentHash === draft.artifactHash);
  if (!artifact) return { ok: false, reason: 'changed' };
  if (!artifact.storagePath) return { ok: false, reason: 'file_missing' };
  let bytes: Buffer;
  try {
    bytes = await readFile(artifact.storagePath);
  } catch {
    return { ok: false, reason: 'file_missing' };
  }
  if (sha256(bytes) !== artifact.contentHash) return { ok: false, reason: 'changed' };
  return { ok: true, artifact };
}

const clip = (value: string): string => value.trim().slice(0, APPLY_COPY_LIMITS.shortField);

export async function getApplyCopyFields(db: WorkspaceDb, attemptId: string): Promise<ApplyCopyView> {
  getApplicationAttempt(db, attemptId); // Throws WorkspaceNotFoundError for an unknown attempt.
  const artifacts = listApplicationArtifacts(db, attemptId);
  const drafts = currentDrafts(db, attemptId);

  const letters: ApplyCopyView['letters'] = [];
  let letterUnavailable: ApplyCopyUnavailable | null = null;
  if (artifacts.some((row) => row.kind === 'cover_letter_pdf')) {
    // A current letter draft that fails verification is reported even when another letter kind
    // verified, so a missing motivation letter is never silently dropped next to a cover letter.
    let failed: ApplyCopyUnavailable | null = null;
    for (const draft of drafts) {
      if (draft.content.type !== 'letter' || (draft.kind !== 'cover_letter' && draft.kind !== 'motivation_letter')) continue;
      const verdict = await verifyDraft(draft, artifacts);
      if (!verdict.ok) {
        failed ??= verdict.reason;
        continue;
      }
      const text = normalizeLetterBody(draft.content.body);
      if (text.length === 0 || text.length > APPLY_COPY_LIMITS.letterChars) {
        failed ??= 'changed';
        continue;
      }
      letters.push({ kind: draft.kind, text, version: draft.version, artifactHash: draft.artifactHash });
    }
    letterUnavailable = failed ?? (letters.length === 0 ? 'no_draft' : null);
  }

  let contact: ApplyCopyView['contact'] = null;
  let contactUnavailable: ApplyCopyUnavailable | null = null;
  if (artifacts.some((row) => row.kind === 'cv_pdf')) {
    const draft = drafts.find((row) => row.kind === 'cv' && row.content.type === 'cv');
    if (!draft || draft.content.type !== 'cv') {
      contactUnavailable = 'no_draft';
    } else {
      const verdict = await verifyDraft(draft, artifacts);
      if (!verdict.ok) {
        contactUnavailable = verdict.reason;
      } else {
        const source = draft.content.resume.contact;
        contact = {
          name: clip(source.name),
          email: clip(source.email),
          phone: clip(source.phone),
          location: clip(source.location),
          links: source.links
            .map(clip)
            .filter((link) => link.length > 0)
            .slice(0, APPLY_COPY_LIMITS.links),
          version: draft.version,
          artifactHash: draft.artifactHash,
        };
      }
    }
  }

  return { letters, letterUnavailable, contact, contactUnavailable };
}
