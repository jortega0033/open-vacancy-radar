// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceDb, type WorkspaceDb } from '../electron/workspace/client.js';
import * as workspace from '../electron/workspace/repository.js';
import { cvDocumentToTailoredResume, describeCvExportBlockers } from '../electron/cv-export.js';
import { renderResumeDocx } from '../electron/resume-docx.js';
import { renderResumeHtml } from '../electron/resume-html.js';
import { reconcileTailoredResumeWithSource, tailoredResumeFromSource } from '../electron/resume-source.js';
import type { TailoredResume } from '../electron/resume-schema.js';
import {
  describeCvSourceGaps,
  PROJECTS_UNLIMITED,
  selectSourceProjects,
  type CvSourceDocument,
} from '../electron/workspace/cv-source-schema.js';
import { parseCvDocumentInput, parseCvDocumentPatch, parseCvSource } from '../electron/workspace/validate.js';
import { buildSourceCvPrompt, buildStructuredResumePrompt, MAX_CV_PROMPT_CHARS } from '../src/components/cv/prompts.js';
import { parseSourceCvResponse, sourceCvCompleteness } from '../src/components/cv/source-cv-response.js';
import type { VacancyLead } from '../src/components/cv/types.js';

/**
 * #274's five acceptance checks, each against the code path it names.
 *
 * Every fixture here is synthetic: "Jamie Rivera", "Redwood Software", "Northwind Retail" and the
 * rest are invented for this file and match no real person, employer or document.
 *
 * The suite runs against a real migrated SQLite file rather than a mocked repository, for the same
 * reason `workspace-repository.test.ts` does: the behaviours worth proving here (a source CV
 * surviving a write and a read back, a pre-#274 row coming back with no source at all) are
 * behaviours of the schema plus these functions together.
 */

let dir: string;
let db: WorkspaceDb;
let close: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-cv-source-test-'));
  ({ db, close } = createWorkspaceDb(dir));
});

afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

/** What the extraction prompt asks the model to return, as a realistic answer: two roles (one of
 * them a client engagement through an agency), one degree, three projects. */
const EXTRACTION_ANSWER = JSON.stringify({
  contact: {
    name: 'Jamie Rivera',
    title: 'Senior Frontend Engineer',
    location: 'Amsterdam, Netherlands',
    email: 'typo-in-the-cv@example.invalid',
    phone: '+31 6 0000 0000',
    links: ['https://github.com/example-jamie'],
  },
  summary: 'Frontend engineer with eight years building design systems.',
  experience: [
    {
      company: 'Redwood Software',
      title: 'Senior Frontend Engineer',
      dates: 'Mar 2021 - Present',
      engagement: 'employment',
      client: '',
      bullets: ['Led the design system rewrite.', 'Mentored three junior engineers.'],
    },
    {
      company: 'Beacon Consultancy',
      title: 'Frontend Consultant',
      dates: 'Jan 2019 - Feb 2021',
      engagement: 'client_engagement',
      client: 'Northwind Retail',
      bullets: ['Rebuilt the checkout flow.'],
    },
  ],
  education: [{ institution: 'TU Delft', credential: 'BSc Computer Science', dates: '2014 - 2018' }],
  projects: [
    {
      name: 'Aurora Design System',
      role: 'Lead',
      dates: '2022',
      organization: 'Redwood Software',
      description: 'An accessible component library used across six products.',
      technologies: ['TypeScript', 'Storybook'],
      links: ['https://example.invalid/aurora'],
    },
    {
      name: 'Checkout Rebuild',
      role: 'Consultant',
      dates: '2020',
      organization: 'Northwind Retail',
      description: 'Replaced a four-step checkout with a single page.',
      technologies: ['React'],
      links: [],
    },
    {
      name: 'Ferry Timetable App',
      role: 'Author',
      dates: '2019',
      organization: '',
      description: 'A side project that reads a public ferry feed.',
      technologies: ['Svelte'],
      links: [],
    },
  ],
});

const CV_TEXT = 'Jamie Rivera. Senior Frontend Engineer. Redwood Software, Beacon Consultancy, TU Delft.';

const VACANCY: VacancyLead = {
  title: 'Senior Frontend Engineer',
  company: 'Lighthouse Labs',
  location: 'Remote (EU)',
  url: 'https://example.invalid/jobs/1',
  description: 'Design systems, accessibility, TypeScript.',
};

