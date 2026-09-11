/**
 * The reviewed, full structured *source* CV (#274): the candidate's own document, preserved as
 * records rather than reduced to the seven flat `CvProfile` fields.
 *
 * `CvProfile` (see `cv-profile-schema.ts`) is a summary -- title, years, location, languages,
 * skills, summary, auth -- and nothing in it can carry an employer, a date range, a contact
 * correction, a link, or a project. That is why `cv-export.ts` had to emit empty
 * experience/education arrays and blank contact fields: there was genuinely nothing to emit. This
 * module is the shape that *does* carry them, so an export or a tailoring pass has real source
 * facts to work from instead of a thin profile and a no-invention rule.
 *
 * Three properties this shape exists to guarantee:
 *
 * 1. **Provenance, not reconstruction.** Every field holds the source CV's own words. `dates` is
 *    free text for the same reason `ResumeExperienceEntry.dates` is: CVs write dates too many ways
 *    to parse into a range without risking an inference the document never made.
 * 2. **Client engagements stay distinct from direct employment.** `engagement`/`client` are
 *    separate fields, never folded into `company`, so a contract delivered for an end client can
 *    never be rendered (or re-tailored) as direct employment at that client.
 * 3. **Honest incompleteness.** `complete`/`incompleteReason`/`coveredChars`/`sourceChars` record
 *    whether the whole document was actually read. A CV whose later sections were never seen is a
 *    known-incomplete record that blocks a final export, never a silently shortened one that
 *    exports looking finished.
 *
 * Deliberately no runtime imports, the same discipline (and the same `eslint.config.js`
 * `no-restricted-imports` rule) as `cv-profile-schema.ts`: this file is bundled into both the
 * renderer and the Electron main process, and that is only safe while it never touches an
 * Electron- or Node-only API at runtime.
 */

/** How a role was actually held. Kept separate from `company` on purpose -- see this module's
 * header, property 2. */
export type CvEngagementType = 'employment' | 'client_engagement';

export const CV_ENGAGEMENT_TYPES: readonly CvEngagementType[] = ['employment', 'client_engagement'];

export interface CvSourceContact {
  name: string;
  title: string;
  location: string;
  email: string;
  phone: string;
  /** Portfolio/LinkedIn/GitHub links, exactly as the source CV writes them. */
  links: string[];
}

export interface CvSourceExperienceEntry {
  /** The direct employer, agency, or own company -- never the end client of a contract. */
  company: string;
  title: string;
  /** Free text, e.g. "Jan 2021 - Present". */
  dates: string;
  engagement: CvEngagementType;
  /** The end client, for a `client_engagement`. Empty for direct employment. */
  client: string;
  bullets: string[];
}

export interface CvSourceEducationEntry {
  institution: string;
  credential: string;
  dates: string;
}

export interface CvSourceProjectEntry {
  /** Stable across edits, so a pin (and a tailored output referring back here) survives the list
   * being reordered or re-extracted. Assigned by the app, never by the model. */
  id: string;
  name: string;
  role: string;
  dates: string;
  /** The employer, client or context the project was delivered under, when the CV states one. */
  organization: string;
  description: string;
  technologies: string[];
  links: string[];
  /**
   * The candidate's own "always keep this one" mark. Pinned projects survive tailoring: they are
   * selected before anything else and are never displaced by `maxProjects`. This is why the count
   * below can be a plain cap rather than an applicant-specific rule about which projects matter.
   */
  pinned: boolean;
}

export interface CvSourceDocument {
  contact: CvSourceContact;
  summary: string;
  experience: CvSourceExperienceEntry[];
  education: CvSourceEducationEntry[];
  projects: CvSourceProjectEntry[];
  /**
   * How many projects at most reach a tailored document. Candidate-configurable per CV; `0` means
   * "every project in this source", which is the default precisely so the app ships no opinion
   * about how many projects a given candidate should show.
   */
  maxProjects: number;
  /** False when the source text was not read end to end (see `incompleteReason`). */
  complete: boolean;
  /** Why this record is incomplete, in the user's terms. Empty when `complete` is true. */
  incompleteReason: string;
  /** Characters of `CvDocumentRecord.text` actually covered when this record was produced. */
  coveredChars: number;
  /** Characters the source text had in total. */
  sourceChars: number;
  /** ISO-8601 of when a person actually confirmed this record, stamped by the main process (never
   * renderer-supplied, the same rule `savedJobs.gapAnalysisAt` follows). Empty means never. */
  reviewedAt: string;
}

