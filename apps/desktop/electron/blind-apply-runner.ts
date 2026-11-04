import type { ApplicationTargetPolicy } from '@agent-dock/application-executor';
import { mapBlindApplyAnswers } from './blind-apply-answers.js';
import {
  evaluateBlindApplyCandidate,
  type BlindApplyCandidate,
  type BlindApplyCurrentFacts,
  type BlindApplyGateDecision,
  type BlindApplyLiveness,
} from './blind-apply-eligibility.js';
import type {
  BlindApplyAnswerInput,
  BlindApplyAnswerResult,
} from './blind-apply-types.js';
import {
  BLIND_APPLY_WORKFLOW_VERSION,
  CAPTCHA_STOP_DETAIL,
  type DeterministicFieldMapInput,
  type DeterministicFieldMapOutcome,
  type PipelineVacancy,
  type StartApplicationAttemptInput,
  type StartApplicationAttemptResult,
} from './application-pipeline.js';
import { POSTING_CLOSED_DETAIL, isPostingPreparationStopDetail } from './application-posting-verification.js';
import type { SubmitApplicationReviewResult } from './application-review-session.js';
import { deriveApplicationIdentity } from './workspace/application-identity.js';
import {
  BLIND_APPLY_STOPPABLE_STATES,
  BlindApplyDuplicateItemError,
  appendBlindApplyEvent,
  findBlindApplyAnswer,
  findIdentityBlockingBlindApplyItem,
  findManualApplicationDuplicate,
  getActiveBlindApplyAuthorization,
  getBlindApplyAuthorization,
  getBlindApplyItem,
  getBlindApplyItemByAttempt,
  insertBlindApplyItem,
  isBlindApplyAuthorizationActive,
  listBlindApplyItems,
  recordBlindApplyAnswerUsed,
  saveBlindApplyAnswer,
  scopedBlindAnswerKey,
  stopBlindApplyAuthorization,
  transitionBlindApplyItem,
  type BlindApplyAuthorizationRecord,
  type BlindApplyItemRecord,
  type BlindApplyItemState,
} from './workspace/blind-apply-store.js';
import type { BlindApplyGateEvidence } from './workspace/blind-apply-schema.js';
import * as workspace from './workspace/repository.js';
import { ApplicationAlreadyCompletedError } from './workspace/repository.js';
import type { WorkspaceDb } from './workspace/client.js';

/**
 * The Blind Apply runner (#722): one turn of `tick()` selects candidates, runs the gates, starts the
 * preparation of what passed, follows each item's attempt, and submits what is ready.
 *
 * Division of labour, deliberately narrow:
 *
 *  - The EXISTING pipeline prepares an attempt (documents, form) under the daemon's queue lease. This
 *    runner only starts attempts and then reads their checkpoints; it never prepares anything itself.
 *    The only change inside preparation is the attempt-keyed deterministic field mapper, which this
 *    module supplies (`createBlindApplyFieldMapper`).
 *  - The EXISTING `submitApplicationReview` makes the click, with every check it already makes. This
 *    runner adds exactly one thing there: the `beforeClick` boundary that a global Stop can still win.
 *  - An item's state is derived from its attempt's checkpoint plus Blind-only facts. The attempt is the
 *    source of truth for whether anything was sent; the item never overrides it.
 *
 * What it will never do: submit anything for an unsupported target, tailor anything for one, retry a
 * click, resubmit an item whose outcome is unknown, create a reapply, or act on an authorization that
 * has been stopped. There is no counter and no cap anywhere in it.
 */

// ------------------------------------------------------------------------------------- ports

export interface BlindApplyPipelinePort {
  /** One vacancy as this app's own discovery data records it, or undefined when it is gone. */
  resolveVacancy(vacancyKey: string): PipelineVacancy | undefined;
  start(input: StartApplicationAttemptInput): Promise<StartApplicationAttemptResult>;
  /** Re-runs preparation of an attempt that stopped on a blocker the person has since addressed. */
  resume(attemptId: string): Promise<{ ok: boolean; detail?: string }>;
  /** Prepares an attempt again from the top (its live page view was lost). */
  requeue(attemptId: string): Promise<void>;
  /** Cancels the attempt's entry in the daemon queue. Safe when there is none. */
  cancelQueue(attemptId: string): Promise<void>;
  /** Asks the preparation worker to take its next turn now. */
  kick(): void;
}