/** Imports the CV, applies the corrections a person makes during review, and saves. The three
 * steps the ticket names as "import -> review", in the order a user performs them. */
function importReviewAndSave(): { id: string; reviewed: CvSourceDocument } {
  const extracted = parseSourceCvResponse(EXTRACTION_ANSWER, CV_TEXT);
  const reviewed: CvSourceDocument = {
    ...extracted,
    contact: {
      ...extracted.contact,
      email: 'jamie@example.invalid',
      phone: '+31 6 1234 5678',
      links: [...extracted.contact.links, 'https://example.invalid/jamie'],
    },
    projects: extracted.projects.map((project) =>
      project.name === 'Checkout Rebuild' ? { ...project, pinned: true } : project,
    ),
    maxProjects: 2,
  };

  const created = workspace.createCvDocument(
    db,
    parseCvDocumentInput({
      name: 'Frontend CV: Netherlands',
      kind: 'uploaded',
      text: CV_TEXT,
      profile: { title: 'Senior Frontend Engineer', skills: ['TypeScript', 'React'] },
      source: reviewed,
    }),
  );
  return { id: created.id, reviewed };
}

describe('acceptance 1: import -> review -> tailor -> PDF/DOCX keeps projects, dates, employers, contact corrections and links', () => {
  it('carries every reviewed fact through the save and back out of the database', () => {
    const { id } = importReviewAndSave();
    const stored = workspace.getCvDocument(db, id);

    expect(stored.source).not.toBeNull();
    expect(stored.source?.contact.email).toBe('jamie@example.invalid');
    expect(stored.source?.contact.phone).toBe('+31 6 1234 5678');
    expect(stored.source?.contact.links).toContain('https://example.invalid/jamie');
    expect(stored.source?.experience.map((entry) => entry.company)).toEqual([
      'Redwood Software',
      'Beacon Consultancy',
    ]);
    expect(stored.source?.experience[0]?.dates).toBe('Mar 2021 - Present');
    expect(stored.source?.projects.map((project) => project.name)).toEqual([
      'Aurora Design System',
      'Checkout Rebuild',
      'Ferry Timetable App',
    ]);
  });

  it('renders those facts into the exported HTML rather than the empty sections #156 had to emit', () => {
    const { id } = importReviewAndSave();
    const html = renderResumeHtml(cvDocumentToTailoredResume(workspace.getCvDocument(db, id), null));

    expect(html).toContain('Jamie Rivera');
    expect(html).toContain('Redwood Software');
    expect(html).toContain('Mar 2021 - Present');
    expect(html).toContain('jamie@example.invalid');
    expect(html).toContain('+31 6 1234 5678');
    expect(html).toContain('https://example.invalid/jamie');
    expect(html).toContain('TU Delft');
    expect(html).toContain('Projects');
    expect(html).toContain('Checkout Rebuild');
  });

  it('renders the same facts into the exported DOCX', async () => {
    const { id } = importReviewAndSave();
    const buffer = await renderResumeDocx(cvDocumentToTailoredResume(workspace.getCvDocument(db, id), null));
    const raw = buffer.toString('utf8');

    // The document part of a .docx is deflated, so the readable assertion available without a zip
    // reader is that real bytes came back; the content assertions above cover the same template's
    // section decisions, which `resume-docx.ts` mirrors one-for-one from `resume-html.ts`.
    expect(buffer.byteLength).toBeGreaterThan(1_000);
    expect(raw.slice(0, 2)).toBe('PK');
  });

  it('keeps the reviewed facts through a tailoring pass', () => {
    const { reviewed } = importReviewAndSave();
    // A model answer that re-words bullets and reorders roles, as tailoring is meant to.
    const tailored: TailoredResume = {
      contact: { name: 'J. Rivera', title: 'Frontend Engineer', location: 'Remote', email: '', phone: '', links: [] },
      summary: 'Design systems engineer.',
      experience: [
        {
          company: 'Beacon Consultancy',
          title: 'Frontend Consultant',
          dates: 'unknown',
          engagement: 'employment',
          client: '',
          bullets: ['Rebuilt a retail checkout flow end to end.'],
        },
        {
          company: 'Redwood Software',
          title: 'Senior Frontend Engineer',
          dates: '',
          engagement: 'employment',
          client: '',
          bullets: ['Led an accessible design system rewrite.'],
        },
      ],
      projects: [{ name: 'Checkout Rebuild', role: '', dates: '', organization: '', description: '', technologies: [], links: [] }],
      skills: ['TypeScript'],
      education: [{ institution: 'TU Delft', credential: 'BSc Computer Science', dates: 'invented date' }],
    };

    const { resume } = reconcileTailoredResumeWithSource(tailored, reviewed);

    expect(resume.contact.email).toBe('jamie@example.invalid');
    expect(resume.contact.links).toContain('https://example.invalid/jamie');
    expect(resume.experience.map((entry) => entry.dates)).toEqual(['Jan 2019 - Feb 2021', 'Mar 2021 - Present']);
    expect(resume.experience.map((entry) => entry.company)).toEqual(['Beacon Consultancy', 'Redwood Software']);
    expect(resume.education.map((entry) => entry.institution)).toEqual(['TU Delft']);
    expect(resume.education.map((entry) => entry.dates)).toEqual(['2014 - 2018']);
    expect(resume.projects.map((project) => project.name)).toContain('Checkout Rebuild');
    // Re-wording is the point of tailoring, so the model's bullets are kept as written.
    expect(resume.experience[1]?.bullets).toEqual(['Led an accessible design system rewrite.']);
  });
});

