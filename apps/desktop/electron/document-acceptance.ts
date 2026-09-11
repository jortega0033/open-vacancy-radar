import { createHash } from 'node:crypto';
import { isAcceptableDocumentLink, sameDocumentLink } from './document-links.js';

/**
 * The shared artifact acceptance contract (#276) for every document this app produces: CVs, cover
 * letters, motivation letters and combined packs. One contract shape, one validator, one set of
 * finding codes -- so a letter can never be waved through on checks a CV has to pass, which is the
 * specific gap the ticket's evidence names (`resume-pdf-validation.ts` checked extractable text and
 * selected names for resumes only; `stageHtmlArtifact` staged letters with no validation at all).
 *
 * What this adds over "is there extractable text": the *rendered geometry*. `unpdf` hands back each
 * text run's position and size in PDF user space, and each page's own media box, so a page that
 * came out blank, a line that ran off the edge of the paper, and two blocks printed on top of each
 * other are all detectable from the finished bytes -- none of which changes the extracted string at
 * all. That is what makes this a layout check rather than a longer substring check.
 *
 * Electron-free at runtime, deliberately: `unpdf` is a pure-JS pdf.js wrapper (see `cv-text.ts`'s
 * own doc comment for why it was chosen), so the exact same function validates a PDF that came from
 * a real `webContents.printToPDF` call and one built by a test fixture. There is no Electron-only
 * branch here to leave untested.
 */

export type DocumentArtifactKind = 'cv' | 'cover_letter' | 'motivation_letter' | 'combined';

export type DocumentFindingCode =
  /** The bytes are not a PDF this app can read back at all. */
  | 'pdf_unreadable'
  /** Readable, but with no text layer anywhere -- a rasterized render, not a document. */
  | 'no_extractable_text'
  /** One page carries no text at all: a page break that shed its content. */
  | 'blank_page'
  | 'too_few_pages'
  | 'too_many_pages'
  /** A section the contract requires never reached the page. */
  | 'required_content_missing'
  /** A text run extends past the page's own media box: it is physically cut off in print. */
  | 'content_clipped'
  /** Two text runs are printed over each other. */
  | 'content_overlapping'
  /** A link the document declares did not survive into the PDF as a usable link. */
  | 'required_link_missing'
  /** The PDF carries a link annotation whose target is not a resolvable http(s)/mailto URL. */
  | 'malformed_link'
  /** The finished document belongs to someone else, or is titled as some other document. */
  | 'wrong_document_identity'
  /** A letter that never names the employer or role it is addressed to. */
  | 'target_not_addressed'
  /** The target employer was written into the candidate's own work history. See `targetRule`. */
  | 'target_company_in_employment_history';

export interface DocumentFinding {
  code: DocumentFindingCode;
  /** One specific, actionable sentence -- never a bare "invalid PDF". Surfaced to the user as the
   * reason an attempt stayed out of `ready`. */
  detail: string;
  /** 1-based, for findings that belong to one page. */
  page?: number;
}

export interface RequiredContentItem {
  /** What this is, for the finding text: "employer", "project", "candidate name". */
  label: string;
  text: string;
}

export interface DocumentTarget {
  company: string;
  role: string;
}

/**
 * How a document is allowed to relate to the vacancy it was produced for.
 *
 * `addresses_target` -- the document is written *to* the employer (a cover or motivation letter, or
 * a combined pack containing one). Naming the company and the role is the entire point, so both are
 * required to appear.
 *
 * `states_own_history` -- the document states the candidate's own record (a CV). #276's fifth
 * acceptance check exists because the obvious way to make "does this PDF mention the target
 * company?" pass for a CV is to write the prospective employer into employment history, which is a
 * false claim about where someone has worked. So a CV is never required to name the company at all;
 * instead the check runs the other way, and a target company that turns up inside the work-history
 * text without being a real prior employer is itself a refusal.
 */
export type DocumentTargetRule = 'addresses_target' | 'states_own_history';

export interface DocumentIdentity {
  /** Whose document this must be. Must appear in the rendered text. */
  candidateName: string;
  /** The title the template stamps into the document, compared against the PDF's own `/Title`
   * metadata when the renderer wrote one. A finished PDF titled for a different person or a
   * different document is the "wrong document attached" case, and no amount of matching body text
   * makes it the right file. */
  documentTitle: string;
}

