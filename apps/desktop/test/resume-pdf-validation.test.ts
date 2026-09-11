import { jsPDF } from 'jspdf';
import { describe, expect, it } from 'vitest';
import type { TailoredResume } from '../electron/resume-schema.js';
import { validateRenderedResumePdf } from '../electron/resume-pdf-validation.js';

/**
 * Builds real, genuinely-extractable PDF bytes (via `jsPDF`, already a dependency for the existing
 * interactive letter export) containing exactly the given lines -- a stand-in for what Electron's
 * `printToPDF` produces from `resume-html.ts`'s template, so this suite can prove
 * `validateRenderedResumePdf`'s extraction logic against real PDF bytes rather than a mock. It does
 * not prove `resume-html.ts`'s specific HTML renders correctly through `printToPDF` itself -- that
 * step needs a real Electron process and is left to code review, the same way this codebase's other
 * Electron-API-only glue (`main.ts`'s `Tray`/`BrowserWindow` construction) already is.
 */
function realPdfContaining(lines: string[]): Uint8Array {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  let y = 50;
  for (const line of lines) {
    doc.text(line, 50, y);
    y += 20;
  }
  return new Uint8Array(doc.output('arraybuffer'));
}

/** A rasterized-image PDF has no text layer at all -- an empty page is the closest realistic
 * stand-in for "no extractable text" without actually embedding an image. */
function blankPdf(): Uint8Array {
  return new Uint8Array(new jsPDF({ unit: 'pt', format: 'a4' }).output('arraybuffer'));
}

const RESUME: TailoredResume = {
  contact: { name: 'Jamie Rivera', title: '', location: '', email: '', phone: '', links: [] },
  summary: '',
  experience: [
    { company: 'Redwood Software', title: 'Senior Frontend Engineer', dates: '', engagement: 'employment', client: '', bullets: [] },
  ],
  projects: [],
  skills: [],
  education: [],
};

describe('validateRenderedResumePdf', () => {
  it('passes when the rendered text contains the candidate name and every employer/role', async () => {
    const pdf = realPdfContaining(['Jamie Rivera', 'Senior Frontend Engineer, Redwood Software']);
    const result = await validateRenderedResumePdf(pdf, RESUME);
    expect(result).toEqual({ ok: true, reasons: [] });
  });

  it('fails on a PDF with no extractable text at all', async () => {
    const result = await validateRenderedResumePdf(blankPdf(), RESUME);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/no extractable text/);
  });

  it('fails when the candidate name is missing from the rendered text', async () => {
    const pdf = realPdfContaining(['Someone Else', 'Senior Frontend Engineer, Redwood Software']);
    const result = await validateRenderedResumePdf(pdf, RESUME);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/candidate name is missing/);
  });

  it('fails when an employer is missing from the rendered text -- the template-dropped-a-section case', async () => {
    const pdf = realPdfContaining(['Jamie Rivera']); // experience section silently missing
    const result = await validateRenderedResumePdf(pdf, RESUME);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/employer "Redwood Software" is missing/);
    expect(result.reasons.join(' ')).toMatch(/role "Senior Frontend Engineer" is missing/);
  });

  it('names every problem found, not just the first', async () => {
    const result = await validateRenderedResumePdf(realPdfContaining(['Someone Else']), RESUME);
    expect(result.reasons.length).toBeGreaterThan(1);
  });

  it('passes for a real Node Buffer, not only a plain Uint8Array (#156)', async () => {
    // `webContents.printToPDF()` -- `printHtmlToPdf`'s own real caller -- resolves to a real Node
    // `Buffer`, not a plain `Uint8Array`, and `unpdf`'s `extractText` rejects a `Buffer` outright
    // even though `Buffer` is itself a `Uint8Array` subclass. Every other test in this file happens
    // to pass a plain `Uint8Array` (`new Uint8Array(doc.output('arraybuffer'))`), so this exact gap
    // was invisible here and only surfaced against a real running Electron process (#156's export
    // action, the first caller to ever exercise this function with a real `printToPDF` `Buffer`).
    const buffer = Buffer.from(realPdfContaining(['Jamie Rivera', 'Senior Frontend Engineer, Redwood Software']));
    expect(buffer).toBeInstanceOf(Buffer);
    const result = await validateRenderedResumePdf(buffer, RESUME);
    expect(result).toEqual({ ok: true, reasons: [] });
  });
});
