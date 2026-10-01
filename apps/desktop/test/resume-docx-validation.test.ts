// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { renderResumeDocx } from '../electron/resume-docx.js';
import { validateRenderedResumeDocx } from '../electron/resume-docx-validation.js';
import type { TailoredResume } from '../electron/resume-schema.js';

/**
 * The DOCX check against real bytes from the app's own renderer (#419 step 9): a faithful render
 * passes, and each way a document can drift from the approved snapshot is named. Nothing here claims
 * anything about how the file looks or paginates; that is the candidate's own review.
 */
const RESUME: TailoredResume = {
  contact: {
    name: 'Jamie Rivera',
    title: 'Frontend engineer',
    location: 'Utrecht, Netherlands',
    email: 'jamie.rivera@example.invalid',
    phone: '+31 6 0000 0000',
    links: ['https://example.invalid/jamie', 'https://code.example.invalid/jamie'],
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
    {
      company: 'Northwind Agency',
      title: 'Developer',
      dates: '2018 - 2021',
      engagement: 'client_engagement',
      client: 'Contoso Rail',
      bullets: ['Built the timetable widgets'],
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
      links: ['https://example.invalid/toolkit'],
    },
    { name: 'Dashboard', role: '', dates: '', organization: '', description: 'A reporting dashboard.', technologies: [], links: [] },
  ],
  skills: ['TypeScript', 'Angular', 'RxJS'],
  education: [{ institution: 'Utrecht University', credential: 'BSc Computer Science', dates: '2014 - 2018' }],
};

const MINIMAL: TailoredResume = {
  contact: { name: 'Sam Doe', title: '', location: '', email: '', phone: '', links: [] },
  summary: '',
  experience: [],
  projects: [],
  skills: [],
  education: [],
};

async function validate(rendered: TailoredResume, approved: TailoredResume) {
  return validateRenderedResumeDocx(await renderResumeDocx(rendered), approved);
}

describe('validateRenderedResumeDocx', () => {
  it('passes a faithful render of a full resume and returns the hash of the bytes checked', async () => {
    const bytes = await renderResumeDocx(RESUME);
    const result = await validateRenderedResumeDocx(bytes, RESUME);
    expect(result.reasons).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('passes a resume with only a name', async () => {
    expect((await validate(MINIMAL, MINIMAL)).ok).toBe(true);
  });

  it('passes a resume with no name, which the template prints as Candidate', async () => {
    const unnamed = { ...MINIMAL, contact: { ...MINIMAL.contact, name: '' }, summary: 'Short summary.' };
    expect((await validate(unnamed, unnamed)).ok).toBe(true);
  });

  it('names a missing bullet', async () => {
    const dropped = { ...RESUME, experience: [{ ...RESUME.experience[0]!, bullets: ['Built the booking screens, using Angular'] }, RESUME.experience[1]!] };
    const result = await validate(dropped, RESUME);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toContain('the bullet "Kept the reporting screens fast" is missing');
  });

  it('names a changed contact detail and a changed link', async () => {
    const result = await validate(
      { ...RESUME, contact: { ...RESUME.contact, email: 'someone.else@example.invalid', links: ['https://example.invalid/other'] } },
      RESUME,
    );
    expect(result.ok).toBe(false);
    const reasons = result.reasons.join(' ');
    expect(reasons).toContain('the email "jamie.rivera@example.invalid" is missing');
    expect(reasons).toContain('the link "https://example.invalid/jamie" is missing');
  });

  it('names a selected project that did not reach the document', async () => {
    const result = await validate({ ...RESUME, projects: [RESUME.projects[0]!] }, RESUME);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toContain('the project "Dashboard" is missing');
  });

  it('names a project that was not selected', async () => {
    const result = await validate(RESUME, { ...RESUME, projects: [RESUME.projects[0]!] });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/not in the approved CV/);
  });

  it('names a section the approved CV does not have', async () => {
    const result = await validate(RESUME, { ...RESUME, projects: [] });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toContain('has a "Projects" section the approved CV does not have');
  });

  it('names sections in the wrong order', async () => {
    const swapped = { ...RESUME, experience: [RESUME.experience[1]!, RESUME.experience[0]!] };
    const result = await validate(swapped, RESUME);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/out of order/);
  });

  it('names extra text that is not in the approved CV', async () => {
    const result = await validate({ ...RESUME, summary: `${RESUME.summary} Led a team of forty.` }, RESUME);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/not in the approved CV/);
  });

  it('names a client engagement shown without its end client', async () => {
    const result = await validate({ ...RESUME, experience: [RESUME.experience[0]!, { ...RESUME.experience[1]!, client: '' }] }, RESUME);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toContain('the client "Contoso Rail" is missing');
  });

  it('fails a file that is not a Word document', async () => {
    const result = await validateRenderedResumeDocx(new TextEncoder().encode('not a docx'), RESUME);
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toMatch(/could not be reopened/);
  });

  it('never reports a page count or fit', async () => {
    const result = await validateRenderedResumeDocx(await renderResumeDocx(RESUME), RESUME);
    expect(Object.keys(result).sort()).toEqual(['contentHash', 'ok', 'reasons']);
  });
});
