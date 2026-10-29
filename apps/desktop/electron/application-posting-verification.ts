import { createHash } from 'node:crypto';
import {
  comparePostingText,
  POSTING_FRESHNESS_WINDOW_MS,
  POSTING_UNABLE_RETRY_AFTER_MS,
  POSTING_VERIFY_TIMEOUT_MS,
  postingContentHash,
  resolvePostingProbe,
  type PostingObservation,
  type PostingValidators,
} from '@open-vacancy-radar/vacancy-engine';
import type {
  PostingVerificationAction,
  PostingVerificationReasonCode,
  PostingVerificationStatus,
  PostingVerificationView,
} from './application-pipeline-types.js';
import * as workspace from './workspace/repository.js';
import {
  adoptPostingChange,
  getLatestPostingVerification,
  getNewestDefinitivePostingVerification,
  getPendingPostingFinding,
  getPostingObservedText,
  isHistoricalAttempt,
  recordPostingVerification,
  resolvePostingVerification,
  type PostingChangeSummary,
  type PostingHoldEffect,
  type PostingHoldRequest,
  type PostingVerificationRecord,
  type PostingVerificationResult,
  type ResolvePostingVerificationOutcome,
} from './workspace/posting-verification-store.js';
import type { WorkspaceDb } from './workspace/client.js';
import type { ApplicationAttemptCheckpoint, ApplicationAttemptRecord } from './workspace/types.js';

/**
 * The single owner of #687: one bounded, authoritative check of an attempt's live posting, shared by
 * preparation, resumption and the explicit "check again" action (see `docs/posting-verification.md`).
 *
 * What it guarantees, and where each guarantee is enforced:
 *  - **One network request for overlapping callers, judged by each caller.** Only the network
 *    observation is shared (`inFlight`, per attempt and URL). Every caller then re-reads the attempt
 *    and judges and records the result under its OWN trigger, allowed checkpoints and liveness, so a
 *    renderer check can never make a preparation run lose its observation, its force, or its claim.
 *  - **A check that cannot run is "could not check".** A rejected or hanging verifier port (for
 *    example an HTTP client that could not be set up) becomes an `unable` observation; preparation
 *    continues on the stored text and never stays in `reading_jd`.
 *  - **Freshness without a request.** A stored finding younger than `POSTING_FRESHNESS_WINDOW_MS`
 *    (an "unable" one: `POSTING_UNABLE_RETRY_AFTER_MS`) is returned as it was observed, with its
 *    original `checkedAt`; nothing is fetched and nothing is rewritten.
 *  - **No silent overwrite, no lost package.** This module never edits `jdSnapshot` (except filling a
 *    description that was missing, as the on-demand fetch did). A closed/changed posting found on a
 *    prepared package HOLDS it (out of review, checkpoint/detail/answers copied onto the finding);
 *    Keep / Get ready anyway put it back unchanged; only the explicit Refresh replaces it. An attempt
 *    waiting for any other reason is never touched; it only shows the finding.
 *  - **Historical attempts are untouchable.** Submitted / reported / skipped attempts are never
 *    verified (no request) and the store refuses to write for them.
 *  - **Interruption is safe.** The write re-reads the attempt in one transaction and requires the
 *    checkpoint the caller was entitled to write at; a cancelled, abandoned or moved-on attempt
 *    records nothing, and an older observation never replaces a newer one.
 */

export interface PostingVerifierPort {
  verify(input: { url: string; validators?: PostingValidators | null | undefined }): Promise<PostingObservation>;
}

export interface PostingVerificationDeps {
  db: WorkspaceDb;
  /** Absent in a build/test with no verifier: nothing is checked and nothing about preparation changes. */
  verifyPosting?: PostingVerifierPort['verify'];
  now?(): Date;
  log?(message: string, meta?: Record<string, unknown>): void;
}

/** Sentences main writes into `checkpointDetail`; the renderer routes on the structured view, not on these. */
export const POSTING_CLOSED_DETAIL =
  "This posting looks closed: the employer's own job system says it no longer exists. Open the posting to check, or get ready anyway.";
