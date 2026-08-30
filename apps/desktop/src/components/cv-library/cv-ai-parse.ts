import type { CvProfile } from '../../window.js';

/**
 * The model is asked for a bare JSON object but coding-agent CLIs habitually wrap answers in a
 * fenced code block anyway — this strips one if present, and otherwise falls back to the outermost
 * `{...}` span so a stray sentence before/after the object doesn't break `JSON.parse`.
 */
function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start !== -1 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

function stringField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function skillsField(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const skills = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return skills.length > 0 ? skills : undefined;
}

/**
 * Coerces the AI's parsed JSON into whichever `CvProfile` fields actually came back in the expected
 * shape, dropping anything else rather than throwing — a model returning `years: 5` (a number) or an
 * extra field should still let every valid field through, since the result only ever prefills a form
 * the user reviews before saving, never writes to the workspace directly.
 */
export function toPartialCvProfile(value: unknown): Partial<CvProfile> {
  if (typeof value !== 'object' || value === null) return {};
  const record = value as Record<string, unknown>;
  const profile: Partial<CvProfile> = {};

  const title = stringField(record.title);
  if (title) profile.title = title;
  const years = stringField(record.years);
  if (years) profile.years = years;
  const location = stringField(record.location);
  if (location) profile.location = location;
  const languages = stringField(record.languages);
  if (languages) profile.languages = languages;
  const summary = stringField(record.summary);
  if (summary) profile.summary = summary;
  const auth = stringField(record.auth);
  if (auth) profile.auth = auth;
  const skills = skillsField(record.skills);
  if (skills) profile.skills = skills;

  return profile;
}

/**
 * Parses one AI CV-parse response end to end. Throws a user-facing message on anything that is not
 * recoverable JSON — the caller (`CvDrawer`) surfaces that message and leaves the form exactly as it
 * was, so a bad response never wipes out fields the user already filled in.
 */
export function parseCvAiResponse(raw: string): Partial<CvProfile> {
  let value: unknown;
  try {
    value = JSON.parse(extractJsonPayload(raw));
  } catch {
    throw new Error('the AI response was not valid JSON — try again or fill the fields in manually');
  }
  return toPartialCvProfile(value);
}
