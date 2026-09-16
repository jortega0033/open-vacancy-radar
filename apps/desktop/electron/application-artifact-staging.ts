import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
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

/**
 * Thrown in place of a staged artifact when the caller's own `stillLive` check says the run that
 * asked for this document no longer owns the attempt (see `application-pipeline.ts`'s "the
 * preparation fence").
 *
 * A thrown error rather than a `null` return, for the same reason `DocumentAcceptanceError` is one:
 * every staging function's contract is "a registered artifact, or an explanation", and a caller that
 * forgot about a third possibility would otherwise carry on with a record it does not have. The
 * pipeline catches this specific type and stops quietly; nothing else in the app produces it,
 * because nothing else passes `stillLive`.
 *
 * "Registered", not "written": one of the two checks that raises this sits after the PDF is already
 * on disk, and answers by removing that file again rather than by having prevented it. What the
 * error promises the caller is that no artifact row was left behind, which is the claim anything
 * downstream actually depends on.
 */
export class StagingAbandonedError extends Error {
  constructor(public readonly attemptId: string) {
    super(`staging for attempt ${attemptId} was abandoned before its artifact was registered`);
    this.name = 'StagingAbandonedError';
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

/**
 * "Is the caller that asked for this document still the one entitled to write it?", re-asked on the
 * trailing edge of the render rather than trusted from before it.
 *
 * Staging is the one path in this module with a genuinely unbounded gap between being asked for a
 * document and producing it: `printHtmlToPdf` opens an offscreen `BrowserWindow`, loads a URL into
 * it and waits for `printToPDF`, none of which this process can cancel or time out. A caller that
 * checked its own fence before calling has therefore checked it minutes before anything durable
 * happens, which is no check at all -- so the check has to come back down here, into
 * `writeAndRegisterArtifact`, whose side effects replace whatever a *newer* run has already staged
 * for the same attempt.
 *
 * Asked twice there, not once, and that is the whole point of the second one: on entry, so an
 * already-abandoned run does no work at all, and again once the PDF is written, immediately before
 * the rows that make it this attempt's current document. Only the second check can see an
 * abandonment that happened *during* the write, which is the case a leading check structurally
 * cannot cover. So it must be cheap and side-effect-free enough to call repeatedly, and it must
 * answer about right now rather than caching an earlier answer.
 *
 * Optional, and absent everywhere except the pipeline's fenced preparation path: the manual CV
 * Library export and the tests that stage directly have no second run to lose a race with, and a
 * missing check means "always live", exactly as before this existed.
 */
type StillLive = () => boolean;

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
  stillLive?: StillLive;
}

/**
 * The write-to-disk-and-register half shared by every staging path below, after each one has
 * already produced and accepted the actual PDF bytes.
 *
 * Ordered the way it is because of the fence, not for readability. A leading `stillLive` check alone
 * only says this run was entitled to write when the function was *entered*; every `await` after it
 * is a point where the run can be abandoned and replaced, and nothing in this process can recall a
 * filesystem call already issued. So the destructive half -- dropping the rows a previous run
 * registered for this same logical document, and with them the files those rows point at -- is
 * deliberately deferred until *after* the new PDF is on disk, where it sits behind a second
 * `stillLive` check with no `await` between that check and the row writes it guards. That makes the
 * replacement of an attempt's current artifact atomic with respect to the fence: an abandoned run
 * that loses the race is refused there and deletes nothing, instead of taking the live run's
 * documents down with it on its way out.
 *
 * What is genuinely irreducible, and accepted: the new PDF's own `mkdir`/`writeFile`/`chmod` can
 * still land after the fence has moved, because they are already in flight by the time anyone could
 * notice. They are compensated rather than prevented -- the trailing check removes the file it just
 * wrote before throwing -- and that compensation is best-effort in both directions. It declines to
 * delete a path some live artifact row already claims (file names are content hashes, so a
 * replacement run that produced identical bytes is registered at the very same path), and if the
 * `rm` fails it gives up rather than failing the run. Either way what can be left behind is an
 * unreferenced file under this attempt's directory, which nothing reads and which the application
 * data reset removes wholesale with the rest of `storageRoot`. No artifact row ever points at it,
 * which is the property that actually matters: a document nothing registered cannot be attached to
 * an application. Closing the window itself, rather than compensating for it, would need an
 * `AbortSignal` threaded through every filesystem call in the app -- a separate hardening effort the
 * fencing work deliberately left out of its own scope.
 */
async function writeAndRegisterArtifact(options: WriteAndRegisterOptions): Promise<ApplicationArtifactRecord> {
  // Before the path is even computed, so a run that was already fenced out when it arrived here
  // leaves nothing at all behind: no directory created, no PDF written, no row touched.
  if (options.stillLive && !options.stillLive()) throw new StagingAbandonedError(options.attemptId);

  const storagePath = stagedArtifactPath(options.storageRoot, options.attemptId, options.contentHash, options.fileName);
  const workspaceKind = WORKSPACE_KIND[options.kind];
  const storageRoot = resolve(options.storageRoot);
  const attemptStorage = resolve(storageRoot, options.attemptId);
  if (dirname(attemptStorage) !== storageRoot) throw new Error('invalid application artifact attempt directory');

  // A generated CV/letter PDF is as sensitive as anything in workspace.db itself -- it's the same
  // CV text and contact info, just rendered. Mirror workspace.db's 0700/0600 hardening here too:
  // `mkdir`'s `mode` applies to every directory level `recursive` creates, so this one call covers
  // both `application-artifacts/` and its per-attempt subdirectory. POSIX-only in effect; a no-op
  // on Windows, same posture as `workspace/client.ts`'s `secureDatabaseFiles`.
  await mkdir(join(options.storageRoot, options.attemptId), { recursive: true, mode: 0o700 });
  await writeFile(storagePath, options.pdf, { mode: 0o600 });
  await chmod(storagePath, 0o600); // writeFile's own `mode` is masked by umask; this is not

  // The trailing edge: the last moment before this run changes anything another run can read. A
  // file written here and then orphaned is inert; a row registered here is not, so the answer to
  // "am I still the live run?" has to be the one from *now*, not the one from before the write.
  if (options.stillLive && !options.stillLive()) {
    // Not unconditionally: file names are content hashes, so a replacement run that produced
    // byte-identical output -- the same CV tailored from the same source against the same vacancy,
    // which is the *likely* case for a re-run, not an exotic one -- registered that document at
    // exactly this path. Deleting "the file this run wrote" would then delete the live attempt's
    // own current CV, turning a compensation into precisely the damage the fence exists to prevent.
    // Identical hash means identical bytes, so leaving the file alone costs nothing.
    const claimed = workspace
      .listApplicationArtifacts(options.db, options.attemptId)
      .some((artifact) => artifact.storagePath && resolve(artifact.storagePath) === resolve(storagePath));
    if (!claimed) {
      try {
        await rm(storagePath, { force: true });
      } catch {
        // Best effort by design -- see this function's own doc comment. Leaving the bytes behind is
        // strictly better than letting the throw below turn into a staging *failure* the caller
        // would report to a person, about an attempt a replacement run is preparing perfectly well.
      }
    }
    throw new StagingAbandonedError(options.attemptId);
  }

  // Nothing between the check above and the `createApplicationArtifact` below awaits, so the fence
  // cannot move while this is happening: the old rows going and the new row arriving are one
  // indivisible step as far as any other run is concerned. An interrupted run may have registered
  // this same logical document before the attempt was requeued, and replacing that registration is
  // what keeps a retried attempt showing one current artifact instead of an accumulating history.
  const superseded = workspace
    .listApplicationArtifacts(options.db, options.attemptId)
    .filter((artifact) => artifact.kind === workspaceKind && artifact.fileName === options.fileName);
  for (const artifact of superseded) {
    workspace.deleteApplicationArtifact(options.db, artifact.id);
  }
  const record = workspace.createApplicationArtifact(options.db, {
    attemptId: options.attemptId,
    kind: workspaceKind,
    fileName: options.fileName,
    mimeType: 'application/pdf',
    byteSize: options.pdf.byteLength,
    contentHash: options.contentHash,
    storagePath,
  });

  // And only then the superseded files, which no row points at any more. Confined to this attempt's
  // own directory, so a malformed or hand-edited `storagePath` can never make this delete something
  // outside the artifact store. The path this run just wrote is skipped explicitly: re-staging
  // byte-identical content produces the same content hash and therefore the same file name, so
  // without this an idempotent re-stage would delete its own freshly written PDF and register a row
  // pointing at nothing.
  for (const artifact of superseded) {
    if (!artifact.storagePath) continue;
    if (dirname(resolve(artifact.storagePath)) !== attemptStorage) continue;
    if (resolve(artifact.storagePath) === resolve(storagePath)) continue;
    try {
      await rm(artifact.storagePath, { force: true });
    } catch {
      // Best effort, same as the compensating delete above: the row swap has already committed by
      // this point, so a failing rm here (a Windows EBUSY/EPERM on a PDF another handle still has
      // open, an EACCES) must never surface as a staging failure about an attempt whose current
      // artifact row and file are in fact fine -- it would only orphan bytes nothing points at any
      // more, the same inert outcome this function's own doc comment already accepts.
    }
  }

  return record;
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
  /** Re-asked after the render, immediately before anything durable happens. See `StillLive`. */
  stillLive?: StillLive;
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
    ...(options.stillLive ? { stillLive: options.stillLive } : {}),
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
  /** Re-asked after the render, immediately before anything durable happens. See `StillLive`. */
  stillLive?: StillLive;
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
    ...(options.stillLive ? { stillLive: options.stillLive } : {}),
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
  /** Re-asked after the render, immediately before anything durable happens. See `StillLive`. */
  stillLive?: StillLive;
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
    ...(options.stillLive ? { stillLive: options.stillLive } : {}),
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
  /** Re-asked after each render, immediately before anything durable happens -- once per document,
   * not once for the set, since every one of them is a separate unbounded render. See `StillLive`. */
  stillLive?: StillLive;
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
      ...(options.stillLive ? { stillLive: options.stillLive } : {}),
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
        ...(options.stillLive ? { stillLive: options.stillLive } : {}),
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