export const POSTING_CHANGED_DETAIL =
  'This posting changed since it was read. Review what changed, then refresh your application from the updated posting or keep what you have.';

export function isPostingFindingDetail(detail: string): boolean {
  return detail === POSTING_CLOSED_DETAIL || detail === POSTING_CHANGED_DETAIL;
}

/**
 * The full manual hand-off sentence (`application-pipeline.ts`): documents are ready and the person
 * applies on the employer site. A test keeps the two in step.
 */
export const PREPARED_HANDOFF_PHRASE = 'Your application documents are ready.';

/**
 * A prepared package a closed/changed posting must take out of review until the person decides: a
 * `ready` review, or the manual hand-off whose documents are ready. An attempt waiting on anything
 * else (a question, a missing letter, a failure) is not a package and is never held.
 */
export function isPreparedPackage(attempt: { checkpoint: ApplicationAttemptCheckpoint; checkpointDetail: string }): boolean {
  if (attempt.checkpoint === 'ready') return true;
  return (
    attempt.checkpoint === 'needs_user' &&
    attempt.checkpointDetail.includes(PREPARED_HANDOFF_PHRASE) &&
    !isPostingFindingDetail(attempt.checkpointDetail)
  );
}

const POSTING_HOLD: PostingHoldRequest = {
  isPreparedPackage,
  detailFor: (result) => (result === 'confirmed_closed' ? POSTING_CLOSED_DETAIL : POSTING_CHANGED_DETAIL),
};

const PREPARED_CHECKPOINTS: readonly ApplicationAttemptCheckpoint[] = ['ready', 'needs_user', 'failed'];
const IN_FLIGHT_CHECKPOINTS: readonly ApplicationAttemptCheckpoint[] = [
  'queued',
  'reading_jd',
  'tailoring',
  'rendering',
  'filling',
];
/** Desktop-side backstop past the engine's own (aborting) deadline, for a port that never settles. */
const PORT_BACKSTOP_MS = POSTING_VERIFY_TIMEOUT_MS + 5_000;

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function nowOf(deps: { now?(): Date }): Date {
  return deps.now?.() ?? new Date();
}

export function isPostingFresh(record: PostingVerificationRecord, now: Date): boolean {
  const age = now.getTime() - Date.parse(record.observedAt);
  const window = record.outcome === 'unable' ? POSTING_UNABLE_RETRY_AFTER_MS : POSTING_FRESHNESS_WINDOW_MS;
  return age >= 0 && age < window;
}

function baselineHashOf(attempt: ApplicationAttemptRecord): string {
  return attempt.jdSnapshot.trim().length === 0 ? '' : postingContentHash(attempt.jdSnapshot);
}

/** Whether the stored finding still describes the snapshot the attempt holds right now. */
function describesCurrentSnapshot(record: PostingVerificationRecord, baselineHash: string): boolean {
  return (
    record.baselineHash === baselineHash ||
    (record.resolution === 'refreshed' && record.contentHash !== null && record.contentHash === baselineHash)
  );
}

function actionsFor(
  status: PostingVerificationStatus,
  resolution: PostingVerificationRecord['resolution'],
  attemptCheckpoint: ApplicationAttemptCheckpoint,
  checkable: boolean,
): PostingVerificationAction[] {
  const waiting = attemptCheckpoint === 'needs_user' || attemptCheckpoint === 'failed';
  // "Check again" only where it can actually ask someone: a link with an authoritative route.
  const checkAgain: PostingVerificationAction[] = checkable ? ['check_again'] : [];
  switch (status) {
    case 'not_applicable':
      return [];
    case 'confirmed_closed':
      return resolution === null && waiting
        ? ['open_posting', 'prepare_anyway', ...checkAgain]
        : ['open_posting', ...checkAgain];
    case 'materially_changed':
      return resolution === null && waiting
        ? ['refresh', 'keep_current', 'open_posting', ...checkAgain]
        : ['open_posting', ...checkAgain];
    case 'unable_to_verify':
      return ['open_posting', ...checkAgain];
    case 'confirmed_open':
    case 'not_checked':
      return checkAgain;
  }
}

