import { createHash } from 'node:crypto';
import { reportedBaseName, stagedArtifactFileName } from './application-artifact-naming.js';
import type { DraftKind } from './application-critique-types.js';
import type { PreparedApplicationFields } from './workspace/types.js';

/**
 * #691: the record of which documents went with one recorded submission, as pure functions.
 *
 * Two questions kept apart on purpose:
 *  - Was an application sent? `submission.evidence`: `receipt` (this app observed a confirmation or a
 *    receipt reference, #271), `user_reported` (the person said so), or `none` (nothing recorded).
 *  - Which document went with it? Per document `provenance`:
 *     `prepared`        this app prepared it for this application. Nobody has said it was the file sent.
 *     `user_confirmed`  the person said this exact version is what they sent (or supplied the text).
 *     `receipt_backed`  this app sent the application itself, attached this file (its own form-fill
 *                       record names the file) and then observed a receipt. The receipt confirms the
 *                       application landed; it does not contain or prove the file's bytes.
 *     `unknown`         the person said they do not know, or sent something this app cannot name.
 *
 * Nothing here infers a confirmation: generated, accepted or exported files are `prepared` until a
 * person or a receipt says otherwise, and a person's statement never overwrites a receipt-backed file.
 */

export const PACKAGE_SCHEMA_VERSION = 1;

export const PACKAGE_SLOTS = ['cv', 'letter'] as const;
export type PackageSlot = (typeof PACKAGE_SLOTS)[number];

export const DOCUMENT_PROVENANCES = ['prepared', 'user_confirmed', 'receipt_backed', 'unknown'] as const;
export type DocumentProvenance = (typeof DOCUMENT_PROVENANCES)[number];

/** Where the document's text comes from. Only `person_text` and `linked_copy` carry text in the manifest. */
export const DOCUMENT_SOURCES = ['draft', 'artifact_only', 'person_text', 'linked_copy', 'none'] as const;
export type DocumentSource = (typeof DOCUMENT_SOURCES)[number];

export const SUBMISSION_EVIDENCE = ['receipt', 'user_reported', 'none'] as const;
export type SubmissionEvidence = (typeof SUBMISSION_EVIDENCE)[number];

export interface PackageDocument {
  slot: PackageSlot;
  /** The draft kind (cv, cover_letter, motivation_letter), or null when unknown. */
  kind: DraftKind | null;
  provenance: DocumentProvenance;
  source: DocumentSource;
  draftId: string | null;
  draftVersion: number | null;
  /** The draft's content hash (`draft`), or sha256 of `text` (`person_text` / `linked_copy`). */
  contentHash: string | null;
  artifactId: string | null;
  artifactHash: string | null;
  fileName: string | null;
  /** Only for `person_text` / `linked_copy`. */
  text: string | null;
  /** When the person made the statement this entry rests on (null for entries bound by the submission). */
  statedAt: string | null;
}

