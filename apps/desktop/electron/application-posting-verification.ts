import { createHash } from 'node:crypto';
import {
  comparePostingText,
  POSTING_FRESHNESS_WINDOW_MS,
  POSTING_UNABLE_RETRY_AFTER_MS,
  postingContentHash,
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
  getPostingObservedText,
  invalidatePreparedAttempt,
  isHistoricalAttempt,
  recordPostingVerification,
  resolvePostingVerification,
  type PostingVerificationRecord,
  type PostingVerificationResolution,
  type PostingVerificationResult,
} from './workspace/posting-verification-store.js';
import type { WorkspaceDb } from './workspace/client.js';
import type { ApplicationAttemptCheckpoint, ApplicationAttemptRecord } from './workspace/types.js';

/**
 * The single owner of #687: one bounded, authoritative check of an attempt's live posting, shared by
 * preparation, resumption and the explicit "check again" action (see `docs/posting-verification.md`).
 *
 * What it guarantees, and where each guarantee is enforced:
 *  - **One request for overlapping callers.** A prepare run, a resume and a renderer-triggered check
 *    for the same attempt share one in-flight promise (`inFlight`), so they cannot double-fetch or
 *    race two different verdicts into the store.
 *  - **Freshness without a request.** A stored finding younger than `POSTING_FRESHNESS_WINDOW_MS`
 *    (an "unable" one: `POSTING_UNABLE_RETRY_AFTER_MS`) is returned as it was observed, with its
 *    original `checkedAt`; nothing is fetched and nothing is rewritten.
 *  - **No silent overwrite.** This module never edits `jdSnapshot` (the one exception is filling a
 *    description that was missing or known incomplete, the behaviour the on-demand fetch already had).
 *    A changed posting is stored beside the snapshot and only `adoptPostingChange`, on the person's
 *    explicit refresh, replaces it.
 *  - **Historical attempts are untouchable.** Submitted / reported / skipped attempts are never
 *    verified (no request) and the store refuses to write for them.
 *  - **Interruption is safe.** The write re-reads the attempt in one transaction and requires the
 *    checkpoint the caller was entitled to write at; a cancelled, abandoned or moved-on attempt
 *    records nothing.
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

const PREPARED_CHECKPOINTS: readonly ApplicationAttemptCheckpoint[] = ['ready', 'needs_user', 'failed'];
const IN_FLIGHT_CHECKPOINTS: readonly ApplicationAttemptCheckpoint[] = [
  'queued',
  'reading_jd',
  'tailoring',
  'rendering',
  'filling',
];

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
): PostingVerificationAction[] {
  const waiting = attemptCheckpoint === 'needs_user' || attemptCheckpoint === 'failed';
  switch (status) {
    case 'not_applicable':
      return [];
    case 'confirmed_closed':
      return resolution === null && waiting
        ? ['open_posting', 'prepare_anyway', 'check_again']
        : ['open_posting', 'check_again'];
    case 'materially_changed':
      return resolution === null && waiting ? ['refresh', 'keep_current', 'open_posting'] : ['open_posting', 'check_again'];
    case 'unable_to_verify':
      return ['open_posting', 'check_again'];
    case 'confirmed_open':
    case 'not_checked':
      return ['check_again'];
  }
}

export function buildPostingVerificationView(
  attempt: ApplicationAttemptRecord,
  record: PostingVerificationRecord | null,
  now: Date,
  extra: { reused?: boolean; invalidated?: boolean } = {},
): PostingVerificationView {
  const historical = isHistoricalAttempt(attempt);
  const baselineHash = baselineHashOf(attempt);
  const current = record !== null && describesCurrentSnapshot(record, baselineHash) ? record : null;
  let status: PostingVerificationStatus = historical ? 'not_applicable' : 'not_checked';
  if (!historical && current !== null) {
    status =
      current.resolution === 'refreshed' && current.result === 'materially_changed' ? 'confirmed_open' : current.result;
  }
  // A stored finding about an older snapshot is history, not a statement about this one.
  const shown = historical ? null : current;
  const stale = shown === null || !isPostingFresh(shown, now);
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
    change: shown?.result === 'materially_changed' && shown.resolution !== 'refreshed' ? shown.changeSummary : null,
    resolution: shown?.resolution ?? null,
    reused: extra.reused ?? false,
    stale,
    invalidated: extra.invalidated ?? false,
    actions: actionsFor(status, shown?.resolution ?? null, attempt.checkpoint),
  };
}

/** Reads the stored finding for the renderer. Makes no request and writes nothing. */
export function readPostingVerification(deps: { db: WorkspaceDb; now?(): Date }, attemptId: string): PostingVerificationView {
  const attempt = workspace.getApplicationAttempt(deps.db, attemptId);
  return buildPostingVerificationView(attempt, getLatestPostingVerification(deps.db, attemptId), nowOf(deps));
}