export function buildPostingVerificationView(
  attempt: ApplicationAttemptRecord,
  latest: PostingVerificationRecord | null,
  pending: PostingVerificationRecord | null,
  now: Date,
  extra: { reused?: boolean; hold?: PostingHoldEffect } = {},
): PostingVerificationView {
  const historical = isHistoricalAttempt(attempt);
  const baselineHash = baselineHashOf(attempt);
  // An undecided closure/change stays the answer until someone decides or a later check answers;
  // a later "could not check" is shown beside it, not instead of it.
  const pendingCurrent = pending !== null && describesCurrentSnapshot(pending, baselineHash) ? pending : null;
  const latestCurrent = latest !== null && describesCurrentSnapshot(latest, baselineHash) ? latest : null;
  const current = pendingCurrent ?? latestCurrent;
  let status: PostingVerificationStatus = historical ? 'not_applicable' : 'not_checked';
  if (!historical && current !== null) {
    status =
      current.resolution === 'refreshed' && current.result === 'materially_changed' ? 'confirmed_open' : current.result;
  }
  // A stored finding about an older snapshot is history, not a statement about this one.
  const shown = historical ? null : current;
  const recheck =
    !historical && pendingCurrent !== null && latest !== null && latest.id !== pendingCurrent.id && latest.result === 'unable_to_verify'
      ? { checkedAt: latest.observedAt, reason: latest.reason as PostingVerificationReasonCode }
      : null;
  const freshnessBasis = recheck !== null ? latest : shown;
  const changeSummary: PostingChangeSummary | null =
    shown?.result === 'materially_changed' && shown.resolution !== 'refreshed' ? shown.changeSummary : null;
  return {
    attemptId: attempt.id,
    status,
    checkedAt: shown?.observedAt ?? null,
    source: shown && shown.source !== 'none' ? shown.source : null,
    sourceRef: shown && shown.source !== 'none' ? shown.sourceRef : null,
    reason: (shown?.reason as PostingVerificationReasonCode | undefined) ?? null,
    httpStatus: shown?.httpStatus ?? null,
    contentVersion: shown?.contentVersion ?? null,
    deadline:
      shown?.deadline && shown.deadlineProvenance
        ? { date: shown.deadline, excerpt: shown.deadlineProvenance.excerpt }
        : null,
    noDeadlineStated: shown !== null && shown.outcome === 'open' && shown.deadline === null && shown.contentHash !== null,
    change: changeSummary ? { added: changeSummary.added, removed: changeSummary.removed } : null,
    changeKind: changeSummary ? (changeSummary.kind ?? 'requirements') : null,
    resolution: shown?.resolution === 'superseded' ? null : (shown?.resolution ?? null),
    reused: extra.reused ?? false,
    stale: freshnessBasis === null || !isPostingFresh(freshnessBasis, now),
    invalidated: extra.hold === 'held',
    held: !historical && pendingCurrent?.held === true,
    released: extra.hold === 'released',
    recheck,
    actions: actionsFor(
      status,
      shown?.resolution ?? null,
      attempt.checkpoint,
      !historical && resolvePostingProbe(attempt.canonicalUrl) !== null,
    ),
  };
}

function viewFor(deps: { db: WorkspaceDb }, attempt: ApplicationAttemptRecord, now: Date, extra: { reused?: boolean; hold?: PostingHoldEffect } = {}) {
  return buildPostingVerificationView(
    attempt,
    getLatestPostingVerification(deps.db, attempt.id),
    getPendingPostingFinding(deps.db, attempt.id),
    now,
    extra,
  );
}

/** Reads the stored finding for the renderer. Makes no request and writes nothing. */
export function readPostingVerification(deps: { db: WorkspaceDb; now?(): Date }, attemptId: string): PostingVerificationView {
  return viewFor(deps, workspace.getApplicationAttempt(deps.db, attemptId), nowOf(deps));
}

