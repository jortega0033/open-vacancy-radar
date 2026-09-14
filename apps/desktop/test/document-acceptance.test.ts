import { jsPDF } from 'jspdf';
import { describe, expect, it } from 'vitest';
import { acceptRenderedDocument, hashDocumentBytes, type DocumentFindingCode } from '../electron/document-acceptance.js';
import { letterAcceptanceContract, resumeAcceptanceContract } from '../electron/document-contracts.js';
import type { TailoredResume } from '../electron/resume-schema.js';

/**
 * #276's controlled fixtures. Every PDF here is real, readable output built with `jsPDF` (already a
 * dependency for the interactive letter export) and placed at exact coordinates, which is the only
 * way to produce the specific bad layouts this contract exists to catch: a page that came out
 * blank, a line printed past the edge of the paper, two blocks overprinted. A renderer cannot be
 * asked for those on demand, so they are constructed.
 *
 * The other half of the evidence -- that the real Electron `printToPDF` output of this app's own
 * templates passes these same checks, including for long titles, multi-page experience and pinned
 * projects -- lives in `e2e/document-acceptance.spec.ts`, which drives the real app. Neither test
 * replaces the other: this one proves each check actually fires, that one proves the real
 * documents satisfy them.
 *
 * All fixture data is synthetic. `.invalid` and `.example` are reserved, never-resolving domains.
 */

interface FixtureRun {
  text: string;
  /** Points from the left edge. */
  x: number;
  /** Points from the top edge, as `jsPDF` measures. */
  y: number;
  link?: string;
}

const A4_WIDTH_PT = 595.28;

function buildPdf(pages: FixtureRun[][], options: { title?: string } = {}): Uint8Array {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  if (options.title !== undefined) doc.setProperties({ title: options.title });
  doc.setFontSize(11);
  pages.forEach((runs, index) => {
    if (index > 0) doc.addPage();
    for (const run of runs) {
      if (run.link === undefined) doc.text(run.text, run.x, run.y);
      else doc.textWithLink(run.text, run.x, run.y, { url: run.link });
    }
  });
  return new Uint8Array(doc.output('arraybuffer'));
}

/** Lays text out down the page the way a real template would, so a fixture that is *supposed* to be
 * well-formed genuinely is: no run past a margin, none on top of another. */
function flowedPage(lines: string[], startY = 60): FixtureRun[] {
  return lines.map((text, index) => ({ text, x: 56, y: startY + index * 18 }));
}

const RESUME: TailoredResume = {
  contact: {
    name: 'Jamie Rivera',
    title: 'Senior Frontend Engineer',
    location: 'Amsterdam, Netherlands',
    email: 'jamie@example.invalid',
    phone: '+31 6 1234 5678',
    links: ['https://github.example/jamie'],
  },
  summary: 'Frontend engineer with eight years building design systems.',
  experience: [
    {
      company: 'Redwood Software',
      title: 'Senior Frontend Engineer',
      dates: '2021 - Present',
      engagement: 'employment',
      client: '',
      bullets: ['Led the design system rewrite.'],
    },
  ],
  projects: [{ name: 'Atlas Design Tokens', role: 'Lead', dates: '2023', organization: 'Redwood Software', description: 'A token pipeline.', technologies: ['TypeScript'], links: [] }],
  skills: ['TypeScript'],
  education: [],
};

/** Everything the CV contract requires, laid out cleanly on one page. The baseline every negative
 * fixture below is a single deliberate mutation of. */
const GOOD_RESUME_PAGE: FixtureRun[] = [
  { text: 'Jamie Rivera', x: 56, y: 60 },
  { text: 'Senior Frontend Engineer', x: 56, y: 80 },
  { text: 'Amsterdam, Netherlands', x: 56, y: 100 },
  { text: 'https://github.example/jamie', x: 56, y: 120, link: 'https://github.example/jamie' },
  { text: 'Redwood Software', x: 56, y: 150 },
  { text: '2021 - Present', x: 56, y: 170 },
  { text: 'Led the design system rewrite.', x: 56, y: 190 },
  { text: 'Atlas Design Tokens', x: 56, y: 220 },
];

function codes(findings: Array<{ code: DocumentFindingCode }>): DocumentFindingCode[] {
  return findings.map((finding) => finding.code);
}

const CV_CONTRACT = resumeAcceptanceContract(RESUME);

