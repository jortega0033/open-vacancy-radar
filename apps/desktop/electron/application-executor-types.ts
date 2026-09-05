import type { FieldMapRefusalReason, FormSnapshot, ValueProvenance } from '@agent-dock/application-executor';
import type { SubmitApplicationReviewRefusalReason } from './application-review-session.js';

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

export interface SubmitApplicationReviewResult {
  ok: boolean;
  reason?: SubmitApplicationReviewRefusalReason;
  detail?: string;
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
  /**
   * The one real, irreversible action in this bridge (#202): runs the pre-submit validation gate
   * against freshly re-read state, resolves the one real submit control on the page, and clicks it
   * for real. Never call this before the user has explicitly reviewed and confirmed this specific
   * attempt -- there is no confirmation step inside this call itself, by design (per #196's
   * trust-domain split, confirmation is a product/UI decision, not something this bridge enforces
   * on the caller's behalf). See `application-review-session.ts`'s `submitApplicationReview` for
   * the full list of refusal reasons and what each one means.
   */
  submitReview(attemptId: string): Promise<SubmitApplicationReviewResult>;
  /** Destroys the isolated view for `attemptId`. Safe to call for an attempt with no open review. */
  closeReview(attemptId: string): Promise<void>;
  /**
   * Which compiled policy (if any) governs `canonicalUrl`, so a caller that only has an attempt's
   * URL (the review UI) can find the `policyId` `openReview` needs, without this app exposing a
   * whole policy object -- or any origin/selector detail -- to the renderer. `null` when no
   * compiled policy covers the URL, which is every real (non-fixture) URL today.
   */
  resolveTargetPolicyId(canonicalUrl: string): Promise<string | null>;
}