export interface PackageManifestContent {
  schema: number;
  submission: {
    evidence: SubmissionEvidence;
    receiptId: string | null;
    /** The receipt's evidence kind (confirmation_page, receipt_reference, delivery_receipt, user_statement). */
    receiptKind: string | null;
    recordedAt: string | null;
  };
  requisition: {
    employerKey: string;
    requisitionId: string | null;
    canonicalUrlKey: string;
    company: string;
    role: string;
  };
  posting: { jdHash: string | null; jdComplete: boolean | null };
  candidate: {
    sourceCvId: string | null;
    sourceCvHash: string | null;
    reviewedEvidenceHash: string | null;
    /** Where the reviewed-evidence hash was taken: the #690 review fence, or the source CV at binding. */
    reviewedEvidenceFrom: 'review' | 'submission' | null;
  };
  documents: PackageDocument[];
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function manifestHash(content: PackageManifestContent): string {
  return sha256Hex(stable(content));
}

export function slotOfKind(kind: DraftKind): PackageSlot {
  return kind === 'cv' ? 'cv' : 'letter';
}

/* -------------------------------------------------------------------- binding at submission ----- */

export interface BindDraft {
  id: string;
  kind: DraftKind;
  version: number;
  contentHash: string;
  artifactHash: string;
}
export interface BindArtifact {
  id: string;
  kind: 'cv_pdf' | 'cover_letter_pdf' | 'combined_pdf' | 'other';
  fileName: string;
  contentHash: string;
}
export interface BindReceipt {
  id: string;
  outcome: 'submitted' | 'rejected' | 'unknown' | 'user_reported';
  evidenceKind: string;
  observedAt: string;
}
export interface BindAttempt {
  employerKey: string;
  requisitionId: string | null;
  canonicalUrlKey: string;
  company: string;
  role: string;
  jdSnapshotHash: string;
  jdComplete: boolean;
  sourceCvId: string | null;
  sourceCvContentHash: string;
  completionEvidence: 'user_reported' | 'receipt_confirmed' | null;
  preparedFields: PreparedApplicationFields | null;
}

export interface BindInput {
  attempt: BindAttempt;
  /** The drafts that were current when the submission was recorded. */
  drafts: readonly BindDraft[];
  artifacts: readonly BindArtifact[];
  receipts: readonly BindReceipt[];
  reviewedEvidence: { hash: string; from: 'review' | 'submission' } | null;
  /** The previous manifest of this attempt, so a person's earlier statement is carried forward. */
  previous: PackageManifestContent | null;
}

/**
 * The file names this app's own form fill recorded as attached (#272/#273), reduced to their base name.
 *
 * What a committed file field holds is what the page's file input reported after the upload, which is
 * the STAGED name (`<contentHash>-<fileName>`, see `stagedArtifactFileName`), possibly behind a
 * `C:\fakepath\` or other directory prefix. Both separators are stripped, so the same file compares
 * equal on every platform. A name the review session had to truncate simply never matches.
 */
export function attachedFileNames(fields: PreparedApplicationFields | null): Set<string> {
  const names = new Set<string>();
  for (const field of fields?.fields ?? []) {
    if (field.controlType === 'file' && field.status === 'committed' && field.value) names.add(reportedBaseName(field.value));
  }
  return names;
}

/** True when the form-fill record names this exact artifact (its content hash AND file name) as attached. */
function wasAttached(attached: ReadonlySet<string>, artifact: BindArtifact): boolean {
  return attached.has(stagedArtifactFileName(artifact.contentHash, artifact.fileName));
}

function submissionOf(input: BindInput): PackageManifestContent['submission'] {
  const ordered = [...input.receipts].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  const observed = ordered.find((receipt) => receipt.outcome === 'submitted');
  if (observed) {
    return { evidence: 'receipt', receiptId: observed.id, receiptKind: observed.evidenceKind, recordedAt: observed.observedAt };
  }
  const reported = ordered.find((receipt) => receipt.outcome === 'user_reported');
  if (reported) {
    return { evidence: 'user_reported', receiptId: reported.id, receiptKind: reported.evidenceKind, recordedAt: reported.observedAt };
  }
  // A completion the person asserted without a receipt row (a renderer status patch): still their word.
  if (input.attempt.completionEvidence === 'user_reported') {
    return { evidence: 'user_reported', receiptId: null, receiptKind: null, recordedAt: null };
  }
  return { evidence: 'none', receiptId: null, receiptKind: null, recordedAt: null };
}

const PERSON_PROVENANCE: readonly DocumentProvenance[] = ['user_confirmed', 'unknown'];

export function buildSubmissionManifest(input: BindInput): PackageManifestContent {
  const submission = submissionOf(input);
  const attached = attachedFileNames(input.attempt.preparedFields);
  const documents: PackageDocument[] = [];

  for (const slot of PACKAGE_SLOTS) {
    const earlier = input.previous?.documents.find((doc) => doc.slot === slot) ?? null;
    const draft = input.drafts.find((candidate) => slotOfKind(candidate.kind) === slot) ?? null;
    const artifactKinds = slot === 'cv' ? ['cv_pdf', 'combined_pdf'] : ['cover_letter_pdf'];
    const artifact = draft
      ? (input.artifacts.find((candidate) => candidate.contentHash === draft.artifactHash) ?? null)
      : (input.artifacts.find((candidate) => artifactKinds.includes(candidate.kind)) ?? null);
    const receiptBacked = submission.evidence === 'receipt' && artifact !== null && wasAttached(attached, artifact);

    // A person's earlier statement stands unless this app now holds a receipt for its own attached file.
    if (earlier && PERSON_PROVENANCE.includes(earlier.provenance) && !receiptBacked) {
      documents.push(earlier);
      continue;
    }
    if (!draft && !artifact) {
      if (earlier) documents.push(earlier);
      continue;
    }
    documents.push({
      slot,
      kind: draft?.kind ?? (slot === 'cv' ? 'cv' : null),
      provenance: receiptBacked ? 'receipt_backed' : 'prepared',
      source: draft ? 'draft' : 'artifact_only',
      draftId: draft?.id ?? null,
      draftVersion: draft?.version ?? null,
      contentHash: draft?.contentHash ?? null,
      artifactId: artifact?.id ?? null,
      artifactHash: artifact?.contentHash ?? draft?.artifactHash ?? null,
      fileName: artifact?.fileName ?? null,
      text: null,
      statedAt: null,
    });
  }

  return {
    schema: PACKAGE_SCHEMA_VERSION,
    submission,
    requisition: {
      employerKey: input.attempt.employerKey,
      requisitionId: input.attempt.requisitionId,
      canonicalUrlKey: input.attempt.canonicalUrlKey,
      company: input.attempt.company,
      role: input.attempt.role,
    },
    posting: { jdHash: input.attempt.jdSnapshotHash || null, jdComplete: input.attempt.jdComplete },
    candidate: {
      sourceCvId: input.attempt.sourceCvId,
      sourceCvHash: input.attempt.sourceCvContentHash || null,
      reviewedEvidenceHash: input.reviewedEvidence?.hash ?? null,
      reviewedEvidenceFrom: input.reviewedEvidence?.from ?? null,
    },
    documents,
  };
}

/* ---------------------------------------------------------------------- a person's statement ----- */

export const STATEMENT_CHOICES = ['prepared_file', 'supplied_text', 'linked_document', 'unknown'] as const;
export type StatementChoice = (typeof STATEMENT_CHOICES)[number];

export interface DocumentStatement {
  slot: PackageSlot;
  choice: StatementChoice;
  /** `supplied_text`: the text the person pasted. `linked_document`: the library text the main process read. */
  text?: string;
  /** `linked_document` / `supplied_text` letters: the letter type, when known. */
  kind?: DraftKind | null;
}

export type StatementRefusal =
  | 'receipt_backed'
  | 'nothing_prepared'
  | 'text_required';

export type ApplyStatementsResult =
  | { ok: true; content: PackageManifestContent }
  | { ok: false; code: StatementRefusal; slot: PackageSlot };

/**
 * Applies what the person said about each document to a manifest, returning the next version's content.
 * `prepared_file` can only confirm a document this app actually holds for this application (`prepared`).
 */
export function applyStatements(
  base: PackageManifestContent,
  statements: readonly DocumentStatement[],
  now: string,
  /** The documents this app holds for the application (what `prepared_file` may confirm). */
  prepared: readonly PackageDocument[] = base.documents,
): ApplyStatementsResult {
  const documents = [...base.documents];
  for (const statement of statements) {
    const index = documents.findIndex((doc) => doc.slot === statement.slot);
    const current = index >= 0 ? documents[index]! : null;
    if (current?.provenance === 'receipt_backed') return { ok: false, code: 'receipt_backed', slot: statement.slot };
    let next: PackageDocument;
    switch (statement.choice) {
      case 'prepared_file': {
        const held = prepared.find((doc) => doc.slot === statement.slot && (doc.source === 'draft' || doc.source === 'artifact_only'));
        if (!held) return { ok: false, code: 'nothing_prepared', slot: statement.slot };
        next = { ...held, provenance: 'user_confirmed', statedAt: now };
        break;
      }
      case 'supplied_text':
      case 'linked_document': {
        const text = statement.text?.trim() ?? '';
        if (!text) return { ok: false, code: 'text_required', slot: statement.slot };
        next = {
          slot: statement.slot,
          kind: statement.kind ?? (statement.slot === 'cv' ? 'cv' : null),
          provenance: 'user_confirmed',
          source: statement.choice === 'supplied_text' ? 'person_text' : 'linked_copy',
          draftId: null,
          draftVersion: null,
          contentHash: sha256Hex(text),
          artifactId: null,
          artifactHash: null,
          fileName: null,
          text,
          statedAt: now,
        };
        break;
      }
      case 'unknown': {
        next = {
          slot: statement.slot,
          kind: current?.kind ?? (statement.slot === 'cv' ? 'cv' : null),
          provenance: 'unknown',
          source: 'none',
          draftId: null,
          draftVersion: null,
          contentHash: null,
          artifactId: null,
          artifactHash: null,
          fileName: null,
          text: null,
          statedAt: now,
        };
        break;
      }
    }
    if (index >= 0) documents[index] = next;
    else documents.push(next);
  }
  documents.sort((a, b) => PACKAGE_SLOTS.indexOf(a.slot) - PACKAGE_SLOTS.indexOf(b.slot));
  return { ok: true, content: { ...base, documents } };
}

/** An empty manifest for an Applications row with no attempt: only the person's statements fill it. */
export function emptyRowManifest(row: { company: string; role: string }): PackageManifestContent {
  return {
    schema: PACKAGE_SCHEMA_VERSION,
    submission: { evidence: 'none', receiptId: null, receiptKind: null, recordedAt: null },
    requisition: { employerKey: '', requisitionId: null, canonicalUrlKey: '', company: row.company, role: row.role },
    posting: { jdHash: null, jdComplete: null },
    candidate: { sourceCvId: null, sourceCvHash: null, reviewedEvidenceHash: null, reviewedEvidenceFrom: null },
    documents: [],
  };
}

/** True when two manifests say the same thing (used to keep re-binding idempotent). */
export function sameManifest(a: PackageManifestContent, b: PackageManifestContent): boolean {
  return manifestHash(a) === manifestHash(b);
}