describe('acceptRenderedDocument -- controlled fixtures (#276 acceptance check 1)', () => {
  it('accepts a well-formed document that satisfies the whole contract', async () => {
    const result = await acceptRenderedDocument(buildPdf([GOOD_RESUME_PAGE]), CV_CONTRACT);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.pageCount).toBe(1);
  });

  it('catches a blank page -- a page break that shed its content', async () => {
    const result = await acceptRenderedDocument(buildPdf([GOOD_RESUME_PAGE, []]), CV_CONTRACT);
    expect(codes(result.findings)).toContain('blank_page');
    expect(result.findings.find((finding) => finding.code === 'blank_page')?.page).toBe(2);
    expect(result.ok).toBe(false);
  });

  it('catches a document that overflowed past its page budget', async () => {
    const pages = [GOOD_RESUME_PAGE, ...Array.from({ length: 4 }, () => flowedPage(['continued']))];
    const result = await acceptRenderedDocument(buildPdf(pages), CV_CONTRACT);
    expect(codes(result.findings)).toContain('too_many_pages');
  });

  it('catches content that runs off the edge of the page, even though it extracts fine', async () => {
    const clipped = [...GOOD_RESUME_PAGE, { text: 'Principal Engineer, Platform Enablement Group', x: A4_WIDTH_PT - 40, y: 250 }];
    const result = await acceptRenderedDocument(buildPdf([clipped]), CV_CONTRACT);
    expect(codes(result.findings)).toContain('content_clipped');
    expect(result.findings.find((finding) => finding.code === 'content_clipped')?.detail).toMatch(/cut off in print/);
  });

  it('catches required content that never reached the page', async () => {
    const withoutProject = GOOD_RESUME_PAGE.filter((run) => run.text !== 'Atlas Design Tokens');
    const result = await acceptRenderedDocument(buildPdf([withoutProject]), CV_CONTRACT);
    expect(codes(result.findings)).toContain('required_content_missing');
    expect(result.findings.map((finding) => finding.detail).join(' ')).toMatch(/project "Atlas Design Tokens" is missing/);
  });

  it('catches a malformed link the renderer could not resolve to a usable address', async () => {
    const withBadLink = [...GOOD_RESUME_PAGE, { text: 'portfolio', x: 56, y: 250, link: 'htp://typo.example/jamie' }];
    const result = await acceptRenderedDocument(buildPdf([withBadLink]), CV_CONTRACT);
    expect(codes(result.findings)).toContain('malformed_link');
  });

  it('refuses a script-scheme link annotation rather than treating it as an ordinary link', async () => {
    const withScriptLink = [...GOOD_RESUME_PAGE, { text: 'click', x: 56, y: 250, link: 'javascript:alert(1)' }];
    const result = await acceptRenderedDocument(buildPdf([withScriptLink]), CV_CONTRACT);
    expect(codes(result.findings)).toContain('malformed_link');
  });

  it('catches a link that survived as text but not as a clickable link', async () => {
    const textOnlyLink = GOOD_RESUME_PAGE.map((run) => (run.link === undefined ? run : { ...run, link: undefined }));
    const result = await acceptRenderedDocument(buildPdf([textOnlyLink]), CV_CONTRACT);
    expect(codes(result.findings)).toContain('required_link_missing');
  });

  it('catches the wrong document identity -- a finished PDF that is someone else\'s', async () => {
    const someoneElse = GOOD_RESUME_PAGE.map((run) => (run.text === 'Jamie Rivera' ? { ...run, text: 'Priya Raman' } : run));
    const result = await acceptRenderedDocument(buildPdf([someoneElse]), CV_CONTRACT);
    expect(codes(result.findings)).toContain('wrong_document_identity');
  });

  it('catches a document whose own title names a different document, even when the body text matches', async () => {
    const result = await acceptRenderedDocument(buildPdf([GOOD_RESUME_PAGE], { title: 'Priya Raman' }), CV_CONTRACT);
    expect(codes(result.findings)).toEqual(['wrong_document_identity']);
    expect(result.findings[0]?.detail).toMatch(/titled "Priya Raman"/);
  });

  it('accepts a document whose title is the one this artifact should carry', async () => {
    const result = await acceptRenderedDocument(buildPdf([GOOD_RESUME_PAGE], { title: 'Jamie Rivera' }), CV_CONTRACT);
    expect(result.ok).toBe(true);
  });

  it('catches a PDF with no text layer at all', async () => {
    const result = await acceptRenderedDocument(buildPdf([[]]), CV_CONTRACT);
    expect(codes(result.findings)).toContain('no_extractable_text');
  });

  it('reports unreadable bytes as one clear finding rather than throwing', async () => {
    const result = await acceptRenderedDocument(new Uint8Array([1, 2, 3, 4]), CV_CONTRACT);
    expect(codes(result.findings)).toEqual(['pdf_unreadable']);
    expect(result.pageCount).toBe(0);
  });

  it('names every problem found, not just the first', async () => {
    const broken = [{ text: 'Priya Raman', x: 56, y: 60 }];
    const result = await acceptRenderedDocument(buildPdf([broken]), CV_CONTRACT);
    expect(new Set(codes(result.findings)).size).toBeGreaterThan(1);
  });

  it('accepts a real Node Buffer, not only a plain Uint8Array (#156)', async () => {
    // `webContents.printToPDF()` resolves to a real Node `Buffer`, and unpdf rejects a `Buffer`
    // outright even though `Buffer` is itself a `Uint8Array` subclass.
    const buffer = Buffer.from(buildPdf([GOOD_RESUME_PAGE]));
    expect(buffer).toBeInstanceOf(Buffer);
    const result = await acceptRenderedDocument(buffer, CV_CONTRACT);
    expect(result.ok).toBe(true);
  });
});

