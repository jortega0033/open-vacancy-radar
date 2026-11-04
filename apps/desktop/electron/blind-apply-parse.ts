import {
  BLIND_APPLY_STATE_LABELS,
  type BlindApplyAnswerResult,
  type BlindApplyEnableResult,
  type BlindApplyEvidenceView,
  type BlindApplyFeedItem,
  type BlindApplyIntervention,
  type BlindApplyItemState,
  type BlindApplyMissingField,
  type BlindApplyOpenResult,
  type BlindApplyStatus,
} from './blind-apply-types.js';

/**
 * The preload's fail-closed readers for Blind Apply results (#722). Each result is REBUILT from known
 * fields: an unknown state, a missing field or a mistyped value reads as the least permissive thing
 * (not active, no items, no evidence), never as a success. The renderer therefore never sees a shape main
 * did not write, and a malformed reply can never look like "Submitted".
 */

const STATES = Object.keys(BLIND_APPLY_STATE_LABELS) as BlindApplyItemState[];
const INTERVENTIONS: readonly BlindApplyIntervention[] = ['captcha', 'login', 'verification_code', 'consent', 'upload_unsupported', 'other'];

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
function text(source: Record<string, unknown> | undefined, key: string): string {
  const value = source?.[key];
  return typeof value === 'string' ? value : '';
}
function nullableText(source: Record<string, unknown> | undefined, key: string): string | null {
  const value = source?.[key];
  return typeof value === 'string' ? value : null;
}
function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

const EMPTY_COUNTS = Object.fromEntries(STATES.map((state) => [state, 0])) as BlindApplyStatus['counts'];

export function parseBlindApplyStatus(value: unknown): BlindApplyStatus {
  const source = record(value);
  const counts = { ...EMPTY_COUNTS };
  const rawCounts = record(source?.counts);
  for (const state of STATES) {
    const count = rawCounts?.[state];
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) counts[state] = Math.floor(count);
  }
  const auth = record(source?.authorization);
  const paused = record(source?.paused);
  const supported = record(source?.supported);
  const pausedReason = text(paused, 'reason');
  return {
    active: source?.active === true && auth !== undefined,
    paused:
      paused && (pausedReason === 'cv_changed' || pausedReason === 'profile_changed')
        ? { reason: pausedReason, detail: text(paused, 'detail') }
        : null,
    authorization: auth
      ? {
          createdAt: text(auth, 'createdAt'),
          roleFamilies: stringList(auth.roleFamilies),
          filters: stringList(auth.filters),
          cvName: nullableText(auth, 'cvName'),
        }
      : null,
    supported: { real: stringList(supported?.real), testOnly: stringList(supported?.testOnly) },
    counts,
  };
}

function parseMissing(value: unknown): BlindApplyMissingField[] | null {
  if (!Array.isArray(value)) return null;
  const fields: BlindApplyMissingField[] = [];
  for (const entry of value) {
    const source = record(entry);
    const controlType = text(source, 'controlType');
    const label = text(source, 'label');
    if (!source || label === '' || (controlType !== 'text' && controlType !== 'textarea' && controlType !== 'select')) continue;
    const options = Array.isArray(source.options) ? stringList(source.options) : undefined;
    const optionSetHash = text(source, 'optionSetHash');
    fields.push({ label, controlType, ...(options ? { options } : {}), ...(optionSetHash ? { optionSetHash } : {}) });
  }
  return fields;
}

export function parseBlindApplyFeed(value: unknown): BlindApplyFeedItem[] {
  if (!Array.isArray(value)) return [];
  const items: BlindApplyFeedItem[] = [];
  for (const entry of value) {
    const source = record(entry);
    const state = text(source, 'state') as BlindApplyItemState;
    const id = text(source, 'id');
    if (!source || id === '' || !STATES.includes(state)) continue;
    const intervention = text(source, 'intervention') as BlindApplyIntervention;
    const open = text(source, 'open');
    items.push({
      id,
      company: text(source, 'company'),
      role: text(source, 'role'),
      state,
      // The label is derived from the state here, never taken from the reply, so wording cannot be spoofed.
      label: BLIND_APPLY_STATE_LABELS[state],
      detail: text(source, 'detail'),
      intervention: INTERVENTIONS.includes(intervention) ? intervention : null,
      missingFields: parseMissing(source.missingFields),
      updatedAt: text(source, 'updatedAt'),
      attemptId: nullableText(source, 'attemptId'),
      open: open === 'review' || open === 'apply_yourself' ? open : null,
    });
  }
  return items;
}

