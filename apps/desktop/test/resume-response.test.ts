import { describe, expect, it } from 'vitest';
import { EMPTY_TAILORED_RESUME, RESUME_LIMITS } from '../electron/resume-schema.js';
import { parseTailoredResumeResponse, toTailoredResume } from '../src/components/cv/resume-response.js';

const VALID = {
  contact: {
    name: 'Jamie Rivera',
    title: 'Frontend Engineer',
    location: 'Amsterdam, Netherlands',
    email: 'jamie@example.invalid',
    phone: '',
    links: ['https://github.com/example'],
  },
  summary: 'Frontend engineer with eight years building design systems.',
  experience: [
    { company: 'Redwood Software', title: 'Senior Frontend Engineer', dates: '2021-Present', bullets: ['Led the design system rewrite.'] },
  ],
  skills: ['TypeScript', 'React'],
  education: [{ institution: 'TU Delft', credential: 'BSc Computer Science', dates: '2014-2018' }],
};

describe('toTailoredResume', () => {
  it('round-trips a well-formed resume unchanged', () => {
    expect(toTailoredResume(VALID)).toEqual(VALID);
  });

  it('falls back to the empty resume for a non-object value, rather than throwing', () => {
    expect(toTailoredResume(null)).toEqual(EMPTY_TAILORED_RESUME);
    expect(toTailoredResume('a string')).toEqual(EMPTY_TAILORED_RESUME);
    expect(toTailoredResume(42)).toEqual(EMPTY_TAILORED_RESUME);
  });

  it('fills in missing top-level fields with their empty defaults instead of dropping the whole object', () => {
    expect(toTailoredResume({ summary: 'Only a summary was returned.' })).toEqual({
      ...EMPTY_TAILORED_RESUME,
      summary: 'Only a summary was returned.',
    });
  });

  it('drops a malformed experience entry rather than discarding every entry', () => {
    const result = toTailoredResume({
      ...VALID,
      experience: [VALID.experience[0], 'not an object', { company: '', title: '' }, null],
    });
    // The all-empty entry (no company, no title) and the non-object entries are dropped.
    expect(result.experience).toEqual(VALID.experience);
  });

  it('drops a malformed education entry the same way', () => {
    const result = toTailoredResume({ ...VALID, education: [VALID.education[0], { institution: '', credential: '' }] });
    expect(result.education).toEqual(VALID.education);
  });

  it('never invents a value: a field the response omits stays empty, not filled with a placeholder', () => {
    const result = toTailoredResume({
      contact: { name: 'Jamie Rivera' },
      summary: '',
      experience: [],
      skills: [],
      education: [],
    });
    expect(result.contact).toEqual({ name: 'Jamie Rivera', title: '', location: '', email: '', phone: '', links: [] });
  });

  it('bounds every list to its documented limit', () => {
    const result = toTailoredResume({
      ...VALID,
      skills: Array.from({ length: RESUME_LIMITS.skills + 50 }, (_, i) => `skill-${i}`),
      contact: { ...VALID.contact, links: Array.from({ length: RESUME_LIMITS.links + 5 }, (_, i) => `link-${i}`) },
    });
    expect(result.skills).toHaveLength(RESUME_LIMITS.skills);
    expect(result.contact.links).toHaveLength(RESUME_LIMITS.links);
  });

  it('bounds each short field length', () => {
    const result = toTailoredResume({ ...VALID, summary: 'x'.repeat(RESUME_LIMITS.summary + 1000) });
    expect(result.summary).toHaveLength(RESUME_LIMITS.summary);
  });
});

describe('parseTailoredResumeResponse', () => {
  it('parses a bare JSON object', () => {
    expect(parseTailoredResumeResponse(JSON.stringify(VALID))).toEqual(VALID);
  });

  it('salvages JSON wrapped in a fenced code block, matching parseCvAiResponse\'s own tolerance', () => {
    const wrapped = `Here is the resume:\n\`\`\`json\n${JSON.stringify(VALID)}\n\`\`\``;
    expect(parseTailoredResumeResponse(wrapped)).toEqual(VALID);
  });

  it('throws a user-facing error for genuinely unparseable output', () => {
    expect(() => parseTailoredResumeResponse('not json at all')).toThrow(/could not be generated/);
  });
});