describe('acceptRenderedDocument -- real layout, not extracted text length (#276 acceptance check 2)', () => {
  it('catches two blocks printed on top of each other', async () => {
    const overprinted = [
      ...GOOD_RESUME_PAGE,
      { text: 'Staff Engineer, Developer Platform', x: 56, y: 250 },
      { text: 'January 2019 - December 2021', x: 70, y: 250 },
    ];
    const result = await acceptRenderedDocument(buildPdf([overprinted]), CV_CONTRACT);
    expect(codes(result.findings)).toContain('content_overlapping');
    expect(result.findings.find((finding) => finding.code === 'content_overlapping')?.detail).toMatch(/printed on top of each other/);
  });

  it('does not mistake ordinary adjacent runs on one line for overprinting', async () => {
    const sameLine = [
      ...GOOD_RESUME_PAGE,
      { text: 'Staff Engineer, Developer Platform', x: 56, y: 250 },
      { text: '2019 - 2021', x: 400, y: 250 },
    ];
    const result = await acceptRenderedDocument(buildPdf([sameLine]), CV_CONTRACT);
    expect(codes(result.findings)).not.toContain('content_overlapping');
  });

  it('refuses a clipped document whose extracted text nonetheless contains every required string', async () => {
    // The exact failure mode the ticket names: "readable PDF text does not prove the document
    // retained usable layout". Every string the contract asks for is present and extractable here;
    // the document is refused anyway, purely because a line is printed off the edge of the paper.
    const clipped = [...GOOD_RESUME_PAGE, { text: 'References available on request', x: A4_WIDTH_PT - 40, y: 250 }];
    const result = await acceptRenderedDocument(buildPdf([clipped]), CV_CONTRACT);
    expect(codes(result.findings)).toEqual(['content_clipped']);
    expect(codes(result.findings)).not.toContain('required_content_missing');
    expect(result.ok).toBe(false);
  });

  it('reads content in the order it is printed, not the order it was written to the file', async () => {
    // A two-column entry head emits the date column in the middle of a wrapping title's lines, so
    // the employer name arrives split in two in the raw stream and a perfectly well-rendered
    // document looks like it lost content. Reconstructing reading order from the runs' own
    // coordinates is what makes the content check describe the printed page rather than the file.
    const interleaved: FixtureRun[] = [
      { text: 'Jamie Rivera', x: 56, y: 60 },
      { text: 'Senior Frontend Engineer', x: 56, y: 80 },
      { text: 'Amsterdam, Netherlands', x: 56, y: 100 },
      { text: 'https://github.example/jamie', x: 56, y: 120, link: 'https://github.example/jamie' },
      { text: 'Redwood', x: 56, y: 150 },
      { text: '2021 - Present', x: 400, y: 150 }, // written second, printed to the right of "Redwood"
      { text: 'Software', x: 130, y: 150 }, // written last, printed between the two above
      { text: 'Led the design system rewrite.', x: 56, y: 190 },
      { text: 'Atlas Design Tokens', x: 56, y: 220 },
    ];
    const result = await acceptRenderedDocument(buildPdf([interleaved]), CV_CONTRACT);
    expect(result.findings).toEqual([]);
  });

  it('accepts a long-title, multi-page, pinned-project CV laid out properly across three pages', async () => {
    const longTitle = 'Senior Staff Frontend Engineer, Design Systems and Developer Experience Platform';
    const manyJobs: TailoredResume = {
      ...RESUME,
      contact: { ...RESUME.contact, title: longTitle },
      experience: Array.from({ length: 6 }, (_unused, index) => ({
        company: `Employer ${index + 1}`,
        title: longTitle,
        dates: `${2010 + index} - ${2011 + index}`,
        engagement: 'employment' as const,
        client: '',
        bullets: [`Shipped release ${index + 1}.`],
      })),
      projects: Array.from({ length: 3 }, (_unused, index) => ({
        name: `Pinned Project ${index + 1}`,
        role: 'Lead',
        dates: '2023',
        organization: 'Redwood Software',
        description: 'Synthetic project description.',
        technologies: ['TypeScript'],
        links: [],
      })),
    };
    // Wrapped to a width that fits the margins, exactly as a template would lay a long title out.
    const lines = [
      'Jamie Rivera',
      'Senior Staff Frontend Engineer, Design Systems and',
      'Developer Experience Platform',
      'https://github.example/jamie',
      ...manyJobs.experience.flatMap((entry) => [`Employer: ${entry.company}`, 'Senior Staff Frontend Engineer, Design Systems and', 'Developer Experience Platform', entry.dates, ...entry.bullets]),
      ...manyJobs.projects.map((project) => project.name),
    ];
    const perPage = 16;
    const pages: FixtureRun[][] = [];
    for (let start = 0; start < lines.length; start += perPage) {
      const slice = lines.slice(start, start + perPage);
      const runs = flowedPage(slice);
      if (start === 0) runs[3] = { ...(runs[3] as FixtureRun), link: 'https://github.example/jamie' };
      pages.push(runs);
    }

    const result = await acceptRenderedDocument(buildPdf(pages), resumeAcceptanceContract(manyJobs));
    expect(result.findings).toEqual([]);
    expect(result.pageCount).toBeGreaterThan(1);
  });
});

