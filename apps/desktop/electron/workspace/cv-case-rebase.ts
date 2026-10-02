/**
 * Source-change handling for a tailoring case (#419 step 8, data and invalidation contract): what
 * changed in the CV a case was started from, and what survives when the candidate explicitly
 * rebases the case onto the new version.
 *
 * Nothing here writes. `describeCvInputChanges` lists the differences in the candidate's terms, and
 * `planCvEvidenceRebase` says which wording stays valid and which is dropped, so the same answer can
 * be shown before the candidate confirms and applied by the repository when they do.
 *
 * Same "no runtime imports" discipline as the rest of `electron/workspace`'s shared schema files.
 */

import type {
  CvApprovedWording,
  CvEvidenceFact,
  CvEvidenceOverlay,
  CvFactAnchor,
  CvFactAnchorField,
  CvSourceBaseline,
} from './cv-evidence-schema.js';
import type { CvSourceDocument } from './cv-source-schema.js';

/** SHA-256 hex (or any stable digest) of a string. Supplied by the caller: this file has no runtime
 * imports by design, and anchors are only ever stamped and compared in the main process. */
export type CvDigest = (text: string) => string;

/** The reviewed source field a fact about `parentId` is anchored to, its current text and the parts
 * that text is made of (a role's bullets, or a project's one description). `null` when `parentId`
 * is empty or names nothing in `source`. */
export function readCvAnchorField(
  source: CvSourceDocument | null,
  parentId: string,
): { field: CvFactAnchorField; text: string; parts: string[] } | null {
  if (!source || !parentId) return null;
  const role = source.experience.find((entry) => entry.id === parentId);
  if (role) return { field: 'experience_bullets', text: role.bullets.join('\n'), parts: role.bullets };
  const project = source.projects.find((entry) => entry.id === parentId);
  if (project) return { field: 'project_description', text: project.description, parts: [project.description] };
  return null;
}

function skillKey(skill: string): string {
  return skill.trim().toLowerCase();
}

function anchorFieldDigest(field: CvFactAnchorField, text: string, digest: CvDigest): string {
  return digest(`${field}\n${text}`);
}

/** Stamps an anchor for a fact about `parentId` from the reviewed source as it reads now. `skills`
 * are the profile skills the fact backs; only those present in `profileSkills` are anchored. */
export function buildCvFactAnchor(
  source: CvSourceDocument | null,
  parentId: string,
  backedSkills: readonly string[],
  profileSkills: readonly string[],
  digest: CvDigest,
): CvFactAnchor | null {
  const read = readCvAnchorField(source, parentId);
  if (!read) return null;
  const inProfile = new Set(profileSkills.map(skillKey));
  const seen = new Set<string>();
  const anchored: CvFactAnchor['profileSkills'] = [];
  for (const skill of backedSkills) {
    const key = skillKey(skill);
    if (!key || seen.has(key) || !inProfile.has(key)) continue;
    seen.add(key);
    anchored.push({ skill, digest: digest(key) });
  }
  return { parentId, field: read.field, text: read.text, digest: anchorFieldDigest(read.field, read.text, digest), profileSkills: anchored };
}

/** Why an anchored fact no longer matches the reviewed source, or `null` when it still does (or has
 * no anchor to check). A fact whose role or project is gone is reported as orphaned elsewhere. */
export function describeStaleFactAnchor(
  fact: Pick<CvEvidenceFact, 'parentId' | 'anchor'>,
  current: Pick<CvCurrentInputs, 'source' | 'skills'>,
  digest: CvDigest,
): string | null {
  const anchor = fact.anchor;
  if (!anchor) return null;
  const read = readCvAnchorField(current.source, fact.parentId);
  if (!read) return null;
  if (read.field !== anchor.field) return 'the role or project it was reviewed against changed kind';
  if (anchorFieldDigest(read.field, read.text, digest) !== anchor.digest) {
    if (read.field === 'project_description') return 'the project description it was reviewed against changed';
    // A role gaining another bullet does not touch the bullets a fact was reviewed against; editing
    // or removing one of them does.
    const now = new Set(read.parts);
    if (anchor.text.split('\n').some((bullet) => bullet !== '' && !now.has(bullet))) return 'a role bullet it was reviewed against changed';
  }
  const inProfile = new Set(current.skills.map((skill) => digest(skillKey(skill))));
  const missing = anchor.profileSkills.find((entry) => !inProfile.has(entry.digest));
  if (missing) return `the profile skill "${missing.skill}" it backs was removed`;
  return null;
}

/** The CV inputs a case depends on, as they are right now. */
export interface CvCurrentInputs {
  source: CvSourceDocument | null;
  skills: readonly string[];
  profileSummary: string;
  textDigest: string;
}

