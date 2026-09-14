import type { ElectronApplication } from '@playwright/test';
import { acceptRenderedDocument, type DocumentFindingCode } from '../electron/document-acceptance.js';
import { letterAcceptanceContract, resumeAcceptanceContract } from '../electron/document-contracts.js';
import { renderLetterHtml } from '../electron/letter-html.js';
import { renderResumeHtml } from '../electron/resume-html.js';
import type { TailoredResume } from '../electron/resume-schema.js';
import { expect, test } from './fixtures.js';

/**
 * #276's layout checks against the *real* Electron PDF output.
 *
 * `document-acceptance.test.ts` proves every finding fires, using hand-placed fixtures. It cannot
 * prove the thing that actually matters day to day: that this app's own templates, run through
 * Chromium's real print pipeline, produce documents that satisfy the contract -- including for the
 * inputs the ticket names, long role titles, experience that spills onto later pages, and pinned
 * projects. Only a real `webContents.printToPDF` can answer that, so it runs here, where the real
 * built app is already running.
 *
 * All fixture data is synthetic. `.example` is a reserved, never-resolving domain.
 */

/**
 * The same offscreen-window print step `application-artifact-staging.ts`'s `printHtmlToPdf`
 * performs, repeated here rather than imported: `electronApp.evaluate` runs its function inside
 * the already-running main process, which has no way to import a module from this test file. The
 * `webPreferences` are kept identical to the real one deliberately -- a render under different
 * window settings would not be evidence about the real output.
 */