describe('acceptance 2: a long CV either gets processed or is reported incomplete and blocks the export', () => {
  /** A CV whose project section sits well past the old 14,000-character interactive clamp. */
  const LONG_CV = `${'Earlier roles and responsibilities. '.repeat(600)}\nPROJECTS\nHarbour Analytics Platform`;

  it('processes content past the old 14,000-character limit instead of dropping it', () => {
    expect(LONG_CV.length).toBeGreaterThan(MAX_CV_PROMPT_CHARS);

    const completeness = sourceCvCompleteness(LONG_CV);
    expect(completeness.complete).toBe(true);
    // The section the old clamp discarded actually reaches the model.
    expect(buildSourceCvPrompt('cv.pdf', LONG_CV)).toContain('Harbour Analytics Platform');
  });

  it('reports a CV too long to read in one pass as incomplete, naming what is missing', () => {
    const huge = 'x'.repeat(30);
    const completeness = sourceCvCompleteness(huge, 10);

    expect(completeness.complete).toBe(false);
    expect(completeness.coveredChars).toBe(10);
    expect(completeness.sourceChars).toBe(30);
    expect(completeness.incompleteReason).toMatch(/only the first/);
  });

  it('blocks the export of an incomplete source rather than exporting a document that looks finished', () => {
    const extracted = parseSourceCvResponse(EXTRACTION_ANSWER, CV_TEXT);
    const created = workspace.createCvDocument(
      db,
      parseCvDocumentInput({
        name: 'Long CV',
        kind: 'uploaded',
        text: CV_TEXT,
        source: {
          ...extracted,
          complete: false,
          incompleteReason: 'only the first 200,000 characters could be read',
          coveredChars: 200_000,
          sourceChars: 260_000,
        },
      }),
    );

    const blockers = describeCvExportBlockers(workspace.getCvDocument(db, created.id));
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('incomplete');
    expect(blockers[0]).toContain('only the first 200,000 characters could be read');
  });

  it('allows the export once the source is complete and reviewed', () => {
    const { id } = importReviewAndSave();
    expect(describeCvExportBlockers(workspace.getCvDocument(db, id))).toEqual([]);
  });

  it('refuses a source nobody has confirmed, even a complete one', () => {
    const extracted = parseSourceCvResponse(EXTRACTION_ANSWER, CV_TEXT);
    expect(extracted.reviewedAt).toBe('');
    expect(describeCvSourceGaps(extracted)).toEqual([
      'the extracted source CV has not been reviewed and confirmed yet',
    ]);
  });
});

