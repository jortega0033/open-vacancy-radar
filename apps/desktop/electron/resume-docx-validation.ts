import { createHash } from 'node:crypto';
import { RESUME_SECTION_HEADINGS, findResumeClaimProblems, normalizeResumeWhitespace, resumeClaims } from './resume-claims.js';
import type { TailoredResume } from './resume-schema.js';

/**
 * Reopens a produced DOCX and checks what it says against the approved snapshot it was rendered from
 * (#419 step 9): extracted text, section order, contact details, links and the selected projects.
 *
 * What this does not check is how the document looks. Pagination, fonts and spacing depend on the
 * editor that opens the file, so no page count or fit is claimed here; the candidate reads the file
 * in their own editor and confirms it separately. The template writes links as plain text, so a
 * link is checked as text, not as a clickable relationship.
 */

export interface ResumeDocxValidationResult {
  ok: boolean;
  /** Empty when `ok` is true. Each entry names one specific problem. */
  reasons: string[];
  /** sha256 of the exact bytes checked. */
  contentHash: string;
}

/** Words the template adds around the claims it prints. Anything else left on a line is text the
 * snapshot does not contain. */
const TEMPLATE_FILLER = ['client engagement', 'Candidate'];

function residue(line: string, claimTexts: string[]): string {
  let rest = line;
  for (const text of claimTexts) rest = rest.split(text).join(' ');
  for (const filler of TEMPLATE_FILLER) rest = rest.split(filler).join(' ');
  return rest.replace(/[\s,:;·|•\-–.()]+/g, '').trim();
}

export async function validateRenderedResumeDocx(
  docxBytes: Uint8Array,
  resume: TailoredResume,
): Promise<ResumeDocxValidationResult> {
  const contentHash = createHash('sha256').update(docxBytes).digest('hex');
  const fail = (reasons: string[]): ResumeDocxValidationResult => ({ ok: false, reasons, contentHash });

  let text: string;
  try {
    const mammoth = await import('mammoth');
    text = (await mammoth.extractRawText({ buffer: Buffer.from(docxBytes) })).value;
  } catch (err) {
    return fail([`the Word document could not be reopened: ${err instanceof Error ? err.message : 'unreadable file'}`]);
  }
  if (text.trim().length === 0) return fail(['the Word document has no readable text']);

  const claims = resumeClaims(resume);
  const reasons = findResumeClaimProblems(text, claims);

  // A section the snapshot does not have must not appear (an unselected project list, say).
  const lines = text.split(/\r?\n/).map(normalizeResumeWhitespace);
  const expectedHeadings = new Set(claims.filter((claim) => claim.kind === 'heading').map((claim) => claim.text));
  for (const heading of RESUME_SECTION_HEADINGS) {
    if (!expectedHeadings.has(heading) && lines.includes(heading)) {
      reasons.push(`the document has a "${heading}" section the approved CV does not have`);
    }
  }

  // Text the snapshot does not contain is as much a parity failure as missing text.
  const claimTexts = [...new Set(claims.map((claim) => normalizeResumeWhitespace(claim.text)))].sort((a, b) => b.length - a.length);
  const headingTexts = new Set<string>(RESUME_SECTION_HEADINGS);
  for (const line of lines) {
    if (line.length === 0 || headingTexts.has(line)) continue;
    const left = residue(line, claimTexts);
    if (left.length > 0) reasons.push(`the document contains text that is not in the approved CV: "${line.slice(0, 80)}"`);
  }

  return { ok: reasons.length === 0, reasons, contentHash };
}
