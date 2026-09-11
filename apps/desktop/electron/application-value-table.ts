import { randomBytes } from 'node:crypto';
import type { FieldMap, FormSnapshot, SnapshotField } from '@agent-dock/application-executor';
import type {
  PreparedApplicationField,
  PreparedApplicationFields,
  PreparedFieldProvenance,
} from './workspace/types.js';

/**
 * Domain A's *input*, built entirely in Electron main (#196 §2, issue #272).
 *
 * The generation session never authors a value. It is handed a closed table of values this process
 * read out of the user's own reviewed records, plus the structured form snapshot the executor
 * minted, and its only job is to say which value belongs in which field. That is what makes "never
 * fabricate content" a structural property rather than a prompt instruction: a value that is not in
 * the table below cannot reach the page at all, because `validateFieldMap` (Domain B) refuses any
 * `valueRef` it has never seen.
 *
 * Three deliberate absences:
 *
 *  - **No job-description text.** Field mapping does not need it, and the JD is untrusted remote
 *    content. Leaving it out of this prompt entirely means there is no path by which a job posting
 *    can instruct the session that reasons about the candidate's own answers.
 *  - **No invented answers.** Every entry traces to a record the user reviewed (the source CV) or
 *    configured (the candidate profile). Nothing is defaulted: an unset field produces no entry at
 *    all rather than a plausible-looking placeholder, and no role, country, language or salary is
 *    assumed on the user's behalf.
 *  - **No option choices.** A `<select>`/radio answer ("preferred work arrangement", "are you
 *    authorised to work here") is a claim about the candidate that no source record supports, so
 *    this pipeline never commits one -- see `summarisePreparedFields`, which records such fields as
 *    `awaiting_you` for the person to answer in the live review instead.
 */

/** Matches `field-map.ts`'s `VALUE_REF_PATTERN` (`v` + 16 hex). Minted here rather than imported
 * because the executor package mints field/option/submit refs (which describe a page it read) and
 * deliberately not value refs (which describe records it never sees). */
function mintValueRef(): string {
  return `v${randomBytes(8).toString('hex')}`;
}

export interface ApplicationValueTableEntry {
  valueRef: string;
  /**
   * A short name for what this value is ("Full name", "Email address"), shown to the generation
   * session so it can match a value to a field. Never a selector, a path, or anything the session
   * could use to reach outside the closed set.
   */
  label: string;
  value: string;
  provenance: PreparedFieldProvenance;
}

/** The reviewed contact facts a source CV carries. Structural rather than `CvSourceContact` so
 * this module does not depend on the workspace CV schema's exact shape. */
export interface ApplicationValueCvContact {
  name: string;
  title: string;
  location: string;
  email: string;
  phone: string;
  links: readonly string[];
}

/** The candidate-profile fields this table draws on. Structural for the same reason, and narrow on
 * purpose: nothing about targeting (roles, salary floors, excluded families) belongs in an answer
 * typed into an employer's form. */
export interface ApplicationValueProfile {
  candidateName: string;
  currentRole: string;
  location: string;
  professionalLanguage: string;
}

export interface BuildApplicationValueTableInput {
  /** Null when the source CV has not been reviewed into its structured form yet (#274). The table
   * is then built from the profile alone rather than from guessed CV contents. */
  cvContact: ApplicationValueCvContact | null;
  profile: ApplicationValueProfile | null;
}

function push(
  entries: ApplicationValueTableEntry[],
  label: string,
  value: string | undefined,
  provenance: PreparedFieldProvenance,
): void {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0) return;
  // First writer wins: the reviewed CV is consulted before the profile for every fact both can
  // carry, so a contact detail the user corrected during CV review is never overwritten by an
  // older profile value.
  if (entries.some((entry) => entry.label === label)) return;
  entries.push({ valueRef: mintValueRef(), label, value: trimmed, provenance });
}

/** A link is only offered under a specific name when it is unambiguously that kind of link -- a
 * bare host match, not a guess about what the page behind it contains. */
function findLink(links: readonly string[], host: string): string | undefined {
  return links.find((link) => {
    try {
      return new URL(link).hostname.toLowerCase().endsWith(host);
    } catch {
      return false;
    }
  });
}

/**
 * Builds the closed value table for one attempt. Order matters only in that the reviewed CV is
 * consulted first (see `push`); every entry is otherwise independent, and an absent source simply
 * contributes nothing.
 */
