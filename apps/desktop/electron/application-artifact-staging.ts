import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import {
  acceptRenderedDocument,
  type DocumentAcceptance,
  type DocumentAcceptanceContract,
  type DocumentArtifactKind,
  type DocumentTarget,
} from './document-acceptance.js';
import { letterAcceptanceContract, resumeAcceptanceContract } from './document-contracts.js';
import { checkDocumentReadiness, type DocumentReadinessResult } from './document-readiness.js';
import { renderLetterHtml } from './letter-html.js';
import { renderResumeHtml } from './resume-html.js';
import type { TailoredResume } from './resume-schema.js';
import * as workspace from './workspace/repository.js';
import type { WorkspaceDb } from './workspace/client.js';
import type { ApplicationArtifactKind, ApplicationArtifactRecord } from './workspace/types.js';

/**
 * Unattended local artifact staging (#199): renders app-owned HTML to a real PDF and registers it
 * against #198's artifact table, with no native Save dialog anywhere in the path. The existing
 * interactive export flow (`letters/export.ts`'s `window.system.saveFile`) is untouched and stays
 * available for manual use -- this is a separate, main-process-only path for the unattended
 * staging case, per #199's own scope: "Only the main process/worker resolves local file paths."
 *
 * Since #276 nothing reaches the artifact table unvalidated. Every staging path below runs the
 * shared document acceptance contract (`document-acceptance.ts`) against the finished bytes first,
 * and registers the artifact under *that* check's own content hash. Before #276 the resume path
 * validated and the generic path (used for letters) did not, so a blank or clipped letter could be
 * registered and reported ready exactly like a good one.
 */

/**
 * Where a staged artifact's file lives on disk, given its attempt, content hash, and file name.
 * Pure and separately testable -- the part of this module that isn't a thin wrapper around a real
 * Electron API (`printToPDF`) or a real filesystem write, both of which need a real Electron/Node
 * runtime this codebase's other Electron-glue modules (`resolve-window-icon.ts`, `main.ts`'s own
 * `Tray`/`BrowserWindow` construction) already leave to code review rather than a unit test.
 *
 * Namespaced under the attempt id so two attempts' artifacts never collide, and named with the
 * content hash so re-staging identical content twice is idempotent at the filesystem level too.
 */
export function stagedArtifactPath(storageRoot: string, attemptId: string, contentHash: string, fileName: string): string {
  return join(storageRoot, attemptId, `${contentHash}-${fileName}`);
}

/**
 * Renders `html` to a PDF buffer via a hidden, offscreen `BrowserWindow` -- `printToPDF` needs a
 * real `webContents`, and there is no headless-Electron equivalent that doesn't. The window loads
 * only the caller's own app-owned HTML (`resume-html.ts`'s output), never remote job-posting
 * content: that stays confined to the text-only generation session per #196's trust-domain design
 * and never reaches this function at all.
 *
 * Exported (not module-private) since #156: the manual CV Library export action
 * (`main.ts`'s `workspace:cv-documents:export` handler) needs exactly this same HTML-to-PDF step,
 * just followed by a native save dialog instead of this module's own artifact-table registration.
 * Reusing the function rather than a second copy of the `BrowserWindow`/`printToPDF` dance keeps
 * there being exactly one place that ever renders app-owned HTML into a PDF.
 */
export async function printHtmlToPdf(html: string): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await win.webContents.printToPDF({});
  } finally {
    win.destroy();
  }
}

/** Thrown when finished PDF bytes fail the shared acceptance contract -- a template bug that
 * silently dropped a section, a page that came out blank, content printed off the edge of the
 * paper -- rather than staging and registering broken output. `reasons` is the contract's own
 * finding list, so the caller can surface exactly what was wrong rather than "rendering failed". */
export class DocumentAcceptanceError extends Error {
  constructor(
    public readonly kind: DocumentArtifactKind,
    public readonly reasons: string[],
  ) {
    super(`the rendered ${kind.replaceAll('_', ' ')} PDF failed the document acceptance contract: ${reasons.join('; ')}`);
    this.name = 'DocumentAcceptanceError';
  }
}

function describeFindings(acceptance: DocumentAcceptance): string[] {
  return acceptance.findings.map((finding) => (finding.page === undefined ? finding.detail : `page ${finding.page}: ${finding.detail}`));
}

/** The workspace artifact table predates #276's four-way document kind and has no row for a
 * motivation letter, which it stores as a cover letter. Both directions are spelled out here so a
 * future kind cannot be added on one side only. */