export interface BlindApplyReviewPort {
  hasLive(attemptId: string): boolean;
  close(attemptId: string): Promise<void>;
  submit(attemptId: string, beforeClick: () => boolean): Promise<SubmitApplicationReviewResult>;
}

export interface BlindApplyRunnerDeps {
  db: WorkspaceDb;
  now?(): Date;
  log?(message: string, meta?: Record<string, unknown>): void;
  /** Frontend, filter-passing rows from the latest results, already folded to gate inputs. */
  listCandidates(): BlindApplyCandidate[];
  loadCurrentFacts(): Promise<BlindApplyCurrentFacts>;
  resolvePolicy(url: string): ApplicationTargetPolicy | undefined;
  /** Pacing only (B6): the policy's minimum gap between two sends. It delays and never drops. */
  minIntervalMs(policyId: string): number;
  checkLiveness(candidate: BlindApplyCandidate): Promise<BlindApplyLiveness>;
  pipeline: BlindApplyPipelinePort;
  reviews: BlindApplyReviewPort;
}

export interface BlindApplyRunner {
  tick(): Promise<void>;
  stop(reason?: string): Promise<{ stopped: boolean; itemsStopped: number }>;
  answer(input: BlindApplyAnswerInput): Promise<BlindApplyAnswerResult>;
  /** Run once at startup, after the pipeline's own recovery. */
  recoverOnStartup(): Promise<void>;
}

// ------------------------------------------------------------------------------------ helpers

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The identity two postings of one role share: the receiving ATS's requisition where there is one. */
export function blindIdentityKey(candidate: Pick<BlindApplyCandidate, 'company' | 'applyUrl'>): string {
  const identity = deriveApplicationIdentity({ company: candidate.company, canonicalUrl: candidate.applyUrl });
  return `${identity.employerKey}|${identity.requisitionId ?? identity.canonicalUrlKey}`;
}

/** A plain sentence for a pre-click refusal. Never employer page text. */
function plainRefusal(reason: string | undefined): string {
  switch (reason) {
    case 'form_not_ready':
      return 'Not sent: the form was not complete when it was time to send it.';
    case 'unresolved_submit_control':
      return 'Not sent: the page did not show one clear Submit button.';
    case 'source_cv_not_found':
    case 'cv_changed':
      return 'Not sent: your CV changed after this was prepared.';
    case 'artifact_bytes_changed':
    case 'artifact_read_failed':
      return 'Not sent: a prepared document could not be verified.';
    case 'submit_refused':
      return 'Not sent: the page would not accept the click.';
    default:
      return 'Not sent: a safety check stopped it.';
  }
}

// ----------------------------------------------------------------------- the field mapper

/**
 * The deterministic field mapper the pipeline consults for Blind Apply attempts. It also records its
 * findings on the item, so a "needs one answer" or "needs you" state is durable the moment it is known.
 *
 * Fail-closed on every side: an attempt whose item is missing, not live, or under a stopped
 * authorization gets a refusal and nothing is typed into the form.
 */
