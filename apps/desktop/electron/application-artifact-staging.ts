import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import { renderResumeHtml } from './resume-html.js';
import { validateRenderedResumePdf } from './resume-pdf-validation.js';
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
 */
async function printHtmlToPdf(html: string): Promise<Buffer> {
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

interface WriteAndRegisterOptions {
  db: WorkspaceDb;
  attemptId: string;
  kind: ApplicationArtifactKind;
  fileName: string;
  storageRoot: string;
  pdf: Buffer;
}

/** The write-to-disk-and-register half shared by every staging path below, after each one has
 * already produced (and, where applicable, validated) the actual PDF bytes. */
async function writeAndRegisterArtifact(options: WriteAndRegisterOptions): Promise<ApplicationArtifactRecord> {
  const contentHash = createHash('sha256').update(options.pdf).digest('hex');
  const storagePath = stagedArtifactPath(options.storageRoot, options.attemptId, contentHash, options.fileName);
  await mkdir(join(options.storageRoot, options.attemptId), { recursive: true });
  await writeFile(storagePath, options.pdf);

  return workspace.createApplicationArtifact(options.db, {
    attemptId: options.attemptId,
    kind: options.kind,
    fileName: options.fileName,
    mimeType: 'application/pdf',
    byteSize: options.pdf.byteLength,
    contentHash,
    storagePath,
  });
}

export interface StageHtmlArtifactOptions {
  db: WorkspaceDb;
  attemptId: string;
  kind: ApplicationArtifactKind;
  html: string;
  /** e.g. "cover-letter.pdf" -- the artifact's own record of what it should be called; never
   * derived from anything the renderer or a remote source supplies. */
  fileName: string;
  /** Where staged artifacts live, e.g. `join(app.getPath('userData'), 'application-artifacts')`.
   * Passed in rather than resolved here so this module stays free of an `app.getPath` import a
   * test would otherwise have to mock. */
  storageRoot: string;
}

/**
 * Renders arbitrary app-owned HTML to a PDF, writes it to disk, and registers it against #198's
 * artifact table -- the generic staging path (a cover letter, say) with no per-kind validation
 * beyond what `printToPDF` itself guarantees. See `stageTailoredResumeArtifact` below for the
 * resume-specific path, which additionally validates the rendered output.
 */
export async function stageHtmlArtifact(options: StageHtmlArtifactOptions): Promise<ApplicationArtifactRecord> {
  const pdf = await printHtmlToPdf(options.html);
  return writeAndRegisterArtifact({ ...options, pdf });
}

export interface StageTailoredResumeOptions {
  db: WorkspaceDb;
  attemptId: string;
  resume: TailoredResume;
  storageRoot: string;
  fileName?: string;
}

/** Thrown when the rendered resume PDF fails `validateRenderedResumePdf`'s check -- a template bug
 * that silently dropped a section, most likely -- rather than staging and registering broken
 * output. `reasons` is `validateRenderedResumePdf`'s own list, so the caller can surface exactly
 * what was wrong rather than a bare "rendering failed". */
export class ResumeRenderValidationError extends Error {
  constructor(public readonly reasons: string[]) {
    super(`the rendered resume PDF failed validation: ${reasons.join('; ')}`);
    this.name = 'ResumeRenderValidationError';
  }
}

/**
 * The full unattended resume-staging path (#199): render `resume` through the app's default
 * template (`resume-html.ts`), print it to PDF, validate the result actually contains readable
 * text and the resume's own employer/role names, then write and register it -- only once
 * validation passes. Nothing here is ever registered unvalidated.
 */
export async function stageTailoredResumeArtifact(options: StageTailoredResumeOptions): Promise<ApplicationArtifactRecord> {
  const html = renderResumeHtml(options.resume);
  const pdf = await printHtmlToPdf(html);

  const validation = await validateRenderedResumePdf(pdf, options.resume);
  if (!validation.ok) throw new ResumeRenderValidationError(validation.reasons);

  return writeAndRegisterArtifact({
    db: options.db,
    attemptId: options.attemptId,
    kind: 'cv_pdf',
    fileName: options.fileName ?? 'resume.pdf',
    storageRoot: options.storageRoot,
    pdf,
  });
}
