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
    const { extractPdfText } = await import('./cv-text.js');
    // `Uint8Array.from(...)`, not `pdfBytes` passed through: `printHtmlToPdf`'s caller hands this a
    // real Node `Buffer` (what `webContents.printToPDF()` resolves to), and unpdf's `extractText`
    // rejects a `Buffer` outright ("Please provide binary data as `Uint8Array`, rather than
    // `Buffer`") even though `Buffer` is itself a `Uint8Array` subclass -- the same reason
    // `cv-text.ts`'s own `readCvFile` already wraps its PDF bytes the same way before calling this.
    // Without this, every call here with a real `Buffer` failed this exact validation, always, for
    // any caller -- #199's own staging path never actually exercised it in a running Electron
    // process before #156 wired the first manual UI trigger to it and caught this.
    text = await extractPdfText(Uint8Array.from(pdfBytes));
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
    // #274: an engagement whose end client never reached the page reads as direct employment at
    // the agency, which is a different (and wrong) claim about the candidate's history.
    if (entry.engagement === 'client_engagement' && entry.client && !text.includes(entry.client)) {
      reasons.push(`client "${entry.client}" is missing from the rendered text`);
    }
  }
  // #274's own acceptance case: a selected project silently absent from the finished document is
  // exactly the "looks complete, lost evidence" failure this validation exists to catch.
  for (const project of resume.projects) {
    if (project.name && !text.includes(project.name)) {
      reasons.push(`project "${project.name}" is missing from the rendered text`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}
