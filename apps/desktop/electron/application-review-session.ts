import { createHash } from 'node:crypto';
import {
  ApplicationExecutor,
  ExecutorPolicyError,
  classifyDelayedReceipt,
  isNavigationAllowed,
  resolveSubmitControl,
  validateFieldMap,
  type FormSnapshot,
  type ObservedResponse,
  type SubmissionOutcomeReport,
} from '@agent-dock/application-executor';
import { createApplicationView, type ApplicationView } from './application-view.js';
import { AcceptedBytesChangedError, readAcceptedArtifactBytes } from './document-readiness.js';
import { resolveApplicationTargetPolicy, resolvePolicyIdForCanonicalUrl } from './application-target-policies.js';
import { runPreSubmitGate, type PreSubmitGateRefusalReason } from './application-submit-gate.js';
import {
  checkAutomaticEligibility,
  checkRateLimits,
  type AutomaticEligibilityRefusalReason,
  type RateLimitRefusalReason,
} from './automatic-submission-guardrails.js';
import { extractPdfText } from './cv-text.js';
import { notifyAutomaticSubmission } from './automatic-submission-notify.js';
import * as workspace from './workspace/repository.js';
import { WorkspaceNotFoundError } from './workspace/repository.js';
import type { WorkspaceDb } from './workspace/client.js';
import type { ApplicationAttemptRecord, ApplicationSubmissionReceiptInput } from './workspace/types.js';
import type {
  ApplyApplicationFieldMapInput,
  ApplyApplicationFieldMapResult,
  OpenApplicationReviewInput,
  OpenApplicationReviewResult,
} from './application-executor-types.js';

/**
 * The main-process orchestration behind `window.applicationExecutor` (issue #201): owns the
 * per-attempt `{ view, executor }` registry so `main.ts`'s IPC handlers stay thin, and so this
 * module is reachable directly (no IPC) from a Node test.
 *
 * Deliberately Electron-adjacent, not Electron-free like `packages/application-executor` itself:
 * `createApplicationView` is real Electron. Kept in its own module rather than inlined into
 * `main.ts` for the same reason `application-queue-relay.ts` is its own file: a real unit test can
 * import it directly against a mocked `electron`, the same technique `application-view.test.ts`
 * already uses.
 */

interface ActiveReview {
  view: ApplicationView;
  executor: ApplicationExecutor;
  /** The URL this review was opened against -- the "destination" every submission receipt records
   * (#271). Kept from the open call rather than re-read from the live page: what a receipt has to
   * name is where this app deliberately sent the application, not wherever the page ended up. */
  targetUrl: string;
}

const activeReviews = new Map<string, ActiveReview>();

/** Attempt ids currently mid-`submitApplicationReview`. The manual (renderer IPC) and automatic
 * (timer tick) paths are otherwise entirely independent callers of the same function with no other
 * shared state -- this is what stops them (or two overlapping timer ticks) from both reaching
 * `executor.submit()` for the same attempt at once. */
const submittingAttemptIds = new Set<string>();

export async function openApplicationReview(input: OpenApplicationReviewInput): Promise<OpenApplicationReviewResult> {
  if (activeReviews.has(input.attemptId)) {
    throw new Error(`attempt ${input.attemptId} already has an open review`);
  }
  const policy = resolveApplicationTargetPolicy(input.policyId);
  if (!policy) {
    throw new Error(`unknown application target policy: ${input.policyId}`);
  }

  // The runtime half of #196 §1.1's "never a followed redirect" rule -- see `application-view.ts`'s
  // own doc comment on `createApplicationView` for why this can't live inside the executor package.
  const view = createApplicationView(
    input.attemptId,
    (url) => isNavigationAllowed(policy, url),
    (url) => console.warn('[application-executor] blocked an off-policy navigation', { attemptId: input.attemptId, policyId: policy.id, url }),
  );
  const executor = new ApplicationExecutor(view.transport, policy);
  activeReviews.set(input.attemptId, { view, executor, targetUrl: input.targetUrl });

  try {
    await executor.openTarget(input.targetUrl);
    const snapshot = await executor.snapshot();
    const screenshotBase64 = await executor.capture();
    return { snapshot, screenshotBase64 };
  } catch (err) {
    // A failed open leaves nothing for the caller to clean up -- release it here rather than
    // requiring a matching closeReview() the caller has no way to know it needs to make.
    activeReviews.delete(input.attemptId);
    view.destroy();
    throw err;
  }
}

