import { describe, expect, it } from 'vitest';
import { findResumeClaimProblems, resumeClaims } from '../electron/resume-claims.js';
import { renderResumePlainText } from '../electron/resume-text.js';
import type { TailoredResume } from '../electron/resume-schema.js';

const RESUME: TailoredResume = {
  contact: {
    name: 'Jamie Rivera',
    title: 'Frontend engineer',
    location: 'Utrecht, Netherlands',
    email: 'jamie.rivera@example.invalid',
    phone: '+31 6 0000 0000',
    links: ['https://example.invalid/jamie'],
  },
  summary: 'Frontend engineer who builds booking and reporting screens.',
  experience: [
    { company: 'Redwood Software', title: 'Senior Frontend Engineer', dates: '2021 - Present', engagement: 'employment', client: '', bullets: ['Built the booking screens, using Angular'] },
    { company: 'Northwind Agency', title: 'Developer', dates: '2018 - 2021', engagement: 'client_engagement', client: 'Contoso Rail', bullets: ['Built the timetable widgets'] },
  ],
  projects: [
    { name: 'Toolkit', role: 'Maintainer', dates: '2023', organization: 'Open source', description: 'A component toolkit.', technologies: ['TypeScript', 'React'], links: ['https://example.invalid/toolkit'] },
  ],
  skills: ['TypeScript', 'Angular'],
  education: [{ institution: 'Utrecht University', credential: 'BSc Computer Science', dates: '2014 - 2018' }],
};

describe('renderResumePlainText (#419 step 9)', () => {
  it('carries every claim of the approved snapshot, in order', () => {
    const text = renderResumePlainText(RESUME);
    expect(findResumeClaimProblems(text, resumeClaims(RESUME))).toEqual([]);
  });

  it('adds no claim the snapshot does not hold', () => {
    const text = renderResumePlainText(RESUME);
    const claims = resumeClaims(RESUME).map((claim) => claim.text);
    const filler = ['Technologies:', 'Links:', 'Client engagement:'];
    let rest = text;
    for (const claim of [...claims].sort((a, b) => b.length - a.length)) rest = rest.split(claim).join(' ');
    for (const word of filler) rest = rest.split(word).join(' ');
    expect(rest.replace(/[\s,:;|()\-]+/g, '')).toBe('');
  });

  it('omits an empty section entirely', () => {
    const text = renderResumePlainText({ ...RESUME, projects: [], skills: [] });
    expect(text).not.toContain('Projects');
    expect(text).not.toContain('Skills');
    expect(findResumeClaimProblems(text, resumeClaims({ ...RESUME, projects: [], skills: [] }))).toEqual([]);
  });

  it('shows a client engagement with its end client, never as direct employment', () => {
    expect(renderResumePlainText(RESUME)).toContain('Client engagement: Contoso Rail');
  });

  it('a claim missing from other text is reported', () => {
    const problems = findResumeClaimProblems(renderResumePlainText(RESUME).replace('Angular', 'Vue'), resumeClaims(RESUME));
    expect(problems.join(' ')).toContain('is missing');
  });
});