/** Field size budgets. Generous for a real CV, finite against a hostile or over-eager answer --
 * the same reasoning as `CV_PROFILE_LIMITS` and `RESUME_LIMITS`. */
export const CV_SOURCE_LIMITS = {
  /** name / title / location / email / phone / company / client / institution / credential / dates
   * / project name / project role / project organization */
  shortField: 512,
  /** each link, each technology */
  listItem: 512,
  /** each experience bullet */
  bullet: 1_000,
  summary: 4_000,
  projectDescription: 4_000,
  incompleteReason: 1_000,
  links: 10,
  experienceEntries: 60,
  bulletsPerEntry: 30,
  educationEntries: 20,
  projectEntries: 60,
  technologiesPerProject: 40,
  linksPerProject: 5,
  /** A cap on the configurable cap: a number, not a product opinion. */
  maxProjectsSetting: 60,
} as const;

/** `0` means "no cap": include every project the source has. */
export const PROJECTS_UNLIMITED = 0;

export const EMPTY_CV_SOURCE: CvSourceDocument = {
  contact: { name: '', title: '', location: '', email: '', phone: '', links: [] },
  summary: '',
  experience: [],
  education: [],
  projects: [],
  maxProjects: PROJECTS_UNLIMITED,
  complete: true,
  incompleteReason: '',
  coveredChars: 0,
  sourceChars: 0,
  reviewedAt: '',
};

/** The JSON shape the source-CV extraction prompt asks for, and the shape the response coercion
 * reads back -- kept in this one dependency-free file so the two can never drift. `id` and
 * `pinned` are absent on purpose: the app assigns the id and the candidate owns the pin, so a
 * model is never asked for either. */
export const CV_SOURCE_JSON_SHAPE =
  '{"contact": {"name": string, "title": string, "location": string, "email": string, "phone": string, "links": string[]}, ' +
  '"summary": string, ' +
  '"experience": [{"company": string, "title": string, "dates": string, "engagement": "employment" | "client_engagement", "client": string, "bullets": string[]}], ' +
  '"education": [{"institution": string, "credential": string, "dates": string}], ' +
  '"projects": [{"name": string, "role": string, "dates": string, "organization": string, "description": string, "technologies": string[], "links": string[]}]}';

/**
 * Which projects reach a document built from this source, in order.
 *
 * Pinned first, in source order, then the rest in source order, and the cap is applied to the
 * unpinned tail only: a pin is the candidate's explicit instruction, so a cap set lower than the
 * number of pins keeps every pin rather than quietly discarding one. `maxProjects: 0` means no cap.
 */
export function selectSourceProjects(source: CvSourceDocument): CvSourceProjectEntry[] {
  const pinned = source.projects.filter((project) => project.pinned);
  const unpinned = source.projects.filter((project) => !project.pinned);
  if (source.maxProjects === PROJECTS_UNLIMITED) return [...pinned, ...unpinned];
  const remaining = Math.max(0, source.maxProjects - pinned.length);
  return [...pinned, ...unpinned.slice(0, remaining)];
}

/**
 * Every reason this source CV must not back a final export, in the user's terms. Empty means it
 * may. Returning reasons rather than a bare boolean is the same choice `validateRenderedResumePdf`
 * makes: the caller has to be able to say what is wrong and what would fix it, because the whole
 * point of blocking here is that the alternative -- exporting a document that looks complete and
 * is not -- is the failure this record exists to prevent.
 */
export function describeCvSourceGaps(source: CvSourceDocument): string[] {
  const reasons = describeCvSourceContentGaps(source);
  if (source.reviewedAt.trim().length === 0) {
    reasons.push('the extracted source CV has not been reviewed and confirmed yet');
  }
  return reasons;
}

/**
 * The subset of the above that saying "yes, this is right" cannot fix: the record is missing
 * content nobody has seen. Split out for the review UI, which must not list "has not been reviewed
 * yet" as a blocker to a person who is reviewing it right now -- their next click clears exactly
 * that one, and only that one.
 */
export function describeCvSourceContentGaps(source: CvSourceDocument): string[] {
  if (source.complete) return [];
  const detail =
    source.incompleteReason ||
    `only ${source.coveredChars.toLocaleString('en-US')} of ${source.sourceChars.toLocaleString('en-US')} characters of the CV were read`;
  return [`the source CV is incomplete: ${detail}`];
}

export function isCvSourceExportable(source: CvSourceDocument): boolean {
  return describeCvSourceGaps(source).length === 0;
}
