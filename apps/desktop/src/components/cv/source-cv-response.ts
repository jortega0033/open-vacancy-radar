import {
  CV_SOURCE_LIMITS,
  EMPTY_CV_SOURCE,
  PROJECTS_UNLIMITED,
  type CvSourceDocument,
  type CvSourceEducationEntry,
  type CvSourceExperienceEntry,
  type CvSourceProjectEntry,
} from '../../../electron/workspace/cv-source-schema.js';
import { extractAiJsonPayload } from '../cv-library/cv-ai-parse.js';
import { MAX_SOURCE_CV_PROMPT_CHARS, wasCvTextTruncated } from './prompts.js';

/**
 * Coerces one source-CV extraction answer (#274) into a `CvSourceDocument`, and records honestly
 * how much of the CV the answer could have been based on.
 *
 * The coercion half follows `toTailoredResume`'s stance exactly: drop what is malformed, keep what
 * is not, never throw away a whole answer over one bad array element, and never invent a value to
 * fill a gap. The second half is the part this ticket is really about -- `completenessOf` derives
 * `complete`/`coveredChars`/`sourceChars` from the prompt's own bound rather than from anything the
 * model says about itself, so a CV too long to be read in one pass produces a record that says so
 * and is refused an export, instead of a shortened one that exports looking finished.
 */

function stringField(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function stringArray(value: unknown, itemLimit: number, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().slice(0, itemLimit))
    .filter((entry) => entry.length > 0)
    .slice(0, maxItems);
}

function toExperienceEntry(value: unknown): CvSourceExperienceEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const company = stringField(record.company, CV_SOURCE_LIMITS.shortField);
  const title = stringField(record.title, CV_SOURCE_LIMITS.shortField);
  if (!company && !title) return undefined;
  const engagement = record.engagement === 'client_engagement' ? 'client_engagement' : 'employment';
  return {
    company,
    title,
    dates: stringField(record.dates, CV_SOURCE_LIMITS.shortField),
    engagement,
    client: engagement === 'client_engagement' ? stringField(record.client, CV_SOURCE_LIMITS.shortField) : '',
    bullets: stringArray(record.bullets, CV_SOURCE_LIMITS.bullet, CV_SOURCE_LIMITS.bulletsPerEntry),
  };
}

function toEducationEntry(value: unknown): CvSourceEducationEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const institution = stringField(record.institution, CV_SOURCE_LIMITS.shortField);
  const credential = stringField(record.credential, CV_SOURCE_LIMITS.shortField);
  if (!institution && !credential) return undefined;
  return { institution, credential, dates: stringField(record.dates, CV_SOURCE_LIMITS.shortField) };
}

function toProjectEntry(value: unknown, index: number): CvSourceProjectEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const name = stringField(record.name, CV_SOURCE_LIMITS.shortField);
  if (!name) return undefined;
  return {
    // App-assigned, never read from the answer: an id is this app's own handle on the entry, and a
    // model-supplied one would be a value the candidate never saw carried into their record.
    id: `project-${index + 1}`,
    name,
    role: stringField(record.role, CV_SOURCE_LIMITS.shortField),
    dates: stringField(record.dates, CV_SOURCE_LIMITS.shortField),
    organization: stringField(record.organization, CV_SOURCE_LIMITS.shortField),
    description: stringField(record.description, CV_SOURCE_LIMITS.projectDescription),
    technologies: stringArray(record.technologies, CV_SOURCE_LIMITS.listItem, CV_SOURCE_LIMITS.technologiesPerProject),
    links: stringArray(record.links, CV_SOURCE_LIMITS.listItem, CV_SOURCE_LIMITS.linksPerProject),
    // The candidate's own mark, so never preset from an extraction: nothing is pinned until a
    // person pins it in the review drawer.
    pinned: false,
  };
}

export interface SourceCvCompleteness {
  complete: boolean;
  incompleteReason: string;
  coveredChars: number;
  sourceChars: number;
}

