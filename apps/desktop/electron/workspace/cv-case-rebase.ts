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

import type { CvApprovedWording, CvEvidenceOverlay, CvSourceBaseline } from './cv-evidence-schema.js';
import type { CvSourceDocument } from './cv-source-schema.js';

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
    requirementIdsToReview,
  };
}