export interface DocumentAcceptanceContract {
  kind: DocumentArtifactKind;
  identity: DocumentIdentity;
  requiredContent: readonly RequiredContentItem[];
  /** Absolute http(s)/mailto URLs the template turned into real anchors, each of which must survive
   * into the PDF as a resolvable link annotation. */
  requiredLinks: readonly string[];
  target: DocumentTarget | null;
  targetRule: DocumentTargetRule;
  /** Every string the document states as part of the candidate's own work history -- employers,
   * end clients, role titles, bullets, project organizations. Only read for `states_own_history`. */
  employmentHistoryText: readonly string[];
  /** Employers the reviewed source CV actually attests to. A target company that also appears here
   * is a genuine prior employer (someone re-applying), not a fabrication. */
  verifiedEmployers: readonly string[];
  pageBounds: { min: number; max: number };
}

export interface DocumentAcceptance {
  ok: boolean;
  /** sha256 of the exact bytes that were checked. This -- not a hash re-derived later from
   * whatever is on disk at attach time -- is what downstream readiness and upload verification bind
   * to (#276's fourth acceptance check). See `document-readiness.ts`. */
  contentHash: string;
  pageCount: number;
  findings: DocumentFinding[];
}

/** Page-geometry thresholds, in PDF points (1/72 inch). Text extraction reports each run's advance
 * width and font height, both of which carry a little slack around the glyphs themselves, so an
 * exact-intersection test would flag ordinary adjacent runs on the same line. These are set wide
 * enough that normal kerning and line packing never trip them, and narrow enough that a genuinely
 * clipped or overprinted block always does. */
export const DOCUMENT_LAYOUT_TOLERANCES = {
  /** How far past the page edge a run may sit before it counts as cut off. */
  clipPt: 1,
  overlapMinWidthPt: 2,
  overlapMinHeightPt: 2,
  /** Share of the smaller run's area that must be covered before it counts as overprinting. */
  overlapAreaRatio: 0.4,
} as const;

export const DEFAULT_PAGE_BOUNDS: Readonly<Record<DocumentArtifactKind, { min: number; max: number }>> = {
  cv: { min: 1, max: 4 },
  cover_letter: { min: 1, max: 2 },
  motivation_letter: { min: 1, max: 2 },
  combined: { min: 2, max: 6 },
};

export function hashDocumentBytes(bytes: Uint8Array): string {
  // `Uint8Array.from`, not the value as handed in: a caller's `Buffer` is a view onto Node's shared
  // allocation pool, and hashing a view is fine, but every other consumer here needs a standalone
  // copy (see `extractPdfText`'s own note), so one copy is made up front and used throughout.
  return createHash('sha256').update(Uint8Array.from(bytes)).digest('hex');
}

interface TextRun {
  text: string;
  left: number;
  right: number;
  bottom: number;
  top: number;
}

interface PageGeometry {
  pageNumber: number;
  box: { left: number; right: number; bottom: number; top: number };
  runs: TextRun[];
}