const WORKSPACE_KIND: Readonly<Record<DocumentArtifactKind, ApplicationArtifactKind>> = {
  cv: 'cv_pdf',
  cover_letter: 'cover_letter_pdf',
  motivation_letter: 'cover_letter_pdf',
  combined: 'combined_pdf',
};

export function documentKindForArtifact(kind: ApplicationArtifactKind): DocumentArtifactKind | null {
  switch (kind) {
    case 'cv_pdf':
      return 'cv';
    case 'cover_letter_pdf':
      return 'cover_letter';
    case 'combined_pdf':
      return 'combined';
    default:
      return null;
  }
}

interface WriteAndRegisterOptions {
  db: WorkspaceDb;
  attemptId: string;
  kind: DocumentArtifactKind;
  fileName: string;
  storageRoot: string;
  pdf: Buffer;
  /** The hash the acceptance check itself computed over these exact bytes. Not recomputed here:
   * the whole point of #276's fourth acceptance case is that the registered hash is the accepted
   * one, so that a later readiness or attachment step comparing against it is comparing against a
   * document something actually validated. */
  contentHash: string;
}

/** The write-to-disk-and-register half shared by every staging path below, after each one has
 * already produced and accepted the actual PDF bytes. */
async function writeAndRegisterArtifact(options: WriteAndRegisterOptions): Promise<ApplicationArtifactRecord> {
  const storagePath = stagedArtifactPath(options.storageRoot, options.attemptId, options.contentHash, options.fileName);
  await mkdir(join(options.storageRoot, options.attemptId), { recursive: true });
  await writeFile(storagePath, options.pdf);

  return workspace.createApplicationArtifact(options.db, {
    attemptId: options.attemptId,
    kind: WORKSPACE_KIND[options.kind],
    fileName: options.fileName,
    mimeType: 'application/pdf',
    byteSize: options.pdf.byteLength,
    contentHash: options.contentHash,
    storagePath,
  });
}

export interface StageHtmlArtifactOptions {
  db: WorkspaceDb;
  attemptId: string;
  html: string;
  /** What this document has to be for the acceptance contract to accept it. Required, not optional:
   * an artifact staged with no contract is exactly the unvalidated letter path #276 exists to
   * close. */
  contract: DocumentAcceptanceContract;
  /** e.g. "cover-letter.pdf" -- the artifact's own record of what it should be called; never
   * derived from anything the renderer or a remote source supplies. */
  fileName: string;
  /** Where staged artifacts live, e.g. `join(app.getPath('userData'), 'application-artifacts')`.
   * Passed in rather than resolved here so this module stays free of an `app.getPath` import a
   * test would otherwise have to mock. */
  storageRoot: string;
}

/**
 * Renders app-owned HTML to a PDF, checks the finished bytes against the caller's acceptance
 * contract, and only then writes and registers the artifact. The general path every kind-specific
 * one below goes through.
 */
export async function stageHtmlArtifact(options: StageHtmlArtifactOptions): Promise<ApplicationArtifactRecord> {
  const pdf = await printHtmlToPdf(options.html);
  const acceptance = await acceptRenderedDocument(Uint8Array.from(pdf), options.contract);
  if (!acceptance.ok) throw new DocumentAcceptanceError(options.contract.kind, describeFindings(acceptance));

  return writeAndRegisterArtifact({
    db: options.db,
    attemptId: options.attemptId,
    kind: options.contract.kind,
    fileName: options.fileName,
    storageRoot: options.storageRoot,
    pdf,
    contentHash: acceptance.contentHash,
  });
}

export interface StageTailoredResumeOptions {
  db: WorkspaceDb;
  attemptId: string;
  resume: TailoredResume;
  storageRoot: string;
  fileName?: string;
  /** The vacancy this CV was tailored for. Recorded on the acceptance decision, never required to
   * appear inside the CV's own work history -- see `document-acceptance.ts`'s `targetRule`. */
  target?: DocumentTarget | null;
  /** Employers the reviewed source CV attests to, so a genuine re-application to a previous
   * employer is not mistaken for a fabricated one. */
  verifiedEmployers?: readonly string[];
}

/**
 * The full unattended resume-staging path (#199, contract-checked since #276): render `resume`
 * through the app's default template, print it to PDF, accept the finished bytes against the CV
 * contract, then write and register them under the accepted hash. Nothing here is ever registered
 * unvalidated.
 */
