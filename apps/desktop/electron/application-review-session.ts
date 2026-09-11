import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { BrowserWindow } from 'electron';
import {
  ApplicationExecutor,
  ExecutorPolicyError,
  isActionAllowed,
  isNavigationAllowed,
  resolveSubmitControl,
  validateFieldMap,
  type ApplicationTargetPolicy,
  type FormSnapshot,
} from '@agent-dock/application-executor';
import { listOwnedArtifactIds, resolveUploadArtifact, type UploadReadyArtifact } from './application-artifact-upload.js';
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
import type { ApplicationAttemptRecord } from './workspace/types.js';
import type {
  ApplicationAttachmentResult,
  ApplyApplicationFieldMapInput,
  ApplyApplicationFieldMapResult,
  OpenApplicationReviewInput,
  OpenApplicationReviewResult,
} from './application-executor-types.js';

/**
 * The main-process orchestration behind `window.applicationExecutor` (issue #201): owns the
 * per-attempt `{ view, executor, policy }` registry so `main.ts`'s IPC handlers stay thin, and so
 * this module is reachable directly (no IPC) from a Node test.
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
  /** The same compiled policy the executor was constructed with. Kept here too so the artifact
   * resolution in `applyApplicationFieldMap` can check a candidate upload against this target's own
   * constraints *before* calling `attach`, without re-resolving a policy id and risking the two
   * halves disagreeing about which policy this review is running under. */
  policy: ApplicationTargetPolicy;
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
  activeReviews.set(input.attemptId, { view, executor, policy });

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

/** How much of a page-reported file name is ever echoed back to the renderer. The string comes off
 * the target page, so it is third-party text however plausible it looks -- bounded here for the
 * same reason `maximumSnapshotBytes` bounds a snapshot. */
const MAX_REPORTED_ATTACHMENT_NAME_LENGTH = 200;

interface PlannedAttachment {
  fieldRef: string;
  file: UploadReadyArtifact;
}

/**
 * Validates `fieldMap` and applies it (#196 §2.4, #201), now including its `artifact` (file-upload)
 * assignments (#273).
 *
 * The artifact half runs in three deliberate phases rather than one pass:
 *
 * 1. **Resolve, before anything is applied.** Every `artifact` assignment is resolved against this
 *    attempt's own registered artifacts and re-verified (`application-artifact-upload.ts`) --
 *    ownership, staging location, the target's upload constraints, and a full re-hash of the bytes
 *    currently on disk. Any failure refuses the whole call here, with nothing typed into the page
 *    and nothing uploaded. That ordering is the point: a wrong-attempt, changed, missing, oversized
 *    or wrong-type file must be refused *before* upload, not discovered halfway through one.
 * 2. **Fill and select**, exactly as before.
 * 3. **Attach, then read the control back.** `attach` is followed by
 *    `readBackAttachment(fieldRef)`, and the call only succeeds if the browser itself reports the
 *    staged file on that control. Nothing here is fire-and-forget: an attachment that cannot be
 *    confirmed refuses with `attachment_unconfirmed` rather than being reported as applied.
 *
 * A retry is safe and is never ambient: phase 1 resolves the artifact id to the one path recorded
 * for it under this attempt's own staging folder, and `DOM.setFileInputFiles` *replaces* a file
 * input's selection rather than appending to it, so running this twice sets exactly the same
 * intended file both times. No part of this path opens a native file picker, reads a directory, or
 * looks at anything outside that one registered path.
 *
 * `db` is a parameter rather than something this module resolves for itself, the same shape
 * `submitApplicationReview` already has: it keeps this function directly callable from a test
 * against an in-memory workspace, and keeps the "who owns the database handle" answer in `main.ts`.
 */
