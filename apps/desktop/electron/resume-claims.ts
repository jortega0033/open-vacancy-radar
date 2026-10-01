import type { TailoredResume } from './resume-schema.js';

/**
 * The ordered list of things a `TailoredResume` says, in the order the app's default template lays
 * them out (#419 step 9). Two consumers share it so they can never disagree about what "the same
 * content" means: the DOCX validator (`resume-docx-validation.ts`) looks for these items, in this
 * order, in the text it extracts from the produced file, and the copyable plain-text rendering
 * (`resume-text.ts`) is checked against it in tests. Same "no runtime imports" discipline as
 * `resume-schema.ts`: the renderer imports this as well.
 */

export type ResumeClaimKind = 'heading' | 'content';

export interface ResumeClaim {
  kind: ResumeClaimKind;
  /** What the item is, for a reason a candidate can read ("project", "bullet", "email"). */
  label: string;
  text: string;
}

export const RESUME_SECTION_HEADINGS = ['Experience', 'Projects', 'Skills', 'Education'] as const;

export function resumeClaims(resume: TailoredResume): ResumeClaim[] {
  const claims: ResumeClaim[] = [];
  const add = (label: string, text: string): void => {
    const trimmed = text.trim();
    if (trimmed.length > 0) claims.push({ kind: 'content', label, text: trimmed });
  };
  const heading = (text: string): void => {
    claims.push({ kind: 'heading', label: 'section heading', text });
  };

  add('name', resume.contact.name);
  add('title', resume.contact.title);
  add('location', resume.contact.location);
  add('email', resume.contact.email);
  add('phone', resume.contact.phone);
  for (const link of resume.contact.links) add('link', link);
  add('summary', resume.summary);

  if (resume.experience.length > 0) {
    heading('Experience');
    for (const entry of resume.experience) {
      add('role', entry.title);
      add('employer', entry.company);
      add('dates', entry.dates);
      if (entry.engagement === 'client_engagement') add('client', entry.client);
      for (const bullet of entry.bullets) add('bullet', bullet);
    }
  }

  if (resume.projects.length > 0) {
    heading('Projects');
    for (const project of resume.projects) {
      add('project', project.name);
      add('dates', project.dates);
      add('project role', project.role);
      add('project organization', project.organization);
      add('project description', project.description);
      for (const technology of project.technologies) add('technology', technology);
      for (const link of project.links) add('project link', link);
    }
  }

  if (resume.skills.length > 0) {
    heading('Skills');
    for (const skill of resume.skills) add('skill', skill);
  }

  if (resume.education.length > 0) {
    heading('Education');
    for (const entry of resume.education) {
      add('credential', entry.credential);
      add('institution', entry.institution);
      add('dates', entry.dates);
    }
  }

  return claims;
}

/** Collapses every run of whitespace (a tab between a title and its dates, a paragraph break) to one space. */
export function normalizeResumeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Looks for every claim, in order, in a document's text. Headings must be a line of their own;
 * content may share a line with its neighbours (a title and its employer, a date after them).
 * Returns one reason per problem: a claim not found at all, or found only before an earlier claim.
 */
export function findResumeClaimProblems(text: string, claims: ResumeClaim[]): string[] {
  const lines = text
    .split(/\r?\n/)
    .map(normalizeResumeWhitespace)
    .filter((line) => line.length > 0);
  const problems: string[] = [];
  let lineIndex = 0;
  let offset = 0;

  for (const claim of claims) {
    const needle = normalizeResumeWhitespace(claim.text);
    let found = false;
    for (let i = lineIndex; i < lines.length && !found; i += 1) {
      const line = lines[i] ?? '';
      if (claim.kind === 'heading') {
        if (line === needle) {
          lineIndex = i + 1;
          offset = 0;
          found = true;
        }
      } else {
        const at = line.indexOf(needle, i === lineIndex ? offset : 0);
        if (at >= 0) {
          lineIndex = i;
          offset = at + needle.length;
          found = true;
        }
      }
    }
    if (found) continue;
    const elsewhere = claim.kind === 'heading' ? lines.includes(needle) : lines.some((line) => line.includes(needle));
    problems.push(
      elsewhere
        ? `the ${claim.label} "${claim.text}" appears out of order`
        : `the ${claim.label} "${claim.text}" is missing`,
    );
  }
  return problems;
}