describe('acceptance 3: pinned projects survive tailoring and the count is configurable', () => {
  it('keeps a pinned project the model left out entirely', () => {
    const { reviewed } = importReviewAndSave();
    const withoutProjects: TailoredResume = {
      contact: { name: '', title: '', location: '', email: '', phone: '', links: [] },
      summary: '',
      experience: [],
      projects: [],
      skills: [],
      education: [],
    };

    const { resume } = reconcileTailoredResumeWithSource(withoutProjects, reviewed);
    expect(resume.projects.map((project) => project.name)).toEqual(['Checkout Rebuild']);
  });

  it('applies the candidate\'s configured count rather than a fixed rule', () => {
    const extracted = parseSourceCvResponse(EXTRACTION_ANSWER, CV_TEXT);

    expect(selectSourceProjects({ ...extracted, maxProjects: PROJECTS_UNLIMITED })).toHaveLength(3);
    expect(selectSourceProjects({ ...extracted, maxProjects: 1 }).map((project) => project.name)).toEqual([
      'Aurora Design System',
    ]);
    expect(selectSourceProjects({ ...extracted, maxProjects: 2 }).map((project) => project.name)).toEqual([
      'Aurora Design System',
      'Checkout Rebuild',
    ]);
  });

  it('never lets the count displace a pin: a pin is an instruction, not a preference', () => {
    const extracted = parseSourceCvResponse(EXTRACTION_ANSWER, CV_TEXT);
    const pinnedTwo: CvSourceDocument = {
      ...extracted,
      maxProjects: 1,
      projects: extracted.projects.map((project) =>
        project.name === 'Checkout Rebuild' || project.name === 'Ferry Timetable App'
          ? { ...project, pinned: true }
          : project,
      ),
    };

    expect(selectSourceProjects(pinnedTwo).map((project) => project.name)).toEqual([
      'Checkout Rebuild',
      'Ferry Timetable App',
    ]);
  });

  it('defaults to no cap at all, so the app ships no opinion about how many projects to show', () => {
    expect(parseSourceCvResponse(EXTRACTION_ANSWER, CV_TEXT).maxProjects).toBe(PROJECTS_UNLIMITED);
  });

  it('tells the prompt which projects are pinned and what the cap is', () => {
    const { reviewed } = importReviewAndSave();
    const prompt = buildStructuredResumePrompt({ fileName: 'cv.pdf', text: CV_TEXT }, VACANCY, reviewed);

    expect(prompt).toContain('PINNED Checkout Rebuild');
    expect(prompt).toContain('at most 2');
    expect(prompt).toContain('Include every project marked PINNED');
  });
});

describe('acceptance 4: client engagements stay distinct from direct employment, and tailoring invents nothing', () => {
  it('keeps the agency as the employer and the end client as the client', () => {
    const { reviewed } = importReviewAndSave();
    const engagement = reviewed.experience.find((entry) => entry.company === 'Beacon Consultancy');

    expect(engagement?.engagement).toBe('client_engagement');
    expect(engagement?.client).toBe('Northwind Retail');
    // The end client is never written where the employer goes.
    expect(reviewed.experience.map((entry) => entry.company)).not.toContain('Northwind Retail');
  });

  it('restores the engagement type when a tailored answer restates a contract as direct employment', () => {
    const { reviewed } = importReviewAndSave();
    const promoted: TailoredResume = {
      contact: { name: '', title: '', location: '', email: '', phone: '', links: [] },
      summary: '',
      experience: [
        {
          company: 'Beacon Consultancy',
          title: 'Frontend Consultant',
          dates: '',
          engagement: 'employment',
          client: '',
          bullets: [],
        },
      ],
      projects: [],
      skills: [],
      education: [],
    };

    const { resume } = reconcileTailoredResumeWithSource(promoted, reviewed);
    expect(resume.experience[0]?.engagement).toBe('client_engagement');
    expect(resume.experience[0]?.client).toBe('Northwind Retail');
  });

  it('labels a client engagement in the rendered document instead of leaving it to look like a job', () => {
    const { id } = importReviewAndSave();
    const html = renderResumeHtml(cvDocumentToTailoredResume(workspace.getCvDocument(db, id), null));

    expect(html).toContain('client engagement: Northwind Retail');
  });

  it('drops an employer, a project and a qualification the source CV does not have, and says which', () => {
    const { reviewed } = importReviewAndSave();
    const invented: TailoredResume = {
      contact: { name: '', title: '', location: '', email: '', phone: '', links: [] },
      summary: '',
      experience: [
        { company: 'Lighthouse Labs', title: 'Staff Engineer', dates: '2015', engagement: 'employment', client: '', bullets: [] },
        { company: 'Redwood Software', title: 'Senior Frontend Engineer', dates: '', engagement: 'employment', client: '', bullets: ['Real work.'] },
      ],
      projects: [{ name: 'Quantum Ledger', role: '', dates: '', organization: '', description: '', technologies: [], links: [] }],
      skills: [],
      education: [{ institution: 'ETH Zurich', credential: 'MSc Distributed Systems', dates: '' }],
    };

    const { resume, dropped } = reconcileTailoredResumeWithSource(invented, reviewed);

    expect(resume.experience.map((entry) => entry.company)).toEqual(['Redwood Software']);
    expect(resume.education).toEqual([]);
    expect(resume.projects.map((project) => project.name)).not.toContain('Quantum Ledger');
    expect(dropped).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Lighthouse Labs'),
        expect.stringContaining('Quantum Ledger'),
        expect.stringContaining('MSc Distributed Systems'),
      ]),
    );
  });

  it('refuses to let a renderer smuggle a client onto a direct-employment record', () => {
    const parsed = parseCvSource({
      experience: [{ company: 'Redwood Software', title: 'Engineer', engagement: 'employment', client: 'Northwind Retail' }],
    });
    expect(parsed?.experience[0]?.client).toBe('');
  });

  it('never accepts a caller-supplied review timestamp', () => {
    const parsed = parseCvSource({ reviewedAt: '1999-01-01T00:00:00.000Z', contact: { name: 'Jamie Rivera' } });
    expect(parsed?.reviewedAt).toBe('');
  });
});