/**
 * How much of `text` the extraction prompt could actually have read, computed from the prompt's own
 * bound rather than taken on trust from the answer.
 *
 * This is the #274 acceptance case in one function: a CV whose projects sit past the bound produces
 * `complete: false` and a reason a person can act on, which `describeCvSourceGaps` then turns into a
 * refused export. The alternative the ticket rules out -- read the first N characters, return what
 * was found, call it done -- is exactly what silently loses a candidate's later sections.
 */
export function sourceCvCompleteness(text: string, limit: number = MAX_SOURCE_CV_PROMPT_CHARS): SourceCvCompleteness {
  const sourceChars = text.trim().length;
  if (!wasCvTextTruncated(text, limit)) {
    return { complete: true, incompleteReason: '', coveredChars: sourceChars, sourceChars };
  }
  return {
    complete: false,
    incompleteReason: `this CV is ${sourceChars.toLocaleString('en-US')} characters long and only the first ${limit.toLocaleString('en-US')} could be read, so any role or project after that point is missing. Split the CV or shorten it, then extract it again.`,
    coveredChars: limit,
    sourceChars,
  };
}

/** Coerces a parsed source-CV answer into a `CvSourceDocument`, with the supplied completeness
 * facts attached. `maxProjects` and every `pinned` flag start neutral: those are the candidate's
 * settings, not the extraction's, and the review drawer is where they get made. */
export function toCvSourceDocument(value: unknown, completeness: SourceCvCompleteness): CvSourceDocument {
  if (typeof value !== 'object' || value === null) {
    return { ...EMPTY_CV_SOURCE, ...completeness };
  }
  const record = value as Record<string, unknown>;
  const contactValue =
    typeof record.contact === 'object' && record.contact !== null ? (record.contact as Record<string, unknown>) : {};

  return {
    contact: {
      name: stringField(contactValue.name, CV_SOURCE_LIMITS.shortField),
      title: stringField(contactValue.title, CV_SOURCE_LIMITS.shortField),
      location: stringField(contactValue.location, CV_SOURCE_LIMITS.shortField),
      email: stringField(contactValue.email, CV_SOURCE_LIMITS.shortField),
      phone: stringField(contactValue.phone, CV_SOURCE_LIMITS.shortField),
      links: stringArray(contactValue.links, CV_SOURCE_LIMITS.listItem, CV_SOURCE_LIMITS.links),
    },
    summary: stringField(record.summary, CV_SOURCE_LIMITS.summary),
    experience: Array.isArray(record.experience)
      ? record.experience
          .map(toExperienceEntry)
          .filter((entry): entry is CvSourceExperienceEntry => entry !== undefined)
          .slice(0, CV_SOURCE_LIMITS.experienceEntries)
      : [],
    education: Array.isArray(record.education)
      ? record.education
          .map(toEducationEntry)
          .filter((entry): entry is CvSourceEducationEntry => entry !== undefined)
          .slice(0, CV_SOURCE_LIMITS.educationEntries)
      : [],
    projects: Array.isArray(record.projects)
      ? record.projects
          .map(toProjectEntry)
          .filter((entry): entry is CvSourceProjectEntry => entry !== undefined)
          .slice(0, CV_SOURCE_LIMITS.projectEntries)
      : [],
    maxProjects: PROJECTS_UNLIMITED,
    ...completeness,
    // Stamped by the main process when the candidate saves the reviewed record; an extraction has
    // by definition not been reviewed yet.
    reviewedAt: '',
  };
}

/**
 * Parses one source-CV extraction response end to end. Throws a user-facing message on anything
 * that is not recoverable JSON at all; a recoverable-but-malformed shape still returns a (possibly
 * partial) document, matching `parseTailoredResumeResponse`'s stance that a partially-wrong answer
 * should not destroy what it got right.
 */
export function parseSourceCvResponse(raw: string, sourceText: string): CvSourceDocument {
  const completeness = sourceCvCompleteness(sourceText);
  let value: unknown;
  try {
    value = JSON.parse(extractAiJsonPayload(raw));
  } catch {
    throw new Error('the AI response was not valid JSON: the CV could not be read into records');
  }
  return toCvSourceDocument(value, completeness);
}
