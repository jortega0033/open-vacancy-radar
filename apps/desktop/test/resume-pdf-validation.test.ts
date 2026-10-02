import { jsPDF } from 'jspdf';
import { describe, expect, it } from 'vitest';
import type { TailoredResume } from '../electron/resume-schema.js';
import { squashForMatch } from '../electron/document-acceptance.js';
import { validateRenderedResumePdf } from '../electron/resume-pdf-validation.js';

/**
 * Builds real, genuinely-extractable PDF bytes (via `jsPDF`, already a dependency for the existing
 * interactive letter export) containing exactly the given lines -- a stand-in for what Electron's
 * `printToPDF` produces from `resume-html.ts`'s template, so this suite can prove
 * `validateRenderedResumePdf`'s extraction logic against real PDF bytes rather than a mock.
 *
 * This file stays focused on the resume-shaped entry point and the reasons it reports. Since #276
 * the checks themselves live in the shared document acceptance contract, covered by
 * `document-acceptance.test.ts` (every finding, against controlled fixtures) and
 * `e2e/document-acceptance.spec.ts` (this app's own templates through a real Electron
 * `printToPDF`, which needs a real Electron process and so runs in the Playwright suite).
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
    expect(result).toEqual({ ok: true, reasons: [], contentHash: expect.stringMatching(/^[0-9a-f]{64}$/), pageCount: 1 });
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
    // Since #276 this is reported as a document-identity failure rather than one more missing
    // string: a finished CV carrying someone else's name is the wrong file, not an incomplete one.
    expect(result.reasons.join(' ')).toMatch(/candidate name "Jamie Rivera" is missing/);
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
    expect(result).toEqual({ ok: true, reasons: [], contentHash: expect.stringMatching(/^[0-9a-f]{64}$/), pageCount: 1 });
  });
});

/**
 * #434: the PDF is held to the same claim list as the Word file. The PDFs here are built by `jsPDF`
 * from the claim list in the order the template lays it out. Chromium's own `printToPDF` output for
 * the same data is checked in `e2e/document-acceptance.spec.ts`, which needs a real Electron process.
 */
const FULL: TailoredResume = {
  contact: {
    name: 'Jamie Rivera',
    title: 'Frontend engineer',
    location: 'Utrecht, Netherlands',
    email: 'jamie.rivera@example.invalid',
    phone: '+31 6 0000 0000',
    links: ['example.invalid/jamie'],
  },
  summary: 'Frontend engineer who builds booking and reporting screens.',
  experience: [
    {
      company: 'Redwood Software',
      title: 'Senior Frontend Engineer',
      dates: '2021 - Present',
      engagement: 'employment',
      client: '',
      bullets: ['Built the booking screens, using Angular', 'Kept the reporting screens fast'],
    },
  ],
  projects: [
    {
      name: 'Toolkit',
      role: 'Maintainer',
      dates: '2023',
      organization: 'Open source',
      description: 'A component toolkit.',
      technologies: ['TypeScript', 'React'],
      links: ['example.invalid/toolkit'],
    },
  ],
  skills: ['TypeScript', 'Angular', 'RxJS'],
  education: [{ institution: 'Utrecht University', credential: 'BSc Computer Science', dates: '2014 - 2018' }],
};

const FULL_LINES = [
  'Jamie Rivera',
  'Frontend engineer',
  'Utrecht, Netherlands  jamie.rivera@example.invalid',
  '+31 6 0000 0000  example.invalid/jamie',
  'Frontend engineer who builds booking and reporting screens.',
  'EXPERIENCE',
  'Senior Frontend Engineer, Redwood Software   2021 - Present',
  'Built the booking screens, using Angular',
  'Kept the reporting screens fast',
  'PROJECTS',
  'Toolkit   2023',
  'Maintainer, Open source',
  'A component toolkit.',
  'TypeScript, React  example.invalid/toolkit',
  'SKILLS',
  'TypeScript, Angular, RxJS',
  'EDUCATION',
  'BSc Computer Science, Utrecht University   2014 - 2018',
];

describe('validateRenderedResumePdf claim parity (#434)', () => {
  it('passes a faithful render of every claim, with the headings in capitals', async () => {
    const result = await validateRenderedResumePdf(realPdfContaining(FULL_LINES), FULL);
    expect(result.reasons).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it.each([
    ['bullet', 'Kept the reporting screens fast', /bullet "Kept the reporting screens fast" is missing/],
    ['summary', 'Frontend engineer who builds booking and reporting screens.', /summary "Frontend engineer who builds booking and reporting screens\." is missing/],
    ['skill', 'TypeScript, Angular, RxJS', /skill "Angular" is missing/],
    ['project description', 'A component toolkit.', /project description "A component toolkit\." is missing/],
    ['education date', 'BSc Computer Science, Utrecht University   2014 - 2018', /credential "BSc Computer Science" is missing/],
  ])('fails when the %s was dropped from the render', async (_label, droppedLine, expected) => {
    const lines = FULL_LINES.filter((line) => line !== droppedLine);
    const result = await validateRenderedResumePdf(realPdfContaining(lines), FULL);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' | ')).toMatch(expected);
  });

  it('needs one occurrence per claim, so a bullet repeated in the approved CV cannot be satisfied by one', async () => {
    const twice: TailoredResume = {
      ...FULL,
      experience: [{ ...FULL.experience[0]!, bullets: ['Kept the reporting screens fast', 'Kept the reporting screens fast'] }],
    };
    const result = await validateRenderedResumePdf(realPdfContaining(FULL_LINES), twice);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/bullet "Kept the reporting screens fast" is missing/);
  });

  it('does not fail a correct render because of line wraps, hyphenation, spacing or case in the extraction', async () => {
    const lines = FULL_LINES.flatMap((line) => {
      if (line === 'Built the booking screens, using Angular') return ['Built the booking', 'screens, us-', 'ing   Angular'];
      if (line === 'Frontend engineer who builds booking and reporting screens.') return ['FRONTEND ENGINEER WHO BUILDS', 'booking and reporting', 'screens.'];
      return [line];
    });
    const result = await validateRenderedResumePdf(realPdfContaining(lines), FULL);
    expect(result.reasons).toEqual([]);
  });

  it('does not report the same missing role or employer twice', async () => {
    const result = await validateRenderedResumePdf(realPdfContaining(['Jamie Rivera']), FULL);
    const employer = result.reasons.filter((reason) => reason.includes('"Redwood Software"'));
    expect(employer).toHaveLength(1);
  });
});

describe('squashForMatch (#434)', () => {
  it('folds ligatures, soft hyphens, quotes, dashes and whitespace the way extraction mangles them', () => {
    expect(squashForMatch('eﬃcient work­ flow')).toBe(squashForMatch('efficient  workflow'));
    expect(squashForMatch('Don’t “ship” it')).toBe(squashForMatch('Don\'t "ship" it'));
    expect(squashForMatch('co-\nordinated')).toBe(squashForMatch('coordinated'));
  });
});
