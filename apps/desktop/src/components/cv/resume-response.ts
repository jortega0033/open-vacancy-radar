import { RESUME_LIMITS, EMPTY_TAILORED_RESUME, type ResumeEducationEntry, type ResumeExperienceEntry, type TailoredResume } from '../../../electron/resume-schema.js';
import { extractAiJsonPayload } from '../cv-library/cv-ai-parse.js';

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

function toExperienceEntry(value: unknown): ResumeExperienceEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const company = stringField(record.company, RESUME_LIMITS.shortField);
  const title = stringField(record.title, RESUME_LIMITS.shortField);
  // An entry naming neither a company nor a title is not a real experience entry -- most likely a
  // malformed or hallucinated array element, dropped rather than kept as an empty row.
  if (!company && !title) return undefined;
  return {
    company,
    title,
    dates: stringField(record.dates, RESUME_LIMITS.shortField),
    bullets: stringArray(record.bullets, RESUME_LIMITS.bullet, RESUME_LIMITS.bulletsPerEntry),
  };
}

function toEducationEntry(value: unknown): ResumeEducationEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const institution = stringField(record.institution, RESUME_LIMITS.shortField);
  const credential = stringField(record.credential, RESUME_LIMITS.shortField);
  if (!institution && !credential) return undefined;
  return { institution, credential, dates: stringField(record.dates, RESUME_LIMITS.shortField) };
}

/**
 * Coerces the AI's parsed JSON into a `TailoredResume`, dropping anything malformed rather than
 * throwing -- the same defensive stance as `toPartialCvProfile`, but for a shape with nested
 * objects and arrays. A field or entry that doesn't match the expected shape is simply absent from
 * the result; this never invents a value to fill the gap, and never lets one bad array element
 * throw away every other one.
 */
export function toTailoredResume(value: unknown): TailoredResume {
  if (typeof value !== 'object' || value === null) return EMPTY_TAILORED_RESUME;
  const record = value as Record<string, unknown>;

  const contactValue = typeof record.contact === 'object' && record.contact !== null ? (record.contact as Record<string, unknown>) : {};
  const contact = {
    name: stringField(contactValue.name, RESUME_LIMITS.shortField),
    title: stringField(contactValue.title, RESUME_LIMITS.shortField),
    location: stringField(contactValue.location, RESUME_LIMITS.shortField),
    email: stringField(contactValue.email, RESUME_LIMITS.shortField),
    phone: stringField(contactValue.phone, RESUME_LIMITS.shortField),
    links: stringArray(contactValue.links, RESUME_LIMITS.listItem, RESUME_LIMITS.links),
  };

  const experience = Array.isArray(record.experience)
    ? record.experience
        .map(toExperienceEntry)
        .filter((entry): entry is ResumeExperienceEntry => entry !== undefined)
        .slice(0, RESUME_LIMITS.experienceEntries)
    : [];

  const education = Array.isArray(record.education)
    ? record.education
        .map(toEducationEntry)
        .filter((entry): entry is ResumeEducationEntry => entry !== undefined)
        .slice(0, RESUME_LIMITS.educationEntries)
    : [];

  return {
    contact,
    summary: stringField(record.summary, RESUME_LIMITS.summary),
    experience,
    skills: stringArray(record.skills, RESUME_LIMITS.listItem, RESUME_LIMITS.skills),
    education,
  };
}

/**
 * Parses one structured-resume AI response end to end. Throws a user-facing message on anything
 * that is not recoverable JSON at all; a recoverable-but-malformed shape still returns a (possibly
 * partial) `TailoredResume` via `toTailoredResume` rather than throwing, matching
 * `parseCvAiResponse`'s stance that a partially-wrong AI answer should not destroy what it got
 * right.
 */
export function parseTailoredResumeResponse(raw: string): TailoredResume {
  let value: unknown;
  try {
    value = JSON.parse(extractAiJsonPayload(raw));
  } catch {
    throw new Error('the AI response was not valid JSON: the tailored resume could not be generated');
  }
  return toTailoredResume(value);
}