export function createBlindApplyFieldMapper(deps: Pick<BlindApplyRunnerDeps, 'db' | 'now'>) {
  return (input: DeterministicFieldMapInput): DeterministicFieldMapOutcome => {
    const { db } = deps;
    const now = deps.now?.() ?? new Date();
    const item = getBlindApplyItemByAttempt(db, input.attempt.id);
    if (!item || (item.state !== 'preparing' && item.state !== 'needs_answer')) {
      return { ok: false, detail: 'Blind Apply paused: this application is not being handled by Blind Apply right now' };
    }
    if (!isBlindApplyAuthorizationActive(db, item.authorizationId)) {
      return { ok: false, detail: 'Blind Apply paused: Blind Apply was stopped' };
    }

    const mapping = mapBlindApplyAnswers({
      attemptId: input.attempt.id,
      snapshot: input.snapshot,
      valueTable: input.valueTable,
      artifacts: input.artifacts,
      findSavedAnswer: (key) => {
        const found = findBlindApplyAnswer(db, key) ?? findBlindApplyAnswer(db, scopedBlindAnswerKey(key, item.id));
        return found ? { id: found.id, answer: found.answer } : null;
      },
    });

    if (mapping.interventions.length > 0) {
      const first = mapping.interventions[0]!;
      transitionBlindApplyItem(
        db,
        item.id,
        ['preparing', 'needs_answer'],
        'needs_you',
        { intervention: first.kind, stateDetail: `Needs you: ${first.label}`, attemptId: input.attempt.id },
        { kind: 'prepare', detail: `needs you (${first.kind})` },
        now,
      );
      return { ok: false, detail: `Blind Apply paused: "${first.label}" needs you` };
    }

    if (mapping.missing.length > 0) {
      transitionBlindApplyItem(
        db,
        item.id,
        ['preparing', 'needs_answer'],
        'needs_answer',
        {
          missingFields: mapping.missing.map(({ fieldRef: _fieldRef, ...field }) => field),
          stateDetail: `Needs ${mapping.missing.length === 1 ? 'one answer' : `${mapping.missing.length} answers`}`,
        },
        { kind: 'prepare', detail: `needs ${mapping.missing.length} answer(s)` },
        now,
      );
      return { ok: false, detail: `Blind Apply paused: it needs ${mapping.missing.length === 1 ? 'one answer' : `${mapping.missing.length} answers`} from you` };
    }

    for (const use of mapping.uses) {
      if (use.answerId) recordBlindApplyAnswerUsed(db, use.answerId, now);
    }
    appendBlindApplyEvent(db, item.id, item.state, { kind: 'answer_used', answers: mapping.uses, detail: 'form filled from your saved details' }, now);
    return { ok: true, fieldMap: mapping.fieldMap, valueTable: mapping.valueTable };
  };
}

// ---------------------------------------------------------------------------------- the runner