export interface CvInputChange {
  /** A short heading such as "Experience" or "Skills". */
  area: string;
  /** A plain sentence naming what changed. */
  detail: string;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function roleLabel(entry: { title: string; company: string }): string {
  return `${entry.title || 'Untitled role'} at ${entry.company || 'unknown employer'}`;
}

function listDelta(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const key = (value: string) => value.trim().toLowerCase();
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));
  return {
    added: after.filter((value) => !beforeKeys.has(key(value))),
    removed: before.filter((value) => !afterKeys.has(key(value))),
  };
}

/** What differs between the CV a case was started from and the CV now. Empty when nothing the case
 * depends on changed, or when there is no earlier copy to compare against (see `CvSourceBaseline`). */
export function describeCvInputChanges(baseline: CvSourceBaseline | null, current: CvCurrentInputs): CvInputChange[] {
  if (!baseline) return [];
  const changes: CvInputChange[] = [];
  const before = baseline.source;
  const after = current.source;

  if (before && !after) {
    changes.push({ area: 'Source CV', detail: 'The reviewed source CV was removed.' });
  } else if (!before && after) {
    changes.push({ area: 'Source CV', detail: 'A reviewed source CV was added.' });
  } else if (before && after) {
    if (!same(before.contact, after.contact)) {
      const fields = (['name', 'title', 'location', 'email', 'phone', 'links'] as const).filter(
        (field) => !same(before.contact[field], after.contact[field]),
      );
      changes.push({ area: 'Contact', detail: `Contact details changed (${fields.join(', ')}).` });
    }
    if (before.summary !== after.summary) changes.push({ area: 'Summary', detail: 'The summary text changed.' });

    const beforeRoles = new Map(before.experience.map((entry) => [entry.id, entry]));
    const afterRoles = new Map(after.experience.map((entry) => [entry.id, entry]));
    for (const entry of after.experience) {
      const old = beforeRoles.get(entry.id);
      if (!old) {
        changes.push({ area: 'Experience', detail: `Added: ${roleLabel(entry)}.` });
      } else if (!same(old, entry)) {
        const fields = (['company', 'title', 'dates', 'engagement', 'client', 'bullets'] as const).filter(
          (field) => !same(old[field], entry[field]),
        );
        changes.push({ area: 'Experience', detail: `${roleLabel(entry)} changed (${fields.join(', ')}).` });
      }
    }
    for (const entry of before.experience) {
      if (!afterRoles.has(entry.id)) changes.push({ area: 'Experience', detail: `Removed: ${roleLabel(entry)}.` });
    }

    const beforeProjects = new Map(before.projects.map((entry) => [entry.id, entry]));
    const afterProjects = new Map(after.projects.map((entry) => [entry.id, entry]));
    for (const entry of after.projects) {
      const old = beforeProjects.get(entry.id);
      if (!old) {
        changes.push({ area: 'Projects', detail: `Added: ${entry.name || 'Unnamed project'}.` });
      } else if (!same(old, entry)) {
        const fields = (
          ['name', 'role', 'dates', 'organization', 'description', 'technologies', 'links', 'pinned'] as const
        ).filter((field) => !same(old[field], entry[field]));
        changes.push({ area: 'Projects', detail: `${entry.name || 'Unnamed project'} changed (${fields.join(', ')}).` });
      }
    }
    for (const entry of before.projects) {
      if (!afterProjects.has(entry.id)) changes.push({ area: 'Projects', detail: `Removed: ${entry.name || 'Unnamed project'}.` });
    }
    if (before.maxProjects !== after.maxProjects) {
      changes.push({
        area: 'Projects',
        detail: `The project limit changed from ${before.maxProjects === 0 ? 'no limit' : before.maxProjects} to ${after.maxProjects === 0 ? 'no limit' : after.maxProjects}.`,
      });
    }
    if (!same(before.education, after.education)) changes.push({ area: 'Education', detail: 'Education entries changed.' });
  }

  const skills = listDelta(baseline.skills, current.skills);
  if (skills.added.length > 0) changes.push({ area: 'Skills', detail: `Added: ${skills.added.join(', ')}.` });
  if (skills.removed.length > 0) changes.push({ area: 'Skills', detail: `Removed: ${skills.removed.join(', ')}.` });
  if (baseline.profileSummary !== current.profileSummary) {
    changes.push({ area: 'Profile', detail: 'The profile summary changed.' });
  }
  if (baseline.textDigest !== current.textDigest) {
    changes.push({ area: 'CV text', detail: 'The extracted CV text changed.' });
  }
  return changes;
}

export interface CvDroppedWording {
  variantId: string;
  text: string;
  reason: string;
}

export interface CvStaleFact {
  factId: string;
  /** The fact's own `activity`, so the candidate can tell which fact it is. */
  activity: string;
  reason: string;
}

