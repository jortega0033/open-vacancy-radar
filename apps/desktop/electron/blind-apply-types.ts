import type {
  BlindApplyAnswerUse,
  BlindApplyGateEvidence,
  BlindApplyIntervention,
  BlindApplyItemState,
  BlindApplyMissingField,
  BlindApplySkipReason,
} from './workspace/blind-apply-schema.js';

/**
 * What the renderer may know about Blind Apply (#722). Pure types and plain-language labels, with no
 * runtime dependency on Electron or the database, so the renderer can import it directly.
 *
 * The renderer can read the activity feed, ask for one item's evidence, answer a "needs one answer"
 * card, open an item into the existing reviewed flow, enable Blind Apply (which only asks main to show
 * its own native confirmation) and press Stop. It can write nothing else: it cannot create an
 * authorization, move an item's state, pick a policy, or name a URL.
 */

export type { BlindApplyItemState, BlindApplyIntervention, BlindApplyMissingField, BlindApplySkipReason };

/** The only words the activity feed uses for an item's state. */
export const BLIND_APPLY_STATE_LABELS: Readonly<Record<BlindApplyItemState, string>> = {
  queued: 'Waiting',
  preparing: 'Preparing',
  ready: 'Sending',
  submitting: 'Sending',
  submitted: 'Submitted',
  outcome_unknown: "Sent? Couldn't confirm",
  could_not_submit: 'Could not submit',
  needs_answer: 'Needs one answer',
  needs_you: 'Needs you',
  apply_yourself: 'Apply yourself',
  skipped: 'Skipped',
  stopped: 'Stopped',
};

export const BLIND_APPLY_SKIP_LABELS: Readonly<Record<BlindApplySkipReason, string>> = {
  closed: 'This posting is closed',
  duplicate: 'You already applied or started this one',
  not_frontend: 'Not a frontend role',
  filters: 'Outside your filters',
  unverified_link: 'The apply link is not confirmed',
  unverifiable_posting: 'This posting could not be confirmed open',
};

export const BLIND_APPLY_INTERVENTION_LABELS: Readonly<Record<BlindApplyIntervention, string>> = {
  captcha: 'This page shows a bot check. Only you can pass it.',
  login: 'This page needs you to sign in.',
  verification_code: 'This page asks for a verification code.',
  consent: 'This form needs a consent box that only you can tick.',
  upload_unsupported: 'This form needs a document this app cannot attach.',
  other: 'This form has a choice only you can make.',
};

/** States where nothing more will happen without the person. Skipped and apply-yourself are quiet. */
export function isBlindApplyAttentionState(state: BlindApplyItemState): boolean {
  return state === 'needs_answer' || state === 'needs_you' || state === 'could_not_submit' || state === 'outcome_unknown';
}

export type BlindApplyPauseView = { reason: 'cv_changed' | 'profile_changed'; detail: string };

export interface BlindApplyStatus {
  /** An authorization exists and has not been stopped. */
  active: boolean;
  /** Set when Blind Apply is on but cannot continue until the person confirms it again. */
  paused: BlindApplyPauseView | null;
  authorization: {
    createdAt: string;
    roleFamilies: string[];
    /** The hard filters the person confirmed, in plain language. */
    filters: string[];
    cvName: string | null;
  } | null;
  /** Where Blind Apply can actually send. Empty `real` means it submits nowhere real in this build. */
  supported: { real: string[]; testOnly: string[] };
  counts: Record<BlindApplyItemState, number>;
}

export interface BlindApplyFeedItem {
  id: string;
  company: string;
  role: string;
  state: BlindApplyItemState;
  /** The plain label for `state`. */
  label: string;
  /** One plain sentence, or empty. Never employer page text. */
  detail: string;
  intervention: BlindApplyIntervention | null;
  missingFields: BlindApplyMissingField[] | null;
  updatedAt: string;
  attemptId: string | null;
  /** What "Open" does: the existing reviewed flow for this vacancy, or this item's own review card. */
  open: 'review' | 'apply_yourself' | null;
}

export interface BlindApplyEvidenceView {
  itemId: string;
  gate: BlindApplyGateEvidence;
  events: Array<{ at: string; kind: string; from: string | null; to: string; detail: string }>;
  documents: { cvHash: string | null; letterHash: string | null };
  answers: BlindApplyAnswerUse[];
  receipt: {
    outcome: string;
    evidenceKind: string;
    evidenceReference: string;
    destination: string;
    observedAt: string;
    detail: string;
  } | null;
}

export type BlindApplyEnableResult =
  | { ok: true }
  | { ok: false; reason: 'declined' | 'no_cv' | 'no_profile' | 'no_role_family' };

export interface BlindApplyAnswerInput {
  itemId: string;
  /** One entry per field the card listed. Select answers must be one of the listed option labels. */
  answers: Array<{ label: string; answer: string }>;
  /** Ticked: reuse this answer for the same question on later forms. Unticked: this form only. */
  remember: boolean;
}

export type BlindApplyAnswerResult = { ok: true } | { ok: false; reason: 'not_waiting' | 'incomplete' | 'invalid_option' | 'stopped' };

export type BlindApplyOpenResult =
  | { ok: true; kind: 'review'; attemptId: string }
  | { ok: true; kind: 'apply_yourself'; attemptId: string; savedJobId: string }
  | { ok: false; reason: 'not_openable' | 'unavailable' };

export interface BlindApplyBridge {
  status(): Promise<BlindApplyStatus>;
  /** Asks main to show its own native confirmation. The renderer cannot supply or skip anything in it. */
  enable(): Promise<BlindApplyEnableResult>;
  stop(): Promise<{ stopped: boolean; itemsStopped: number }>;
  feed(): Promise<BlindApplyFeedItem[]>;
  evidence(itemId: string): Promise<BlindApplyEvidenceView | null>;
  answer(input: BlindApplyAnswerInput): Promise<BlindApplyAnswerResult>;
  open(itemId: string): Promise<BlindApplyOpenResult>;
}