export function createBlindApplyRunner(deps: BlindApplyRunnerDeps): BlindApplyRunner {
  const { db } = deps;
  const now = () => deps.now?.() ?? new Date();
  const log = (message: string, meta?: Record<string, unknown>) => deps.log?.(message, meta);

  /** Authorizations a Stop has been requested for. Read right before the click alongside the database. */
  const stopRequested = new Set<string>();
  /** Items whose submit this process is awaiting. Reconciliation leaves them to that call. */
  const submitsInFlight = new Set<string>();
  /** When each policy last had a click, for pacing. In memory only: pacing, not a limit. */
  const lastClickAt = new Map<string, number>();

  const isActive = (authorizationId: string): boolean =>
    !stopRequested.has(authorizationId) && isBlindApplyAuthorizationActive(db, authorizationId);

  function move(
    item: BlindApplyItemRecord,
    expected: readonly BlindApplyItemState[],
    to: BlindApplyItemState,
    patch: Parameters<typeof transitionBlindApplyItem>[4],
    event: Parameters<typeof transitionBlindApplyItem>[5],
  ): BlindApplyItemRecord | null {
    return transitionBlindApplyItem(db, item.id, expected, to, patch, event, now());
  }

  function isDuplicate(candidate: BlindApplyCandidate): boolean {
    if (
      workspace.findInFlightOrCompletedApplication(db, {
        company: candidate.company,
        canonicalUrl: candidate.applyUrl,
        vacancyKey: candidate.vacancyKey,
      })
    ) {
      return true;
    }
    if (findIdentityBlockingBlindApplyItem(db, blindIdentityKey(candidate))) return true;
    return findManualApplicationDuplicate(db, candidate.company, candidate.role) !== null;
  }

  // ----------------------------------------------------------------------- selection

  function recordDecision(
    auth: BlindApplyAuthorizationRecord,
    candidate: BlindApplyCandidate,
    decision: Exclude<BlindApplyGateDecision, { kind: 'paused' }>,
  ): void {
    const base = {
      authorizationId: auth.id,
      vacancyKey: candidate.vacancyKey,
      identityKey: blindIdentityKey(candidate),
      company: candidate.company,
      role: candidate.role,
      applyUrl: candidate.applyUrl,
      gateEvidence: decision.evidence,
    };
    try {
      if (decision.kind === 'skip') {
        insertBlindApplyItem(db, { ...base, policyId: decision.evidence.policyId, state: 'skipped', skipReason: decision.reason, stateDetail: decision.detail }, now());
      } else if (decision.kind === 'apply_yourself') {
        insertBlindApplyItem(db, { ...base, policyId: decision.evidence.policyId, state: 'apply_yourself', stateDetail: decision.detail }, now());
      } else {
        insertBlindApplyItem(db, { ...base, policyId: decision.policyId, state: 'queued', stateDetail: 'Waiting to start' }, now());
      }
    } catch (error) {
      if (!(error instanceof BlindApplyDuplicateItemError)) throw error;
      // Another item took this identity between the check and the write: this one is a duplicate.
      const evidence: BlindApplyGateEvidence = { ...decision.evidence, duplicateCheck: 'duplicate' };
      insertBlindApplyItem(
        db,
        { ...base, gateEvidence: evidence, policyId: null, state: 'skipped', skipReason: 'duplicate', stateDetail: 'You already applied or started this one' },
        now(),
      );
    }
  }

  async function selectCandidates(auth: BlindApplyAuthorizationRecord, current: BlindApplyCurrentFacts): Promise<void> {
    const seen = new Set(listBlindApplyItems(db, { authorizationId: auth.id }).map((item) => item.vacancyKey));
    for (const candidate of deps.listCandidates()) {
      if (seen.has(candidate.vacancyKey)) continue;
      if (!isActive(auth.id)) return;
      let decision: BlindApplyGateDecision;
      try {
        decision = await evaluateBlindApplyCandidate(candidate, {
          authorization: {
            active: true,
            roleFamilies: auth.roleFamilies,
            sourceCvContentHash: auth.sourceCvContentHash,
            profileVersion: auth.profileVersion,
          },
          current,
          resolvePolicy: deps.resolvePolicy,
          isDuplicate,
          checkLiveness: deps.checkLiveness,
        });
      } catch (error) {
        // A failed check is not evidence of anything: leave the vacancy for the next turn.
        log('a Blind Apply gate check failed; the vacancy will be looked at again', { vacancyKey: candidate.vacancyKey, error: describeError(error) });
        continue;
      }
      if (decision.kind === 'paused') return;
      // A Stop that landed while the posting check was out wins: nothing new is queued after it.
      if (!isActive(auth.id)) return;
      recordDecision(auth, candidate, decision);
      seen.add(candidate.vacancyKey);
    }
  }

  // ------------------------------------------------------------------------- starting

  async function startItem(auth: BlindApplyAuthorizationRecord, item: BlindApplyItemRecord): Promise<void> {
    const vacancy = deps.pipeline.resolveVacancy(item.vacancyKey);
    if (!vacancy) {
      move(item, ['queued'], 'could_not_submit', { stateDetail: 'This role is no longer in your latest results' }, { kind: 'prepare', detail: 'vacancy no longer available' });
      return;
    }
    if (!isActive(auth.id)) return;

    let result: StartApplicationAttemptResult;
    try {
      result = await deps.pipeline.start({ vacancy, workflowVersion: BLIND_APPLY_WORKFLOW_VERSION });
    } catch (error) {
      if (error instanceof ApplicationAlreadyCompletedError) {
        move(item, ['queued'], 'skipped', { skipReason: 'duplicate', stateDetail: 'You already applied or started this one' }, { kind: 'gate', detail: 'already applied (attempt guard)' });
        return;
      }
      log('Blind Apply could not start an application', { itemId: item.id, error: describeError(error) });
      move(item, ['queued'], 'could_not_submit', { stateDetail: 'Could not start this application' }, { kind: 'prepare', detail: describeError(error) });
      return;
    }

    if (!result.ok) {
      if (result.reason === 'attempt_already_in_progress') {
        move(item, ['queued'], 'skipped', { skipReason: 'duplicate', stateDetail: 'You already applied or started this one' }, { kind: 'gate', detail: 'already in progress (attempt guard)' });
      } else {
        move(item, ['queued'], 'could_not_submit', { stateDetail: result.detail ?? 'Could not start this application' }, { kind: 'prepare', detail: result.reason ?? 'refused' });
      }
      return;
    }

    const attemptId = result.attemptId;
    const moved = move(item, ['queued'], 'preparing', { attemptId, stateDetail: 'Preparing' }, { kind: 'prepare', detail: 'preparation started' });
    if (!moved && attemptId) {
      // A Stop took the item while the attempt was being created: cancel what was just queued.
      await deps.pipeline.cancelQueue(attemptId).catch((error: unknown) => log('could not cancel an attempt started during Stop', { attemptId, error: describeError(error) }));
      return;
    }
    deps.pipeline.kick();
  }

  // ---------------------------------------------------------------------- reconciling

  function documentHashes(attemptId: string): { cv: string | null; letter: string | null } {
    const artifacts = workspace.listApplicationArtifacts(db, attemptId);
    const cv = artifacts.find((artifact) => artifact.kind === 'cv_pdf' || artifact.kind === 'combined_pdf');
    const letter = artifacts.find((artifact) => artifact.kind === 'cover_letter_pdf');
    return { cv: cv?.contentHash ?? null, letter: letter?.contentHash ?? null };
  }

  async function reconcilePreparing(item: BlindApplyItemRecord): Promise<void> {
    if (!item.attemptId) return;
    const attempt = workspace.getApplicationAttempt(db, item.attemptId);
    switch (attempt.checkpoint) {
      case 'ready': {
        const hashes = documentHashes(attempt.id);
        move(item, ['preparing'], 'ready', { stateDetail: 'Prepared; sending' }, { kind: 'prepare', detail: 'ready to send', cvArtifactHash: hashes.cv, letterArtifactHash: hashes.letter });
        return;
      }
      case 'needs_user': {
        // The field mapper records its own needs-an-answer / needs-you states before this is reached.
        if (attempt.checkpointDetail === CAPTCHA_STOP_DETAIL) {
          move(item, ['preparing'], 'needs_you', { intervention: 'captcha', stateDetail: 'This page shows a bot check' }, { kind: 'prepare', detail: 'bot check detected' });
        } else if (isPostingPreparationStopDetail(attempt.checkpointDetail)) {
          const closed = attempt.checkpointDetail === POSTING_CLOSED_DETAIL;
          move(
            item,
            ['preparing'],
            'skipped',
            { skipReason: closed ? 'closed' : 'unverifiable_posting', stateDetail: closed ? 'This posting is closed' : 'This posting could not be confirmed open' },
            { kind: 'gate', detail: attempt.checkpointDetail },
          );
        } else {
          move(item, ['preparing'], 'could_not_submit', { stateDetail: 'Could not prepare this application' }, { kind: 'prepare', detail: attempt.checkpointDetail });
        }
        return;
      }
      case 'failed': {
        if (item.prepRetries < 1) {
          const resumed = await deps.pipeline.resume(attempt.id);
          if (resumed.ok) {
            move(item, ['preparing'], 'preparing', { prepRetries: item.prepRetries + 1, stateDetail: 'Preparing again' }, { kind: 'prepare', detail: 'one automatic retry after a failed preparation' });
            deps.pipeline.kick();
            return;
          }
        }
        move(item, ['preparing'], 'could_not_submit', { stateDetail: 'Could not prepare this application' }, { kind: 'prepare', detail: attempt.checkpointDetail });
        return;
      }
      case 'skipped':
        move(item, ['preparing'], 'stopped', { stateDetail: 'Cancelled before it was sent' }, { kind: 'stop', detail: attempt.checkpointDetail });
        return;
      case 'submitted':
      case 'submission_unknown':
      case 'user_reported':
        settleFromAttempt(item, ['preparing'], attempt);
        return;
      default:
        // queued, reading_jd, tailoring, rendering, filling, submitting: preparation (or a submit) is under way.
        return;
    }
  }

  function latestSubmittedReceiptId(attemptId: string): string | null {
    const receipts = workspace.listApplicationSubmissionReceipts(db, attemptId);
    return receipts.filter((receipt) => receipt.outcome === 'submitted').at(-1)?.id ?? null;
  }

  /** Brings an item in line with an attempt that already reached a submit-side checkpoint. */
  function settleFromAttempt(
    item: BlindApplyItemRecord,
    expected: readonly BlindApplyItemState[],
    attempt: ReturnType<typeof workspace.getApplicationAttempt>,
  ): void {
    if (attempt.checkpoint === 'submitted') {
      move(item, expected, 'submitted', { stateDetail: 'Submitted' }, { kind: 'receipt', detail: 'receipt observed', receiptId: latestSubmittedReceiptId(attempt.id) });
    } else if (attempt.checkpoint === 'user_reported') {
      move(item, expected, 'outcome_unknown', { stateDetail: 'You said you applied; no receipt was seen' }, { kind: 'user_action', detail: 'reported by you' });
    } else if (attempt.checkpoint === 'submission_unknown') {
      move(item, expected, 'outcome_unknown', { stateDetail: "Sent? Couldn't confirm" }, { kind: 'recover', detail: attempt.checkpointDetail });
    } else if (attempt.checkpoint === 'needs_user') {
      move(item, expected, 'could_not_submit', { stateDetail: 'The site did not accept it' }, { kind: 'receipt', detail: attempt.checkpointDetail });
    }
  }

  // ------------------------------------------------------------------------ submitting

  async function submitItem(auth: BlindApplyAuthorizationRecord, item: BlindApplyItemRecord): Promise<void> {
    if (!item.attemptId || submitsInFlight.has(item.id)) return;
    const attempt = workspace.getApplicationAttempt(db, item.attemptId);
    if (attempt.checkpoint !== 'ready') return;

    // The page view does not survive a restart. Prepare again rather than send into nothing.
    if (!deps.reviews.hasLive(attempt.id)) {
      const moved = move(item, ['ready'], 'preparing', { stateDetail: 'Preparing again after a restart' }, { kind: 'recover', detail: 'the page view was closed; preparing again' });
      if (moved) {
        await deps.pipeline.requeue(attempt.id);
        deps.pipeline.kick();
      }
      return;
    }

    const policyId = item.policyId;
    const wait = policyId ? deps.minIntervalMs(policyId) : 0;
    const last = policyId ? lastClickAt.get(policyId) : undefined;
    if (wait > 0 && last !== undefined && now().getTime() - last < wait) return; // pacing: later, never dropped

    submitsInFlight.add(item.id);
    let result: SubmitApplicationReviewResult;
    try {
      result = await deps.reviews.submit(attempt.id, () => {
        // The stop boundary. Synchronous, evaluated after every pre-click check and immediately before
        // the checkpoint is written. The database is the authority; the in-memory flag only adds speed.
        if (!isActive(auth.id)) return false;
        const sending = move(item, ['ready'], 'submitting', { stateDetail: 'Sending' }, { kind: 'submit_click', detail: 'about to send' });
        if (!sending) return false;
        if (policyId) lastClickAt.set(policyId, now().getTime());
        return true;
      });
    } catch (error) {
      // Anything thrown here is ambiguous if the click was reached; the attempt's checkpoint decides.
      log('a Blind Apply submit call threw', { itemId: item.id, error: describeError(error) });
      submitsInFlight.delete(item.id);
      return;
    }
    submitsInFlight.delete(item.id);

    const fresh = getBlindApplyItem(db, item.id);
    if (!fresh) return;
    const current = workspace.getApplicationAttempt(db, attempt.id);

    if (result.ok) {
      move(fresh, ['submitting'], 'submitted', { stateDetail: 'Submitted' }, { kind: 'receipt', detail: 'receipt observed', receiptId: latestSubmittedReceiptId(attempt.id) });
      await deps.reviews.close(attempt.id).catch(() => {});
      return;
    }

    switch (result.reason) {
      case 'stopped':
        move(fresh, ['ready'], 'stopped', { stateDetail: 'Stopped before it was sent' }, { kind: 'stop', detail: 'stopped at the last moment' });
        return;
      case 'already_submitting':
      case 'handoff_in_progress':
        return; // try again next turn
      case 'no_open_review':
        move(fresh, ['ready'], 'preparing', { stateDetail: 'Preparing again' }, { kind: 'recover', detail: 'no live page' });
        await deps.pipeline.requeue(attempt.id);
        deps.pipeline.kick();
        return;
      case 'captcha_detected':
        move(fresh, ['ready'], 'needs_you', { intervention: 'captcha', stateDetail: 'This page shows a bot check' }, { kind: 'submit_click', detail: 'bot check before sending' });
        return;
      case 'submission_unknown':
        move(fresh, ['submitting'], 'outcome_unknown', { stateDetail: "Sent? Couldn't confirm" }, { kind: 'receipt', detail: result.detail ?? current.checkpointDetail });
        await deps.reviews.close(attempt.id).catch(() => {});
        return;
      case 'submission_rejected':
        move(fresh, ['submitting'], 'could_not_submit', { stateDetail: 'The site did not accept it' }, { kind: 'receipt', detail: result.detail ?? '' });
        return;
      case 'submit_refused':
        move(fresh, ['submitting'], 'could_not_submit', { stateDetail: plainRefusal(result.reason) }, { kind: 'submit_click', detail: result.detail ?? '' });
        return;
      default:
        // A refusal before anything was sent: the attempt stays `ready` and untouched.
        move(fresh, ['ready'], 'could_not_submit', { stateDetail: plainRefusal(result.reason) }, { kind: 'submit_click', detail: `${result.reason ?? 'refused'}: ${result.detail ?? ''}` });
        return;
    }
  }

  /** An item left at `submitting` by a process that is gone: the attempt already says what happened. */
  function reconcileSubmitting(item: BlindApplyItemRecord): void {
    if (!item.attemptId || submitsInFlight.has(item.id)) return;
    const attempt = workspace.getApplicationAttempt(db, item.attemptId);
    if (attempt.checkpoint === 'submitting') return; // still genuinely in flight elsewhere
    settleFromAttempt(item, ['submitting'], attempt);
    // A `ready` attempt here means the click was refused before landing: it never went out.
    if (attempt.checkpoint === 'ready') {
      move(item, ['submitting'], 'could_not_submit', { stateDetail: 'Not sent: the page would not accept the click' }, { kind: 'recover', detail: 'the click was refused' });
    }
  }

  // -------------------------------------------------------------------------------- tick

  async function tick(): Promise<void> {
    const auth = getActiveBlindApplyAuthorization(db);
    if (!auth || stopRequested.has(auth.id)) return;

    let current: BlindApplyCurrentFacts;
    try {
      current = await deps.loadCurrentFacts();
    } catch (error) {
      log('Blind Apply could not read your CV and profile; pausing this turn', { error: describeError(error) });
      return;
    }
    const paused =
      current.cvContentHash === null ||
      current.cvContentHash !== auth.sourceCvContentHash ||
      current.profileVersion !== auth.profileVersion;

    if (!paused) await selectCandidates(auth, current);

    for (const item of listBlindApplyItems(db, { authorizationId: auth.id, states: ['submitting'] })) reconcileSubmitting(item);
    for (const item of listBlindApplyItems(db, { authorizationId: auth.id, states: ['preparing'] })) {
      try {
        await reconcilePreparing(item);
      } catch (error) {
        log('Blind Apply could not follow an application', { itemId: item.id, error: describeError(error) });
      }
    }
    if (paused) return; // "no new submissions" while the CV or profile is unconfirmed

    for (const item of listBlindApplyItems(db, { authorizationId: auth.id, states: ['queued'] })) {
      if (!item.attemptId && isActive(auth.id)) await startItem(auth, item);
    }
    // Oldest first, one at a time: serial sending is the natural pace.
    const ready = listBlindApplyItems(db, { authorizationId: auth.id, states: ['ready'] }).reverse();
    for (const item of ready) {
      if (!isActive(auth.id)) break;
      try {
        await submitItem(auth, item);
      } catch (error) {
        log('Blind Apply could not send an application', { itemId: item.id, error: describeError(error) });
      }
    }
  }

  // -------------------------------------------------------------------------------- stop

  async function stop(reason = 'you pressed Stop'): Promise<{ stopped: boolean; itemsStopped: number }> {
    const auth = getActiveBlindApplyAuthorization(db);
    if (!auth) return { stopped: false, itemsStopped: 0 };

    // 1 + 2: the database write and the in-memory flag, with no await between them and the item moves,
    // so by the time anything else can run, nothing new can be started and nothing unsent can be clicked.
    stopBlindApplyAuthorization(db, auth.id, reason, now());
    stopRequested.add(auth.id);

    // 3: every item whose click has not happened yet becomes `stopped`. An item at `submitting` is past
    // the boundary and is never touched; completed items and receipts are never written to.
    const moved: BlindApplyItemRecord[] = [];
    for (const item of listBlindApplyItems(db, { authorizationId: auth.id, states: BLIND_APPLY_STOPPABLE_STATES })) {
      const done = move(item, [item.state], 'stopped', { stateDetail: 'Stopped by you' }, { kind: 'stop', detail: reason });
      if (done) moved.push(item);
    }

    // 4: cancel what is still queued or preparing and close its page. An item waiting on the person keeps
    // its page: they may be using it right now, and the attempt keeps its checkpoint for the reviewed flow.
    for (const item of moved) {
      if (!item.attemptId) continue;
      if (item.state === 'needs_answer' || item.state === 'needs_you') continue;
      await deps.pipeline.cancelQueue(item.attemptId).catch((error: unknown) => log('could not cancel a queue entry during Stop', { itemId: item.id, error: describeError(error) }));
      await deps.reviews.close(item.attemptId).catch((error: unknown) => log('could not close a page during Stop', { itemId: item.id, error: describeError(error) }));
    }
    return { stopped: true, itemsStopped: moved.length };
  }

  // ------------------------------------------------------------------------------ answer

  async function answer(input: BlindApplyAnswerInput): Promise<BlindApplyAnswerResult> {
    const item = getBlindApplyItem(db, input.itemId);
    if (!item || item.state !== 'needs_answer' || !item.attemptId) return { ok: false, reason: 'not_waiting' };
    if (!isActive(item.authorizationId)) return { ok: false, reason: 'stopped' };
    const missing = item.missingFields ?? [];

    const resolved: Array<{ field: (typeof missing)[number]; answer: string }> = [];
    for (const field of missing) {
      const given = input.answers.find((entry) => entry.label === field.label)?.answer.trim() ?? '';
      if (given === '') return { ok: false, reason: 'incomplete' };
      if (field.controlType === 'select' && !(field.options ?? []).includes(given)) return { ok: false, reason: 'invalid_option' };
      resolved.push({ field, answer: given });
    }

    // Saved before preparation is asked to run again, so the mapper can never run ahead of its answers.
    for (const { field, answer: given } of resolved) {
      saveBlindApplyAnswer(
        db,
        { label: field.label, controlType: field.controlType, answer: given, optionSetHash: field.controlType === 'select' ? (field.optionSetHash ?? null) : null },
        now(),
        input.remember ? undefined : item.id,
      );
    }
    const resumed = await deps.pipeline.resume(item.attemptId);
    if (!resumed.ok) return { ok: false, reason: 'not_waiting' };
    move(item, ['needs_answer'], 'preparing', { stateDetail: 'Preparing with your answer' }, { kind: 'user_action', detail: input.remember ? 'answered; remembered for Blind Apply' : 'answered for this form only' });
    deps.pipeline.kick();
    return { ok: true };
  }

  // --------------------------------------------------------------------------- recovery

  async function recoverOnStartup(): Promise<void> {
    // Anything still live under an authorization that was stopped (a crash mid-Stop) is stopped now.
    // Nothing resumes under a stopped authorization.
    for (const item of listBlindApplyItems(db, { states: BLIND_APPLY_STOPPABLE_STATES })) {
      const auth = getBlindApplyAuthorization(db, item.authorizationId);
      if (auth && auth.stoppedAt !== null) {
        move(item, [item.state], 'stopped', { stateDetail: 'Stopped by you' }, { kind: 'recover', detail: 'stopped before the app closed' });
      }
    }
    const active = getActiveBlindApplyAuthorization(db);
    if (!active) return;

    // The pipeline's own recovery has already turned a mid-submit attempt into `submission_unknown`
    // (never re-sent); bring the matching items in line.
    for (const item of listBlindApplyItems(db, { authorizationId: active.id, states: ['submitting'] })) reconcileSubmitting(item);

    // A `ready` item lost its page with the process. Prepare it again; never send into nothing.
    for (const item of listBlindApplyItems(db, { authorizationId: active.id, states: ['ready'] })) {
      if (!item.attemptId || deps.reviews.hasLive(item.attemptId)) continue;
      const moved = move(item, ['ready'], 'preparing', { stateDetail: 'Resumed after restart' }, { kind: 'recover', detail: 'resumed after a restart' });
      if (moved) await deps.pipeline.requeue(item.attemptId);
    }
    deps.pipeline.kick();
  }

  return { tick, stop, answer, recoverOnStartup };
}
