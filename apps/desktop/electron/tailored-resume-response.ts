import {
  EMPTY_TAILORED_RESUME,
  RESUME_LIMITS,
  type ResumeEducationEntry,
  type ResumeExperienceEntry,
  type ResumeProjectEntry,
  type TailoredResume,
} from './resume-schema.js';

function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return start !== -1 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

function stringField(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function stringArray(value: unknown, itemLimit: number, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().slice(0, itemLimit))
    .filter(Boolean)
    .slice(0, maxItems);
}

function toExperienceEntry(value: unknown): ResumeExperienceEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const company = stringField(record.company, RESUME_LIMITS.shortField);
  const title = stringField(record.title, RESUME_LIMITS.shortField);
  if (!company && !title) return undefined;
  const engagement = record.engagement === 'client_engagement' ? 'client_engagement' : 'employment';
  return {
    company,
    title,
    dates: stringField(record.dates, RESUME_LIMITS.shortField),
    engagement,
    client: engagement === 'client_engagement' ? stringField(record.client, RESUME_LIMITS.shortField) : '',
    bullets: stringArray(record.bullets, RESUME_LIMITS.bullet, RESUME_LIMITS.bulletsPerEntry),
  };
}

function toProjectEntry(value: unknown): ResumeProjectEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const name = stringField(record.name, RESUME_LIMITS.shortField);
  if (!name) return undefined;
  return {
    name,
    role: stringField(record.role, RESUME_LIMITS.shortField),
    dates: stringField(record.dates, RESUME_LIMITS.shortField),
    organization: stringField(record.organization, RESUME_LIMITS.shortField),
    description: stringField(record.description, RESUME_LIMITS.projectDescription),
    technologies: stringArray(record.technologies, RESUME_LIMITS.listItem, RESUME_LIMITS.technologiesPerProject),
    links: stringArray(record.links, RESUME_LIMITS.listItem, RESUME_LIMITS.linksPerProject),
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

export function toTailoredResume(value: unknown): TailoredResume {
  if (typeof value !== 'object' || value === null) return EMPTY_TAILORED_RESUME;
  const record = value as Record<string, unknown>;
  const rawContact = typeof record.contact === 'object' && record.contact !== null
    ? (record.contact as Record<string, unknown>)
    : {};
  const experience = Array.isArray(record.experience)
    ? record.experience.map(toExperienceEntry).filter((entry): entry is ResumeExperienceEntry => entry !== undefined)
    : [];
  const projects = Array.isArray(record.projects)
    ? record.projects.map(toProjectEntry).filter((entry): entry is ResumeProjectEntry => entry !== undefined)
    : [];
  const education = Array.isArray(record.education)
    ? record.education.map(toEducationEntry).filter((entry): entry is ResumeEducationEntry => entry !== undefined)
    : [];
  return {
    contact: {
      name: stringField(rawContact.name, RESUME_LIMITS.shortField),
      title: stringField(rawContact.title, RESUME_LIMITS.shortField),
      location: stringField(rawContact.location, RESUME_LIMITS.shortField),
      email: stringField(rawContact.email, RESUME_LIMITS.shortField),
      phone: stringField(rawContact.phone, RESUME_LIMITS.shortField),
      links: stringArray(rawContact.links, RESUME_LIMITS.listItem, RESUME_LIMITS.links),
    },
    summary: stringField(record.summary, RESUME_LIMITS.summary),
    experience: experience.slice(0, RESUME_LIMITS.experienceEntries),
    projects: projects.slice(0, RESUME_LIMITS.projectEntries),
    skills: stringArray(record.skills, RESUME_LIMITS.listItem, RESUME_LIMITS.skills),
    education: education.slice(0, RESUME_LIMITS.educationEntries),
  };
}

export function parseTailoredResumeResponse(raw: string): TailoredResume {
  try {
    return toTailoredResume(JSON.parse(extractJsonPayload(raw)));
  } catch {
    throw new Error('the AI response was not valid JSON: the tailored resume could not be generated');
  }
}
