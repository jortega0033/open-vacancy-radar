import type { FieldMapRefusalReason, FormSnapshot, ValueProvenance } from '@agent-dock/application-executor';

/**
 * The `window.applicationExecutor` wire contract (issue #201), mirroring
 * `application-queue-types.ts`'s role for the #200 queue: declared here, implemented by
 * `preload.ts`, re-exported by `src/window.d.ts`. Type-only, so nothing here is emitted into the
 * renderer bundle.
 */

export interface OpenApplicationReviewInput {
  attemptId: string;
  /** Looked up against the compiled table in `application-target-policies.ts` -- never a policy
   * object itself, which never crosses this bridge. */
  policyId: string;
  targetUrl: string;
}

export interface OpenApplicationReviewResult {
  snapshot: FormSnapshot;
  /** Base64 PNG, straight from `Page.captureScreenshot`. */
  screenshotBase64: string;
}

export interface ApplicationValueTableEntryInput {
  valueRef: string;
  value: string;
  provenance: ValueProvenance;
}

export interface ApplyApplicationFieldMapInput {
  attemptId: string;
  /** Untrusted until `validateFieldMap` (#196 §2.4) runs against it main-process side. */
  fieldMap: unknown;
  valueTable: ApplicationValueTableEntryInput[];
  allowJdProvenance?: boolean;
}

export interface ApplyApplicationFieldMapResult {
  ok: boolean;
  reason?: FieldMapRefusalReason;
  detail?: string;
  appliedCount?: number;
}

export interface ApplicationExecutorBridge {
  /** Opens an isolated browser view for `attemptId`, navigates it to `targetUrl` (refused unless
   * `targetUrl`'s origin is in the resolved policy's allowlist), and returns a fresh snapshot plus
   * a screenshot. Throws if `attemptId` already has an open review. */
  openReview(input: OpenApplicationReviewInput): Promise<OpenApplicationReviewResult>;
  /**
   * Validates `fieldMap` against the attempt's current snapshot and value table (#196 §2.4), then
   * applies every validated `value`/`option` assignment via fill/select. This slice never resolves
   * artifact ownership (the caller always supplies an empty owned-artifact set -- #198's artifact
   * repository integration is a separate, future piece of work), so a field map containing an
   * `artifact` (file-upload) assignment is refused outright with reason `'artifact_not_owned'`,
   * never silently skipped.
   */
  applyFieldMap(input: ApplyApplicationFieldMapInput): Promise<ApplyApplicationFieldMapResult>;
  /** Destroys the isolated view for `attemptId`. Safe to call for an attempt with no open review. */
  closeReview(attemptId: string): Promise<void>;
}
