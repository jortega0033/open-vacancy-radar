import { describe, expect, it } from 'vitest';
import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';
import { cvDocumentToTailoredResume, sanitizeCvExportFileName } from '../electron/cv-export.js';
import type { CvDocumentRecord } from '../electron/workspace/types.js';

const CV: CvDocumentRecord = {
  id: 'cv-1',
  name: 'Frontend CV: Netherlands',
  kind: 'manual',
  targetRole: 'Senior Frontend Engineer',
  text: '',
  profile: {
    title: 'Senior Frontend Engineer',
    years: '8',
    location: 'Amsterdam, Netherlands',
    languages: 'Dutch (B2), English (native)',
    skills: ['TypeScript', 'React', 'Accessibility'],
    summary: 'Frontend engineer with eight years building design systems.',
    auth: 'EU citizen, no sponsorship needed',
  },
  isDefault: true,
  uploadedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const CANDIDATE: CandidateProfile = {
  profileVersion: 'candidate-profile-1',
  candidateName: 'Jamie Rivera',
  currentRole: 'Senior Frontend Engineer',
  location: 'Amsterdam, Netherlands',
  experienceYears: 8,
  strongestSkills: ['TypeScript'],
  additionalSkills: [],
  targetRoles: ['Senior Frontend Engineer'],
  consideredRoles: [],
  excludedRoleFamilies: [],
  constraints: {
    professionalLanguage: 'English',
    dutchRequired: false,
    primaryCountry: 'NL',
    allowRemoteEuSupportingNetherlands: true,
    minimumMonthlyBaseEur: 0,
  },
};

describe('cvDocumentToTailoredResume (#156)', () => {
  it('maps the CV profile fields the template can render', () => {
    const resume = cvDocumentToTailoredResume(CV, CANDIDATE);
    expect(resume.contact.name).toBe('Jamie Rivera');
    expect(resume.contact.title).toBe('Senior Frontend Engineer');
    expect(resume.contact.location).toBe('Amsterdam, Netherlands');
    expect(resume.summary).toBe('Frontend engineer with eight years building design systems.');
    expect(resume.skills).toEqual(['TypeScript', 'React', 'Accessibility']);
  });

  it('never invents contact details the CV profile does not have', () => {
    const resume = cvDocumentToTailoredResume(CV, CANDIDATE);
    expect(resume.contact.email).toBe('');
    expect(resume.contact.phone).toBe('');
    expect(resume.contact.links).toEqual([]);
  });

  it('never invents employer history the CV profile does not have', () => {
    const resume = cvDocumentToTailoredResume(CV, CANDIDATE);
    expect(resume.experience).toEqual([]);
    expect(resume.education).toEqual([]);
  });

  it('leaves the name blank rather than fabricating one when no candidate profile is configured', () => {
    const resume = cvDocumentToTailoredResume(CV, null);
    expect(resume.contact.name).toBe('');
    // Everything else still comes from the CV's own profile.
    expect(resume.contact.title).toBe('Senior Frontend Engineer');
  });

  it('never uses the CV entry\'s own label as the candidate name', () => {
    // "Frontend CV: Netherlands" is a label for the document, not a person -- it must never leak
    // into contact.name even when a candidate profile is configured.
    const resume = cvDocumentToTailoredResume(CV, CANDIDATE);
    expect(resume.contact.name).not.toBe(CV.name);
  });
});

describe('sanitizeCvExportFileName (#156)', () => {
  it('strips filename-invalid characters and collapses whitespace', () => {
    expect(sanitizeCvExportFileName('Frontend CV: Netherlands / Remote?')).toBe('Frontend CV Netherlands Remote');
  });

  it('falls back to "cv" for an empty or all-invalid name', () => {
    expect(sanitizeCvExportFileName('')).toBe('cv');
    expect(sanitizeCvExportFileName('   ')).toBe('cv');
    expect(sanitizeCvExportFileName('///')).toBe('cv');
  });
});
