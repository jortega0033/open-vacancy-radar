import { randomBytes } from 'node:crypto';
import type { FieldMap, FormSnapshot, SnapshotField } from '@agent-dock/application-executor';
import {
  APPLICATION_VALUE_LABEL_SYNONYMS,
  chooseArtifactForField,
  normalizeFieldLabel,
  squashFieldLabel,
  type ApplicationValueTableEntry,
} from './application-value-table.js';
import type { BlindApplyAnswerUse, BlindApplyIntervention, BlindApplyMissingField } from './workspace/blind-apply-schema.js';
import { blindAnswerKey, optionSetHashOf } from './workspace/blind-apply-store.js';
import type { ApplicationArtifactRecord } from './workspace/types.js';

/**
 * Blind Apply's deterministic answer mapper (#722). It replaces the AI field-mapping session for Blind
 * Apply attempts ONLY; the reviewed flow keeps asking the session.
 *
 * Why not the session: in a reviewed application a person looks at every value before it goes out. In
 * Blind Apply nobody does, so "which of my details goes in which field" cannot be a model's judgement
 * call -- a valid-but-wrong mapping (a phone number typed into "Current employer") would be sent
 * unseen. Here the rule is the plainest one that works: a field is filled only when its label EXACTLY
 * equals a known label for a value this app already holds, or exactly matches a question the person
 * answered earlier and chose to remember. Anything else is not guessed.
 *
 * What it never does, whatever the page asks:
 *  - tick a consent box, type a credential, or enter a verification code;
 *  - answer an equal-opportunity / demographic question from the CV or profile (a remembered answer the
 *    person gave and chose to keep is the only source, and "decline to answer" is theirs to pick);
 *  - choose an option nobody chose: a select is answered only by an exact remembered answer whose
 *    stored option still exists in the live option list, for the exact same list of options;
 *  - invent a value. There is no job-description input to this module at all, so a posting cannot steer it.
 *
 * Its output is still only a proposal. The map goes through `validateFieldMap` and the live readback
 * exactly like a model's would; determinism narrows what the closed set can produce, it never widens it.
 */

/** A required field this app cannot truthfully answer by itself. The person answers once; the item continues. */
export type BlindMissingAnswer = BlindApplyMissingField & { fieldRef: string };

export interface BlindIntervention {
  kind: BlindApplyIntervention;
  label: string;
}

export interface BlindSavedAnswerLookup {
  id: string;
  answer: string;
}

export interface BlindAnswerMapperInput {
  attemptId: string;
  snapshot: FormSnapshot;
  /** The closed value table built from the reviewed CV and profile. */
  valueTable: readonly ApplicationValueTableEntry[];
  artifacts: readonly ApplicationArtifactRecord[];
  /** Exact-key lookup into the answers the person chose to remember for Blind Apply. */
  findSavedAnswer(matchKey: string): BlindSavedAnswerLookup | null;
}

export interface BlindAnswerMapping {
  fieldMap: FieldMap;
  /** The value table the map was built against: the closed table plus one entry per remembered text answer used. */
  valueTable: ApplicationValueTableEntry[];
  /** Every answer used and where it came from, for the audit trail. Values are on the attempt's prepared fields. */
  uses: BlindApplyAnswerUse[];
  /** Required questions with no truthful stored answer. Non-empty means: ask, do not submit. */
  missing: BlindMissingAnswer[];
  /** Things only the person can do (consent, login, code, a control this app cannot drive). Non-empty means: pause for the person. */
  interventions: BlindIntervention[];
}

const VERIFICATION_CODE_LABEL = /\b(?:verification|security|confirmation|one[- ]?time|login|sms|email)\s+code\b|\botp\b|\bpasscode\b/u;
const DEMOGRAPHIC_LABEL =
  /\b(?:gender|sex|ethnic\w*|race|racial|disabilit\w*|veteran|sexual orientation|pronouns?|hispanic|latino|religio\w*|marital|date of birth|age range|transgender)\b/u;

function mintValueRef(): string {
  return `v${randomBytes(8).toString('hex')}`;
}

function isPlaceholderOption(label: string): boolean {
  return /^(?:select|choose|please select|--|—)/iu.test(label.trim()) || label.trim() === '';
}

/** value-table label -> the normalized field labels it may fill. */
function buildSynonymIndex(valueTable: readonly ApplicationValueTableEntry[]): Map<string, ApplicationValueTableEntry> {
  const index = new Map<string, ApplicationValueTableEntry>();
  for (const entry of valueTable) {
    for (const synonym of APPLICATION_VALUE_LABEL_SYNONYMS[entry.label] ?? []) {
      if (!index.has(squashFieldLabel(synonym))) index.set(squashFieldLabel(synonym), entry);
    }
  }
  return index;
}