describe('letter acceptance -- equivalent applicable checks (#276 acceptance check 3)', () => {
  const LETTER = letterAcceptanceContract({
    kind: 'cover_letter',
    title: 'Cover Letter',
    body: 'Dear Northwind Freight hiring team,\n\nI am applying for the Logistics Platform Engineer role.',
    candidateName: 'Jamie Rivera',
    target: { company: 'Northwind Freight', role: 'Logistics Platform Engineer' },
  });

  const GOOD_LETTER_PAGE: FixtureRun[] = flowedPage([
    'Cover Letter',
    'Dear Northwind Freight hiring team,',
    'I am applying for the Logistics Platform Engineer role.',
    'Jamie Rivera',
  ]);

  it('accepts a well-formed letter', async () => {
    const result = await acceptRenderedDocument(buildPdf([GOOD_LETTER_PAGE], { title: 'Cover Letter' }), LETTER);
    expect(result.findings).toEqual([]);
  });

  it('applies the same blank-page, clipping, overprinting and identity checks a CV gets', async () => {
    const broken: FixtureRun[] = [
      ...GOOD_LETTER_PAGE.filter((run) => run.text !== 'Jamie Rivera'),
      { text: 'a closing line that runs past the right margin', x: A4_WIDTH_PT - 40, y: 160 },
      { text: 'overlapping block one', x: 56, y: 200 },
      { text: 'overlapping block two', x: 66, y: 200 },
    ];
    const result = await acceptRenderedDocument(buildPdf([broken, []], { title: 'Cover Letter' }), LETTER);
    const found = new Set(codes(result.findings));
    expect(found).toContain('blank_page');
    expect(found).toContain('content_clipped');
    expect(found).toContain('content_overlapping');
    expect(found).toContain('wrong_document_identity');
  });

  it('refuses a letter whose own opening paragraph never reached the page', async () => {
    const withoutOpening = GOOD_LETTER_PAGE.filter((run) => !run.text.startsWith('Dear '));
    const result = await acceptRenderedDocument(buildPdf([withoutOpening], { title: 'Cover Letter' }), LETTER);
    expect(codes(result.findings)).toContain('required_content_missing');
  });

  it('refuses a letter that never names the employer or role it is addressed to', async () => {
    const generic = flowedPage(['Cover Letter', 'Dear hiring team,', 'I am applying for the role.', 'Jamie Rivera']);
    const result = await acceptRenderedDocument(buildPdf([generic], { title: 'Cover Letter' }), LETTER);
    expect(codes(result.findings)).toContain('target_not_addressed');
  });

  it('refuses a blank letter, which the pre-#276 generic staging path registered without a single check', async () => {
    const result = await acceptRenderedDocument(buildPdf([[]]), LETTER);
    const found = new Set(codes(result.findings));
    expect(found).toContain('no_extractable_text');
    expect(found).toContain('blank_page');
  });
});

