import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';
import type { TailoredResume } from './resume-schema.js';
import type { CvDocumentRecord } from './workspace/types.js';

/**
 * The mapping half of #156's manual CV Library export: turns one `CvDocumentRecord` (the flat
 * `title`/`years`/`location`/`languages`/`skills`/`summary`/`auth` profile a CV Library entry
 * actually stores -- see `workspace/types.ts`'s `CvProfile`) into the structured `TailoredResume`
 * shape `resume-html.ts`/`resume-docx.ts` already know how to render.
 *
 * Deliberately conservative about what it fills in, on the same no-invention principle
 * `resume-schema.ts`'s own doc comment states for the AI-generated path: a `CvProfile` has no
 * employer history (no company, no per-role dates or bullets) and no contact details (no email,
 * phone, or links) at all, so `experience`/`education` stay empty arrays and `contact.email`/
 * `contact.phone`/`contact.links` stay blank strings/an empty array here rather than guessing at
 * content the stored profile never captured. A thin, honest resume beats a fabricated one.
 *
 * `contact.name` is the one field this reaches outside `CvDocumentRecord` for: the CV Library has
 * no "candidate's own name" field anywhere (the document's own `name`, e.g. "Frontend CV:
 * Netherlands", is a label for the entry, not the person), while `CandidateProfile.candidateName`
 * (the Search page's own candidate profile, already real user-entered data) is the one place in
 * this app that is. `candidate` is passed in rather than loaded here, so this function stays free
 * of any Electron/filesystem API and is unit-testable on its own -- see `cv-export.test.ts`.
 */
export function cvDocumentToTailoredResume(doc: CvDocumentRecord, candidate: CandidateProfile | null): TailoredResume {
  return {
    contact: {
      name: candidate?.candidateName.trim() ?? '',
      title: doc.profile.title,
      location: doc.profile.location,
      email: '',
      phone: '',
      links: [],
    },
    summary: doc.profile.summary,
    experience: [],
    skills: doc.profile.skills,
    education: [],
  };
}

/** Strips characters invalid in a Windows/macOS filename and collapses whitespace, mirroring
 * `letters/export.ts`'s `sanitizeFileName` (not imported: that module lives in `src/`, the
 * renderer's own bundle, and electron/ never imports from it). */
export function sanitizeCvExportFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'cv';
}