export type VerifyTrigger = 'prepare' | 'manual';

export interface VerifyAttemptOptions {
  trigger: VerifyTrigger;
  /** Ignore a fresh stored finding (the explicit "Check again"). Joining a request in flight is live, so it honours this. */
  force?: boolean;
  /** Evaluated after the network call: false means the caller lost its claim on the attempt. */
  isLive?: () => boolean;
}

export type VerifyAttemptResult =
  | {
      kind: 'verified';
      view: PostingVerificationView;
      record: PostingVerificationRecord | null;
      /** This caller waited on a live request (its own or one it joined); false = stored finding reused. */
      requested: boolean;
      /** This caller joined a request another caller had already started. */
      joined: boolean;
    }
  | { kind: 'not_applicable'; view: PostingVerificationView }
  | { kind: 'no_verifier'; view: PostingVerificationView }
  /** The caller lost the attempt while the check was in flight; nothing was written by this caller. */
  | { kind: 'dropped'; view: PostingVerificationView };

/** Only the network observation is shared between overlapping callers, never the judgement or the write. */
const inFlight = new Map<string, { url: string; promise: Promise<PostingObservation> }>();

function unableObservation(url: string, reason: 'timeout' | 'check_failed', at: Date): PostingObservation {
  const probe = resolvePostingProbe(url);
  return {
    observedAt: at.toISOString(),
    source: probe?.source ?? 'none',
    sourceRef: probe?.sourceRef ?? 'none',
    outcome: 'unable',
    reason,
    httpStatus: null,
    text: null,
    contentHash: null,
    validators: null,
    notModified: false,
    deadline: null,
    logicalRequests: 0,
  };
}

