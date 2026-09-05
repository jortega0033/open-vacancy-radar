import { describe, expect, it } from 'vitest';
import type { TailoredResume } from '../electron/resume-schema.js';
import { renderResumeHtml } from '../electron/resume-html.js';

const RESUME: TailoredResume = {
  contact: {
    name: 'Jamie Rivera',
    title: 'Senior Frontend Engineer',
    location: 'Amsterdam, Netherlands',
    email: 'jamie@example.invalid',
    phone: '+31 6 1234 5678',
    links: ['https://github.com/example'],
  },
  summary: 'Frontend engineer with eight years building design systems.',
  experience: [
    {
      company: 'Redwood Software',
      title: 'Senior Frontend Engineer',
      dates: '2021 - Present',
      bullets: ['Led the design system rewrite.', 'Mentored three junior engineers.'],
    },
  ],
  skills: ['TypeScript', 'React', 'Accessibility'],
  education: [{ institution: 'TU Delft', credential: 'BSc Computer Science', dates: '2014 - 2018' }],
};

describe('renderResumeHtml', () => {
  it('renders a complete, valid HTML document', () => {
    const html = renderResumeHtml(RESUME);
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
  });

  it('includes the candidate name, employer, role, and dates as real text', () => {
    const html = renderResumeHtml(RESUME);
    expect(html).toContain('Jamie Rivera');
    expect(html).toContain('Redwood Software');
    expect(html).toContain('Senior Frontend Engineer');
    expect(html).toContain('2021 - Present');
    expect(html).toContain('Led the design system rewrite.');
  });

  it('escapes HTML-significant characters in every field rather than interpolating them raw', () => {
    const hostile: TailoredResume = {
      ...RESUME,
      contact: { ...RESUME.contact, name: '<script>alert(1)</script>' },
      summary: 'Summary with "quotes" & <tags>',
    };
    const html = renderResumeHtml(hostile);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;quotes&quot;');
  });

  it('omits a section entirely when its data is empty, rather than rendering an empty heading', () => {
    const noEducation: TailoredResume = { ...RESUME, education: [] };
    const html = renderResumeHtml(noEducation);
    expect(html).not.toContain('Education');
  });

  it('omits every optional section for a fully empty resume without throwing', () => {
    const html = renderResumeHtml({
      contact: { name: '', title: '', location: '', email: '', phone: '', links: [] },
      summary: '',
      experience: [],
      skills: [],
      education: [],
    });
    expect(html).not.toContain('Experience');
    expect(html).not.toContain('Skills');
    expect(html).not.toContain('Education');
    expect(html).toContain('Candidate'); // the no-name fallback heading
  });

  it('separates multiple experience and education entries as distinct blocks', () => {
    const twoJobs: TailoredResume = {
      ...RESUME,
      experience: [
        RESUME.experience[0]!,
        { company: 'Acme Corp', title: 'Frontend Engineer', dates: '2018 - 2021', bullets: [] },
      ],
    };
    const html = renderResumeHtml(twoJobs);
    expect(html).toContain('Redwood Software');
    expect(html).toContain('Acme Corp');
  });
});