export function stageTailoredResumeArtifact(options: StageTailoredResumeOptions): Promise<ApplicationArtifactRecord> {
  return stageHtmlArtifact({
    db: options.db,
    attemptId: options.attemptId,
    html: renderResumeHtml(options.resume),
    contract: resumeAcceptanceContract(options.resume, { target: options.target ?? null, verifiedEmployers: options.verifiedEmployers }),
    fileName: options.fileName ?? 'resume.pdf',
    storageRoot: options.storageRoot,
  });
}

export interface StageLetterOptions {
  db: WorkspaceDb;
  attemptId: string;
  kind: Extract<DocumentArtifactKind, 'cover_letter' | 'motivation_letter'>;
  /** The letter's heading, e.g. "Cover Letter". Also the finished PDF's own title. */
  title: string;
  body: string;
  candidateName: string;
  target: DocumentTarget | null;
  storageRoot: string;
  fileName?: string;
}

/**
 * The letter counterpart of `stageTailoredResumeArtifact`, and the reason #276 lists "CV and
 * letter paths receive equivalent applicable checks" as an acceptance case of its own: before this,
 * letters went through the generic HTML path with no validation at all.
 */
export function stageLetterArtifact(options: StageLetterOptions): Promise<ApplicationArtifactRecord> {
  return stageHtmlArtifact({
    db: options.db,
    attemptId: options.attemptId,
    html: renderLetterHtml(options.title, options.body, { candidateName: options.candidateName }),
    contract: letterAcceptanceContract({
      kind: options.kind,
      title: options.title,
      body: options.body,
      candidateName: options.candidateName,
      target: options.target,
    }),
    fileName: options.fileName ?? `${options.kind.replaceAll('_', '-')}.pdf`,
    storageRoot: options.storageRoot,
  });
}

export interface StageApplicationDocumentsOptions {
  db: WorkspaceDb;
  attemptId: string;
  storageRoot: string;
  target: DocumentTarget | null;
  resume: TailoredResume;
  verifiedEmployers?: readonly string[];
  /** The letters this application actually asked for. A requested letter whose generation produced
   * nothing must be listed here with an empty `body`: that is what lets readiness refuse instead of
   * reporting the application ready on the CV alone. */
  letters: ReadonlyArray<{
    kind: Extract<DocumentArtifactKind, 'cover_letter' | 'motivation_letter'>;
    title: string;
    body: string;
  }>;
}

export interface StageApplicationDocumentsResult {
  records: ApplicationArtifactRecord[];
  /** Whose refusals, if any, say why this application is not ready to attach. */
  readiness: DocumentReadinessResult;
}

/**
 * Stages every document one application asked for and reports whether the set is ready -- the one
 * entry point that knows what was *requested*, which is the only place the "a requested cover
 * letter that never got produced" case is visible at all (#276). Staging a CV successfully and
 * finding no letter file is indistinguishable from "no letter was ever wanted" once you are only
 * looking at the artifact table.
 *
 * A letter whose body is empty is never rendered: an empty PDF would fail the contract anyway, and
 * refusing here reports the real cause ("the letter was requested and not produced") rather than
 * "the letter is blank".
 */
export async function stageApplicationDocuments(options: StageApplicationDocumentsOptions): Promise<StageApplicationDocumentsResult> {
  const requested: DocumentArtifactKind[] = ['cv', ...options.letters.map((letter) => letter.kind)];
  const staged: Array<{ kind: DocumentArtifactKind; record: ApplicationArtifactRecord }> = [];

  staged.push({
    kind: 'cv',
    record: await stageTailoredResumeArtifact({
      db: options.db,
      attemptId: options.attemptId,
      resume: options.resume,
      storageRoot: options.storageRoot,
      target: options.target,
      verifiedEmployers: options.verifiedEmployers,
    }),
  });

  for (const letter of options.letters) {
    if (letter.body.trim().length === 0) continue;
    staged.push({
      kind: letter.kind,
      record: await stageLetterArtifact({
        db: options.db,
        attemptId: options.attemptId,
        kind: letter.kind,
        title: letter.title,
        body: letter.body,
        candidateName: options.resume.contact.name,
        target: options.target,
        storageRoot: options.storageRoot,
      }),
    });
  }

  const readiness = checkDocumentReadiness({
    requested,
    accepted: staged.map((document) => ({
      kind: document.kind,
      acceptedContentHash: document.record.contentHash,
      acceptedTarget: options.target,
    })),
    present: staged.map((document) => ({ kind: document.kind, currentContentHash: document.record.contentHash })),
    target: options.target,
  });

  return { records: staged.map((document) => document.record), readiness };
}