interface LinkAnnotation {
  page: number;
  /** Set by pdf.js only when the destination resolved to a valid absolute URL. */
  url: string | null;
  /** The raw, unresolved destination, present whenever the annotation named one at all. */
  unsafeUrl: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Collapses every run of whitespace to a single space. Required, not cosmetic: a paragraph that
 * wraps across lines comes back from pdf.js with a newline mid-sentence, so a raw `includes` of the
 * source text would report perfectly-rendered content as missing the moment it needed two lines.
 */
function normalizeForMatch(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function containsText(haystack: string, needle: string): boolean {
  if (needle.trim().length === 0) return true;
  return normalizeForMatch(haystack).includes(normalizeForMatch(needle));
}

function containsCaseInsensitive(haystack: string, needle: string): boolean {
  if (needle.trim().length === 0) return true;
  return normalizeForMatch(haystack).toLowerCase().includes(normalizeForMatch(needle).toLowerCase());
}

function intersectionLength(aMin: number, aMax: number, bMin: number, bMax: number): number {
  return Math.max(0, Math.min(aMax, bMax) - Math.max(aMin, bMin));
}

/**
 * Two runs count as overprinting only when they cover a real, two-dimensional patch of each other.
 * Adjacent runs on one line share an edge (zero-width intersection) and a superscript clips a
 * corner of its neighbour, and neither is a layout bug.
 */
function runsOverlap(a: TextRun, b: TextRun): boolean {
  const width = intersectionLength(a.left, a.right, b.left, b.right);
  const height = intersectionLength(a.bottom, a.top, b.bottom, b.top);
  if (width < DOCUMENT_LAYOUT_TOLERANCES.overlapMinWidthPt) return false;
  if (height < DOCUMENT_LAYOUT_TOLERANCES.overlapMinHeightPt) return false;
  const areaA = (a.right - a.left) * (a.top - a.bottom);
  const areaB = (b.right - b.left) * (b.top - b.bottom);
  const smaller = Math.min(areaA, areaB);
  if (smaller <= 0) return false;
  return (width * height) / smaller >= DOCUMENT_LAYOUT_TOLERANCES.overlapAreaRatio;
}

interface RenderedPdf {
  pageCount: number;
  text: string;
  pages: PageGeometry[];
  links: LinkAnnotation[];
  /** The PDF's own `/Title`, when the renderer wrote one. Chromium's `printToPDF` takes it from
   * the HTML `<title>`; a fixture can set it directly. Null when the document declares none, which
   * is not itself a fault -- the identity check simply has one fewer signal to work with. */
  title: string | null;
}

/**
 * Reads back everything the acceptance checks need from one PDF, in a single pdf.js document
 * session. Geometry comes from the text runs' own transforms rather than a rendered raster, so no
 * canvas (and so no native `@napi-rs/canvas` build) is ever needed -- the same constraint that
 * decided `unpdf` over `pdfjs-dist` in `cv-text.ts`.
 */
/** Two runs belong to the same printed line when their baselines are within this many points --
 * enough to absorb the sub-point baseline jitter a renderer introduces between runs of different
 * font sizes on one line, well under any real line height. */
const LINE_TOLERANCE_PT = 3;

/** Below this gap two runs are parts of one word (a renderer is free to split a word into several
 * runs for kerning); at or above it they are separate words with a space between them. */
const WORD_GAP_PT = 1;

/**
 * Rebuilds the page's text in the order a reader sees it, from the runs' own coordinates, rather
 * than taking the order they happen to appear in the content stream.
 *
 * Not a refinement: the two genuinely differ. A two-column entry head (a wrapping role title on the
 * left, the dates on the right) is emitted by Chromium with the dates in the middle of the title's
 * wrapped lines, which splits the employer name in the extracted string and makes a perfectly
 * well-rendered document look like it lost content. Reading order puts the dates back at the end of
 * the line they are printed on, and the title's own lines back together.
 */
function readingOrderText(runs: readonly TextRun[]): string {
  const lines: TextRun[][] = [];
  for (const run of [...runs].sort((a, b) => b.bottom - a.bottom)) {
    const current = lines[lines.length - 1];
    const first = current?.[0];
    if (current !== undefined && first !== undefined && Math.abs(first.bottom - run.bottom) <= LINE_TOLERANCE_PT) current.push(run);
    else lines.push([run]);
  }

  return lines
    .map((line) => {
      let text = '';
      let previousRight = Number.NEGATIVE_INFINITY;
      for (const run of [...line].sort((a, b) => a.left - b.left)) {
        if (text.length > 0 && run.left - previousRight >= WORD_GAP_PT) text += ' ';
        text += run.text;
        previousRight = run.right;
      }
      return text;
    })
    .join('\n');
}

async function readRenderedPdf(bytes: Uint8Array): Promise<RenderedPdf> {
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(Uint8Array.from(bytes));
  try {
    const metadata = await pdf.getMetadata();
    const info: unknown = metadata.info;
    const title = isRecord(info) ? optionalString(info.Title) : null;

    const pages: PageGeometry[] = [];
    const links: LinkAnnotation[] = [];
    const pageTexts: string[] = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      // `page.view` is the crop box as [x0, y0, x1, y1] in the same user space the text
      // transforms below are expressed in. `getViewport()` would apply page rotation and flip the
      // y axis, which would have to be undone again to compare against those transforms.
      const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = page.view;

      const content = await page.getTextContent();
      const runs: TextRun[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        if (item.str.trim().length === 0) continue;
        // transform is [a, b, c, d, e, f]; e/f are the run's origin on the text baseline. Width is
        // the run's advance and height the transformed font height, both already in user space.
        const left = item.transform[4] as number;
        const bottom = item.transform[5] as number;
        runs.push({
          text: item.str,
          left,
          right: left + Math.abs(item.width),
          bottom,
          top: bottom + Math.abs(item.height),
        });
      }
      pageTexts.push(readingOrderText(runs));
      pages.push({
        pageNumber,
        box: { left: Math.min(x0, x1), right: Math.max(x0, x1), bottom: Math.min(y0, y1), top: Math.max(y0, y1) },
        runs,
      });

      // pdf.js types `getAnnotations()` as `Array<any>` (annotation shape varies by subtype), so it
      // is read as `unknown` here and narrowed explicitly rather than trusted.
      const annotations: readonly unknown[] = await page.getAnnotations();
      for (const annotation of annotations) {
        if (!isRecord(annotation) || annotation.subtype !== 'Link') continue;
        const url = optionalString(annotation.url);
        const unsafeUrl = optionalString(annotation.unsafeUrl);
        if (url === null && unsafeUrl === null) continue; // an internal jump, not an external link
        links.push({ page: pageNumber, url, unsafeUrl });
      }
    }

    return { pageCount: pdf.numPages, text: pageTexts.join('\n'), pages, links, title };
  } finally {
    // Through the loading task, matching unpdf's own `withDocument` helper: that is what actually
    // terminates the pdf.js worker, and leaking one per validated document would keep the process
    // alive after a test run finishes.
    await pdf.loadingTask.destroy();
  }
}

function checkPageBounds(rendered: RenderedPdf, contract: DocumentAcceptanceContract, findings: DocumentFinding[]): void {
  if (rendered.pageCount < contract.pageBounds.min) {
    findings.push({
      code: 'too_few_pages',
      detail: `the document is ${rendered.pageCount} page(s); a ${contract.kind} needs at least ${contract.pageBounds.min}`,
    });
  }
  if (rendered.pageCount > contract.pageBounds.max) {
    findings.push({
      code: 'too_many_pages',
      detail: `the document ran to ${rendered.pageCount} pages; a ${contract.kind} is capped at ${contract.pageBounds.max}`,
    });
  }
}

function checkLayout(rendered: RenderedPdf, findings: DocumentFinding[]): void {
  for (const page of rendered.pages) {
    if (page.runs.length === 0) {
      findings.push({ code: 'blank_page', detail: 'this page carries no text at all', page: page.pageNumber });
      continue;
    }

    for (const run of page.runs) {
      const tolerance = DOCUMENT_LAYOUT_TOLERANCES.clipPt;
      const clipped =
        run.left < page.box.left - tolerance ||
        run.right > page.box.right + tolerance ||
        run.bottom < page.box.bottom - tolerance ||
        run.top > page.box.top + tolerance;
      if (clipped) {
        findings.push({
          code: 'content_clipped',
          detail: `"${run.text.trim().slice(0, 60)}" extends past the edge of the page and is cut off in print`,
          page: page.pageNumber,
        });
      }
    }

    // Sorted top-down so the scan can stop as soon as the next run starts below the current one's
    // bottom edge: nothing further down the page can reach back up into it.
    const sorted = [...page.runs].sort((a, b) => b.top - a.top);
    for (let i = 0; i < sorted.length; i += 1) {
      const current = sorted[i] as TextRun;
      for (let j = i + 1; j < sorted.length; j += 1) {
        const other = sorted[j] as TextRun;
        if (other.top <= current.bottom) break;
        if (runsOverlap(current, other)) {
          findings.push({
            code: 'content_overlapping',
            detail: `"${current.text.trim().slice(0, 40)}" and "${other.text.trim().slice(0, 40)}" are printed on top of each other`,
            page: page.pageNumber,
          });
        }
      }
    }
  }
}

function checkLinks(rendered: RenderedPdf, contract: DocumentAcceptanceContract, findings: DocumentFinding[]): void {
  for (const link of rendered.links) {
    if (link.url === null || !isAcceptableDocumentLink(link.url)) {
      findings.push({
        code: 'malformed_link',
        detail: `the document carries a link to "${link.url ?? link.unsafeUrl ?? ''}", which is not a usable http(s)/mailto address`,
        page: link.page,
      });
    }
  }

  for (const required of contract.requiredLinks) {
    const present = rendered.links.some((link) => link.url !== null && sameDocumentLink(link.url, required));
    if (!present) {
      findings.push({
        code: 'required_link_missing',
        detail: `"${required}" is in the document's content but did not survive into the PDF as a clickable link`,
      });
    }
  }
}

function checkIdentity(rendered: RenderedPdf, contract: DocumentAcceptanceContract, findings: DocumentFinding[]): void {
  const { candidateName, documentTitle } = contract.identity;
  if (candidateName.trim().length > 0 && !containsText(rendered.text, candidateName)) {
    findings.push({
      code: 'wrong_document_identity',
      detail: `the candidate name "${candidateName}" is missing from the rendered document, so this is not this candidate's document`,
    });
  }
  if (rendered.title !== null && documentTitle.trim().length > 0 && !containsCaseInsensitive(rendered.title, documentTitle)) {
    findings.push({
      code: 'wrong_document_identity',
      detail: `the PDF is titled "${rendered.title}" but this artifact should be "${documentTitle}"`,
    });
  }
}

function checkTarget(rendered: RenderedPdf, contract: DocumentAcceptanceContract, findings: DocumentFinding[]): void {
  const target = contract.target;
  if (target === null) return;

  if (contract.targetRule === 'addresses_target') {
    if (!containsCaseInsensitive(rendered.text, target.company)) {
      findings.push({ code: 'target_not_addressed', detail: `a ${contract.kind} must name "${target.company}", and this one does not` });
    }
    if (!containsCaseInsensitive(rendered.text, target.role)) {
      findings.push({ code: 'target_not_addressed', detail: `a ${contract.kind} must name the "${target.role}" role, and this one does not` });
    }
    return;
  }

  const isPriorEmployer = contract.verifiedEmployers.some((employer) => sameDocumentLink(employer, target.company));
  if (isPriorEmployer) return;
  const fabricated = contract.employmentHistoryText.find((entry) => containsCaseInsensitive(entry, target.company));
  if (fabricated !== undefined) {
    findings.push({
      code: 'target_company_in_employment_history',
      detail: `"${target.company}" is the employer being applied to, but it appears in this document's own work history ("${fabricated.trim().slice(0, 80)}")`,
    });
  }
}

/**
 * Runs the whole contract against one finished PDF and reports every problem found, never just the
 * first: a caller fixing a template wants the full list, and a caller refusing an attempt wants to
 * tell the user everything that is wrong with the document rather than one round trip per fault.
 */
export async function acceptRenderedDocument(
  bytes: Uint8Array,
  contract: DocumentAcceptanceContract,
): Promise<DocumentAcceptance> {
  const contentHash = hashDocumentBytes(bytes);

  let rendered: RenderedPdf;
  try {
    rendered = await readRenderedPdf(bytes);
  } catch {
    return {
      ok: false,
      contentHash,
      pageCount: 0,
      findings: [{ code: 'pdf_unreadable', detail: 'the rendered PDF could not be read back at all -- it may not be a PDF, or may be truncated' }],
    };
  }

  const findings: DocumentFinding[] = [];

  if (rendered.text.trim().length === 0) {
    findings.push({ code: 'no_extractable_text', detail: 'the rendered PDF contains no extractable text -- it may have rendered as an image, not real text' });
  }

  checkPageBounds(rendered, contract, findings);
  checkLayout(rendered, findings);

  for (const required of contract.requiredContent) {
    if (required.text.trim().length === 0) continue;
    if (!containsText(rendered.text, required.text)) {
      findings.push({ code: 'required_content_missing', detail: `${required.label} "${required.text}" is missing from the rendered document` });
    }
  }

  checkLinks(rendered, contract, findings);
  checkIdentity(rendered, contract, findings);
  checkTarget(rendered, contract, findings);

  return { ok: findings.length === 0, contentHash, pageCount: rendered.pageCount, findings };
}
