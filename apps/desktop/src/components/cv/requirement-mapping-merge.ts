import { requirementDedupeKeys } from '../../../electron/workspace/cv-evidence-schema.js';
import type { CvRequirementMapping } from '../../window.js';

/**
 * Merges a fresh requirement-mapping extraction into whatever is already on the overlay, without
 * discarding review progress (#419: "the candidate reviews the extracted list... do not treat the
 * model's list as complete", and no requirement may silently disappear once a person has looked at
 * it).
 *
 * Matched by normalized text or normalized quote (`requirementDedupeKeys`): a requirement the
 * extraction re-surfaces that already exists is left exactly as it was -- its `reviewed` flag, any
 * candidate correction to `classification`/`evidenceClass`/`anchorParentId`, its exclusion, all
 * untouched. An excluded requirement therefore stays excluded when a later batch proposes it again.
 * Only requirements the extraction found that are not already present are appended.
 *
 * `parseRequirementMappingResponse` assigns each entry a positional id (`requirement-1`,
 * `requirement-2`, ...) that is only unique *within one parse*, not across merges into a growing
 * overlay -- reusing it here could collide with an id already on the overlay from an earlier run.
 * Every newly appended entry gets a fresh `crypto.randomUUID()` instead; an already-present entry
 * keeps its existing id untouched, since anything that already references it (a fact, an approved
 * wording variant) is scoped to that exact id.
 */
export function mergeRequirementMappings(
  existing: readonly CvRequirementMapping[],
  extracted: readonly CvRequirementMapping[],
): CvRequirementMapping[] {
  const seen = new Set(existing.flatMap(requirementDedupeKeys));
  const appended: CvRequirementMapping[] = [];
  for (const requirement of extracted) {
    const keys = requirementDedupeKeys(requirement);
    if (keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    appended.push({ ...requirement, requirementId: crypto.randomUUID() });
  }
  return [...existing, ...appended];
}
