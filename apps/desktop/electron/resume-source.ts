import {
  CV_SOURCE_LIMITS,
  selectSourceProjects,
  type CvSourceDocument,
  type CvSourceExperienceEntry,
  type CvSourceProjectEntry,
} from './workspace/cv-source-schema.js';
import {
  describeCvEvidenceOverlayGaps,
  findCvFactConflicts,
  isCvFactUsable,
  type CvEvidenceOverlay,
} from './workspace/cv-evidence-schema.js';
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

  const sourceEducationByKey = new Map(
    source.education.map((entry) => [`${matchKey(entry.institution)}|${matchKey(entry.credential)}`, entry]),
  );
  const education = tailored.education.flatMap((entry) => {
    const match = sourceEducationByKey.get(`${matchKey(entry.institution)}|${matchKey(entry.credential)}`);
    if (!match) {
      dropped.push(`qualification "${entry.credential || '(unnamed)'}" is not in your CV`);
      return [];
    }
    return [{ ...match }];
  });

  return {
    resume: {
      // Contact facts are identity, not emphasis: a corrected email or a link the candidate fixed
      // during review must reach the document exactly as reviewed, never as the model restated it.
      contact: {
        name: source.contact.name,
        title: source.contact.title,
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

export interface ComposedTailoredResume {
  resume: TailoredResume;
  /** Everything that keeps this composition from being approvable, in the user's terms. Empty
   * means it may be approved. Never a boolean alone, for the same reason `describeCvSourceGaps`
   * and `describeCvExportBlockers` are not: the caller has to be able to say what is wrong. */
  blockers: string[];
}

/**
 * The third bridge this module offers (#419, step 5-6), and the one the candidate-approved path
 * actually uses: composes a `TailoredResume` from *only* unchanged reviewed source text and
 * active, exact candidate-approved wording -- never from a free-form AI draft.
 *
 * `TailorCv.tsx`'s existing live draft (`reconcileTailoredResumeWithSource` above) stays exactly
 * as it is and keeps working exactly as it does: an advisory draft a candidate reads and discards,
 * never the input to this function and never itself eligible to become the approved document. A
 * free-form draft cannot become approved by being run through a text checker -- the only way text
 * reaches this function's output is by having been through the requirement-mapping/clarification
 * review and explicitly approved (`CvApprovedWording.status === 'candidate_approved'`), or by
 * never having changed from what the candidate already confirmed when they reviewed their source
 * CV in the first place.
 *
 * What an approved variant does to the base (`tailoredResumeFromSource`'s own unchanged-source
 * resume) depends on whether its `targetField` is a single string or a list on the record it
 * scopes to: `summary` and `project_description` *replace* that field outright (there is exactly
 * one of each per record, so an approved variant for it is unambiguously the field's content);
 * `skill` and `experience_bullet` *add* an entry (each is one line among several, and adding never
 * risks silently dropping a bullet the candidate's own source already carried and never asked to
 * remove).
 *
 * Three things block approval, each named in `blockers` rather than silently excluded:
 *  - The overlay's own `describeCvEvidenceOverlayGaps` (unreviewed requirements, a required item
 *    still `needs_verification`, an overlay left in conflict, and so on).
 *  - An approved variant whose `sourceRevision` no longer matches the *current* source hash --
 *    reviewed against a source that has since changed, whatever the overlay's own stored hash says.
 *  - An approved variant whose `parentId` no longer names a real role or project in the current
 *    source (the role was deleted or re-extracted since the variant was approved).
 * A blocked composition still returns the best resume it could build (excluding only the specific
 * variants that failed), so the review screen has something concrete to show next to the reasons
 * it cannot be approved yet -- the same "recoverable, never a dead end" shape `GenerationReadiness`
 * already uses elsewhere in this app.
 */
export function composeApprovedTailoredResume(
  source: CvSourceDocument,
  overlay: CvEvidenceOverlay,
  currentSourceCvContentHash: string,
  skills: readonly string[],
): ComposedTailoredResume {
  const blockers = describeCvEvidenceOverlayGaps(overlay, currentSourceCvContentHash);

  const experienceById = new Map(source.experience.map((entry) => [entry.id, entry]));
  const projectById = new Map(source.projects.map((entry) => [entry.id, entry]));

  // Both the variant and every fact it cites must be active and approved (#419 step 7). A model
  // can emit a plausible fact id or a sentence, but neither is usable until the candidate approved
  // it here, and a fact in an unresolved contradiction blocks the wording that stands on it.
  const factById = new Map(overlay.facts.map((fact) => [fact.factId, fact]));
  const conflicted = new Set(findCvFactConflicts(overlay.facts).flatMap((conflict) => conflict.factIds));
  const usable = overlay.wordingVariants.filter((variant) => {
    if (variant.status !== 'candidate_approved') return false;
    const backed =
      variant.factIds.length > 0 &&
      variant.factIds.every((factId) => {
        const fact = factById.get(factId);
        return fact !== undefined && isCvFactUsable(fact, conflicted);
      });
    if (!backed) return false;
    if (variant.sourceRevision !== currentSourceCvContentHash) {
      blockers.push(`an approved "${variant.targetField}" variant was approved against a source CV revision that no longer matches`);
      return false;
    }
    if (variant.parentId && !experienceById.has(variant.parentId) && !projectById.has(variant.parentId)) {
      blockers.push(`an approved "${variant.targetField}" variant refers to a role or project that no longer exists in your reviewed source`);
      return false;
    }
    return true;
  });

  const resume = tailoredResumeFromSource(source, skills);
  // Rebuilt here rather than correlated back to `resume.experience`/`resume.projects` by array
  // position: `ResumeExperienceEntry`/`ResumeProjectEntry` carry no id of their own (that shape
  // predates #419), and zipping two independently-produced arrays by index is only as safe as the
  // assumption that neither ever reorders, filters or dedupes relative to the other -- an
  // assumption with nothing enforcing it. Building each resume entry and its id lookup in the same
  // loop, from the same source entry, makes the correlation correct by construction instead.
  const resumeExperienceById = new Map<string, ResumeExperienceEntry>();
  resume.experience = source.experience.map((entry) => {
    const resumeEntry = sourceExperienceToResumeEntry(entry, [...entry.bullets]);
    resumeExperienceById.set(entry.id, resumeEntry);
    return resumeEntry;
  });
  const resumeProjectById = new Map<string, ResumeProjectEntry>();
  resume.projects = selectSourceProjects(source).map((project) => {
    const resumeEntry = sourceProjectToResumeEntry(project);
    resumeProjectById.set(project.id, resumeEntry);
    return resumeEntry;
  });

  for (const variant of usable) {
    if (variant.targetField === 'summary') {
      resume.summary = variant.text;
      continue;
    }
    if (variant.targetField === 'skill') {
      if (!resume.skills.includes(variant.text)) resume.skills.push(variant.text);
      continue;
    }
    if (variant.targetField === 'experience_bullet') {
      const entry = resumeExperienceById.get(variant.parentId);
      if (entry && !entry.bullets.includes(variant.text)) entry.bullets.push(variant.text);
      continue;
    }
    if (variant.targetField === 'project_description') {
      const entry = resumeProjectById.get(variant.parentId);
      if (entry) entry.description = variant.text;
      continue;
    }
    // Exhaustiveness check: a fifth `CvClaimField` added to `CV_CLAIM_FIELDS` without a branch
    // here is a compile error, not a silently-dropped approved variant.
    const exhaustive: never = variant.targetField;
    throw new Error(`composeApprovedTailoredResume: unhandled targetField "${exhaustive as string}"`);
  }

  return { resume, blockers };
}