export function buildApplicationValueTable(input: BuildApplicationValueTableInput): ApplicationValueTableEntry[] {
  const entries: ApplicationValueTableEntry[] = [];
  const cv = input.cvContact;
  const profile = input.profile;

  push(entries, 'Full name', cv?.name, 'cv');
  push(entries, 'Full name', profile?.candidateName, 'profile');
  push(entries, 'Email address', cv?.email, 'cv');
  push(entries, 'Phone number', cv?.phone, 'cv');
  push(entries, 'Current location', cv?.location, 'cv');
  push(entries, 'Current location', profile?.location, 'profile');
  push(entries, 'Current job title', cv?.title, 'cv');
  push(entries, 'Current job title', profile?.currentRole, 'profile');
  push(entries, 'Working languages', profile?.professionalLanguage, 'profile');

  const links = cv?.links ?? [];
  push(entries, 'LinkedIn profile URL', findLink(links, 'linkedin.com'), 'cv');
  push(entries, 'GitHub profile URL', findLink(links, 'github.com'), 'cv');

  return entries;
}

function describeField(field: SnapshotField): string {
  const parts = [`ref: ${field.fieldRef}`, `label: ${JSON.stringify(field.label)}`, `type: ${field.controlType}`, `required: ${field.required}`];
  if (field.classification) parts.push(`excluded: ${field.classification}`);
  if (field.options && field.options.length > 0) {
    parts.push(`options: ${field.options.map((option) => `${option.optionRef}=${JSON.stringify(option.label)}`).join(', ')}`);
  }
  return `- ${parts.join(', ')}`;
}

export interface FieldMapGenerationPromptInput {
  attemptId: string;
  snapshot: FormSnapshot;
  valueTable: readonly ApplicationValueTableEntry[];
}

/**
 * The Domain A prompt. Deterministic, so two runs against the same snapshot and value table send
 * exactly the same text -- nothing about it is templated from remote content.
 *
 * The instructions here are guidance, never the control: everything they ask for is independently
 * enforced afterwards by `validateFieldMap` and by `sanitiseGeneratedFieldMap` below. A session
 * that ignores every line of this prompt cannot produce an assignment that reaches the page.
 */
export function buildFieldMapGenerationPrompt(input: FieldMapGenerationPromptInput): string {
  const fields = input.snapshot.fields.map(describeField).join('\n');
  const values = input.valueTable.map((entry) => `- ${entry.valueRef}: ${entry.label}`).join('\n');

  return [
    'You are matching a person\'s own already-known details to the fields of an application form.',
    'Answer with one JSON object and nothing else: no prose, no markdown fence, no explanation.',
    '',
    'FORM FIELDS (the only fields that exist):',
    fields.length > 0 ? fields : '- (none)',
    '',
    'AVAILABLE VALUES (the only values that exist; you are told what each one is, never its content):',
    values.length > 0 ? values : '- (none)',
    '',
    'RULES:',
    '1. Assign a value to a field only when the value is unmistakably what that field asks for.',
    '2. Never invent a value, a fieldRef, a valueRef or an optionRef. Only the identifiers above exist.',
    '3. Never assign anything to a field marked excluded. List it under "unmapped" instead.',
    '4. A field you cannot match goes under "unmapped", never under a guess.',
    '',
    'RESPONSE SHAPE:',
    JSON.stringify(
      {
        attemptId: input.attemptId,
        snapshotGeneration: input.snapshot.generation,
        assignments: [{ fieldRef: 'f0123456789abcdef', source: { kind: 'value', valueRef: 'v0123456789abcdef' } }],
        unmapped: [{ fieldRef: 'f0123456789abcdef', reason: 'needs_user' }],
      },
      null,
      2,
    ),
    '',
    `"attemptId" must be exactly ${JSON.stringify(input.attemptId)} and "snapshotGeneration" exactly ${input.snapshot.generation}.`,
  ].join('\n');
}

/** Everything `sanitiseGeneratedFieldMap` removed, so the caller can record each one against the
 * field it was proposed for rather than dropping it silently. */
export interface SanitisedFieldMap {
  fieldMap: FieldMap;
  /** Fields the session proposed a document upload for. Blocks readiness: this app is meant to
   * attach the document itself, and cannot yet verify that it did (#273/R02b). */
  uploadFieldRefs: string[];
  /** Fields the session proposed an option choice for. Never committed -- see this module's own
   * doc comment on why a select answer is not this pipeline's to give. */
  optionFieldRefs: string[];
}

/**
 * Narrows a parsed field map to the assignment kinds this pipeline is willing to commit, before it
 * ever reaches `validateFieldMap`.
 *
 * Narrowing rather than refusing the whole map matters: `validateFieldMap`'s rule 5 refuses an
 * entire map containing one `artifact` assignment, so a form with a CV upload would otherwise lose
 * the name and email assignments too, and the reason surfaced to the person would be about
 * ownership rather than about the upload that actually needs doing. Each removed assignment is
 * returned by fieldRef so it lands in the prepared-fields record as its own visible, specific
 * outcome instead of disappearing.
 */
