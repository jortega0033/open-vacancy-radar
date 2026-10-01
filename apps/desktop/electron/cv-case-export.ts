import { createHash } from 'node:crypto';
import { renderResumeDocx } from './resume-docx.js';
import { validateRenderedResumeDocx } from './resume-docx-validation.js';
import { renderResumeHtml } from './resume-html.js';
import { validateRenderedResumePdf } from './resume-pdf-validation.js';
import type { TailoredResume } from './resume-schema.js';
import type { CvArtifactFormat } from './workspace/cv-evidence-schema.js';

/**
 * Renders the approved snapshot of a tailoring case to one file's bytes and checks them (#419 step 9),
 * with no Electron dependency of its own: the PDF printer is passed in, because only the main
 * process has the window it needs. Unlike the CV Library export, a failed check does not throw: the
 * caller records the failed file so the candidate can read why and export again after fixing it.
 *
 * `resume` must be the case's stored approved snapshot. This module never builds or edits one.
 */

export interface RenderedCaseArtifact {
  buffer: Buffer;
  /** SHA-256 hex of `buffer`, the bytes that will be written to disk. */
  contentHash: string;
  validation: { ok: boolean; reasons: string[]; pageCount?: number };
}

export async function renderApprovedSnapshot(
  resume: TailoredResume,
  format: CvArtifactFormat,
  printHtmlToPdf: (html: string) => Promise<Buffer>,
): Promise<RenderedCaseArtifact> {
  if (format === 'pdf') {
    const buffer = await printHtmlToPdf(renderResumeHtml(resume));
    const result = await validateRenderedResumePdf(buffer, resume);
    return {
      buffer,
      contentHash: createHash('sha256').update(buffer).digest('hex'),
      validation: { ok: result.ok, reasons: result.reasons, pageCount: result.pageCount },
    };
  }
  const buffer = await renderResumeDocx(resume);
  const result = await validateRenderedResumeDocx(buffer, resume);
  return {
    buffer,
    contentHash: createHash('sha256').update(buffer).digest('hex'),
    validation: { ok: result.ok, reasons: result.reasons },
  };
}