export async function applyApplicationFieldMap(
  db: WorkspaceDb,
  input: ApplyApplicationFieldMapInput,
): Promise<ApplyApplicationFieldMapResult> {
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
    // #198's real artifact records, scoped in SQL to this exact attempt -- see
    // `listOwnedArtifactIds`. This was a hardcoded empty array until #273, which made
    // `validateFieldMap`'s rule 5 refuse every artifact assignment by construction, including an
    // attempt's own CV.
    ownedArtifactIds: listOwnedArtifactIds(db, input.attemptId),
    allowJdProvenance: input.allowJdProvenance,
  });

  if (!result.ok || !result.fieldMap) {
    return { ok: false, reason: result.reason, detail: result.detail };
  }

  // Phase 1: resolve and verify every attachment before a single field is touched.
  const planned: PlannedAttachment[] = [];
  for (const assignment of result.fieldMap.assignments) {
    if (assignment.source.kind !== 'artifact') continue;
    const { artifactId } = assignment.source;
    const resolved = await resolveUploadArtifact(db, input.attemptId, artifactId, active.policy);
    if (!resolved.ok || !resolved.file) {
      return { ok: false, reason: resolved.reason, detail: resolved.detail };
    }
    // The one refusal that is a handoff rather than an error: this target forbids uploads outright
    // (a compiled kill switch, or a policy that never listed `attach`), so the file is the user's
    // to add by hand on the page itself. Checked after the artifact resolved so the handoff can
    // actually name the document the user should pick.
    if (!isActionAllowed(active.policy, 'attach')) {
      return {
        ok: false,
        reason: 'attachment_requires_manual_handoff',
        detail: `target policy "${active.policy.id}" does not permit automated uploads`,
        manualHandoff: { fieldRef: assignment.fieldRef, artifactId, fileName: resolved.file.fileName, reason: 'unsupported_control' },
      };
    }
    planned.push({ fieldRef: assignment.fieldRef, file: resolved.file });
  }

  // Phase 2: the value/option assignments, unchanged.
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
    // 'artifact' is phase 3 below; 'skip' assigns nothing by definition.
  }

  // Phase 3: attach, then confirm off the control itself.
  const attachments: ApplicationAttachmentResult[] = [];
  for (const { fieldRef, file } of planned) {
    try {
      await active.executor.attach(fieldRef, file);
    } catch (err) {
      if (err instanceof ExecutorPolicyError) {
        // The executor refused this control (not a file input, or a policy check of its own).
        // Nothing reached the page, and there is no second way to drive an upload control that
        // should be tried instead -- hand it to the user, visibly.
        return {
          ok: false,
          reason: 'attachment_requires_manual_handoff',
          detail: err.message,
          manualHandoff: { fieldRef, artifactId: file.artifactId, fileName: file.fileName, reason: 'unsupported_control' },
        };
      }
      throw err;
    }

    const reported = await active.executor.readBackAttachment(fieldRef);
    // The browser names a file input's selection by the staged file's own on-disk name
    // (`<contentHash>-<fileName>`, per `stagedArtifactPath`), so that -- not the artifact's logical
    // file name -- is what a confirmed read-back must contain. An empty control reports its "no
    // file chosen" placeholder instead, and an unrecognized report is treated the same way: a
    // concrete failure, never an assumed success.
    const expected = basename(file.localFilePath);
    if (reported === null || !reported.includes(expected)) {
      return {
        ok: false,
        reason: 'attachment_unconfirmed',
        detail: `the page did not report artifact ${file.artifactId} on field ${fieldRef} after the upload`,
      };
    }
    attachments.push({
      artifactId: file.artifactId,
      fieldRef,
      fileName: file.fileName,
      attachedFileName: reported.slice(0, MAX_REPORTED_ATTACHMENT_NAME_LENGTH),
    });
    appliedCount += 1;
  }

  return { ok: true, appliedCount, ...(attachments.length > 0 ? { attachments } : {}) };
}

/**
 * Surfaces an open review's real page to the user, so an upload control this executor may not drive
 * ends in something the user can actually see and finish by hand -- #273's "unsupported upload
 * controls preserve a visible manual handoff". Returns `false` when there is no open review for
 * `attemptId`, so a caller can tell "shown" from "nothing to show" rather than assuming.
 *
 * Called by `main.ts` when `applyApplicationFieldMap` comes back with a `manualHandoff`; the view
 * is detached again by `closeApplicationReview`, which destroys it.
 */
export function showApplicationReviewForHandoff(attemptId: string, window: BrowserWindow): boolean {
  const active = activeReviews.get(attemptId);
  if (!active) return false;
  active.view.show(window);
  return true;
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
    if (attempt.checkpoint === 'submitted' || attempt.checkpoint === 'submitting') {
      return { ok: false, reason: 'already_submitted', detail: `attempt ${attemptId} already reached checkpoint "${attempt.checkpoint}"` };
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

    workspace.updateApplicationAttempt(db, attemptId, {
      checkpoint: 'submitted',
      submittedAt: new Date().toISOString(),
      submissionMode: mode,
      formStructureHash: computeFormStructureHash(snapshot),
    });
    return { ok: true };
  } finally {
    submittingAttemptIds.delete(attemptId);
  }
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
  if (attempt.checkpoint === 'submitted' || attempt.checkpoint === 'submitting') {
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
