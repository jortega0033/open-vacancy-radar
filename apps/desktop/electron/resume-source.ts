import {
  CV_SOURCE_LIMITS,
  selectSourceProjects,
  type CvSourceDocument,
  type CvSourceExperienceEntry,
  type CvSourceProjectEntry,
} from './workspace/cv-source-schema.js';
import type { ResumeExperienceEntry, ResumeProjectEntry, TailoredResume } from './resume-schema.js';

/**
 * The bridge between the reviewed source CV (#274) and the `TailoredResume` shape the templates
 * render: one function that builds a resume straight from the source, and one that forces an
 * AI-tailored resume back onto the source's own facts.
 *
 * The second is the load-bearing one. The tailoring prompt already forbids invention, but a prompt
 * instruction lives in the same context as the model's own reasoning and is not a control -- the
 * same reasoning `prompts.ts` states about untrusted vacancy text. `reconcileTailoredResumeWithSource`
 * is the control: an employer, a project, or a date that is not in the reviewed source cannot
 * survive it, whatever the model returned, and a client engagement cannot be promoted into direct
 * employment because the engagement fields are taken from the source rather than from the answer.
 *
 * Same "no runtime imports" discipline as `resume-schema.ts` and `cv-source-schema.ts`: imported by
 * the renderer (tailoring) and by Electron main (manual export), so it touches no Electron- or
 * Node-only API.
 */

/** Case- and whitespace-insensitive identity for matching a model's answer back to a source record.
 * Not a fuzzy match: re-wording is allowed for *bullets*, never for the name of an employer. */
function matchKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, ' ');
}

function sourceExperienceToResumeEntry(entry: CvSourceExperienceEntry, bullets: string[]): ResumeExperienceEntry {
  return {
    company: entry.company,
    title: entry.title,
    dates: entry.dates,
    engagement: entry.engagement,
    client: entry.client,
    bullets,
  };
}

function sourceProjectToResumeEntry(project: CvSourceProjectEntry): ResumeProjectEntry {
  return {
    name: project.name,
    role: project.role,
    dates: project.dates,
    organization: project.organization,
    description: project.description,
    technologies: project.technologies,
    links: project.links,
  };
}

/**
 * Builds a `TailoredResume` directly from the reviewed source, with no AI step at all: what the
 * manual CV Library export (#156/#269) renders once a source CV exists. Everything here comes from
 * the source document -- real employers, real dates, real contact details and links, the projects
 * `selectSourceProjects` picks -- so the export finally carries the content the flat `CvProfile`
 * could not hold, without inventing anything the candidate did not write.
 *
 * `skills` is passed in rather than read from the source: skills live on `CvProfile` (the reviewed
 * profile fields), and duplicating them into the source record would create two editable copies of
 * one list that could disagree.
 */
export function tailoredResumeFromSource(source: CvSourceDocument, skills: readonly string[]): TailoredResume {
  return {
    contact: {
      name: source.contact.name,
      title: source.contact.title,
      location: source.contact.location,
      email: source.contact.email,
      phone: source.contact.phone,
      links: [...source.contact.links],
    },
    summary: source.summary,
    experience: source.experience.map((entry) => sourceExperienceToResumeEntry(entry, [...entry.bullets])),
    projects: selectSourceProjects(source).map(sourceProjectToResumeEntry),
    skills: [...skills],
    education: source.education.map((entry) => ({ ...entry })),
  };
}

export interface ReconciledTailoredResume {
  resume: TailoredResume;
  /**
   * Everything the model returned that the reviewed source does not support, named one by one. A
   * non-empty list is not an error the caller has to fail on, but it is never silent: the tailoring
   * UI surfaces it, because "the model tried to add an employer you never worked for" is exactly
   * the thing a candidate must be told rather than shielded from.
   */
  dropped: string[];
}

