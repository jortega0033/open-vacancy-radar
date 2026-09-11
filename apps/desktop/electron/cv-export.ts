import type { TailoredResume } from './resume-schema.js';
import { tailoredResumeFromSource } from './resume-source.js';
import { describeCvSourceGaps } from './workspace/cv-source-schema.js';
import type { CvDocumentRecord } from './workspace/types.js';

/**
 * The mapping half of #156's manual CV Library export, now source-aware (#274).
 *
 * Two paths, and which one runs is decided entirely by whether this record has a reviewed
 * structured source CV (`CvDocumentRecord.source`, see `workspace/cv-source-schema.ts`):
 *
 *  - **With a source.** Real employers with their own dates and engagement type, real education,
 *    the candidate's own corrected contact details and links, and the projects
 *    `selectSourceProjects` picks out of their pins and configured count. This is the content the
 *    flat profile could never hold, and it reaches the document exactly as it was reviewed.
 *  - **Without one.** The original conservative mapping, unchanged: a `CvProfile` has no employer
 *    history and no contact details at all, so `experience`/`education` stay empty and
 *    `email`/`phone`/`links` stay blank rather than guessing at content the stored profile never
 *    captured. A thin, honest resume beats a fabricated one, and that stays true for every record
 *    written before this column existed.
 *
 * `contact.name` is where the two paths differ most. A reviewed source carries the candidate's own
 * name as their CV writes it, so that wins when present; without one, this falls back to
 * `CandidateProfile.candidateName` (the Search page's own profile, the other place in this app that
 * holds real user-entered identity) exactly as before. The CV Library entry's own `name` (e.g.
 * "Frontend CV: Netherlands") is a label for the entry, never a person, and is used by neither.
 *
 * `candidate` is passed in rather than loaded here, so this function stays free of any
 * Electron/filesystem API and is unit-testable on its own -- see `cv-export.test.ts`. It is typed
 * as the one field actually read rather than as the whole `CandidateProfile`: a real profile still
 * satisfies it unchanged, and #272's preparation pipeline can hand over the narrow projection it
 * already carries without importing the vacancy engine's profile schema for a single string.
 */
export function cvDocumentToTailoredResume(doc: CvDocumentRecord, candidate: { candidateName: string } | null): TailoredResume {
  const fallbackName = candidate?.candidateName.trim() ?? '';
  if (doc.source) {
    const resume = tailoredResumeFromSource(doc.source, doc.profile.skills);
    return {
      ...resume,
      contact: {
        ...resume.contact,
        name: resume.contact.name || fallbackName,
        title: resume.contact.title || doc.profile.title,
        location: resume.contact.location || doc.profile.location,
      },
    };
  }

  return {
    contact: {
      name: fallbackName,
      title: doc.profile.title,
      location: doc.profile.location,
      email: '',
      phone: '',
      links: [],
    },
    summary: doc.profile.summary,
    experience: [],
    projects: [],
    skills: doc.profile.skills,
    education: [],
  };
}

/**
 * Whether this CV may back a final export, and if not, exactly why (#274).
 *
 * The case this exists for is the one the ticket names: a CV long enough that its later sections,
 * projects included, were never read. Exporting that produces a document that looks finished and is
 * missing real evidence, and the user has no way to tell -- so the export is refused with the
 * reasons rather than silently shortened. A record with no structured source at all is *not*
 * blocked: the profile-only path above invents nothing, so there is nothing misleading about it.
 */
export function describeCvExportBlockers(doc: CvDocumentRecord): string[] {
  return doc.source ? describeCvSourceGaps(doc.source) : [];
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