/** Calls the port; a rejection or a port that never settles is "could not check", never an exception. */
async function observeSafely(
  deps: PostingVerificationDeps,
  verify: PostingVerifierPort['verify'],
  url: string,
  validators: PostingValidators | null,
): Promise<PostingObservation> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const backstop = new Promise<PostingObservation>((resolve) => {
    timer = setTimeout(() => resolve(unableObservation(url, 'timeout', nowOf(deps))), PORT_BACKSTOP_MS);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => verify({ url, validators })), backstop]);
  } catch (error) {
    deps.log?.('the posting check could not run; treating it as "could not check"', {
      error: error instanceof Error ? error.message : String(error),
    });
    return unableObservation(url, 'check_failed', nowOf(deps));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function sharedObservation(
  deps: PostingVerificationDeps,
  verify: PostingVerifierPort['verify'],
  attemptId: string,
  url: string,
  validators: PostingValidators | null,
): { promise: Promise<PostingObservation>; joined: boolean } {
  const existing = inFlight.get(attemptId);
  if (existing && existing.url === url) return { promise: existing.promise, joined: true };
  const promise = observeSafely(deps, verify, url, validators).finally(() => {
    if (inFlight.get(attemptId)?.promise === promise) inFlight.delete(attemptId);
  });
  inFlight.set(attemptId, { url, promise });
  return { promise, joined: false };
}

function allowedCheckpointsFor(trigger: VerifyTrigger): readonly ApplicationAttemptCheckpoint[] {
  return trigger === 'prepare' ? ['reading_jd'] : PREPARED_CHECKPOINTS;
}

/**
 * Verifies one attempt's posting for one caller. Overlapping callers share the network request only;
 * each judges and records under its own trigger, checkpoints and liveness.
 */
export async function verifyAttemptPosting(
  deps: PostingVerificationDeps,
  attemptId: string,
  options: VerifyAttemptOptions,
): Promise<VerifyAttemptResult> {
  const start = nowOf(deps);
  const attempt = workspace.getApplicationAttempt(deps.db, attemptId);
  if (isHistoricalAttempt(attempt)) {
    return { kind: 'not_applicable', view: viewFor(deps, attempt, start) };
  }
  const verify = deps.verifyPosting;
  if (!verify) {
    return { kind: 'no_verifier', view: viewFor(deps, attempt, start) };
  }
  // A prepared-attempt check never races a run that is still working on the attempt: that run verifies itself.
  if (options.trigger === 'manual' && IN_FLIGHT_CHECKPOINTS.includes(attempt.checkpoint)) {
    return { kind: 'not_applicable', view: viewFor(deps, attempt, start) };
  }

  const latest = getLatestPostingVerification(deps.db, attemptId);
  const baselineHash = baselineHashOf(attempt);
  if (latest && !options.force && isPostingFresh(latest, start) && describesCurrentSnapshot(latest, baselineHash)) {
    return {
      kind: 'verified',
      view: viewFor(deps, attempt, start, { reused: true }),
      record: latest,
      requested: false,
      joined: false,
    };
  }

  const answered = getNewestDefinitivePostingVerification(deps.db, attemptId);
  const validatorSource = answered ?? latest;
  const validators =
    validatorSource && (validatorSource.etag || validatorSource.lastModified)
      ? { etag: validatorSource.etag ?? undefined, lastModified: validatorSource.lastModified ?? undefined }
      : null;
  const shared = sharedObservation(deps, verify, attemptId, attempt.canonicalUrl, validators);
  const observation = await shared.promise;
  if (options.isLive && !options.isLive()) {
    return { kind: 'dropped', view: viewFor(deps, workspace.getApplicationAttempt(deps.db, attemptId), nowOf(deps)) };
  }

  // The attempt can have moved while the request was out; compare against what it holds NOW.
  const fresh = workspace.getApplicationAttempt(deps.db, attemptId);
  const currentBaseline = baselineHashOf(fresh);
  const lastAnswer = getNewestDefinitivePostingVerification(deps.db, attemptId);
  const retainedText =
    observation.notModified && lastAnswer?.result === 'materially_changed' ? getPostingObservedText(deps.db, lastAnswer.id) : null;
  const verdict = judge(fresh, currentBaseline, observation, lastAnswer, retainedText);

  const stored = recordPostingVerification(deps.db, {
    attemptId,
    allowedCheckpoints: allowedCheckpointsFor(options.trigger),
    observedAt: new Date(observation.observedAt),
    source: observation.source,
    sourceRef: observation.sourceRef,
    outcome: observation.outcome,
    result: verdict.result,
    reason: observation.reason,
    httpStatus: observation.httpStatus,
    contentHash: verdict.contentHash,
    // A description filled in by this very check becomes the snapshot, so the finding is recorded
    // against it rather than against the empty text it replaces.
    baselineHash: verdict.fillDescription !== null && verdict.contentHash !== null ? verdict.contentHash : currentBaseline,
    deadline: verdict.deadline?.date ?? null,
    deadlineProvenance: verdict.deadline?.provenance ?? null,
    etag: observation.validators?.etag ?? null,
    lastModified: observation.validators?.lastModified ?? null,
    changeSummary: verdict.change,
    observedText: verdict.result === 'materially_changed' ? verdict.observedText : null,
    ...(options.trigger === 'manual' ? { hold: POSTING_HOLD } : {}),
  });
  if (stored.written === 'refused') {
    deps.log?.('a posting check finished after its attempt moved on; this caller recorded nothing', {
      attemptId,
      trigger: options.trigger,
    });
    return { kind: 'dropped', view: viewFor(deps, workspace.getApplicationAttempt(deps.db, attemptId), nowOf(deps)) };
  }

  // Filling a description the attempt did not have is the existing on-demand behaviour, now fed by
  // the verification request itself instead of a second one.
  if (options.trigger === 'prepare' && verdict.fillDescription !== null) {
    workspace.recordFetchedJobDescription(deps.db, attemptId, {
      jdSnapshot: verdict.fillDescription,
      jdSnapshotHash: sha256(verdict.fillDescription),
      jdComplete: true,
    });
  }

  const finalAttempt = workspace.getApplicationAttempt(deps.db, attemptId);
  return {
    kind: 'verified',
    view: viewFor(deps, finalAttempt, nowOf(deps), { hold: stored.hold }),
    record: stored.record,
    requested: true,
    joined: shared.joined,
  };
}

interface Verdict {
  result: PostingVerificationResult;
  contentHash: string | null;
  deadline: PostingObservation['deadline'];
  change: PostingChangeSummary | null;
  observedText: string | null;
  /** Complete live text to adopt because the attempt had none. */
  fillDescription: string | null;
}

function judge(
  attempt: ApplicationAttemptRecord,
  baselineHash: string,
  observation: PostingObservation,
  lastAnswer: PostingVerificationRecord | null,
  retainedText: string | null,
): Verdict {
  const base: Verdict = {
    result: 'unable_to_verify',
    contentHash: null,
    deadline: null,
    change: null,
    observedText: null,
    fillDescription: null,
  };
  if (observation.outcome === 'closed') return { ...base, result: 'confirmed_closed' };
  if (observation.outcome === 'unable') return base;

  // outcome === 'open'
  let contentHash = observation.contentHash;
  let deadline = observation.deadline;
  const text = observation.text;
  if (contentHash === null && observation.notModified && lastAnswer?.contentHash) {
    // The origin confirmed our stored validators: same content as the last time we read it.
    contentHash = lastAnswer.contentHash;
    deadline =
      lastAnswer.deadline && lastAnswer.deadlineProvenance
        ? { date: lastAnswer.deadline, provenance: lastAnswer.deadlineProvenance }
        : null;
  }
  if (contentHash === null) return { ...base, result: 'unable_to_verify' };
  const common = { contentHash, deadline };

  if (baselineHash === '') {
    // The attempt has no description at all (the scan carried none): the live text IS the description,
    // exactly what the on-demand fetch did before, not a "change". An incomplete-but-present snapshot
    // is deliberately NOT replaced here; it is compared like any other and a difference is shown first.
    return { ...base, ...common, result: 'confirmed_open', fillDescription: text };
  }
  if (contentHash === baselineHash) return { ...base, ...common, result: 'confirmed_open' };
  if (text === null) {
    // Validators say "unchanged since last read", and the last read was a change.
    if (lastAnswer?.result === 'materially_changed' && lastAnswer.contentHash === contentHash) {
      return { ...base, ...common, result: 'materially_changed', change: lastAnswer.changeSummary, observedText: retainedText };
    }
    return { ...base, ...common, result: 'confirmed_open' };
  }
  const comparison = comparePostingText(attempt.jdSnapshot, text);
  if (!comparison.material) return { ...base, ...common, result: 'confirmed_open' };
  return {
    ...base,
    ...common,
    result: 'materially_changed',
    change: {
      added: comparison.added,
      removed: comparison.removed,
      kind: comparison.requirementChange ? 'requirements' : 'text',
      ...(comparison.bounded ? { bounded: true } : {}),
    },
    observedText: text,
  };
}

/** Applies the person's decision about the current open finding (restoring a held package). */
export function resolvePostingFinding(
  deps: PostingVerificationDeps,
  attemptId: string,
  resolution: 'prepare_anyway' | 'keep_current',
): ResolvePostingVerificationOutcome | null {
  return resolvePostingVerification(deps.db, attemptId, resolution);
}

/**
 * Explicit refresh: adopts the changed posting as the attempt's description (unsubmitted, waiting
 * attempts only) and returns whether the caller may now restart preparation.
 */
export function refreshAttemptFromPosting(
  deps: PostingVerificationDeps,
  attemptId: string,
): { ok: true } | { ok: false; detail: string } {
  const adopted = adoptPostingChange(deps.db, attemptId);
  if (adopted.ok) return { ok: true };
  const detail: Record<typeof adopted.reason, string> = {
    not_found: 'this application no longer exists',
    historical: 'this application was already sent, so its documents are kept exactly as they were',
    not_waiting: 'this application is not waiting on a posting change',
    no_pending_change: 'there is no unreviewed posting change for this application',
    baseline_moved: 'the posting was refreshed more recently than this request; check it again first',
  };
  return { ok: false, detail: detail[adopted.reason] };
}