export function sanitiseGeneratedFieldMap(fieldMap: FieldMap): SanitisedFieldMap {
  const uploadFieldRefs: string[] = [];
  const optionFieldRefs: string[] = [];
  const assignments: FieldMap['assignments'] = [];

  for (const assignment of fieldMap.assignments) {
    if (assignment.source.kind === 'artifact') {
      uploadFieldRefs.push(assignment.fieldRef);
      continue;
    }
    if (assignment.source.kind === 'option') {
      optionFieldRefs.push(assignment.fieldRef);
      continue;
    }
    assignments.push(assignment);
  }

  const removed = [...uploadFieldRefs, ...optionFieldRefs];
  const unmapped: FieldMap['unmapped'] = [
    ...fieldMap.unmapped.filter((entry) => !removed.includes(entry.fieldRef)),
    ...removed.map((fieldRef) => ({ fieldRef, reason: 'needs_user' as const })),
  ];

  return { fieldMap: { ...fieldMap, assignments, unmapped }, uploadFieldRefs, optionFieldRefs };
}

export interface SummarisePreparedFieldsInput {
  snapshot: FormSnapshot;
  /** The sanitised, validated map that was actually applied. */
  fieldMap: FieldMap;
  valueTable: readonly ApplicationValueTableEntry[];
  uploadFieldRefs: readonly string[];
  optionFieldRefs: readonly string[];
  company: string;
  role: string;
  /** ISO-8601, from the caller's clock. */
  preparedAt: string;
}

export interface PreparedFieldsSummary {
  prepared: PreparedApplicationFields;
  /**
   * Why this application is not ready for review, if it isn't. Only a required document upload
   * blocks today: everything else a form still wants is something the person completes in the live
   * review view, and is listed there rather than hidden behind a refusal. Verifying that each
   * committed value is genuinely committed on the page -- and refusing readiness when a required
   * field is still empty -- is #277 (R06)'s scope, not silently assumed here.
   */
  blockers: string[];
}

/**
 * Turns "what was applied" into the durable, per-attempt record a review renders. Every field in
 * the snapshot appears exactly once, with a status that says plainly what happened to it, so a
 * person reading the review never has to infer that an absent row means an empty field.
 */
export function summarisePreparedFields(input: SummarisePreparedFieldsInput): PreparedFieldsSummary {
  const valueByRef = new Map(input.valueTable.map((entry) => [entry.valueRef, entry]));
  const assignmentByFieldRef = new Map(input.fieldMap.assignments.map((assignment) => [assignment.fieldRef, assignment]));
  const uploads = new Set(input.uploadFieldRefs);
  const options = new Set(input.optionFieldRefs);

  const fields: PreparedApplicationField[] = [];
  const blockers: string[] = [];

  for (const field of input.snapshot.fields) {
    const base = { label: field.label, controlType: field.controlType, required: field.required };

    if (field.classification) {
      fields.push({
        ...base,
        status: 'awaiting_you',
        detail:
          field.classification === 'consent_field'
            ? 'a consent question, which this app never answers on your behalf'
            : 'a credential field, which this app never fills',
      });
      continue;
    }

    if (uploads.has(field.fieldRef) || field.controlType === 'file') {
      fields.push({ ...base, status: 'pending_upload', detail: 'this form wants a document attached, which this app cannot attach and verify yet' });
      if (field.required) {
        blockers.push(`"${field.label}" needs a document attached, and verified uploads are not wired up yet`);
      }
      continue;
    }

    const assignment = assignmentByFieldRef.get(field.fieldRef);
    if (assignment && assignment.source.kind === 'value') {
      const entry = valueByRef.get(assignment.source.valueRef);
      // Unreachable once Domain B has passed the map (rule 4 refuses an unknown valueRef), but
      // recorded honestly rather than asserted away: an entry with no value is not a committed one.
      if (entry) {
        fields.push({ ...base, status: 'committed', value: entry.value, provenance: entry.provenance });
        continue;
      }
    }

    if (options.has(field.fieldRef) || field.controlType === 'select' || field.controlType === 'radio') {
      fields.push({ ...base, status: 'awaiting_you', detail: 'a choice about you that none of your saved details answers, so this app leaves it to you' });
      continue;
    }

    fields.push({
      ...base,
      status: field.required ? 'awaiting_you' : 'left_blank',
      detail: field.required
        ? 'none of your saved details answers this, so this app left it for you'
        : 'optional, and none of your saved details answers it',
    });
  }

  return {
    prepared: {
      version: 1,
      preparedAt: input.preparedAt,
      company: input.company,
      role: input.role,
      verification: 'applied',
      fields,
    },
    blockers,
  };
}