export interface CvRebasePlan {
  /** False for a case created before baselines existed: there is nothing to list, but the case can
   * still be rebased and its wording is checked against the current source. */
  baselineKnown: boolean;
  /** True when the CV the case depends on is no longer the one it was started or last rebased from.
   * Can be true with no listed `changes` (a CV saved or reviewed again without a visible difference,
   * or a case with no earlier copy to compare against). */
  inputsChanged: boolean;
  changes: CvInputChange[];
  keptVariantIds: string[];
  droppedVariants: CvDroppedWording[];
  /** Facts whose role or project is gone. They are kept, and cannot back a bullet until the
   * candidate decides what they belong to. */
  orphanedFactIds: string[];
  /** Approved facts whose anchored source text (or anchored profile skill) changed. A rebase puts
   * them back to `proposed` and withdraws the wording that cites them; facts whose anchored text
   * did not change stay approved. Facts with no anchor are never listed. */
  staleFacts: CvStaleFact[];
  /** Requirements that linked a role or project that no longer exists. Their dead links are removed
   * and they need review again. */
  requirementIdsToReview: string[];
}

/** Whether the part of the source a variant was approved against still reads the same. */
function describeStaleVariant(
  variant: CvApprovedWording,
  baseline: CvSourceBaseline | null,
  current: CvSourceDocument | null,
): string | null {
  const before = baseline?.source ?? null;
  if (variant.targetField === 'skill') return null;
  if (variant.targetField === 'summary') {
    return before && current && before.summary !== current.summary ? 'the summary it replaces changed' : null;
  }
  if (variant.targetField === 'experience_bullet') {
    const now = current?.experience.find((entry) => entry.id === variant.parentId);
    if (!now) return 'its role is no longer in your CV';
    const old = before?.experience.find((entry) => entry.id === variant.parentId);
    if (old && (old.company !== now.company || old.title !== now.title || old.dates !== now.dates || old.engagement !== now.engagement || old.client !== now.client)) {
      return 'its role changed (employer, title, dates or client)';
    }
    return null;
  }
  const now = current?.projects.find((entry) => entry.id === variant.parentId);
  if (!now) return 'its project is no longer in your CV';
  const old = before?.projects.find((entry) => entry.id === variant.parentId);
  if (old && (old.name !== now.name || old.dates !== now.dates || old.organization !== now.organization || old.description !== now.description)) {
    return 'the project text it replaces changed';
  }
  return null;
}

/**
 * What a rebase would keep and drop. Facts and any wording still valid against the new CV are kept;
 * wording whose role or project is gone, or whose source text changed, is dropped (an approved one
 * is marked superseded by the repository, never deleted). Wording not yet approved follows the same
 * test, since a draft for a role that no longer exists cannot be approved either.
 */
export function planCvEvidenceRebase(
  overlay: Pick<CvEvidenceOverlay, 'facts' | 'wordingVariants' | 'requirements' | 'sourceBaseline'>,
  current: CvCurrentInputs,
  digest?: CvDigest,
): CvRebasePlan {
  const baseline = overlay.sourceBaseline;
  const keptVariantIds: string[] = [];
  const droppedVariants: CvDroppedWording[] = [];
  for (const variant of overlay.wordingVariants) {
    if (variant.status !== 'candidate_approved' && variant.status !== 'draft') continue;
    const reason = describeStaleVariant(variant, baseline, current.source);
    if (reason) droppedVariants.push({ variantId: variant.variantId, text: variant.text, reason });
    else keptVariantIds.push(variant.variantId);
  }
  const exists = (id: string) =>
    !!current.source && (current.source.experience.some((entry) => entry.id === id) || current.source.projects.some((entry) => entry.id === id));
  const orphanedFactIds = overlay.facts
    .filter((fact) => (fact.approval === 'approved' || fact.approval === 'proposed') && !exists(fact.parentId))
    .map((fact) => fact.factId);
  // Without a digest function nothing can be compared, so no fact is called stale.
  const staleFacts: CvStaleFact[] = [];
  if (digest) {
    for (const fact of overlay.facts) {
      if (fact.approval !== 'approved' || !exists(fact.parentId)) continue;
      const reason = describeStaleFactAnchor(fact, current, digest);
      if (reason) staleFacts.push({ factId: fact.factId, activity: fact.activity, reason });
    }
  }
  const requirementIdsToReview = overlay.requirements
    .filter((requirement) => !requirement.excluded)
    .filter((requirement) => (requirement.anchorParentId && !exists(requirement.anchorParentId)) || requirement.sourceIds.some((id) => !exists(id)))
    .map((requirement) => requirement.requirementId);
  const changes = describeCvInputChanges(baseline, current);
  return {
    baselineKnown: baseline !== null,
    // The repository replaces this with the digest comparison; the change list is the best a pure
    // function without hashing can say.
    inputsChanged: changes.length > 0,
    changes,
    keptVariantIds,
    droppedVariants,
    orphanedFactIds,
    staleFacts,
    requirementIdsToReview,
  };
}
