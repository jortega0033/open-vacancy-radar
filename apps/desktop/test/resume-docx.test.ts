import { describe, expect, it } from 'vitest';
import type { TailoredResume } from '../electron/resume-schema.js';
import { renderResumeDocx } from '../electron/resume-docx.js';

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
  projects: [],
  experience: [
    {
      company: 'Redwood Software',
      title: 'Senior Frontend Engineer',
      dates: '2021 - Present',
      engagement: 'employment',
      client: '',
      bullets: ['Led the design system rewrite.', 'Mentored three junior engineers.'],
    },
  ],
  skills: ['TypeScript', 'React', 'Accessibility'],
  education: [{ institution: 'TU Delft', credential: 'BSc Computer Science', dates: '2014 - 2018' }],
};

/** The ZIP local-file-header signature every real `.docx` (a zip archive) starts with -- the same
 * magic-bytes check the ticket's own acceptance criterion asks for. */
const DOCX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

describe('renderResumeDocx', () => {
  it('produces a real, non-empty .docx buffer starting with the ZIP magic bytes', async () => {
    const buffer = await renderResumeDocx(RESUME);
    expect(buffer.byteLength).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4)).toEqual(DOCX_MAGIC);
  });

  it('renders without throwing for a fully empty resume', async () => {
    const buffer = await renderResumeDocx({
      contact: { name: '', title: '', location: '', email: '', phone: '', links: [] },
      summary: '',
      experience: [],
      projects: [],
      skills: [],
      education: [],
    });
    expect(buffer.byteLength).toBeGreaterThan(0);
    expect(buffer.subarray(0, 4)).toEqual(DOCX_MAGIC);
  });

  it('renders a resume with two experience entries and education without throwing', async () => {
    const twoJobs: TailoredResume = {
      ...RESUME,
      experience: [
        RESUME.experience[0]!,
        { company: 'Acme Corp', title: 'Frontend Engineer', dates: '2018 - 2021', engagement: 'employment', client: '', bullets: [] },
      ],
    };
    const buffer = await renderResumeDocx(twoJobs);
    expect(buffer.byteLength).toBeGreaterThan(0);
  });
});
