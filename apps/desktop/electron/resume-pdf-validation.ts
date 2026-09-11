import { acceptRenderedDocument } from './document-acceptance.js';
import { resumeAcceptanceContract, type ResumeContractOptions } from './document-contracts.js';
import type { TailoredResume } from './resume-schema.js';

/**
 * The resume-shaped entry point into the shared artifact acceptance contract (#276).
 *
 * Originally (#199) this was the whole check: extractable text plus the resume's own employer/role
 * names, later (#274) plus selected projects and end clients. #276 replaced the check itself with
 * one contract shared by CVs and letters alike -- page bounds, blank pages, clipped and overprinted
 * content, link integrity, document identity and target metadata, all read back from the real
 * rendered PDF. Everything the earlier check refused, this still refuses; what changed is that a
 * letter now gets the same treatment, and that a document which extracts fine but prints wrong is
 * no longer accepted.
 *
 * Kept as a named function rather than folded into its callers because "validate a rendered
 * resume" is a thing several paths do (unattended staging, the manual CV Library export), and
 * building the contract is the part they would otherwise each have to get right.
 */

export interface ResumePdfValidationResult {
  ok: boolean;
  /** Empty when `ok` is true. Each entry names one specific, actionable problem, never a bare
   * "invalid PDF" -- the caller surfaces this as the reason an attempt moved to `needs_user`/
   * `failed` rather than `ready`. */
  reasons: string[];
  /** sha256 of the exact bytes checked. Callers bind staging, readiness and attachment to this
   * rather than re-deriving a hash later from whatever is on disk (#276). */
  contentHash: string;
}

export async function validateRenderedResumePdf(
  pdfBytes: Uint8Array,
  resume: TailoredResume,
  options: ResumeContractOptions = {},
): Promise<ResumePdfValidationResult> {
  // `Uint8Array.from(...)`, not `pdfBytes` passed through: `printHtmlToPdf`'s caller hands this a
  // real Node `Buffer` (what `webContents.printToPDF()` resolves to), and unpdf's extraction
  // rejects a `Buffer` outright ("Please provide binary data as `Uint8Array`, rather than
  // `Buffer`") even though `Buffer` is itself a `Uint8Array` subclass -- the same reason
  // `cv-text.ts`'s own `readCvFile` already wraps its PDF bytes the same way. Without this, every
  // call here with a real `Buffer` failed this exact validation, always, for any caller (#156).
  const acceptance = await acceptRenderedDocument(Uint8Array.from(pdfBytes), resumeAcceptanceContract(resume, options));
  return {
    ok: acceptance.ok,
    reasons: acceptance.findings.map((finding) => (finding.page === undefined ? finding.detail : `page ${finding.page}: ${finding.detail}`)),
    contentHash: acceptance.contentHash,
  };
}