export async function applyApplicationFieldMap(input: ApplyApplicationFieldMapInput): Promise<ApplyApplicationFieldMapResult> {
  const active = activeReviews.get(input.attemptId);
  if (!active) {
    throw new Error(`no open review for attempt ${input.attemptId}`);
  }
  const snapshot = active.executor.currentSnapshot;
  if (!snapshot) {
    throw new Error(`attempt ${input.attemptId} has no snapshot yet`);
  }

  const result = validateFieldMap({
    raw: input.fieldMap,
    attemptId: input.attemptId,
    snapshot,
    valueTable: input.valueTable,
    // Always empty: see this module's own doc comment and `ApplicationExecutorBridge.applyFieldMap`'s
    // -- artifact ownership resolution (#198) is not wired into this slice, so any `artifact`
    // assignment fails `validateFieldMap`'s rule 5 (`artifact_not_owned`) by construction, refusing
    // the whole map rather than silently dropping one field.
    ownedArtifactIds: [],
    allowJdProvenance: input.allowJdProvenance,
  });

  if (!result.ok || !result.fieldMap) {
    return { ok: false, reason: result.reason, detail: result.detail };
  }

  const valueByRef = new Map(input.valueTable.map((entry) => [entry.valueRef, entry.value]));
  let appliedCount = 0;
  for (const assignment of result.fieldMap.assignments) {
    if (assignment.source.kind === 'value') {
      const value = valueByRef.get(assignment.source.valueRef);
      if (value === undefined) throw new Error(`valueRef ${assignment.source.valueRef} vanished after validation`);
      await active.executor.fill(assignment.fieldRef, value);
      appliedCount += 1;
    } else if (assignment.source.kind === 'option') {
      await active.executor.select(assignment.fieldRef, assignment.source.optionRef);
      appliedCount += 1;
    }
    // 'artifact' is unreachable here (see above); 'skip' assigns nothing by definition.
  }

  return { ok: true, appliedCount };
}

export type SubmitApplicationReviewRefusalReason =
  | PreSubmitGateRefusalReason
  | 'no_open_review'
  | 'no_snapshot'
  | 'already_submitting'
  | 'already_submitted'
  | 'captcha_detected'
  | 'unresolved_submit_control'
  | 'source_cv_not_found'
  | 'artifact_read_failed'
  | 'artifact_bytes_changed'
  | 'submit_refused'
  /** The click landed, and the form (or the endpoint) answered by refusing it (#271). Distinct
   * from `submission_unknown`: this is a *known* non-delivery, and the attempt goes to
   * `needs_user` rather than being left ambiguous. */
  | 'submission_rejected'
  /** A previous submit on this attempt ended on `submission_unknown` and has not been reconciled.
   * Refused rather than retried: a blind second click risks a duplicate application on top of one
   * that may already have gone through (#271's third acceptance case). */
  | 'submission_outcome_unresolved'
  | 'submission_unknown';