/**
 * Forces one AI-tailored resume back onto the reviewed source CV.
 *
 * What the model is allowed to decide: the order of experience entries, which of its bullets to
 * keep and how to word them, the summary, the skill ordering, and which non-pinned projects to
 * include. What it is not allowed to decide: that an employer, project, or qualification exists.
 * Each of those is matched by name against the source, and anything unmatched is dropped and
 * reported. Employer identity, dates, engagement type and client come from the source record every
 * time, so a re-worded or mis-typed one is corrected rather than trusted.
 *
 * Pinned projects are re-inserted whether or not the model kept them, and `maxProjects` is applied
 * here too, so the candidate's configured selection survives tailoring by construction rather than
 * by the model having cooperated.
 */
export function reconcileTailoredResumeWithSource(
  tailored: TailoredResume,
  source: CvSourceDocument,
): ReconciledTailoredResume {
  const dropped: string[] = [];

  const sourceExperienceByKey = new Map<string, CvSourceExperienceEntry>();
  for (const entry of source.experience) {
    sourceExperienceByKey.set(`${matchKey(entry.company)}|${matchKey(entry.title)}`, entry);
  }
  const experience: ResumeExperienceEntry[] = [];
  const seenExperience = new Set<string>();
  for (const entry of tailored.experience) {
    const key = `${matchKey(entry.company)}|${matchKey(entry.title)}`;
    const match = sourceExperienceByKey.get(key);
    if (!match) {
      dropped.push(`experience "${entry.title || '(untitled)'} at ${entry.company || '(no employer)'}" is not in your CV`);
      continue;
    }
    if (seenExperience.has(key)) continue;
    seenExperience.add(key);
    // Bullets may be re-worded, so they are kept as returned -- but an entry the model emptied out
    // falls back to the source's own bullets rather than rendering a role with no content at all.
    const bullets = entry.bullets.length > 0 ? entry.bullets.slice(0, CV_SOURCE_LIMITS.bulletsPerEntry) : [...match.bullets];
    experience.push(sourceExperienceToResumeEntry(match, bullets));
  }
  // A role the model dropped entirely is not re-inserted: dropping a role is a legitimate tailoring
  // decision (it is the candidate's own history either way), while *adding* one is fabrication.

  const selected = selectSourceProjects(source);
  const selectedByKey = new Map(selected.map((project) => [matchKey(project.name), project]));
  const pinnedKeys = new Set(selected.filter((project) => project.pinned).map((project) => matchKey(project.name)));

  const ordered: string[] = [];
  for (const project of tailored.projects) {
    const key = matchKey(project.name);
    if (!selectedByKey.has(key)) {
      const known = source.projects.some((candidate) => matchKey(candidate.name) === key);
      dropped.push(
        known
          ? `project "${project.name}" is outside the ${source.maxProjects} you chose to include`
          : `project "${project.name || '(unnamed)'}" is not in your CV`,
      );
      continue;
    }
    if (!ordered.includes(key)) ordered.push(key);
  }
  for (const key of pinnedKeys) {
    if (!ordered.includes(key)) ordered.push(key);
  }
  const projects = ordered
    .map((key) => selectedByKey.get(key))
    .filter((project): project is CvSourceProjectEntry => project !== undefined)
    .map(sourceProjectToResumeEntry);

  const sourceEducationKeys = new Set(
    source.education.map((entry) => `${matchKey(entry.institution)}|${matchKey(entry.credential)}`),
  );
  const education = tailored.education.filter((entry) => {
    const known = sourceEducationKeys.has(`${matchKey(entry.institution)}|${matchKey(entry.credential)}`);
    if (!known) {
      dropped.push(`qualification "${entry.credential || '(unnamed)'}" is not in your CV`);
    }
    return known;
  });

  return {
    resume: {
      // Contact facts are identity, not emphasis: a corrected email or a link the candidate fixed
      // during review must reach the document exactly as reviewed, never as the model restated it.
      contact: {
        name: source.contact.name,
        title: tailored.contact.title || source.contact.title,
        location: source.contact.location,
        email: source.contact.email,
        phone: source.contact.phone,
        links: [...source.contact.links],
      },
      summary: tailored.summary,
      experience,
      projects,
      skills: tailored.skills,
      education,
    },
    dropped,
  };
}
