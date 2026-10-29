import { load, type Cheerio, type CheerioAPI, type contains } from 'cheerio';
import { jsPDF } from 'jspdf';
import type { CompanyEvidenceProseFact } from '../electron/company-evidence.js';
import type { CvSourceDocument } from '../electron/workspace/cv-source-schema.js';

/**
 * Synthetic fixtures for the independent-critique tests (#690) and the held-out evaluation. Every
 * candidate, employer and posting is invented. Nothing here reaches a model or a network.
 */

export const COMPANY = 'Northwind Freight';
export const ROLE = 'Platform Engineer';
export const APPLY_URL = 'https://jobs.example/apply/northwind-platform-engineer';

export const JD = [
  `${COMPANY} is hiring a ${ROLE}.`,
  'You will build and operate TypeScript services.',
  'Experience with Kubernetes is required.',
  'Experience with GitHub Actions pipelines is a plus.',
  'You will mentor junior engineers.',
].join('\n');

export const SOURCE: CvSourceDocument = {
  contact: { name: 'Jamie Rivera', title: 'Senior Engineer', location: 'Amsterdam', email: 'jamie@example.invalid', phone: '+31 6 0000 0000', links: [] },
  summary: 'Platform engineer focused on reliable TypeScript services.',
  experience: [
    {
      id: 'experience-1',
      company: 'Redwood Software',
      title: 'Senior Engineer',
      dates: '2021 - Present',
      engagement: 'employment',
      client: '',
      bullets: [
        'Built TypeScript services handling 2 million requests per day.',
        'Led the migration of CI pipelines to GitHub Actions.',
        'Mentored four junior engineers.',
      ],
    },
    {
      id: 'experience-2',
      company: 'Blue Harbor Systems',
      title: 'Software Engineer',
      dates: '2017 - 2021',
      engagement: 'employment',
      client: '',
      bullets: ['Maintained Kubernetes clusters for internal tools.', 'Reduced build times by 35 percent.'],
    },
  ],
  education: [{ institution: 'Example University', credential: 'BSc Computer Science', dates: '2013 - 2017' }],
  projects: [],
  maxProjects: 0,
  complete: true,
  incompleteReason: '',
  coveredChars: 400,
  sourceChars: 400,
  reviewedAt: '2026-01-01T00:00:00.000Z',
};

export const PROFILE_SKILLS = ['TypeScript', 'Kubernetes', 'GitHub Actions', 'PostgreSQL'];

/** What the drafting model returns for the tailored CV: Redwood only, two bullets, two skills. */
export function tailoredResumeReply(over: { bullets?: string[]; skills?: string[]; experience?: unknown[] } = {}): string {
  return JSON.stringify({
    contact: { ...SOURCE.contact },
    summary: SOURCE.summary,
    experience: over.experience ?? [
      {
        company: 'Redwood Software',
        title: 'Senior Engineer',
        dates: '2021 - Present',
        engagement: 'employment',
        client: '',
        bullets: over.bullets ?? [SOURCE.experience[0]!.bullets[0], SOURCE.experience[0]!.bullets[1]],
      },
    ],
    projects: [],
    skills: over.skills ?? ['TypeScript', 'GitHub Actions'],
    education: SOURCE.education,
  });
}

export const LETTER_SELECTION_REPLY = JSON.stringify({ factIds: ['summary', 'experience-1-bullet-1'] });

/** A letter the person wrote themselves, marked final for this vacancy. Says something the CV does not. */
export const USER_LETTER_TITLE = 'Cover Letter';
export const USER_LETTER_BODY = [
  `Dear ${COMPANY} hiring team,`,
  `I am writing to apply for the ${ROLE} role.`,
  'I spent five years at Redwood Software building TypeScript services and I led a team of 40 engineers.',
  'Kind regards,',
  'Jamie Rivera',
].join('\n\n');

