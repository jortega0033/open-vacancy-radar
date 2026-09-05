import { fieldMapSchema, type FieldMap } from './field-map.js';
import { findSnapshotField, findSnapshotOption, type FormSnapshot } from './form-snapshot.js';

/**
 * Domain B: the deterministic validator (#196 §2.4). Trusts a field map only after every rule
 * below passes. A failure is a refusal with a fixed reason code, never a partial application --
 * Domain C (the executor) never sees an unvalidated field map at all.
 */

export type ValueProvenance = 'cv' | 'profile' | 'user_answer' | 'jd';

export interface ValueTableEntry {
  valueRef: string;
  value: string;
  provenance: ValueProvenance;
}

export type FieldMapRefusalReason =
  | 'invalid_shape'
  | 'stale_snapshot_generation'
  | 'attempt_mismatch'
  | 'unknown_ref'
  | 'artifact_not_owned'
  | 'disallowed_provenance'
  | 'type_mismatch'
  | 'excluded_field_targeted'
  | 'incomplete';

export interface ValidateFieldMapInput {
  /** The raw, untrusted response from the generation session. */
  raw: unknown;
  attemptId: string;
  snapshot: FormSnapshot;
  valueTable: readonly ValueTableEntry[];
  /** Artifact ids already confirmed (by the caller, against #198's records) to belong to this
   * exact attempt. This validator never resolves ownership itself -- it only checks membership in
   * whatever set the caller vouches for. */
  ownedArtifactIds: readonly string[];
  /**
   * Whether a `jd`-provenance value may be assigned at all (#196 §2.5's open question). Defaults
   * to `false`: refusing every JD-derived value is the safer, simpler-to-audit default the design
   * itself recommends when this isn't explicitly decided. A caller that has made and documented
   * that decision passes `true`.
   */
  allowJdProvenance?: boolean;
}

export interface ValidateFieldMapResult {
  ok: boolean;
  reason?: FieldMapRefusalReason;
  /** A short, specific, non-sensitive detail -- e.g. which fieldRef failed, never the value
   * itself. */
  detail?: string;
  /** Present only when `ok` is true. */
  fieldMap?: FieldMap;
}

function refuse(reason: FieldMapRefusalReason, detail: string): ValidateFieldMapResult {
  return { ok: false, reason, detail };
}

/**
 * Runs every Domain-B rule against one field map. Rules are checked in the order #196 §2.4 lists
 * them; the first failure refuses immediately rather than collecting every problem, since a single
 * violation already means the field map cannot be trusted at all.
 *
 * Rule 10 (bounds) is enforced by `fieldMapSchema` itself (rule 1's parse) via `.max(200)` on both
 * arrays, so it has no separate check here -- listing it twice would just be two copies of the
 * same bound that could drift.
 */
export function validateFieldMap(input: ValidateFieldMapInput): ValidateFieldMapResult {
  // Rule 1: schema.
  const parsed = fieldMapSchema.safeParse(input.raw);
  if (!parsed.success) return refuse('invalid_shape', parsed.error.issues[0]?.message ?? 'schema mismatch');
  const fieldMap = parsed.data;

  // Rule 2: generation match.
  if (fieldMap.snapshotGeneration !== input.snapshot.generation) {
    return refuse('stale_snapshot_generation', `field map targets generation ${fieldMap.snapshotGeneration}, current is ${input.snapshot.generation}`);
  }

  // Rule 3: attempt binding.
  if (fieldMap.attemptId !== input.attemptId) {
    return refuse('attempt_mismatch', 'field map attemptId does not match the attempt it was generated for');
  }

  const valueByRef = new Map(input.valueTable.map((entry) => [entry.valueRef, entry]));
  const ownedArtifacts = new Set(input.ownedArtifactIds);

  for (const assignment of fieldMap.assignments) {
    // Rule 4: closed-set membership (the field itself).
    const field = findSnapshotField(input.snapshot, assignment.fieldRef);
    if (!field) return refuse('unknown_ref', `fieldRef ${assignment.fieldRef} is not in this snapshot`);

    // Rule 8: excluded-field veto. Checked before the source-specific rules below: a structurally
    // classified field is refused regardless of what the field map proposes for it.
    if (field.classification) {
      return refuse('excluded_field_targeted', `fieldRef ${assignment.fieldRef} is a ${field.classification}`);
    }

    if (assignment.source.kind === 'value') {
      // Rule 4 (value half).
      const entry = valueByRef.get(assignment.source.valueRef);
      if (!entry) return refuse('unknown_ref', `valueRef ${assignment.source.valueRef} is not in the value table`);
      // Rule 6: provenance.
      if (entry.provenance === 'jd' && !input.allowJdProvenance) {
        return refuse('disallowed_provenance', `valueRef ${assignment.source.valueRef} is jd-provenance, not permitted`);
      }
      // Rule 7: type compatibility.
      if (field.controlType === 'file' || field.controlType === 'select' || field.controlType === 'radio') {
        return refuse('type_mismatch', `fieldRef ${assignment.fieldRef} does not accept a plain value`);
      }
    } else if (assignment.source.kind === 'option') {
      // Rule 4 (option half). This also subsumes rule 7 for the option path in practice: an
      // option only ever appears in `field.options` for a `select` control (`dom-extract.ts`
      // populates `options` for `select` alone -- a `radio` field is currently surfaced as an
      // independent, option-less field per input, a known v1 limitation on grouping radio buttons
      // by `name`; see that file's own doc comment). So a mismatched field simply has no matching
      // option to find, and the closed-set check above already refuses it as `unknown_ref` before
      // a `type_mismatch` check would ever run. There is deliberately no separate rule-7 check
      // here for that reason -- it would be unreachable dead code, not a second layer of defense.
      const option = findSnapshotOption(field, assignment.source.optionRef);
      if (!option) return refuse('unknown_ref', `optionRef ${assignment.source.optionRef} is not on fieldRef ${assignment.fieldRef}`);
    } else if (assignment.source.kind === 'artifact') {
      // Rule 5: artifact ownership.
      if (!ownedArtifacts.has(assignment.source.artifactId)) {
        return refuse('artifact_not_owned', `artifact ${assignment.source.artifactId} does not belong to this attempt`);
      }
      // Rule 7.
      if (field.controlType !== 'file') {
        return refuse('type_mismatch', `fieldRef ${assignment.fieldRef} does not accept a file`);
      }
    }
    // `skip` sources need no further validation: they assign nothing.
  }

  for (const unmapped of fieldMap.unmapped) {
    // Rule 4, for the unmapped list too: it must still name real fields.
    if (!findSnapshotField(input.snapshot, unmapped.fieldRef)) {
      return refuse('unknown_ref', `fieldRef ${unmapped.fieldRef} in "unmapped" is not in this snapshot`);
    }
  }

  // Rule 9: completeness. Every required field is assigned or explicitly unmapped -- never absent
  // from both, which would be "quietly blank" masquerading as "deliberately deferred."
  const covered = new Set([...fieldMap.assignments.map((a) => a.fieldRef), ...fieldMap.unmapped.map((u) => u.fieldRef)]);
  for (const field of input.snapshot.fields) {
    if (field.required && !covered.has(field.fieldRef)) {
      return refuse('incomplete', `required fieldRef ${field.fieldRef} is neither assigned nor listed as unmapped`);
    }
  }

  return { ok: true, fieldMap };
}
