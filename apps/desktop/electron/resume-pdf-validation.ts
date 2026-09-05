import type { TailoredResume } from './resume-schema.js';

/**
 * Validates a rendered resume PDF's output (#199's "readable text, employer/role names present
 * and correct" acceptance criterion), independent of Electron: `unpdf` is a pure-JS pdf.js wrapper
 * with no native dependency (see `cv-text.ts`'s own doc comment for why it was chosen over
 * `pdf-parse`/`pdfjs-dist`), so this same check runs identically whether the PDF came from a real
 * `printToPDF` call in Electron main or a test fixture built with `jsPDF` -- there is no
 * Electron-only code path here to leave untested.
 */

export interface ResumePdfValidationResult {
  ok: boolean;
  /** Empty when `ok` is true. Each entry names one specific, actionable problem, never a bare
   * "invalid PDF" -- the caller (a later slice's staging code) surfaces this as the reason an
   * attempt moved to `needs_user`/`failed` rather than `ready`. */
  reasons: string[];
}

/**
 * Confirms the rendered PDF's text is real and extractable (not a rasterized image with no text
 * layer) and that it actually contains the resume's own employer/role names -- a template bug that
 * silently drops a section is exactly the failure mode this check exists to catch before an
 * attempt is ever marked `ready` for a human to review.
 */
export async function validateRenderedResumePdf(
  pdfBytes: Uint8Array,
  resume: TailoredResume,
): Promise<ResumePdfValidationResult> {
  const reasons: string[] = [];

  let text: string;
  try {
    // Imported lazily, matching `cv-text.ts`'s own reasoning: the pdf.js build this pulls in is
    // only paid for when a PDF actually needs validating, and importing this module in a test
    // that never calls this function never pulls pdf.js in.
    const { extractText } = await import('unpdf');
    const result = await extractText(pdfBytes, { mergePages: true });
    text = result.text;
  } catch {
    return { ok: false, reasons: ['the rendered PDF text could not be read back at all -- it may have rendered as an image, not real text'] };
  }

  if (text.trim().length === 0) {
    reasons.push('the rendered PDF contains no extractable text');
  }
  if (resume.contact.name && !text.includes(resume.contact.name)) {
    reasons.push('the candidate name is missing from the rendered text');
  }
  for (const entry of resume.experience) {
    if (entry.company && !text.includes(entry.company)) {
      reasons.push(`employer "${entry.company}" is missing from the rendered text`);
    }
    if (entry.title && !text.includes(entry.title)) {
      reasons.push(`role "${entry.title}" is missing from the rendered text`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}
