import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { draftContentHash, draftText } from './application-critique.js';
import {
  applyStatements,
  buildSubmissionManifest,
  emptyRowManifest,
  sha256Hex,
  type DocumentStatement,
  type PackageDocument,
  type PackageManifestContent,
} from './submitted-package.js';
import {
  VIEW_TEXT_LIMITS,
  type DeleteRoundRequest,
  type InterviewContextResult,
  type InterviewContextView,
  type InterviewDocumentView,
  type InterviewPackageView,
  type SaveRoundRequest,
  type StateDocumentsRequest,
} from './interview-context-types.js';
import type { WorkspaceDb } from './workspace/client.js';
import { cvEvidenceReader, WorkspaceNotFoundError } from './workspace/repository.js';
import {
  applicationArtifacts,
  applicationAttempts,
  applicationDocumentDrafts,
  applications,
  cvDocuments,
  letters,
} from './workspace/schema.js';
import {
  appendPackageVersion,
  applicationSubject,
  attemptSubject,
  bindInputFor,
  currentPackage,
  submissionBoundPackage,
} from './workspace/submission-package-store.js';
import { createRound, deleteRound, listRounds, updateRound } from './workspace/interview-round-store.js';

/**
 * #691: which documents an interview should be prepared from, for ONE Applications row.
 *
 * Resolution never looks past the row: only attempts whose `applicationId` is this row are candidates
 * (never the company name, never the newest attempt at the employer). A reapplication at the same
 * requisition gets its own row (#444), and two requisitions at one employer never share one.
 *
 * Text comes only from owners that hold the exact text: the #690 draft a version was rendered from, or
 * text the person supplied. A recorded file is re-hashed to say whether it is still there, never
 * decoded. Nothing here writes outside the manifest and round tables, and nothing calls a model.
 */

export interface InterviewContextDeps {
  db: WorkspaceDb;
  now(): Date;
  /** Runs a write under the application data reset gate. */
  mutate<T>(task: () => T | Promise<T>): Promise<T>;
}

type AttemptRow = typeof applicationAttempts.$inferSelect;

const COMPLETED = new Set(['submitted', 'user_reported']);
const NEVER_SENT = new Set(['queued', 'skipped', 'failed']);

