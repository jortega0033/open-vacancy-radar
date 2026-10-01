import { describe, expect, it } from 'vitest';
import { parseCvAiResponse, toPartialCvProfile } from '../src/components/cv-library/cv-ai-parse.js';

describe('parseCvAiResponse', () => {
  it('parses a bare JSON object', () => {
    expect(parseCvAiResponse('{"title": "Frontend Engineer"}')).toEqual({ title: 'Frontend Engineer' });
  });

  it('strips a Markdown code fence the model added despite being told not to', () => {
    const raw = '```json\n{"title": "Frontend Engineer"}\n```';
    expect(parseCvAiResponse(raw)).toEqual({ title: 'Frontend Engineer' });
  });

  it('recovers the JSON object even with a stray sentence before or after it', () => {
    const raw = 'Here you go:\n{"title": "Frontend Engineer"}\nHope that helps!';
    expect(parseCvAiResponse(raw)).toEqual({ title: 'Frontend Engineer' });
  });

  it('throws a user-facing message when the response is not JSON at all', () => {
    expect(() => parseCvAiResponse('sorry, I cannot do that')).toThrow(/not valid json/i);
  });
});

describe('toPartialCvProfile', () => {
  it('drops non-string scalar fields instead of coercing them', () => {
    expect(toPartialCvProfile({ title: 'Engineer', years: 5 })).toEqual({ title: 'Engineer' });
  });

  it('drops empty strings and empty arrays rather than overwriting existing form fields with blanks', () => {
    expect(toPartialCvProfile({ title: '', skills: [] })).toEqual({});
  });

  it('filters non-string entries out of the skills array rather than rejecting the whole field', () => {
    expect(toPartialCvProfile({ skills: ['React', 42, '  TypeScript  ', null] })).toEqual({
      skills: ['React', 'TypeScript'],
    });
  });

  it('ignores unknown fields and non-object input', () => {
    expect(toPartialCvProfile({ title: 'Engineer', unknownField: 'x' })).toEqual({ title: 'Engineer' });
    expect(toPartialCvProfile('not an object')).toEqual({});
    expect(toPartialCvProfile(null)).toEqual({});
  });
});