export function parseBlindApplyEvidence(value: unknown, requestedId: string): BlindApplyEvidenceView | null {
  const source = record(value);
  if (!source || text(source, 'itemId') !== requestedId) return null;
  const gate = record(source.gate);
  const documents = record(source.documents);
  const receipt = record(source.receipt);
  const events = Array.isArray(source.events) ? source.events : [];
  const answers = Array.isArray(source.answers) ? source.answers : [];
  const filters = text(gate, 'filters');
  const linkStatus = text(gate, 'linkStatus');
  return {
    itemId: requestedId,
    gate: {
      family: nullableText(gate, 'family'),
      filters: filters === 'eligible' || filters === 'not_eligible' ? filters : 'unknown',
      linkStatus: linkStatus === 'verified' || linkStatus === 'unverified' ? linkStatus : 'unknown',
      policyId: nullableText(gate, 'policyId'),
      livenessStatus: nullableText(gate, 'livenessStatus'),
      livenessVerificationId: nullableText(gate, 'livenessVerificationId'),
      duplicateCheck: text(gate, 'duplicateCheck') === 'duplicate' ? 'duplicate' : 'clear',
    },
    events: events.flatMap((entry) => {
      const event = record(entry);
      return event ? [{ at: text(event, 'at'), kind: text(event, 'kind'), from: nullableText(event, 'from'), to: text(event, 'to'), detail: text(event, 'detail') }] : [];
    }),
    documents: { cvHash: nullableText(documents, 'cvHash'), letterHash: nullableText(documents, 'letterHash') },
    answers: answers.flatMap((entry) => {
      const answer = record(entry);
      const provenance = text(answer, 'provenance');
      if (!answer || (provenance !== 'cv' && provenance !== 'profile' && provenance !== 'saved_answer')) return [];
      return [{ label: text(answer, 'label'), provenance, ...(text(answer, 'answerId') ? { answerId: text(answer, 'answerId') } : {}) }];
    }),
    receipt: receipt
      ? {
          outcome: text(receipt, 'outcome'),
          evidenceKind: text(receipt, 'evidenceKind'),
          evidenceReference: text(receipt, 'evidenceReference'),
          destination: text(receipt, 'destination'),
          observedAt: text(receipt, 'observedAt'),
          detail: text(receipt, 'detail'),
        }
      : null,
  };
}

export function parseBlindApplyEnableResult(value: unknown): BlindApplyEnableResult {
  const source = record(value);
  if (source?.ok === true) return { ok: true };
  const reason = text(source, 'reason');
  return {
    ok: false,
    reason: reason === 'no_cv' || reason === 'no_profile' || reason === 'no_role_family' ? reason : 'declined',
  };
}

export function parseBlindApplyStopResult(value: unknown): { stopped: boolean; itemsStopped: number } {
  const source = record(value);
  const count = source?.itemsStopped;
  return { stopped: source?.stopped === true, itemsStopped: typeof count === 'number' && Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0 };
}

export function parseBlindApplyAnswerResult(value: unknown): BlindApplyAnswerResult {
  const source = record(value);
  if (source?.ok === true) return { ok: true };
  const reason = text(source, 'reason');
  return { ok: false, reason: reason === 'incomplete' || reason === 'invalid_option' || reason === 'stopped' ? reason : 'not_waiting' };
}

export function parseBlindApplyOpenResult(value: unknown): BlindApplyOpenResult {
  const source = record(value);
  const attemptId = text(source, 'attemptId');
  if (source?.ok === true && attemptId !== '') {
    if (source.kind === 'review') return { ok: true, kind: 'review', attemptId };
    const savedJobId = text(source, 'savedJobId');
    if (source.kind === 'apply_yourself' && savedJobId !== '') return { ok: true, kind: 'apply_yourself', attemptId, savedJobId };
  }
  return { ok: false, reason: text(source, 'reason') === 'unavailable' ? 'unavailable' : 'not_openable' };
}
