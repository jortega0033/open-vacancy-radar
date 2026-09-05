import { ApplicationExecutor, isNavigationAllowed, validateFieldMap } from '@agent-dock/application-executor';
import { createApplicationView, type ApplicationView } from './application-view.js';
import { resolveApplicationTargetPolicy } from './application-target-policies.js';
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