export type VerifyTrigger = 'prepare' | 'manual';

export interface VerifyAttemptOptions {
  trigger: VerifyTrigger;
  /** Ignore a fresh stored finding (the explicit "Check again"). */
  force?: boolean;
  /** Evaluated after the network call: false means the caller lost its claim on the attempt. */
  isLive?: () => boolean;
}

export type VerifyAttemptResult =
  | { kind: 'verified'; view: PostingVerificationView; record: PostingVerificationRecord | null; requested: boolean }
  | { kind: 'not_applicable'; view: PostingVerificationView }
  | { kind: 'no_verifier'; view: PostingVerificationView }
  /** The caller lost the attempt while the check was in flight; nothing was written. */
  | { kind: 'dropped'; view: PostingVerificationView };

const inFlight = new Map<string, Promise<VerifyAttemptResult>>();

function allowedCheckpointsFor(trigger: VerifyTrigger): readonly ApplicationAttemptCheckpoint[] {
  return trigger === 'prepare' ? ['reading_jd'] : PREPARED_CHECKPOINTS;
}

/**
 * Verifies one attempt's posting. Overlapping calls for the same attempt share one request and one
 * result (the first caller's trigger decides which checkpoints may be written).
 */
export function verifyAttemptPosting(
  deps: PostingVerificationDeps,
  attemptId: string,
  options: VerifyAttemptOptions,
): Promise<VerifyAttemptResult> {
  const existing = inFlight.get(attemptId);
  if (existing) return existing;
  const run = verifyOnce(deps, attemptId, options).finally(() => {
    if (inFlight.get(attemptId) === run) inFlight.delete(attemptId);
  });
  inFlight.set(attemptId, run);
  return run;
}