describe('target metadata without fabricating an employer (#276 acceptance check 5)', () => {
  const TARGET = { company: 'Northwind Freight', role: 'Logistics Platform Engineer' };

  it('accepts a CV that never mentions the employer being applied to', async () => {
    // The point of the check. A CV states where someone has worked; the vacancy it was sent to is
    // not part of that, so a CV is never required to name it and nothing is under pressure to
    // write it in.
    const result = await acceptRenderedDocument(buildPdf([GOOD_RESUME_PAGE]), resumeAcceptanceContract(RESUME, { target: TARGET }));
    expect(result.findings).toEqual([]);
  });

  it('refuses a CV whose work history was made to name the employer being applied to', async () => {
    const fabricated: TailoredResume = {
      ...RESUME,
      experience: [
        ...RESUME.experience,
        { company: 'Northwind Freight', title: 'Logistics Platform Engineer', dates: '2019 - 2021', engagement: 'employment', client: '', bullets: [] },
      ],
    };
    const page = [...GOOD_RESUME_PAGE, { text: 'Northwind Freight', x: 56, y: 250 }, { text: 'Logistics Platform Engineer', x: 56, y: 270 }];
    const result = await acceptRenderedDocument(buildPdf([page]), resumeAcceptanceContract(fabricated, { target: TARGET }));
    expect(codes(result.findings)).toContain('target_company_in_employment_history');
  });

  it('lets a genuine re-application to a previous employer through', async () => {
    const returning: TailoredResume = {
      ...RESUME,
      experience: [
        ...RESUME.experience,
        { company: 'Northwind Freight', title: 'Platform Engineer', dates: '2016 - 2019', engagement: 'employment', client: '', bullets: [] },
      ],
    };
    const page = [...GOOD_RESUME_PAGE, { text: 'Northwind Freight', x: 56, y: 250 }, { text: 'Platform Engineer', x: 56, y: 270 }];
    const result = await acceptRenderedDocument(
      buildPdf([page]),
      resumeAcceptanceContract(returning, { target: TARGET, verifiedEmployers: ['Northwind Freight'] }),
    );
    expect(result.findings).toEqual([]);
  });

  it('catches the employer smuggled into a bullet rather than an employer field', async () => {
    const fabricated: TailoredResume = {
      ...RESUME,
      experience: [{ ...(RESUME.experience[0] as TailoredResume['experience'][number]), bullets: ['Delivered the Northwind Freight logistics platform.'] }],
    };
    const page = GOOD_RESUME_PAGE.map((run) =>
      run.text === 'Led the design system rewrite.' ? { ...run, text: 'Delivered the Northwind Freight logistics platform.' } : run,
    );
    const result = await acceptRenderedDocument(buildPdf([page]), resumeAcceptanceContract(fabricated, { target: TARGET }));
    expect(codes(result.findings)).toContain('target_company_in_employment_history');
  });
});

describe('hashDocumentBytes', () => {
  it('reports the hash of the exact bytes that were checked', async () => {
    const bytes = buildPdf([GOOD_RESUME_PAGE]);
    const result = await acceptRenderedDocument(bytes, CV_CONTRACT);
    expect(result.contentHash).toBe(hashDocumentBytes(bytes));
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports a hash even for bytes it could not read, so a refusal still names a specific file', async () => {
    const result = await acceptRenderedDocument(new Uint8Array([9, 9, 9]), CV_CONTRACT);
    expect(result.contentHash).toBe(hashDocumentBytes(new Uint8Array([9, 9, 9])));
  });

  it('hashes a Buffer and its Uint8Array copy identically', () => {
    const bytes = buildPdf([GOOD_RESUME_PAGE]);
    expect(hashDocumentBytes(Buffer.from(bytes))).toBe(hashDocumentBytes(bytes));
  });
});