export interface SubmitApplicationReviewResult {
  ok: boolean;
  reason?: SubmitApplicationReviewRefusalReason;
  detail?: string;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A deterministic fingerprint of a snapshot's own field structure -- label, control type, and
 * required-ness, sorted so field order (which can shift between snapshots of the same real page)
 * never changes the result. Never a value: this exists to detect when the *page itself* changed
 * since a human last reviewed it (#203 scope item 1), not to compare what was typed into it. */
function computeFormStructureHash(snapshot: FormSnapshot): string {
  // JSON-encode each field individually rather than joining raw strings with a `|` delimiter:
  // labels are unsanitized third-party page text and can themselves contain `|`, which let two
  // structurally different field sets serialize to the same string under naive concatenation.
  // JSON.stringify escapes quotes/backslashes and preserves array structure, so no field content
  // can be crafted to collide with a delimiter.
  const structure = snapshot.fields
    .map((field) => JSON.stringify([field.label, field.controlType, field.required]))
    .sort();
  return sha256(JSON.stringify(structure));
}

/**
 * The one function in this app that can produce a real, irreversible side effect (#202): runs the
 * pre-submit validation gate (`application-submit-gate.ts`) against freshly recomputed state, then
 * -- only if it passes -- clicks the real submit control. Never called by anything in this repo yet
 * except this module's own test and the real-fixture e2e path; the renderer-facing swipe review UI
 * and its IPC wiring are what will call this once built.
 *
 * Every check below runs, and the attempt's checkpoint is only ever moved to `submitting`,
 * immediately before the one call (`executor.submit`) that can actually reach the page:
 *
 * 1. A snapshot must exist and report no active CAPTCHA/challenge (`executor.submit` checks this
 *    too, but checking it here means a challenge refuses before the checkpoint ever changes).
 * 2. `resolveSubmitControl` must resolve exactly one candidate on the current snapshot -- the same
 *    resolution `executor.submit` re-derives and enforces internally; doing it here first means an
 *    ambiguous page refuses with a clear reason before any CDP call at all.
 * 3. The pre-submit gate: the *current* source CV (re-read live from the CV library by
 *    `attempt.sourceCvId`, never trusted from the value stored at attempt-creation time) and the
 *    JD snapshot's own hash must still match what the attempt recorded, and the rendered CV/letter
 *    PDFs (read fresh from disk, not cached, and only through #276's accepted-bytes check so a
 *    file edited since it was validated refuses rather than inheriting that verdict) must still
 *    address the right company/role and carry no placeholder text. A `sourceCvId` of `null` (the
 *    source CV was never a live library entry, or the attempt predates that link) has nothing live
 *    to re-check, so the hash the attempt was created with is compared against itself -- vacuously
 *    satisfied, not skipped.
 *
 * `ExecutorPolicyError` from the submit call itself (the policy disallows the action, or any other
 * pre-click refusal `executor.submit` performs) is treated as a clean, non-ambiguous refusal --
 * nothing reached the page, so the checkpoint reverts to `ready` rather than landing on
 * `submission_unknown`. Any other error (a real CDP/network failure once the click was actually
 * attempted) is genuinely ambiguous and lands on `submission_unknown`, per #202's own acceptance
 * criteria: "never silently retries or silently drops."
 *
 * 4. **The click is not the outcome (#271).** Until this slice, a click that returned was written
 *    down as `submitted` on the next line. It no longer is: `executor.observeSubmissionOutcome()`
 *    re-reads the page under a bounded budget and only a real receipt -- a confirmation the page
 *    was not already showing, a printed reference, or an application identifier in an observed
 *    response -- produces `submitted`, together with a durable evidence row naming the attempt,
 *    the destination, the timestamp and the evidence itself. A form that came back flagging errors
 *    produces `needs_user`; anything inconclusive produces the existing `submission_unknown`, which
 *    this function now also refuses to blindly re-click on a later call.
 */
export async function submitApplicationReview(
  db: WorkspaceDb,
  attemptId: string,
  mode: 'manual' | 'automatic' = 'manual',
): Promise<SubmitApplicationReviewResult> {
  const active = activeReviews.get(attemptId);
  if (!active) return { ok: false, reason: 'no_open_review', detail: `no open review for attempt ${attemptId}` };

  // Refuses a second concurrent call for the same attempt outright -- the manual (renderer IPC) and
  // automatic (timer tick) callers are otherwise unaware of each other, and two overlapping timer
  // ticks are possible too (see `fireDueAutomaticSubmissions`'s own doc comment). Checked and
  // reserved before anything else so neither caller can ever reach `executor.submit()` twice for
  // the same attempt at once.
  if (submittingAttemptIds.has(attemptId)) {
    return { ok: false, reason: 'already_submitting', detail: `attempt ${attemptId} is already mid-submit` };
  }
  submittingAttemptIds.add(attemptId);

  try {
    // Automatic mode re-reads the live page here rather than trusting whatever was snapshotted when
    // the review was opened (possibly minutes ago, across the whole cancel window) -- manual mode
    // keeps the existing cached snapshot, since a human is looking at the live view seconds before
    // approving.
    const snapshot = mode === 'automatic' ? await active.executor.snapshot() : active.executor.currentSnapshot;
    if (!snapshot) return { ok: false, reason: 'no_snapshot', detail: `attempt ${attemptId} has no snapshot yet` };
    if (snapshot.challengeDetected) {
      return { ok: false, reason: 'captcha_detected', detail: 'the current page has an active CAPTCHA/bot-detection challenge' };
    }

    const resolved = resolveSubmitControl(snapshot.submitControls);
    if (!resolved) {
      return { ok: false, reason: 'unresolved_submit_control', detail: 'could not unambiguously identify the submit control on the current page' };
    }

    const attempt = workspace.getApplicationAttempt(db, attemptId);
    if (attempt.checkpoint === 'submitted' || attempt.checkpoint === 'submitting' || attempt.checkpoint === 'user_reported') {
      return { ok: false, reason: 'already_submitted', detail: `attempt ${attemptId} already reached checkpoint "${attempt.checkpoint}"` };
    }
    // #271: an unresolved outcome is the one state where a retry is actively dangerous -- the
    // previous click may well have delivered, so clicking again risks a second real application at
    // the same employer. Resolving it takes either a delayed receipt (`reconcileSubmissionOutcome`)
    // or a person's own statement (`recordUserReportedSubmission`), never another blind click.
    if (attempt.checkpoint === 'submission_unknown') {
      return {
        ok: false,
        reason: 'submission_outcome_unresolved',
        detail: `attempt ${attemptId} has an unresolved earlier submission and will not be blindly retried`,
      };
    }

    let currentSourceCvContentHash = attempt.sourceCvContentHash;
    if (attempt.sourceCvId) {
      const cv = workspace.listCvDocuments(db).find((candidate) => candidate.id === attempt.sourceCvId);
      if (!cv) {
        return {
          ok: false,
          reason: 'source_cv_not_found',
          detail: `the source CV (${attempt.sourceCvId}) used for this attempt no longer exists in the library`,
        };
      }
      currentSourceCvContentHash = sha256(cv.text);
    }
    const currentJdSnapshotHash = sha256(attempt.jdSnapshot);

    const artifacts = workspace.listApplicationArtifacts(db, attemptId);
    const cvArtifact = artifacts.find((artifact) => artifact.kind === 'cv_pdf' || artifact.kind === 'combined_pdf');
    const letterArtifact = artifacts.find((artifact) => artifact.kind === 'cover_letter_pdf');
    let renderedCvText: string;
    let renderedLetterText: string | null;
    try {
      // #276: read through the accepted-bytes check, never a bare `readFile`. Each artifact row
      // carries the hash of the bytes the document acceptance contract actually passed; if what is
      // on disk no longer hashes to it, the earlier "validated" verdict describes a document that
      // no longer exists, and the attempt must not inherit it. Re-extracting text from whatever is
      // there now would agree with itself no matter what was swapped in.
      renderedCvText = cvArtifact ? await extractPdfText(new Uint8Array(await readAcceptedArtifactBytes(cvArtifact))) : '';
      renderedLetterText = letterArtifact ? await extractPdfText(new Uint8Array(await readAcceptedArtifactBytes(letterArtifact))) : null;
    } catch (err) {
      // Never let a missing/corrupted artifact throw out of this function: the automatic path's
      // caller treats a thrown error very differently from a returned refusal (see
      // `fireDueAutomaticSubmissions`), and only a returned refusal is guaranteed to notify the user.
      const detail = err instanceof Error ? err.message : String(err);
      if (err instanceof AcceptedBytesChangedError) return { ok: false, reason: 'artifact_bytes_changed', detail };
      return { ok: false, reason: 'artifact_read_failed', detail };
    }

    const gateResult = runPreSubmitGate({
      attempt: {
        company: attempt.company,
        role: attempt.role,
        sourceCvContentHash: attempt.sourceCvContentHash,
        jdSnapshotHash: attempt.jdSnapshotHash,
      },
      currentSourceCvContentHash,
      currentJdSnapshotHash,
      renderedCvText,
      renderedLetterText,
    });
    if (!gateResult.ok) {
      return { ok: false, reason: gateResult.reason, detail: gateResult.detail };
    }

    workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'submitting' });
    try {
      await active.executor.submit(resolved.controlRef);
    } catch (err) {
      if (err instanceof ExecutorPolicyError) {
        workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'ready', checkpointDetail: err.message });
        return { ok: false, reason: 'submit_refused', detail: err.message };
      }
      const detail = err instanceof Error ? err.message : String(err);
      workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'submission_unknown', checkpointDetail: detail });
      return { ok: false, reason: 'submission_unknown', detail };
    }

    // #271: the click landed. That is all it means. What actually happened is a separate question
    // with three honest answers, and only one of them is `submitted`.
    let report: SubmissionOutcomeReport;
    try {
      report = await active.executor.observeSubmissionOutcome();
    } catch (err) {
      // The observer itself failed (a policy refusal, a transport that is gone). The click already
      // happened, so this is ambiguous, never a success and never a clean refusal.
      report = {
        outcome: 'unknown',
        reason: 'observation_failed',
        detail: `the submission outcome could not be observed: ${err instanceof Error ? err.message : String(err)}`,
        observedAt: new Date().toISOString(),
      };
    }

    if (report.outcome === 'submitted') {
      recordSubmissionReceipt(db, {
        attemptId,
        outcome: 'submitted',
        source: 'page_observation',
        destination: active.targetUrl,
        evidenceKind: report.evidence.kind,
        evidenceReference: report.evidence.reference,
        detail: report.detail,
        observedAt: report.observedAt,
      });
      workspace.updateApplicationAttempt(db, attemptId, {
        checkpoint: 'submitted',
        submittedAt: report.observedAt,
        submissionMode: mode,
        formStructureHash: computeFormStructureHash(snapshot),
        // #275's completion evidence, and the one place in the app entitled to assert it. #275
        // landed this column with nothing able to write `receipt_confirmed` honestly, because the
        // observation that could justify it is #271's and did not exist yet. It does now: this
        // branch is reached only when `observeSubmissionOutcome()` returned `submitted`, which it
        // does only on a confirmation genuinely new since before the click, or a receipt
        // identifier. The receipt row written just above is the durable evidence; this column is
        // the same fact denormalized onto the attempt so #275's completed-application lookup is a
        // plain column read and does not have to join evidence to answer "has this been applied to?".
        completionEvidence: 'receipt_confirmed',
      });
      return { ok: true };
    }

    if (report.outcome === 'rejected') {
      recordSubmissionReceipt(db, {
        attemptId,
        outcome: 'rejected',
        source: 'page_observation',
        destination: active.targetUrl,
        evidenceKind: 'none',
        detail: report.detail,
        observedAt: report.observedAt,
      });
      // `needs_user`, not `failed`: the application still exists and is still fillable, it just has
      // something unresolved on it that a person has to look at. Not `ready` either -- that would
      // let the automatic path pick it straight back up and click again into the same refusal.
      workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'needs_user', checkpointDetail: report.detail });
      return { ok: false, reason: 'submission_rejected', detail: report.detail };
    }

    recordSubmissionReceipt(db, {
      attemptId,
      outcome: 'unknown',
      source: 'page_observation',
      destination: active.targetUrl,
      evidenceKind: 'none',
      detail: report.detail,
      observedAt: report.observedAt,
    });
    // `submittedAt` is set here too, matching `schema.ts`'s own comment on the column: it marks the
    // moment a real, possibly-irreversible submit action was attempted, which is exactly what
    // happened, regardless of whether it landed.
    workspace.updateApplicationAttempt(db, attemptId, {
      checkpoint: 'submission_unknown',
      checkpointDetail: report.detail,
      submittedAt: report.observedAt,
    });
    return { ok: false, reason: 'submission_unknown', detail: report.detail };
  } finally {
    submittingAttemptIds.delete(attemptId);
  }
}

