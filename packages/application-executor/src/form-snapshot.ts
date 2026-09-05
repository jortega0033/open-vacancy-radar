import { randomBytes } from 'node:crypto';

/**
 * The structured field inventory the `snapshot` action produces, and the closed set every
 * `FieldMap` (`field-map.ts`) is validated against. Mints `fieldRef`/`optionRef` identifiers --
 * opaque, valid only within one attempt and one snapshot generation, matching the exact shapes
 * `field-map.ts`'s regexes expect (`f`/`o` + 16 hex chars).
 *
 * A snapshot generation increments every time the page is re-read (a fresh `snapshot` call): a
 * field map produced against an earlier generation is stale and must be refused by Domain B
 * (validate.ts's rule 2), the same way `workspace-grant.ts` invalidates a grant on navigation.
 */

export type FieldControlType = 'text' | 'textarea' | 'select' | 'checkbox' | 'radio' | 'file' | 'unknown';

/** Structural classification of a field the executor must never let a field map assign to,
 * regardless of what the generation session proposes (#196 §1.2, §2.4 rule 8). Detected from the
 * DOM itself (input type, autocomplete token, ARIA label patterns) -- never inferred from prose. */
export type FieldClassification = 'credential_field' | 'consent_field';

export interface SnapshotOption {
  optionRef: string;
  label: string;
}

export interface SnapshotField {
  fieldRef: string;
  label: string;
  controlType: FieldControlType;
  required: boolean;
  /** Present only for `select`/`radio` controls. */
  options?: readonly SnapshotOption[];
  /** Present only when the field was structurally classified as excluded. */
  classification?: FieldClassification;
  /** Present only for `checkbox` controls: whether the DOM's own `checked` attribute was set at
   * snapshot time. Read so `fill()` can toggle a checkbox in *either* direction -- without it, a
   * checkbox that started pre-checked could never be unchecked (a real gap found during #201's
   * review: `fill()` used to assume every checkbox starts unchecked). */
  checked?: boolean;
}

export interface FormSnapshot {
  generation: number;
  fields: readonly SnapshotField[];
  /** ISO-8601 */
  capturedAt: string;
}

function mintRef(prefix: 'f' | 'o'): string {
  return `${prefix}${randomBytes(8).toString('hex')}`;
}

export function mintFieldRef(): string {
  return mintRef('f');
}

export function mintOptionRef(): string {
  return mintRef('o');
}

/** Looks up one field by ref within a snapshot. Returns `undefined` for a ref from a different
 * snapshot generation or a different attempt entirely -- the caller (`validate.ts`) is what turns
 * that into a refusal, not this lookup. */
export function findSnapshotField(snapshot: FormSnapshot, fieldRef: string): SnapshotField | undefined {
  return snapshot.fields.find((field) => field.fieldRef === fieldRef);
}

export function findSnapshotOption(field: SnapshotField, optionRef: string): SnapshotOption | undefined {
  return field.options?.find((option) => option.optionRef === optionRef);
}
