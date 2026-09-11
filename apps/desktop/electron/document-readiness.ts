import type { DocumentArtifactKind, DocumentTarget } from './document-acceptance.js';

/**
 * Binds "this attempt's documents are ready" to the exact bytes an acceptance check actually
 * passed (#276's third and fourth acceptance cases).
 *
 * Two failure modes this exists for, both of which an artifact table alone does not prevent:
 *
 *  - **A requested document that never got produced.** A record can be present for the CV and
 *    absent for the cover letter the attempt asked for, and nothing in the row shape says the
 *    letter was ever wanted. Readiness therefore takes the requested set explicitly, and a
 *    requested document with no file refuses instead of quietly reporting ready on the rest.
 *  - **Bytes that changed after they were accepted.** An acceptance decision is about a specific
 *    sequence of bytes, not about a path. If the file at that path is re-rendered, edited or
 *    swapped afterwards, the earlier "validated" verdict describes a document that no longer
 *    exists. Comparing the hash recorded at acceptance time against one recomputed from what is on
 *    disk right now is what stops that verdict silently carrying over -- and is why the hash the
 *    attachment step uses is this same accepted hash, never one re-derived from the file it is
 *    about to upload.
 *
 * Pure, with no filesystem or database access of its own, matching `application-submit-gate.ts`'s
 * discipline: the caller reads the bytes and recomputes the hash, and gets back a plain verdict.
 */

export type DocumentReadinessRefusal =
  /** The attempt asked for this document and there is no file for it. */
  | 'requested_document_missing'
  /** A file exists but no acceptance decision was ever recorded against its bytes. */
  | 'document_never_accepted'
  /** The file on disk is no longer the file that was accepted. */
  | 'accepted_bytes_changed'
  /** The accepted document was produced for a different vacancy than this attempt. */
  | 'accepted_for_a_different_target';

export interface AcceptedDocument {
  kind: DocumentArtifactKind;
  /** sha256 of the bytes `acceptRenderedDocument` returned `ok` for. */
  acceptedContentHash: string;
  /** The vacancy this document was accepted for, or null for one with no target (a plain library
   * export). This is where a CV's target metadata lives: on the acceptance decision, never written
   * into the CV's own employment history to satisfy a substring check. */
  acceptedTarget: DocumentTarget | null;
}

export interface PresentDocument {
  kind: DocumentArtifactKind;
  /** Recomputed by the caller, now, from the bytes actually on disk. */
  currentContentHash: string;
}

export interface DocumentReadinessResult {
  ok: boolean;
  refusals: Array<{ reason: DocumentReadinessRefusal; kind: DocumentArtifactKind; detail: string }>;
  /** The accepted hash for each requested document, in the requested order. Empty unless `ok`.
   * The attachment/upload step uses these, so what gets sent is provably the reviewed document. */
  verifiedContentHashes: Array<{ kind: DocumentArtifactKind; contentHash: string }>;
}

export interface DocumentReadinessInput {
  /** What this attempt asked for, e.g. `['cv', 'cover_letter']`. */
  requested: readonly DocumentArtifactKind[];
  accepted: readonly AcceptedDocument[];
  present: readonly PresentDocument[];
  /** The vacancy the attempt itself records. */
  target: DocumentTarget | null;
}

/** A combined pack is one file that contains both documents, so it answers a request for either
 * half. Nothing else substitutes: a cover letter is not a motivation letter and neither is a CV. */
function satisfies(candidate: DocumentArtifactKind, requested: DocumentArtifactKind): boolean {
  if (candidate === requested) return true;
  return candidate === 'combined' && (requested === 'cv' || requested === 'cover_letter' || requested === 'motivation_letter');
}

function sameTarget(a: DocumentTarget | null, b: DocumentTarget | null): boolean {
  if (a === null || b === null) return a === b;
  return a.company.trim().toLowerCase() === b.company.trim().toLowerCase() && a.role.trim().toLowerCase() === b.role.trim().toLowerCase();
}

/**
 * Reports readiness for the whole requested set, collecting every refusal rather than stopping at
 * the first: a user told only that the CV is stale, then only that the letter is missing, has to
 * make two round trips to learn what is actually wrong with their application.
 */
export function checkDocumentReadiness(input: DocumentReadinessInput): DocumentReadinessResult {
  const refusals: DocumentReadinessResult['refusals'] = [];
  const verifiedContentHashes: DocumentReadinessResult['verifiedContentHashes'] = [];

  for (const requested of input.requested) {
    const present = input.present.find((document) => satisfies(document.kind, requested));
    if (present === undefined) {
      refusals.push({
        reason: 'requested_document_missing',
        kind: requested,
        detail: `this application asked for a ${requested.replaceAll('_', ' ')} and no file was produced for it`,
      });
      continue;
    }

    const accepted = input.accepted.find((document) => document.kind === present.kind);
    if (accepted === undefined) {
      refusals.push({
        reason: 'document_never_accepted',
        kind: requested,
        detail: `the ${present.kind.replaceAll('_', ' ')} file was never checked against the document acceptance contract`,
      });
      continue;
    }

    if (accepted.acceptedContentHash !== present.currentContentHash) {
      refusals.push({
        reason: 'accepted_bytes_changed',
        kind: requested,
        detail: `the ${present.kind.replaceAll('_', ' ')} file has changed since it was validated, so its earlier "checked" result no longer describes it`,
      });
      continue;
    }

    if (!sameTarget(accepted.acceptedTarget, input.target)) {
      refusals.push({
        reason: 'accepted_for_a_different_target',
        kind: requested,
        detail: `the ${present.kind.replaceAll('_', ' ')} was validated for a different vacancy than this application`,
      });
      continue;
    }

    verifiedContentHashes.push({ kind: requested, contentHash: accepted.acceptedContentHash });
  }

  if (refusals.length > 0) return { ok: false, refusals, verifiedContentHashes: [] };
  return { ok: true, refusals, verifiedContentHashes };
}