/**
 * Writes one durable observation and never lets doing so break the submission path (#271). A
 * failed *evidence* write must not turn an established outcome into a thrown error the automatic
 * caller would treat as a crash -- the checkpoint update immediately after this call is what the
 * user-visible state depends on, and it has to happen either way.
 */
function recordSubmissionReceipt(db: WorkspaceDb, input: ApplicationSubmissionReceiptInput): void {
  try {
    workspace.createApplicationSubmissionReceipt(db, input);
  } catch (err) {
    console.warn('[application-executor] failed to record a submission receipt', {
      attemptId: input.attemptId,
      outcome: input.outcome,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export type RecordUserReportedSubmissionRefusalReason = 'already_observed' | 'attempt_not_found';

export interface RecordUserReportedSubmissionResult {
  ok: boolean;
  reason?: RecordUserReportedSubmissionRefusalReason;
  detail?: string;
}

/**
 * #271's fourth acceptance case: a person finished this application themselves (in the live view,
 * in another tab, by email) and says so.
 *
 * That lands on its own checkpoint, `user_reported`, and its own receipt outcome -- never on
 * `submitted`. The distinction is the entire point: `submitted` since #271 means "this app
 * observed a receipt", and a value that can also be produced by someone simply asserting it is a
 * value no one can rely on later.
 *
 * Just as importantly, nothing anywhere ever moves this state backwards on silence. There is no
 * code path that reads "no confirmation email arrived" as failure, here or in
 * `reconcileSubmissionOutcome` below, because the absence of a receipt is not evidence of
 * non-delivery any more than it is evidence of delivery.
 *
 * Refuses outright for an attempt that already has a machine-observed `submitted` outcome: a
 * person's statement must not overwrite real evidence in either direction.
 */
export function recordUserReportedSubmission(
  db: WorkspaceDb,
  attemptId: string,
  statement = '',
  now: string = new Date().toISOString(),
): RecordUserReportedSubmissionResult {
  let attempt: ApplicationAttemptRecord;
  try {
    attempt = workspace.getApplicationAttempt(db, attemptId);
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError) return { ok: false, reason: 'attempt_not_found', detail: err.message };
    throw err;
  }

  if (attempt.checkpoint === 'submitted') {
    return {
      ok: false,
      reason: 'already_observed',
      detail: `attempt ${attemptId} already has an observed submission receipt; a report cannot overwrite it`,
    };
  }

  const detail = statement.trim() || 'reported as applied by the user';
  workspace.createApplicationSubmissionReceipt(db, {
    attemptId,
    outcome: 'user_reported',
    source: 'user_reported',
    destination: activeReviews.get(attemptId)?.targetUrl ?? attempt.canonicalUrl,
    evidenceKind: 'user_statement',
    evidenceReference: detail,
    detail,
    observedAt: now,
  });
  workspace.updateApplicationAttempt(db, attemptId, {
    checkpoint: 'user_reported',
    checkpointDetail: detail,
    // #275's other completion-evidence value, written here for the same reason the observer writes
    // `receipt_confirmed`: this attempt is now a completed application to its requisition, and
    // #275's lookup must suppress a duplicate for it just as hard as for an observed one, while
    // still being able to say *which* kind of completion it was. Recording the checkpoint without
    // this would leave the lookup unable to tell a person's report from an unrecorded legacy row.
    completionEvidence: 'user_reported',
  });
  return { ok: true };
}

export type ReconcileSubmissionOutcomeRefusalReason =
  | 'attempt_not_found'
  | 'outcome_already_resolved'
  | 'no_delivery_evidence'
  | 'application_error_payload';

export interface ReconcileSubmissionOutcomeResult {
  ok: boolean;
  reason?: ReconcileSubmissionOutcomeRefusalReason;
  detail?: string;
}

/**
 * The delayed half of #271's fifth acceptance case: an acknowledgement that arrives after the
 * post-click observation window has already closed and the attempt is sitting on
 * `submission_unknown`.
 *
 * One direction only. This function can move an unresolved attempt to `submitted`, and it can do
 * nothing else: it never marks anything failed, never touches an attempt whose outcome is already
 * resolved (a `submitted`, `user_reported` or `needs_user` attempt is left exactly as it is), and
 * never accepts a transport-level success as delivery -- a `200 OK` carrying an application-error
 * payload is recorded as a rejection receipt and the checkpoint stays unresolved, because a late
 * error payload is evidence that *this* response was not a receipt, not proof that nothing was
 * ever delivered.
 *
 * `response` is supplied by whatever observed it; this module does not fetch anything, and the
 * executor package structurally cannot (its CDP allowlist denies the whole network domain).
 */
export function reconcileSubmissionOutcome(
  db: WorkspaceDb,
  attemptId: string,
  response: ObservedResponse,
  now: string = new Date().toISOString(),
): ReconcileSubmissionOutcomeResult {
  let attempt: ApplicationAttemptRecord;
  try {
    attempt = workspace.getApplicationAttempt(db, attemptId);
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError) return { ok: false, reason: 'attempt_not_found', detail: err.message };
    throw err;
  }

  if (attempt.checkpoint !== 'submission_unknown') {
    return {
      ok: false,
      reason: 'outcome_already_resolved',
      detail: `attempt ${attemptId} is at checkpoint "${attempt.checkpoint}", which reconciliation never overwrites`,
    };
  }

  const report = classifyDelayedReceipt(response, now);
  const destination = activeReviews.get(attemptId)?.targetUrl ?? attempt.canonicalUrl;

  if (report.outcome === 'submitted') {
    recordSubmissionReceipt(db, {
      attemptId,
      outcome: 'submitted',
      source: 'delayed_receipt',
      destination,
      evidenceKind: report.evidence.kind,
      evidenceReference: report.evidence.reference,
      detail: report.detail,
      observedAt: report.observedAt,
    });
    workspace.updateApplicationAttempt(db, attemptId, {
      checkpoint: 'submitted',
      checkpointDetail: report.detail,
      submittedAt: attempt.submittedAt ?? report.observedAt,
    });
    return { ok: true };
  }

  recordSubmissionReceipt(db, {
    attemptId,
    outcome: report.outcome === 'rejected' ? 'rejected' : 'unknown',
    source: 'delayed_receipt',
    destination,
    evidenceKind: 'none',
    detail: report.detail,
    observedAt: report.observedAt,
  });
  return {
    ok: false,
    reason: report.outcome === 'rejected' ? 'application_error_payload' : 'no_delivery_evidence',
    detail: report.detail,
  };
}

/** Real time between an attempt being cleared for automatic submission and the submit action
 * actually firing -- #203 scope item 4's cancel/undo window, the closest approximation to
 * reversibility this feature can offer. A person can cancel any time before it elapses. */
export const AUTOMATIC_SUBMIT_CANCEL_WINDOW_MS = 3 * 60 * 1000;

export type AutomaticSubmissionRefusalReason =
  | 'no_open_review'
  | 'no_snapshot'
  | 'already_submitted'
  | 'unresolved_policy'
  | 'not_eligible_for_automation'
  | 'no_active_grant'
  | 'schedule_expired'
  | RateLimitRefusalReason
  | AutomaticEligibilityRefusalReason;

export interface AutomaticSubmissionCheckResult {
  ok: boolean;
  reason?: AutomaticSubmissionRefusalReason;
  detail?: string;
}

function attemptsForPolicy(db: WorkspaceDb, policyId: string): ApplicationAttemptRecord[] {
  return workspace.listApplicationAttempts(db).filter((attempt) => resolvePolicyIdForCanonicalUrl(attempt.canonicalUrl) === policyId);
}

/**
 * Every guardrail #203 requires before an automatic submit may fire, evaluated fresh -- no
 * guardrail's result is ever cached or trusted from an earlier call, since this same check runs
 * once to *schedule* an automatic submit and again, independently, right before it actually fires
 * (state can change in the cancel window between the two: the grant could be revoked, a rate limit
 * could be hit by another attempt, an employer's form could change). Order matters only in that it
 * checks structurally-cheaper things first; every check is otherwise independent.
 */
async function checkAutomaticSubmissionEligibility(db: WorkspaceDb, attemptId: string, now: string): Promise<AutomaticSubmissionCheckResult> {
  const active = activeReviews.get(attemptId);
  if (!active) return { ok: false, reason: 'no_open_review' };

  const attempt = workspace.getApplicationAttempt(db, attemptId);
  // `submission_unknown` and `user_reported` are here alongside the two original states (#271): an
  // unresolved earlier submit may already have delivered, and a person who says they applied by
  // hand has not asked for a second, unattended application on top of it.
  if (
    attempt.checkpoint === 'submitted' ||
    attempt.checkpoint === 'submitting' ||
    attempt.checkpoint === 'submission_unknown' ||
    attempt.checkpoint === 'user_reported'
  ) {
    return { ok: false, reason: 'already_submitted' };
  }

  // Re-reads the live page rather than trusting whatever `active.executor.currentSnapshot` still
  // holds from whenever the review was opened -- the whole point of re-validating "from scratch" is
  // to catch drift on the real page (a new required field, a CAPTCHA appearing) during the cancel
  // window, not to re-derive the same stale in-memory object at both call sites.
  const snapshot = await active.executor.snapshot();

  const policyId = resolvePolicyIdForCanonicalUrl(attempt.canonicalUrl);
  if (!policyId) return { ok: false, reason: 'unresolved_policy' };
  const policy = resolveApplicationTargetPolicy(policyId);
  if (!policy || !policy.termsEligibleForAutomation) return { ok: false, reason: 'not_eligible_for_automation' };

  if (!workspace.findActiveAutomationGrant(db, policyId)) return { ok: false, reason: 'no_active_grant' };

  const attemptsForThisPolicy = attemptsForPolicy(db, policyId);

  const recentAutomaticSubmissions = attemptsForThisPolicy
    .filter((a): a is ApplicationAttemptRecord & { submittedAt: string } => a.submissionMode === 'automatic' && a.submittedAt !== null)
    .map((a) => ({ company: a.company, submittedAt: a.submittedAt }));
  const rateLimitResult = checkRateLimits({ rateLimits: policy.rateLimits, company: attempt.company, now, recentAutomaticSubmissions });
  if (!rateLimitResult.ok) return { ok: false, reason: rateLimitResult.reason, detail: rateLimitResult.detail };

  const priorSubmittedAttempts = attemptsForThisPolicy
    .filter((a): a is ApplicationAttemptRecord & { submittedAt: string } => a.checkpoint === 'submitted' && a.submittedAt !== null)
    .map((a) => ({ company: a.company, formStructureHash: a.formStructureHash, submittedAt: a.submittedAt }));
  const eligibilityResult = checkAutomaticEligibility({
    company: attempt.company,
    currentFormStructureHash: computeFormStructureHash(snapshot),
    priorSubmittedAttempts,
  });
  if (!eligibilityResult.ok) return { ok: false, reason: eligibilityResult.reason, detail: eligibilityResult.detail };

  return { ok: true };
}

export interface ScheduleAutomaticSubmissionResult extends AutomaticSubmissionCheckResult {
  /** ISO-8601. Present only when `ok` is true. */
  scheduledAutomaticSubmitAt?: string;
}

/** Runs every #203 guardrail and, only if all pass, queues the attempt for an automatic submit
 * `AUTOMATIC_SUBMIT_CANCEL_WINDOW_MS` from `now` -- never submits immediately, even when eligible. */
export async function evaluateAndScheduleAutomaticSubmission(
  db: WorkspaceDb,
  attemptId: string,
  now: string = new Date().toISOString(),
): Promise<ScheduleAutomaticSubmissionResult> {
  const check = await checkAutomaticSubmissionEligibility(db, attemptId, now);
  if (!check.ok) return check;

  const scheduledAutomaticSubmitAt = new Date(Date.parse(now) + AUTOMATIC_SUBMIT_CANCEL_WINDOW_MS).toISOString();
  workspace.updateApplicationAttempt(db, attemptId, { scheduledAutomaticSubmitAt });
  return { ok: true, scheduledAutomaticSubmitAt };
}

/** The one and only way to stop a scheduled automatic submit before it fires. Safe to call for an
 * attempt that was never scheduled at all, or that no longer exists (e.g. deleted concurrently) --
 * both are a plain, redundant no-op, never a thrown error, since this is the one code path a user
 * relies on to urgently stop an unwanted automatic submission. */
export function cancelScheduledAutomaticSubmission(db: WorkspaceDb, attemptId: string): void {
  try {
    workspace.updateApplicationAttempt(db, attemptId, { scheduledAutomaticSubmitAt: null });
  } catch (err) {
    if (err instanceof WorkspaceNotFoundError) return;
    throw err;
  }
}

export interface FiredAutomaticSubmission {
  attemptId: string;
  company: string;
  role: string;
  /** Either an automatic-submission guardrail refused (re-validated at fire time, so this can
   * differ from whatever passed at scheduling time), or it passed every guardrail and the result
   * is whatever `submitApplicationReview` itself returned. */
  result: { ok: boolean; reason?: AutomaticSubmissionRefusalReason | SubmitApplicationReviewRefusalReason; detail?: string };
}

/**
 * Finds every attempt whose cancel window has elapsed and, for each, re-validates every guardrail
 * from scratch before actually submitting -- never trusting the check that scheduled it, since real
 * time has passed and any of those guardrails could now refuse where they didn't before.
 * `scheduledAutomaticSubmitAt` is cleared unconditionally up front for each one: whatever happens
 * next -- a fresh refusal, or a real submit attempt -- this attempt is no longer "scheduled",
 * falling back to manual review rather than staying silently queued forever.
 *
 * Intended to be called on a periodic timer from `main.ts` (or driven directly by a test); this
 * function itself has no timer of its own; it only answers "what's due right now."
 */
export async function fireDueAutomaticSubmissions(db: WorkspaceDb, now: string = new Date().toISOString()): Promise<FiredAutomaticSubmission[]> {
  const nowMs = Date.parse(now);
  const due = workspace
    .listApplicationAttempts(db)
    .filter((attempt) => attempt.scheduledAutomaticSubmitAt !== null && Date.parse(attempt.scheduledAutomaticSubmitAt) <= nowMs);

  const fired: FiredAutomaticSubmission[] = [];
  for (const attempt of due) {
    // `scheduledAutomaticSubmitAt` is guaranteed non-null by the filter above.
    const scheduledAtMs = Date.parse(attempt.scheduledAutomaticSubmitAt as string);
    workspace.updateApplicationAttempt(db, attempt.id, { scheduledAutomaticSubmitAt: null });

    // A schedule found overdue by more than the cancel window itself means the app was not actually
    // running/awake for a real cancel window's worth of wall-clock time before this became due (the
    // machine slept, or the app was closed) -- firing immediately here would silently skip the one
    // real chance #203 promises the user to cancel. Refuse instead of firing; the attempt falls back
    // to manual review rather than being resubmitted for automatic mode on its own.
    const overdueMs = nowMs - scheduledAtMs;
    if (overdueMs > AUTOMATIC_SUBMIT_CANCEL_WINDOW_MS) {
      const result = {
        ok: false as const,
        reason: 'schedule_expired' as const,
        detail: `overdue by ${Math.round(overdueMs / 1000)}s -- the app may have been asleep or closed through the cancel window, so this was not fired without one`,
      };
      notifyAutomaticSubmission({ company: attempt.company, role: attempt.role, ok: false, detail: result.detail });
      fired.push({ attemptId: attempt.id, company: attempt.company, role: attempt.role, result });
      continue;
    }

    const revalidated = await checkAutomaticSubmissionEligibility(db, attempt.id, now);
    if (!revalidated.ok) {
      const result = { ok: false as const, reason: revalidated.reason, detail: revalidated.detail };
      notifyAutomaticSubmission({ company: attempt.company, role: attempt.role, ok: false, detail: result.detail ?? result.reason });
      fired.push({ attemptId: attempt.id, company: attempt.company, role: attempt.role, result });
      continue;
    }

    const result = await submitApplicationReview(db, attempt.id, 'automatic');
    notifyAutomaticSubmission({ company: attempt.company, role: attempt.role, ok: result.ok, detail: result.detail ?? result.reason });
    fired.push({ attemptId: attempt.id, company: attempt.company, role: attempt.role, result });
  }
  return fired;
}

export async function closeApplicationReview(attemptId: string): Promise<void> {
  const active = activeReviews.get(attemptId);
  if (!active) return;
  activeReviews.delete(attemptId);
  active.view.destroy();
}

/** Destroys every open review's view. Used on app shutdown (mirrors `killDaemon()`'s other
 * cleanup calls) so no isolated `WebContentsView`/CDP session outlives the app itself. */
export function closeAllApplicationReviews(): void {
  for (const { view } of activeReviews.values()) view.destroy();
  activeReviews.clear();
}
