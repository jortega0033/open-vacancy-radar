import type { CvDocumentRecord, LetterRecord } from '../../../src/window.js';
import type { SelectedVacancy } from '../../../src/components/letters/index.js';

/**
 * Shared fixtures for the three Letters tests. Deliberately full records rather than `as`-cast
 * partials: the point of `electron/workspace/types.ts` is that the renderer and main agree on
 * every field, and a cast would let a test keep passing after that contract changed.
 */
export function makeCv(overrides: Partial<CvDocumentRecord> = {}): CvDocumentRecord {
  return {
    id: 'cv-1',
    name: 'Frontend CV.pdf',
    kind: 'uploaded',
    targetRole: 'Senior Frontend Engineer',
    text: 'Angular architect. Eight years of frontend work. Design systems.',
    profile: {
      title: 'Senior Frontend Engineer',
      years: '8',
      location: 'Amsterdam',
      languages: 'English, Dutch',
      skills: ['Angular', 'TypeScript'],
      summary: 'Frontend engineer.',
      auth: 'EU citizen',
    },
    isDefault: true,
    uploadedAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    ...overrides,
  };
}

export function makeLetter(overrides: Partial<LetterRecord> = {}): LetterRecord {
  return {
    id: 'letter-1',
    title: 'Motivation letter — Redwood Software',
    company: 'Redwood Software',
    role: 'Senior Frontend Engineer',
    type: 'motivation_letter',
    tone: 'natural',
    length: 'standard',
    status: 'draft',
    vacancyKey: 'redwood:senior-frontend-engineer',
    cvId: 'cv-1',
    body: 'Dear hiring team, I am writing about the Senior Frontend Engineer role.',
    updatedAt: '2026-08-20T10:00:00.000Z',
    ...overrides,
  };
}

export const LETTER_VACANCY: SelectedVacancy = {
  title: 'Senior Frontend Engineer',
  company: 'Redwood Software',
  location: 'Amsterdam, Netherlands',
  url: 'https://example.invalid/jobs/senior-frontend-engineer',
  description: 'Build Angular applications. Five years of frontend experience required.',
  key: 'redwood:senior-frontend-engineer',
};
