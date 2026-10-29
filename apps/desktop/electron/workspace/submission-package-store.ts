import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq } from 'drizzle-orm';
import { reviewedCvEvidenceHash } from '../application-critique.js';
import {
  buildSubmissionManifest,
  manifestHash,
  sameManifest,
  sha256Hex,
  type BindInput,
  type PackageManifestContent,
} from '../submitted-package.js';
import type { WorkspaceDb } from './client.js';
import {
  applicationArtifacts,
  applicationAttempts,
  applicationCritiques,
  applicationDocumentDrafts,
  applicationSubmissionPackages,
  applicationSubmissionReceipts,
} from './schema.js';
import type { CvDocumentRecord } from './types.js';

/**
 * Persistence for #691's submission package manifests. Rows are INSERT-ONLY: appending a version marks
 * the previous `current` row of the same subject `superseded` and never edits its content. Every write
 * runs inside the caller's transaction (the repository binds a manifest in the same transaction that
 * records the submission checkpoint, so one can never exist without the other).
 */

type Tx = Pick<WorkspaceDb, 'select' | 'insert' | 'update' | 'delete'>;
type Row = typeof applicationSubmissionPackages.$inferSelect;

export interface SubmissionPackageRecord {
  id: string;
  subjectKey: string;
  attemptId: string | null;
  applicationId: string | null;
  version: number;
  status: 'current' | 'superseded';
  boundBy: 'submission' | 'person';
  manifest: PackageManifestContent;
  manifestHash: string;
  createdAt: string;
  supersededAt: string | null;
}

function toRecord(row: Row): SubmissionPackageRecord {
  return {
    id: row.id,
    subjectKey: row.subjectKey,
    attemptId: row.attemptId,
    applicationId: row.applicationId,
    version: row.version,
    status: row.status,
    boundBy: row.boundBy,
    manifest: row.manifest,
    manifestHash: row.manifestHash,
    createdAt: row.createdAt.toISOString(),
    supersededAt: row.supersededAt ? row.supersededAt.toISOString() : null,
  };
}

export const attemptSubject = (attemptId: string): string => `attempt:${attemptId}`;
export const applicationSubject = (applicationId: string): string => `application:${applicationId}`;

export function listPackageVersions(db: Pick<WorkspaceDb, 'select'>, subjectKey: string): SubmissionPackageRecord[] {
  return db
    .select()
    .from(applicationSubmissionPackages)
    .where(eq(applicationSubmissionPackages.subjectKey, subjectKey))
    .orderBy(asc(applicationSubmissionPackages.version))
    .all()
    .map(toRecord);
}

export function currentPackage(db: Pick<WorkspaceDb, 'select'>, subjectKey: string): SubmissionPackageRecord | null {
  const row = db
    .select()
    .from(applicationSubmissionPackages)
    .where(and(eq(applicationSubmissionPackages.subjectKey, subjectKey), eq(applicationSubmissionPackages.status, 'current')))
    .orderBy(desc(applicationSubmissionPackages.version))
    .get();
  return row ? toRecord(row) : null;
}

/** The first manifest the submission itself bound for an attempt: what this app held when it was sent. */
export function submissionBoundPackage(db: Pick<WorkspaceDb, 'select'>, attemptId: string): SubmissionPackageRecord | null {
  const row = db
    .select()
    .from(applicationSubmissionPackages)
    .where(
      and(
        eq(applicationSubmissionPackages.subjectKey, attemptSubject(attemptId)),
        eq(applicationSubmissionPackages.boundBy, 'submission'),
      ),
    )
    .orderBy(asc(applicationSubmissionPackages.version))
    .get();
  return row ? toRecord(row) : null;
}

export interface AppendPackageInput {
  subjectKey: string;
  attemptId: string | null;
  applicationId: string | null;
  boundBy: 'submission' | 'person';
  manifest: PackageManifestContent;
  now: Date;
}

export function appendPackageVersion(tx: Tx, input: AppendPackageInput): SubmissionPackageRecord {
  if ((input.attemptId === null) === (input.applicationId === null)) {
    throw new Error('a submission package belongs to exactly one attempt or one application row');
  }
  const existing = tx
    .select({ version: applicationSubmissionPackages.version })
    .from(applicationSubmissionPackages)
    .where(eq(applicationSubmissionPackages.subjectKey, input.subjectKey))
    .all();
  const next = existing.reduce((max, row) => Math.max(max, row.version), 0) + 1;
  tx.update(applicationSubmissionPackages)
    .set({ status: 'superseded', supersededAt: input.now })
    .where(and(eq(applicationSubmissionPackages.subjectKey, input.subjectKey), eq(applicationSubmissionPackages.status, 'current')))
    .run();
  const [row] = tx
    .insert(applicationSubmissionPackages)
    .values({
      id: randomUUID(),
      subjectKey: input.subjectKey,
      attemptId: input.attemptId,
      applicationId: input.applicationId,
      version: next,
      status: 'current',
      boundBy: input.boundBy,
      manifest: input.manifest,
      manifestHash: manifestHash(input.manifest),
      createdAt: input.now,
    })
    .returning()
    .all();
  if (!row) throw new Error('failed to insert a submission package');
  return toRecord(row);
}