async function printRealPdf(app: ElectronApplication, html: string): Promise<Uint8Array> {
  const base64 = await app.evaluate(async ({ BrowserWindow }, pageHtml) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pageHtml)}`);
      const pdf = await win.webContents.printToPDF({});
      return pdf.toString('base64');
    } finally {
      win.destroy();
    }
  }, html);
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

const PORTFOLIO_LINK = 'https://portfolio.example/jamie-rivera';

const RESUME: TailoredResume = {
  contact: {
    name: 'Jamie Rivera',
    title: 'Senior Frontend Engineer',
    location: 'Amsterdam, Netherlands',
    email: 'jamie@example.invalid',
    phone: '+31 6 1234 5678',
    links: [PORTFOLIO_LINK],
  },
  summary: 'Frontend engineer with eight years building design systems and developer tooling.',
  experience: [
    {
      company: 'Redwood Software',
      title: 'Senior Frontend Engineer',
      dates: '2021 - Present',
      engagement: 'employment',
      client: '',
      bullets: ['Led the design system rewrite.', 'Mentored three junior engineers.'],
    },
    {
      company: 'Bright Harbour Consulting',
      title: 'Frontend Consultant',
      dates: '2019 - 2021',
      engagement: 'client_engagement',
      client: 'Meridian Rail',
      bullets: ['Rebuilt the booking flow.'],
    },
  ],
  projects: [
    {
      name: 'Atlas Design Tokens',
      role: 'Lead',
      dates: '2023',
      organization: 'Redwood Software',
      description: 'A token pipeline shared across four product teams.',
      technologies: ['TypeScript', 'Style Dictionary'],
      links: [],
    },
  ],
  skills: ['TypeScript', 'React', 'Accessibility'],
  education: [{ institution: 'TU Delft', credential: 'BSc Computer Science', dates: '2014 - 2018' }],
};

const LONG_TITLE = 'Senior Staff Frontend Engineer, Design Systems and Developer Experience Platform Enablement';

/** Long titles, enough experience to spill onto later pages, and pinned projects -- the three
 * inputs #276 names as the ones that break a fixed-page layout. */
const DEMANDING_RESUME: TailoredResume = {
  ...RESUME,
  contact: { ...RESUME.contact, title: LONG_TITLE },
  experience: Array.from({ length: 9 }, (_unused, index) => ({
    company: `Longbridge Systems and Infrastructure Group Division ${index + 1}`,
    title: LONG_TITLE,
    dates: `January ${2008 + index} - December ${2009 + index}`,
    engagement: 'employment' as const,
    client: '',
    bullets: [
      'Delivered a platform migration across a very long unbroken identifier: platform_migration_stage_two_rollout_plan_final.',
      'Reduced build times by a third.',
    ],
  })),
  projects: Array.from({ length: 4 }, (_unused, index) => ({
    name: `Pinned Project ${index + 1}: Distributed Configuration and Release Orchestration`,
    role: 'Technical Lead',
    dates: '2023',
    organization: 'Redwood Software',
    description: 'Synthetic project description used only to fill the page.',
    technologies: ['TypeScript', 'Kubernetes'],
    links: [PORTFOLIO_LINK],
  })),
};

const LAYOUT_FAULTS: DocumentFindingCode[] = ['blank_page', 'content_clipped', 'content_overlapping'];

function codes(findings: Array<{ code: DocumentFindingCode }>): DocumentFindingCode[] {
  return findings.map((finding) => finding.code);
}

test.describe('document acceptance against real Electron PDF output (#276)', () => {
  test('a CV rendered by the real print pipeline satisfies the whole acceptance contract', async ({ electronApp }) => {
    const pdf = await printRealPdf(electronApp, renderResumeHtml(RESUME));
    const acceptance = await acceptRenderedDocument(pdf, resumeAcceptanceContract(RESUME));
    expect(acceptance.findings).toEqual([]);
    expect(acceptance.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('long titles, multi-page experience and pinned projects render without clipping or overlapping', async ({ electronApp }) => {
    const pdf = await printRealPdf(electronApp, renderResumeHtml(DEMANDING_RESUME));
    const acceptance = await acceptRenderedDocument(pdf, {
      ...resumeAcceptanceContract(DEMANDING_RESUME),
      // This CV is deliberately longer than any real one; its page count is not what is under test.
      pageBounds: { min: 2, max: 30 },
    });
    expect(acceptance.pageCount).toBeGreaterThan(1);
    expect(codes(acceptance.findings).filter((code) => LAYOUT_FAULTS.includes(code))).toEqual([]);
    expect(acceptance.findings).toEqual([]);
  });

  test('the candidate\'s links survive the real render as usable link annotations', async ({ electronApp }) => {
    const pdf = await printRealPdf(electronApp, renderResumeHtml(RESUME));
    const acceptance = await acceptRenderedDocument(pdf, resumeAcceptanceContract(RESUME));
    expect(codes(acceptance.findings)).not.toContain('required_link_missing');
    expect(codes(acceptance.findings)).not.toContain('malformed_link');
  });

  test('a link the CV states without a scheme is not turned into a broken annotation', async ({ electronApp }) => {
    const schemeless: TailoredResume = { ...RESUME, contact: { ...RESUME.contact, links: ['linkedin.example/in/jamie-rivera'] } };
    const pdf = await printRealPdf(electronApp, renderResumeHtml(schemeless));
    const acceptance = await acceptRenderedDocument(pdf, resumeAcceptanceContract(schemeless));
    expect(acceptance.findings).toEqual([]);
  });

  test('the real print pipeline stamps the document identity the contract checks against', async ({ electronApp }) => {
    // Chromium takes the finished PDF's own title from the HTML <title>. That is what makes a file
    // that is someone else's document detectable from the bytes, so it is asserted directly rather
    // than left to coincide with the name-in-body check.
    const pdf = await printRealPdf(electronApp, renderResumeHtml(RESUME));
    const acceptance = await acceptRenderedDocument(pdf, {
      ...resumeAcceptanceContract(RESUME),
      identity: { candidateName: 'Jamie Rivera', documentTitle: 'Priya Raman' },
    });
    expect(codes(acceptance.findings)).toEqual(['wrong_document_identity']);
    expect(acceptance.findings[0]?.detail).toContain('Jamie Rivera');
  });

  test('a cover letter rendered by the real print pipeline gets -- and passes -- the same checks', async ({ electronApp }) => {
    const target = { company: 'Northwind Freight', role: 'Logistics Platform Engineer' };
    const title = 'Cover Letter';
    const body = [
      'Dear Northwind Freight hiring team,',
      'I am applying for the Logistics Platform Engineer role. I have spent the last four years building design systems and developer tooling, and the work you describe lines up closely with that.',
      'I would welcome the chance to talk it through.',
    ].join('\n\n');

    const pdf = await printRealPdf(electronApp, renderLetterHtml(title, body, { candidateName: 'Jamie Rivera' }));
    const acceptance = await acceptRenderedDocument(
      pdf,
      letterAcceptanceContract({ kind: 'cover_letter', title, body, candidateName: 'Jamie Rivera', target }),
    );
    expect(acceptance.findings).toEqual([]);
  });

  test('a real rendered letter that never names the employer is refused, not reported ready', async ({ electronApp }) => {
    const target = { company: 'Northwind Freight', role: 'Logistics Platform Engineer' };
    const title = 'Cover Letter';
    const body = 'Dear hiring team,\n\nI am writing to express my interest in the position advertised.';

    const pdf = await printRealPdf(electronApp, renderLetterHtml(title, body, { candidateName: 'Jamie Rivera' }));
    const acceptance = await acceptRenderedDocument(
      pdf,
      letterAcceptanceContract({ kind: 'cover_letter', title, body, candidateName: 'Jamie Rivera', target }),
    );
    expect(codes(acceptance.findings)).toContain('target_not_addressed');
    expect(acceptance.ok).toBe(false);
  });
});