export function companyFact(over: Partial<CompanyEvidenceProseFact> = {}): CompanyEvidenceProseFact {
  return {
    id: 'fact-1',
    claim: `${COMPANY} operates a depot network across the Netherlands`,
    scope: 'company',
    topic: 'general',
    sourceUrl: 'https://northwind.example/about',
    observedAt: '2026-10-01T00:00:00.000Z',
    retrievedAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2027-10-01T00:00:00.000Z',
    verification: 'source_confirmed',
    viaLink: null,
    ...over,
  };
}

/** Elements whose end starts a new printed line (the same block tags the earlier stand-in broke lines on). */
const BLOCK_TAGS = new Set(['div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'li', 'p', 'section', 'tr', 'ul']);
/** Never printed as text. */
const SKIPPED_TAGS = new Set(['head', 'noscript', 'script', 'style', 'template', 'title']);

/** A parsed node (cheerio's `AnyNode`, named through a public signature). */
type ParsedNode = Parameters<typeof contains>[0];
type ParsedNodes = Cheerio<ParsedNode>;
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** The printed text of a parsed document: text nodes in order, a new line after each block element. */
function printedText($: CheerioAPI, nodes: ParsedNodes, out: string[]): void {
  for (const child of nodes.toArray()) {
    if (child.nodeType === TEXT_NODE) {
      out.push($(child).text());
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) continue;
    const tag = ($(child).prop('tagName') ?? '').toLowerCase();
    if (SKIPPED_TAGS.has(tag)) continue;
    if (tag === 'br') {
      out.push('\n');
      continue;
    }
    out.push(' ');
    printedText($, $(child).contents(), out);
    out.push(BLOCK_TAGS.has(tag) ? '\n' : ' ');
  }
}

/**
 * Stands in for Chromium's `printToPDF`: a real, text-bearing PDF built from the text of the HTML the
 * app asked to print, so the real document acceptance contract judges bytes that genuinely carry the
 * document. Only the renderer is replaced. The HTML goes through a real HTML parser (cheerio, parse5),
 * never pattern stripping, so entities, comments and script/style content are handled as a browser would.
 */
export function htmlToPdf(html: string): Uint8Array {
  const $ = load(html);
  const title = $('title').first().text();
  const parts: string[] = [];
  printedText($, $('body').contents(), parts);
  const text = parts.join('');
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.setProperties({ title });
  doc.setFontSize(10);
  let y = 60;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    for (const wrapped of doc.splitTextToSize(line, 470) as string[]) {
      if (y > 780) {
        doc.addPage();
        y = 60;
      }
      doc.text(wrapped, 56, y);
      y += 14;
    }
  }
  return new Uint8Array(doc.output('arraybuffer'));
}

/** A finding in the critic's wire format. */
export function finding(over: Record<string, unknown>): Record<string, unknown> {
  return { kind: 'unnecessary_detail', summary: 'A finding.', documents: ['cv'], evidence: [], ...over };
}

export const OMISSION_FINDING = finding({
  kind: 'omitted_requirement',
  summary: 'The posting requires Kubernetes experience and the CV leaves out the reviewed Kubernetes work.',
  documents: ['cv'],
  evidence: [
    { source: 'jd', quote: 'Experience with Kubernetes is required.' },
    { source: 'cv_fact', id: 'experience-2-bullet-1' },
  ],
});

/** The current tailored CV plus the omitted role, using only reviewed text. */
export function validCvRevision(): Record<string, unknown> {
  return JSON.parse(
    tailoredResumeReply({
      experience: [
        {
          company: 'Redwood Software',
          title: 'Senior Engineer',
          dates: '2021 - Present',
          engagement: 'employment',
          client: '',
          bullets: [SOURCE.experience[0]!.bullets[0], SOURCE.experience[0]!.bullets[1]],
        },
        {
          company: 'Blue Harbor Systems',
          title: 'Software Engineer',
          dates: '2017 - 2021',
          engagement: 'employment',
          client: '',
          bullets: ['Maintained Kubernetes clusters for internal tools.'],
        },
      ],
      skills: ['TypeScript', 'Kubernetes', 'GitHub Actions'],
    }),
  ) as Record<string, unknown>;
}
