import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ApplicationExecutor, ExecutorPolicyError, isNavigationAllowed, resolveSubmitControl, validateFieldMap } from '@agent-dock/application-executor';
import { createApplicationView, type ApplicationView } from './application-view.js';
import { resolveApplicationTargetPolicy } from './application-target-policies.js';
import { runPreSubmitGate, type PreSubmitGateRefusalReason } from './application-submit-gate.js';
import { extractPdfText } from './cv-text.js';
import * as workspace from './workspace/repository.js';
import type { WorkspaceDb } from './workspace/client.js';
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
}

const activeReviews = new Map<string, ActiveReview>();

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
  activeReviews.set(input.attemptId, { view, executor });

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
  | 'captcha_detected'
  | 'unresolved_submit_control'
  | 'source_cv_not_found'
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
 *    PDFs (read fresh from disk, not cached) must still name the right company/role and carry no
 *    placeholder text. A `sourceCvId` of `null` (the source CV was never a live library entry, or
 *    the attempt predates that link) has nothing live to re-check, so the hash the attempt was
 *    created with is compared against itself -- vacuously satisfied, not skipped.
 *
 * `ExecutorPolicyError` from the submit call itself (the policy disallows the action, or any other
 * pre-click refusal `executor.submit` performs) is treated as a clean, non-ambiguous refusal --
 * nothing reached the page, so the checkpoint reverts to `ready` rather than landing on
 * `submission_unknown`. Any other error (a real CDP/network failure once the click was actually
 * attempted) is genuinely ambiguous and lands on `submission_unknown`, per #202's own acceptance
 * criteria: "never silently retries or silently drops."
 */
export async function submitApplicationReview(db: WorkspaceDb, attemptId: string): Promise<SubmitApplicationReviewResult> {
  const active = activeReviews.get(attemptId);
  if (!active) return { ok: false, reason: 'no_open_review', detail: `no open review for attempt ${attemptId}` };
  const snapshot = active.executor.currentSnapshot;
  if (!snapshot) return { ok: false, reason: 'no_snapshot', detail: `attempt ${attemptId} has no snapshot yet` };
  if (snapshot.challengeDetected) {
    return { ok: false, reason: 'captcha_detected', detail: 'the current page has an active CAPTCHA/bot-detection challenge' };
  }

  const resolved = resolveSubmitControl(snapshot.submitControls);
  if (!resolved) {
    return { ok: false, reason: 'unresolved_submit_control', detail: 'could not unambiguously identify the submit control on the current page' };
  }

  const attempt = workspace.getApplicationAttempt(db, attemptId);

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
  const renderedCvText = cvArtifact ? await extractPdfText(new Uint8Array(await readFile(cvArtifact.storagePath))) : '';
  const renderedLetterText = letterArtifact ? await extractPdfText(new Uint8Array(await readFile(letterArtifact.storagePath))) : null;

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

  workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'submitted', submittedAt: new Date().toISOString() });
  return { ok: true };
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