function clip(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

async function fileState(db: Pick<WorkspaceDb, 'select'>, doc: PackageDocument): Promise<InterviewDocumentView['fileState']> {
  if (!doc.artifactHash) return 'not_recorded';
  const artifact = doc.artifactId
    ? db.select().from(applicationArtifacts).where(eq(applicationArtifacts.id, doc.artifactId)).get()
    : undefined;
  if (!artifact || !artifact.storagePath) return 'missing';
  try {
    const bytes = await readFile(artifact.storagePath);
    return createHash('sha256').update(bytes).digest('hex') === doc.artifactHash ? 'present' : 'changed';
  } catch {
    return 'missing';
  }
}

function textOf(db: Pick<WorkspaceDb, 'select'>, doc: PackageDocument): Pick<InterviewDocumentView, 'text' | 'textTruncated' | 'textState'> {
  if (doc.source === 'draft' && doc.draftId) {
    const row = db.select().from(applicationDocumentDrafts).where(eq(applicationDocumentDrafts.id, doc.draftId)).get();
    if (!row) return { text: null, textTruncated: false, textState: 'missing' };
    if (draftContentHash(row.content) !== doc.contentHash) return { text: null, textTruncated: false, textState: 'changed' };
    const clipped = clip(draftText(row.content), VIEW_TEXT_LIMITS.documentChars);
    return { text: clipped.text, textTruncated: clipped.truncated, textState: 'available' };
  }
  if ((doc.source === 'person_text' || doc.source === 'linked_copy') && doc.text !== null) {
    if (sha256Hex(doc.text) !== doc.contentHash) return { text: null, textTruncated: false, textState: 'changed' };
    const clipped = clip(doc.text, VIEW_TEXT_LIMITS.documentChars);
    return { text: clipped.text, textTruncated: clipped.truncated, textState: 'available' };
  }
  return { text: null, textTruncated: false, textState: 'not_stored' };
}

async function documentView(db: Pick<WorkspaceDb, 'select'>, doc: PackageDocument): Promise<InterviewDocumentView> {
  return {
    slot: doc.slot,
    kind: doc.kind,
    provenance: doc.provenance,
    source: doc.source,
    version: doc.draftVersion,
    contentHash: doc.contentHash,
    artifactHash: doc.artifactHash,
    fileName: doc.fileName,
    statedAt: doc.statedAt,
    ...textOf(db, doc),
    fileState: await fileState(db, doc),
  };
}

interface ResolvedPackage {
  id: string;
  attempt: AttemptRow | null;
  kind: InterviewPackageView['kind'];
  version: number | null;
  manifestHash: string | null;
  content: PackageManifestContent;
  /** What this app holds for the application: the documents a "the prepared file" statement may confirm. */
  prepared: PackageDocument[];
  createdAt: string;
}

function attemptPackage(db: WorkspaceDb, attempt: AttemptRow): ResolvedPackage | null {
  const completed = COMPLETED.has(attempt.checkpoint);
  if (!completed && NEVER_SENT.has(attempt.checkpoint)) return null;
  const readCv = cvEvidenceReader(db);
  const current = currentPackage(db, attemptSubject(attempt.id));
  const bound = submissionBoundPackage(db, attempt.id);
  const input = bindInputFor(db, attempt.id, readCv);
  if (!input) return null;
  const derived = buildSubmissionManifest({ ...input, previous: null });
  const prepared = (bound?.manifest ?? derived).documents.filter((doc) => doc.source === 'draft' || doc.source === 'artifact_only');
  const content = current?.manifest ?? derived;
  if (!completed && !current && content.documents.length === 0) return null;
  return {
    id: attemptSubject(attempt.id),
    attempt,
    kind: completed ? (bound ? 'recorded' : 'legacy') : 'prepared',
    version: current?.version ?? null,
    manifestHash: current?.manifestHash ?? null,
    content,
    prepared,
    createdAt: (current ? new Date(current.createdAt) : attempt.updatedAt).toISOString(),
  };
}

function rowPackage(db: WorkspaceDb, row: typeof applications.$inferSelect): ResolvedPackage {
  const current = currentPackage(db, applicationSubject(row.id));
  return {
    id: applicationSubject(row.id),
    attempt: null,
    kind: 'row',
    version: current?.version ?? null,
    manifestHash: current?.manifestHash ?? null,
    content: current?.manifest ?? emptyRowManifest(row),
    prepared: [],
    createdAt: current?.createdAt ?? new Date(0).toISOString(),
  };
}

function resolvePackages(db: WorkspaceDb, applicationId: string): { row: typeof applications.$inferSelect; packages: ResolvedPackage[] } {
  const row = db.select().from(applications).where(eq(applications.id, applicationId)).get();
  if (!row) throw new WorkspaceNotFoundError('application', applicationId);
  const attempts = db.select().from(applicationAttempts).where(eq(applicationAttempts.applicationId, applicationId)).all();
  const packages = attempts
    .map((attempt) => attemptPackage(db, attempt))
    .filter((pkg): pkg is ResolvedPackage => pkg !== null)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  // A row with nothing this app prepared or sent (tracked by hand, or from before attempts existed): the
  // person's own statement is the only possible basis, recorded on the row itself.
  const sent = packages.some((pkg) => pkg.kind === 'recorded' || pkg.kind === 'legacy');
  if (!sent && (packages.length === 0 || currentPackage(db, applicationSubject(applicationId)))) packages.push(rowPackage(db, row));
  return { row, packages };
}

function chooseDefault(packages: readonly ResolvedPackage[]): Pick<InterviewContextView, 'defaultPackageId' | 'selection'> {
  const sent = packages.filter((pkg) => pkg.kind === 'recorded' || pkg.kind === 'legacy');
  if (sent.length > 0) {
    const superseded = new Set(sent.map((pkg) => pkg.attempt?.supersedesAttemptId).filter((value): value is string => !!value));
    const heads = sent.filter((pkg) => !pkg.attempt || !superseded.has(pkg.attempt.id));
    if (heads.length === 1) return { defaultPackageId: heads[0]!.id, selection: sent.length === 1 ? 'single' : 'chain' };
    return { defaultPackageId: null, selection: 'choose' };
  }
  const row = packages.find((pkg) => pkg.kind === 'row');
  if (row && row.version !== null) return { defaultPackageId: row.id, selection: 'single' };
  const prepared = packages.filter((pkg) => pkg.kind === 'prepared');
  if (prepared.length === 1) return { defaultPackageId: prepared[0]!.id, selection: 'prepared' };
  if (prepared.length > 1) return { defaultPackageId: null, selection: 'choose' };
  // Nothing recorded: the row itself is shown so the person can say what they sent; it is no basis yet.
  return { defaultPackageId: row?.id ?? null, selection: 'none' };
}

async function packageView(db: WorkspaceDb, pkg: ResolvedPackage): Promise<InterviewPackageView> {
  const attempt = pkg.attempt;
  const jdText = attempt?.jdSnapshot.trim() ? attempt.jdSnapshot : null;
  const recordedJd = pkg.content.posting.jdHash;
  const clippedJd = jdText ? clip(jdText, VIEW_TEXT_LIMITS.jdChars).text : null;
  const requisition = pkg.content.requisition;
  return {
    id: pkg.id,
    attemptId: attempt?.id ?? null,
    kind: pkg.kind,
    version: pkg.version,
    manifestHash: pkg.manifestHash,
    role: requisition.role.slice(0, 500),
    company: requisition.company.slice(0, 500),
    requisition: (requisition.requisitionId ?? requisition.canonicalUrlKey ?? '').slice(0, 500),
    submission: {
      evidence: pkg.content.submission.evidence,
      receiptKind: pkg.content.submission.receiptKind,
      recordedAt: pkg.content.submission.recordedAt,
    },
    posting: {
      text: clippedJd,
      hash: recordedJd,
      complete: pkg.content.posting.jdComplete,
      matches: jdText && recordedJd ? sha256Hex(jdText) === recordedJd : null,
    },
    candidate: {
      sourceCvHash: pkg.content.candidate.sourceCvHash,
      reviewedEvidenceHash: pkg.content.candidate.reviewedEvidenceHash,
      reviewedEvidenceFrom: pkg.content.candidate.reviewedEvidenceFrom,
    },
    documents: await Promise.all(pkg.content.documents.map((doc) => documentView(db, doc))),
    heldSlots: [...new Set(pkg.prepared.map((doc) => doc.slot))],
    supersedesAttemptId: attempt?.supersedesAttemptId ?? null,
    createdAt: pkg.createdAt,
  };
}

export async function getInterviewContextView(deps: Pick<InterviewContextDeps, 'db'>, applicationId: string): Promise<InterviewContextView> {
  const { packages } = resolvePackages(deps.db, applicationId);
  return {
    applicationId,
    packages: await Promise.all(packages.map((pkg) => packageView(deps.db, pkg))),
    ...chooseDefault(packages),
    rounds: listRounds(deps.db, applicationId),
  };
}

/* -------------------------------------------------------------------------------- writes ----- */

const MESSAGES = {
  outdated: 'This changed since you opened it. Check the details again.',
  receipt_backed: 'This app sent that file itself and saw a confirmation, so that record stays as it is.',
  nothing_prepared: 'This app holds no prepared file for that document.',
  text_required: 'Paste the text you sent first.',
  no_linked_document: 'No linked document is in your library for that.',
  not_found: 'That application is no longer available.',
  limit: 'This application already has the most rounds this app keeps.',
} as const;

async function failure(
  deps: InterviewContextDeps,
  applicationId: string,
  code: keyof typeof MESSAGES,
): Promise<InterviewContextResult> {
  let view: InterviewContextView | null;
  try {
    view = await getInterviewContextView(deps, applicationId);
  } catch {
    view = null;
  }
  return { ok: false, code, message: MESSAGES[code], view };
}

/**
 * Records what the person said about the documents of one package as the next manifest version. The
 * package must be one of THIS row's packages, and `expectedVersion` must be the version they were shown.
 */
export async function stateDocuments(deps: InterviewContextDeps, input: StateDocumentsRequest): Promise<InterviewContextResult> {
  const outcome = await deps.mutate(() =>
    deps.db.transaction((tx) => {
      const db = tx as unknown as WorkspaceDb;
      const { row, packages } = resolvePackages(db, input.applicationId);
      const pkg = packages.find((candidate) => candidate.id === input.packageId);
      if (!pkg) return { code: 'not_found' as const };
      if (pkg.version !== input.expectedVersion) return { code: 'outdated' as const };

      const statements: DocumentStatement[] = [];
      for (const statement of input.statements) {
        if (statement.choice === 'linked_document') {
          const linked =
            statement.slot === 'cv'
              ? row.cvId
                ? db.select().from(cvDocuments).where(eq(cvDocuments.id, row.cvId)).get()
                : undefined
              : row.letterId
                ? db.select().from(letters).where(eq(letters.id, row.letterId)).get()
                : undefined;
          if (!linked) return { code: 'no_linked_document' as const };
          const text = 'body' in linked ? linked.body : linked.text;
          const kind = 'type' in linked && (linked.type === 'cover_letter' || linked.type === 'motivation_letter') ? linked.type : statement.slot === 'cv' ? 'cv' : null;
          statements.push({ slot: statement.slot, choice: 'linked_document', text: text.slice(0, VIEW_TEXT_LIMITS.suppliedTextChars), kind });
        } else {
          statements.push({ slot: statement.slot, choice: statement.choice, ...(statement.text !== undefined ? { text: statement.text } : {}) });
        }
      }

      const now = deps.now();
      const applied = applyStatements(pkg.content, statements, now.toISOString(), pkg.prepared);
      if (!applied.ok) return { code: applied.code };
      appendPackageVersion(db, {
        subjectKey: pkg.id,
        attemptId: pkg.attempt?.id ?? null,
        applicationId: pkg.attempt ? null : row.id,
        boundBy: 'person',
        manifest: applied.content,
        now,
      });
      return { code: null };
    }),
  );
  if (outcome.code) return failure(deps, input.applicationId, outcome.code);
  return { ok: true, view: await getInterviewContextView(deps, input.applicationId) };
}

export async function saveRound(deps: InterviewContextDeps, input: SaveRoundRequest): Promise<InterviewContextResult> {
  const round = {
    ...input.round,
    feedback: input.round.feedback.trim(),
    openTopics: input.round.openTopics.map((topic) => topic.trim()).filter(Boolean),
  };
  const outcome = await deps.mutate(() =>
    deps.db.transaction((tx) => {
      const now = deps.now();
      if (input.roundId === null) return createRound(tx, input.applicationId, round, now);
      if (input.expectedUpdatedAt === null) return { ok: false as const, code: 'outdated' as const };
      return updateRound(tx, input.applicationId, input.roundId, round, input.expectedUpdatedAt, now);
    }),
  );
  if (!outcome.ok) return failure(deps, input.applicationId, outcome.code);
  return { ok: true, view: await getInterviewContextView(deps, input.applicationId) };
}

export async function removeRound(deps: InterviewContextDeps, input: DeleteRoundRequest): Promise<InterviewContextResult> {
  const removed = await deps.mutate(() => deps.db.transaction((tx) => deleteRound(tx, input.applicationId, input.roundId)));
  if (!removed) return failure(deps, input.applicationId, 'not_found');
  return { ok: true, view: await getInterviewContextView(deps, input.applicationId) };
}