export function mapBlindApplyAnswers(input: BlindAnswerMapperInput): BlindAnswerMapping {
  const assignments: FieldMap['assignments'] = [];
  const unmapped: FieldMap['unmapped'] = [];
  const valueTable: ApplicationValueTableEntry[] = [...input.valueTable];
  const uses: BlindApplyAnswerUse[] = [];
  const missing: BlindMissingAnswer[] = [];
  const interventions: BlindIntervention[] = [];
  const synonyms = buildSynonymIndex(input.valueTable);

  // Two active fields with the same label and control type cannot be told apart by label alone, so
  // neither is filled by label: guessing which is the "real" one is exactly what this mapper refuses to do.
  const activeFields = input.snapshot.fields.filter((field) => field.active);
  const labelCounts = new Map<string, number>();
  for (const field of activeFields) {
    const key = `${field.controlType}::${normalizeFieldLabel(field.label)}`;
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  }

  const leave = (field: SnapshotField, reason: FieldMap['unmapped'][number]['reason']): void => {
    unmapped.push({ fieldRef: field.fieldRef, reason });
  };
  const intervene = (field: SnapshotField, kind: BlindApplyIntervention, reason: FieldMap['unmapped'][number]['reason']): void => {
    leave(field, reason);
    if (field.required) interventions.push({ kind, label: field.label });
  };
  const ask = (field: SnapshotField, controlType: BlindApplyMissingField['controlType']): void => {
    leave(field, 'needs_user');
    if (!field.required) return;
    missing.push({
      fieldRef: field.fieldRef,
      label: field.label,
      controlType,
      ...(field.options
        ? {
            options: field.options.filter((option) => !isPlaceholderOption(option.label)).map((option) => option.label),
            optionSetHash: optionSetHashOf(field.options.map((option) => option.label)),
          }
        : {}),
    });
  };

  for (const field of activeFields) {
    const label = normalizeFieldLabel(field.label);

    // Structural exclusions first: nothing below may even look at these.
    if (field.classification === 'consent_field') {
      intervene(field, 'consent', 'consent_field');
      continue;
    }
    if (field.classification === 'credential_field') {
      intervene(field, 'login', 'credential_field');
      continue;
    }
    if (VERIFICATION_CODE_LABEL.test(label)) {
      intervene(field, 'verification_code', 'needs_user');
      continue;
    }

    if (field.controlType === 'file') {
      const artifact = chooseArtifactForField(field, input.artifacts);
      if (artifact) {
        assignments.push({ fieldRef: field.fieldRef, source: { kind: 'artifact', artifactId: artifact.id } });
        uses.push({ label: field.label, provenance: 'cv' });
      } else {
        intervene(field, 'upload_unsupported', 'needs_user');
      }
      continue;
    }

    if (field.controlType === 'checkbox' || field.controlType === 'radio' || field.controlType === 'unknown') {
      // A radio button is surfaced one input at a time with no option list, and a plain checkbox is a
      // claim ("I am over 18") this app cannot make for the person. Required ones are the person's.
      intervene(field, 'other', 'needs_user');
      continue;
    }

    const ambiguous = (labelCounts.get(`${field.controlType}::${label}`) ?? 0) > 1;

    if (field.controlType === 'select') {
      const options = field.options ?? [];
      const key = blindAnswerKey(field.label, 'select', optionSetHashOf(options.map((option) => option.label)));
      const saved = ambiguous ? null : input.findSavedAnswer(key);
      const chosen = saved
        ? options.find((option) => normalizeFieldLabel(option.label) === normalizeFieldLabel(saved.answer) && !isPlaceholderOption(option.label))
        : undefined;
      if (saved && chosen) {
        assignments.push({ fieldRef: field.fieldRef, source: { kind: 'option', optionRef: chosen.optionRef } });
        uses.push({ label: field.label, provenance: 'saved_answer', answerId: saved.id });
      } else {
        ask(field, 'select');
      }
      continue;
    }

    // text / textarea
    const textType: 'text' | 'textarea' = field.controlType === 'textarea' ? 'textarea' : 'text';
    const demographic = DEMOGRAPHIC_LABEL.test(label);

    if (!demographic && !ambiguous) {
      const entry = synonyms.get(squashFieldLabel(field.label));
      if (entry) {
        assignments.push({ fieldRef: field.fieldRef, source: { kind: 'value', valueRef: entry.valueRef } });
        uses.push({ label: field.label, provenance: entry.provenance === 'profile' ? 'profile' : 'cv' });
        continue;
      }
    }

    const saved = ambiguous ? null : input.findSavedAnswer(blindAnswerKey(field.label, textType, null));
    if (saved && saved.answer.trim() !== '') {
      const valueRef = mintValueRef();
      valueTable.push({ valueRef, label: field.label, value: saved.answer.trim(), provenance: 'user_answer' });
      assignments.push({ fieldRef: field.fieldRef, source: { kind: 'value', valueRef } });
      uses.push({ label: field.label, provenance: 'saved_answer', answerId: saved.id });
      continue;
    }

    if (ambiguous && field.required) {
      leave(field, 'unrecognized');
      interventions.push({ kind: 'other', label: field.label });
    } else {
      ask(field, textType);
    }
  }

  return {
    fieldMap: {
      attemptId: input.attemptId,
      snapshotGeneration: input.snapshot.generation,
      assignments,
      unmapped,
    },
    valueTable,
    uses,
    missing,
    interventions,
  };
}
