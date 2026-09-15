import type { CvDocumentRecord, LetterRecord } from '../../../src/window.js';
import type { SelectedVacancy } from '../../../src/components/letters/index.js';

/**
 * Shared fixtures for the three Letters tests. Deliberately full records rather than `as`-cast
 * partials: the point of `electron/workspace/types.ts` is that the renderer and main agree on
 * every field, and a cast would let a test keep passing after that contract changed.
 *
 * Every value here is synthetic: an invented employer, an invented candidate, and an
 * `example.invalid` address. Nothing in this file is anyone's real CV.
 *
 * The default record carries a reviewed `source` because that is now the precondition for
 * generating a letter at all (F-J): letters are assembled from facts a person confirmed, so a
 * record without one is the *exceptional* fixture, not the ordinary one. `makeUnreviewedCv` below
 * is how a test asks for that case.
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
    source: {
      contact: {
        name: 'Robin Vega',
        title: 'Senior Frontend Engineer',
        location: 'Amsterdam',
        email: 'robin.vega@example.invalid',
        phone: '',
        links: [],
      },
      summary: 'Frontend engineer working on design systems.',
      experience: [
        {
          company: 'Northwind Digital',
          title: 'Senior Frontend Engineer',
          dates: '2021 - present',
          engagement: 'employment',
          client: '',
          bullets: ['Rebuilt the component library.'],
        },
      ],
      education: [{ institution: 'Utrecht Polytechnic', credential: 'BSc Computer Science', dates: '2013 - 2017' }],
      projects: [
        {
          id: 'p1',
          name: 'Atlas Design Kit',
          role: 'Lead',
          dates: '2022',
          organization: 'Northwind Digital',
          description: 'Component library.',
          technologies: ['TypeScript'],
          links: [],
          pinned: true,
        },
      ],
      maxProjects: 0,
      complete: true,
      incompleteReason: '',
      coveredChars: 4_000,
      sourceChars: 4_000,
      reviewedAt: '2026-08-01T09:00:00.000Z',
    },
    isDefault: true,
    uploadedAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    ...overrides,
  };
}

/** A CV whose source has never been extracted and confirmed: the state in which a grounded letter
 * cannot be assembled, because there are no facts anybody has checked. */
export function makeUnreviewedCv(overrides: Partial<CvDocumentRecord> = {}): CvDocumentRecord {
  return makeCv({ source: null, ...overrides });
}

/** One well-formed reply from a selection run: two ids that exist on `makeCv`'s reviewed source. */
export const FACT_SELECTION = '{"factIds":["experience-1","skill-1"]}';

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