/**
 * What the submission binding reads for one attempt: its current drafts, artifacts, receipts and the
 * reviewed candidate evidence (the #690 review fence when a review ran against this source CV, else the
 * source CV itself when its text still hashes to what the attempt was prepared from, else nothing).
 */
export type ReviewedCvReader = (cvId: string) => (Pick<CvDocumentRecord, 'source' | 'profile' | 'text'>) | null;

export function bindInputFor(tx: Pick<WorkspaceDb, 'select'>, attemptId: string, readCv: ReviewedCvReader): BindInput | null {
  const attempt = tx.select().from(applicationAttempts).where(eq(applicationAttempts.id, attemptId)).get();
  if (!attempt) return null;
  const drafts = tx
    .select()
    .from(applicationDocumentDrafts)
    .where(and(eq(applicationDocumentDrafts.attemptId, attemptId), eq(applicationDocumentDrafts.status, 'current')))
    .all();
  const artifacts = tx.select().from(applicationArtifacts).where(eq(applicationArtifacts.attemptId, attemptId)).all();
  const receipts = tx
    .select()
    .from(applicationSubmissionReceipts)
    .where(eq(applicationSubmissionReceipts.attemptId, attemptId))
    .all();

  let reviewedEvidence: BindInput['reviewedEvidence'] = null;
  const critique = tx.select().from(applicationCritiques).where(eq(applicationCritiques.attemptId, attemptId)).get();
  if (critique?.fence && critique.fence.sourceCvHash === attempt.sourceCvContentHash) {
    reviewedEvidence = { hash: critique.fence.reviewedCvHash, from: 'review' };
  } else if (attempt.sourceCvId) {
    const cv = readCv(attempt.sourceCvId);
    if (cv && sha256Hex(cv.text) === attempt.sourceCvContentHash) {
      reviewedEvidence = { hash: reviewedCvEvidenceHash(cv), from: 'submission' };
    }
  }

  const previous = tx
    .select()
    .from(applicationSubmissionPackages)
    .where(and(eq(applicationSubmissionPackages.subjectKey, attemptSubject(attemptId)), eq(applicationSubmissionPackages.status, 'current')))
    .get();

  return {
    attempt: {
      employerKey: attempt.employerKey,
      requisitionId: attempt.requisitionId,
      canonicalUrlKey: attempt.canonicalUrlKey,
      company: attempt.company,
      role: attempt.role,
      jdSnapshotHash: attempt.jdSnapshotHash,
      jdComplete: attempt.jdComplete,
      sourceCvId: attempt.sourceCvId,
      sourceCvContentHash: attempt.sourceCvContentHash,
      completionEvidence: attempt.completionEvidence,
      preparedFields: attempt.preparedFields ?? null,
    },
    drafts: drafts.map((draft) => ({
      id: draft.id,
      kind: draft.kind,
      version: draft.version,
      contentHash: draft.contentHash,
      artifactHash: draft.artifactHash,
    })),
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      fileName: artifact.fileName,
      contentHash: artifact.contentHash,
    })),
    receipts: receipts.map((receipt) => ({
      id: receipt.id,
      outcome: receipt.outcome,
      evidenceKind: receipt.evidenceKind,
      observedAt: receipt.observedAt.toISOString(),
    })),
    reviewedEvidence,
    previous: previous?.manifest ?? null,
  };
}

/**
 * Binds the manifest for an attempt whose submission was just recorded. Idempotent: a repeated event
 * that would record the same manifest appends nothing. Returns the current record, or null when the
 * attempt is gone.
 */
export function bindSubmissionPackage(
  tx: Tx,
  attemptId: string,
  now: Date,
  readCv: ReviewedCvReader,
): SubmissionPackageRecord | null {
  const input = bindInputFor(tx, attemptId, readCv);
  if (!input) return null;
  const manifest = buildSubmissionManifest(input);
  if (input.previous && sameManifest(input.previous, manifest)) return currentPackage(tx, attemptSubject(attemptId));
  return appendPackageVersion(tx, {
    subjectKey: attemptSubject(attemptId),
    attemptId,
    applicationId: null,
    boundBy: 'submission',
    manifest,
    now,
  });
}

/** Counted and deleted explicitly by the application data reset. */
export function deleteAllSubmissionPackages(tx: Pick<WorkspaceDb, 'select' | 'delete'>): { submissionPackages: number } {
  const count = tx.select({ id: applicationSubmissionPackages.id }).from(applicationSubmissionPackages).all().length;
  tx.delete(applicationSubmissionPackages).run();
  return { submissionPackages: count };
}