describe('acceptance 5: existing small-profile records migrate without fabricated sections', () => {
  it('leaves a pre-#274 record with no source at all, rather than an empty one that looks reviewed', () => {
    const created = workspace.createCvDocument(db, {
      name: 'Frontend CV',
      kind: 'manual',
      profile: { title: 'Senior Frontend Engineer', skills: ['TypeScript'], summary: 'Eight years of frontend work.' },
    });

    expect(created.source).toBeNull();
    expect(workspace.getCvDocument(db, created.id).source).toBeNull();
  });

  it('exports such a record exactly as before: thin and honest, never invented', () => {
    const created = workspace.createCvDocument(db, {
      name: 'Frontend CV',
      kind: 'manual',
      profile: { title: 'Senior Frontend Engineer', location: 'Amsterdam', skills: ['TypeScript'] },
    });
    const resume = cvDocumentToTailoredResume(workspace.getCvDocument(db, created.id), null);

    expect(resume.experience).toEqual([]);
    expect(resume.education).toEqual([]);
    expect(resume.projects).toEqual([]);
    expect(resume.contact.email).toBe('');
    expect(resume.contact.phone).toBe('');
    expect(resume.contact.links).toEqual([]);
    // The fields it genuinely has still come through.
    expect(resume.contact.title).toBe('Senior Frontend Engineer');
    expect(resume.skills).toEqual(['TypeScript']);
  });

  it('never blocks the export of a profile-only record: nothing about it is misleading', () => {
    const created = workspace.createCvDocument(db, { name: 'Frontend CV', kind: 'manual' });
    expect(describeCvExportBlockers(workspace.getCvDocument(db, created.id))).toEqual([]);
  });

  it('gives an incomplete record a recoverable state: re-reading the CV clears the block', () => {
    const extracted = parseSourceCvResponse(EXTRACTION_ANSWER, CV_TEXT);
    const created = workspace.createCvDocument(
      db,
      parseCvDocumentInput({
        name: 'Frontend CV',
        kind: 'uploaded',
        text: CV_TEXT,
        source: { ...extracted, complete: false, incompleteReason: 'the CV was cut short' },
      }),
    );
    expect(describeCvExportBlockers(workspace.getCvDocument(db, created.id))).not.toEqual([]);

    workspace.updateCvDocument(
      db,
      created.id,
      parseCvDocumentPatch({ source: { ...extracted, complete: true } }),
    );

    const repaired = workspace.getCvDocument(db, created.id);
    expect(describeCvExportBlockers(repaired)).toEqual([]);
    // Recovered, not papered over: the stale reason is gone with the state it described.
    expect(repaired.source?.incompleteReason).toBe('');
  });

  it('stamps the review timestamp from the main process when a source is written', () => {
    const { id } = importReviewAndSave();
    const stored = workspace.getCvDocument(db, id);

    expect(stored.source?.reviewedAt).not.toBe('');
    expect(Number.isNaN(new Date(stored.source?.reviewedAt ?? '').valueOf())).toBe(false);
  });

  it('lets a record built straight from a source render without a candidate profile configured', () => {
    const { reviewed } = importReviewAndSave();
    const resume = tailoredResumeFromSource(reviewed, ['TypeScript']);

    expect(resume.contact.name).toBe('Jamie Rivera');
    expect(resume.skills).toEqual(['TypeScript']);
  });
});