async function verifyOnce(
  deps: PostingVerificationDeps,
  attemptId: string,
  options: VerifyAttemptOptions,
): Promise<VerifyAttemptResult> {
  const start = nowOf(deps);
  const attempt = workspace.getApplicationAttempt(deps.db, attemptId);
  const latest = getLatestPostingVerification(deps.db, attemptId);
  if (isHistoricalAttempt(attempt)) {
    return { kind: 'not_applicable', view: buildPostingVerificationView(attempt, latest, start) };
  }
  if (!deps.verifyPosting) {
    return { kind: 'no_verifier', view: buildPostingVerificationView(attempt, latest, start) };
  }
  // A prepared-attempt check never races a run that is still working on the attempt: that run verifies itself.
  if (options.trigger === 'manual' && IN_FLIGHT_CHECKPOINTS.includes(attempt.checkpoint)) {
    return { kind: 'not_applicable', view: buildPostingVerificationView(attempt, latest, start) };
  }

  const baselineHash = baselineHashOf(attempt);
  if (latest && !options.force && isPostingFresh(latest, start) && describesCurrentSnapshot(latest, baselineHash)) {
    return {
      kind: 'verified',
      view: buildPostingVerificationView(attempt, latest, start, { reused: true }),
      record: latest,
      requested: false,
    };
  }

  const observation = await deps.verifyPosting({
    url: attempt.canonicalUrl,
    validators: latest && (latest.etag || latest.lastModified)
      ? { etag: latest.etag ?? undefined, lastModified: latest.lastModified ?? undefined }
      : null,
  });
  if (options.isLive && !options.isLive()) {
    return { kind: 'dropped', view: buildPostingVerificationView(attempt, latest, nowOf(deps)) };
  }

  // The attempt can have moved while the request was out; compare against what it holds NOW.
  const fresh = workspace.getApplicationAttempt(deps.db, attemptId);
  const currentBaseline = baselineHashOf(fresh);
  const retainedText =
    observation.notModified && latest?.result === 'materially_changed' ? getPostingObservedText(deps.db, latest.id) : null;
  const verdict = judge(fresh, currentBaseline, observation, latest, retainedText);

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
  });
  if (stored.written === 'refused') {
    deps.log?.('a posting check finished after its attempt moved on; nothing was recorded', { attemptId });
    return { kind: 'dropped', view: buildPostingVerificationView(workspace.getApplicationAttempt(deps.db, attemptId), stored.record, nowOf(deps)) };
  }

  // Filling a description the attempt did not have (or knew was cut off) is the existing on-demand
  // behaviour, now fed by the verification request itself instead of a second one.
  if (options.trigger === 'prepare' && verdict.fillDescription !== null) {
    workspace.recordFetchedJobDescription(deps.db, attemptId, {
      jdSnapshot: verdict.fillDescription,
      jdSnapshotHash: sha256(verdict.fillDescription),
      jdComplete: true,
    });
  }

  let invalidated = false;
  if (options.trigger === 'manual' && verdict.result === 'materially_changed' && stored.record.resolution === null) {
    invalidated = invalidatePreparedAttempt(deps.db, attemptId, fresh.checkpoint, POSTING_CHANGED_DETAIL);
  }
  const finalAttempt = workspace.getApplicationAttempt(deps.db, attemptId);
  return {
    kind: 'verified',
    view: buildPostingVerificationView(finalAttempt, stored.record, nowOf(deps), { invalidated }),
    record: stored.record,
    requested: true,
  };
}

interface Verdict {
  result: PostingVerificationResult;
  contentHash: string | null;
  deadline: PostingObservation['deadline'];
  change: { added: string[]; removed: string[] } | null;
  observedText: string | null;
  /** Complete live text to adopt because the attempt had none / an incomplete one. */
  fillDescription: string | null;
}

function judge(
  attempt: ApplicationAttemptRecord,
  baselineHash: string,
  observation: PostingObservation,
  latest: PostingVerificationRecord | null,
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
  if (contentHash === null && observation.notModified && latest?.contentHash) {
    // The origin confirmed our stored validators: same content as the last time we read it.
    contentHash = latest.contentHash;
    deadline =
      latest.deadline && latest.deadlineProvenance
        ? { date: latest.deadline, provenance: latest.deadlineProvenance }
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
    // Validators say "unchanged since last read", and the last read was a pending change.
    if (latest?.result === 'materially_changed' && latest.contentHash === contentHash) {
      return { ...base, ...common, result: 'materially_changed', change: latest.changeSummary, observedText: retainedText };
    }
    return { ...base, ...common, result: 'confirmed_open' };
  }
  const comparison = comparePostingText(attempt.jdSnapshot, text);
  if (!comparison.material) return { ...base, ...common, result: 'confirmed_open' };
  return {
    ...base,
    ...common,
    result: 'materially_changed',
    change: { added: comparison.added, removed: comparison.removed },
    observedText: text,
  };
}

/** Applies the person's decision about the current finding, then returns the fresh view. */
export function resolvePostingFinding(
  deps: PostingVerificationDeps,
  attemptId: string,
  resolution: Extract<PostingVerificationResolution, 'prepare_anyway' | 'keep_current'>,
): PostingVerificationRecord | null {
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
