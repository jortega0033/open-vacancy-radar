import { describe, expect, it } from 'vitest';
import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';
import { buildCvCaseExportFileName, cvDocumentToTailoredResume, sanitizeCvExportFileName } from '../electron/cv-export.js';
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
  source: null,
  textSource: 'text_layer',
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

describe('sanitizeCvExportFileName (#156, #565e)', () => {
  it('strips filename-invalid characters and collapses whitespace', () => {
    expect(sanitizeCvExportFileName('Frontend CV: Netherlands / Remote?')).toBe('Frontend CV Netherlands Remote');
  });

  it('strips file extensions from uploaded CVs', () => {
    // Issue #565e: uploaded CVs keep their original filename with .docx extension
    expect(sanitizeCvExportFileName('Jake-Ortega-Senior-Frontend-Developer-React-TypeScript-v1.docx')).toBe(
      'Jake-Ortega-Senior-Frontend-Developer-React-TypeScript-v1'
    );
  });

  it('strips multiple dotted extensions but keeps other dots in the name', () => {
    expect(sanitizeCvExportFileName('My.CV.v2.0.docx')).toBe('My.CV.v2.0');
    expect(sanitizeCvExportFileName('Resume_2026.pdf')).toBe('Resume_2026');
  });

  it('falls back to "cv" for an empty or all-invalid name', () => {
    expect(sanitizeCvExportFileName('')).toBe('cv');
    expect(sanitizeCvExportFileName('   ')).toBe('cv');
    expect(sanitizeCvExportFileName('///')).toBe('cv');
  });

  it('keeps dots that are not a document extension', () => {
    expect(sanitizeCvExportFileName('Resume for Acme Inc. Senior role')).toBe('Resume for Acme Inc. Senior role');
    expect(sanitizeCvExportFileName('CV v2.0')).toBe('CV v2.0');
  });

  it('falls back to "cv" when left with only an extension', () => {
    expect(sanitizeCvExportFileName('.docx')).toBe('cv');
    expect(sanitizeCvExportFileName('.pdf')).toBe('cv');
  });
});

describe('buildCvCaseExportFileName (#565e)', () => {
  it('returns CV name alone when company is undefined', () => {
    expect(buildCvCaseExportFileName('Frontend CV', undefined)).toBe('Frontend CV');
  });

  it('returns CV name alone when company is empty string', () => {
    expect(buildCvCaseExportFileName('Frontend CV', '')).toBe('Frontend CV');
  });

  it('combines CV name and company with " - " separator', () => {
    expect(buildCvCaseExportFileName('Frontend CV', 'Acme Corp')).toBe('Frontend CV - Acme Corp');
  });

  it('strips extension from CV name before combining with company', () => {
    expect(buildCvCaseExportFileName('Jake-Ortega-Senior-Frontend-Developer-React-TypeScript-v1.docx', 'Mejuri')).toBe(
      'Jake-Ortega-Senior-Frontend-Developer-React-TypeScript-v1 - Mejuri'
    );
  });

  it('sanitizes invalid characters in both CV name and company', () => {
    expect(buildCvCaseExportFileName('Frontend CV: React?', 'Acme / Corp')).toBe('Frontend CV React - Acme Corp');
  });

  it('handles company names with invalid characters', () => {
    expect(buildCvCaseExportFileName('MyCV', 'Company <Inc>')).toBe('MyCV - Company Inc');
  });

  it('truncates combined name at 200 characters when necessary', () => {
    const longCvName = 'A'.repeat(150);
    const longCompany = 'B'.repeat(100);
    const result = buildCvCaseExportFileName(longCvName, longCompany);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it('keeps CV name intact if both are short enough', () => {
    const cvName = 'Frontend CV';
    const company = 'Acme';
    expect(buildCvCaseExportFileName(cvName, company)).toBe('Frontend CV - Acme');
  });

  it('intelligently truncates company when combined name exceeds 200 characters', () => {
    const longCvName = 'A'.repeat(80);
    const longCompany = 'B'.repeat(150);
    const result = buildCvCaseExportFileName(longCvName, longCompany);
    expect(result).toContain(' - ');
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.startsWith('A'.repeat(80))).toBe(true);
  });

  it('returns fallback CV name when all-invalid CV name becomes empty', () => {
    expect(buildCvCaseExportFileName('///', 'Acme')).toBe('cv - Acme');
  });

  it('handles whitespace collapsing in company name', () => {
    expect(buildCvCaseExportFileName('MyCV', 'Acme   Corp   Inc')).toBe('MyCV - Acme Corp Inc');
  });

  it('returns CV name when company sanitizes to empty', () => {
    expect(buildCvCaseExportFileName('MyCV', '///')).toBe('MyCV');
  });

  it('returns "cv" fallback when both CV name and company are invalid', () => {
    expect(buildCvCaseExportFileName('///', '///')).toBe('cv');
  });
});
