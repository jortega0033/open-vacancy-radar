import type { FieldMapRefusalReason, FormSnapshot, HandoffReason, ValueProvenance } from '@agent-dock/application-executor';
import type { ArtifactUploadRefusalReason } from './application-artifact-upload.js';
import type { AutomaticSubmissionRefusalReason, SubmitApplicationReviewRefusalReason } from './application-review-session.js';
import type { RequestAutomationGrantRefusalReason } from './automatic-submission-grant.js';

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

/**
 * Everything `applyFieldMap` can refuse with: Domain B's own rules (#196 §2.4), plus the
 * artifact-resolution refusals #273 added on top of them, plus the two outcomes that only exist
 * once an attachment is actually attempted.
 *
 * `attachment_requires_manual_handoff` is never a silent failure: the live page is surfaced to the
 * user and `manualHandoff` below says which field and which file it was, so an upload control this
 * executor cannot drive ends as "you do this one by hand", never as a quietly dropped field or an
 * attempt to drive the control some other way.
 *
 * `attachment_unconfirmed` means the file was sent to the control but the browser did not report it
 * back on that control afterwards -- a concrete failure, deliberately distinct from success, so an
 * attempt is never marked ready on an attachment nothing verified.
 */
export type ApplyApplicationFieldMapRefusalReason =
  | FieldMapRefusalReason
  | ArtifactUploadRefusalReason
  | 'attachment_requires_manual_handoff'
  | 'attachment_unconfirmed';

/** One confirmed attachment. `attachedFileName` is what the *page* reported after the upload, read
 * back from the control itself -- not an echo of what was requested. No path, ever. */
export interface ApplicationAttachmentResult {
  artifactId: string;
  fieldRef: string;
  fileName: string;
  attachedFileName: string;
}

/** The visible fallback for an upload control this executor may not or cannot drive. Carries no
 * path either: the user is shown the real page, and the file name is only there so the UI can say
 * which document to pick. */
export interface ApplicationManualHandoff {
  fieldRef: string;
  artifactId: string;
  fileName: string;
  reason: HandoffReason;
}

export interface ApplyApplicationFieldMapResult {
  ok: boolean;
  reason?: ApplyApplicationFieldMapRefusalReason;
  detail?: string;
  appliedCount?: number;
  /** Present only when `ok` is true and the field map assigned at least one artifact. */
  attachments?: ApplicationAttachmentResult[];
  /** Present only with reason `attachment_requires_manual_handoff`. */
  manualHandoff?: ApplicationManualHandoff;
}

export interface SubmitApplicationReviewResult {
  ok: boolean;
  reason?: SubmitApplicationReviewRefusalReason;
  detail?: string;
}

export interface RequestAutomationGrantInput {
  policyId: string;
  /** Milliseconds, capped by `automatic-submission-grant.ts`'s own `MAX_AUTOMATION_GRANT_DURATION_MS`. */
  durationMs: number;
}

export interface RequestAutomationGrantResult {
  ok: boolean;
  reason?: RequestAutomationGrantRefusalReason;
  /** ISO-8601. Present only when `ok` is true. */
  expiresAt?: string;
}

export interface ScheduleAutomaticSubmissionResult {
  ok: boolean;
  reason?: AutomaticSubmissionRefusalReason;
  detail?: string;
  /** ISO-8601. Present only when `ok` is true. */
  scheduledAutomaticSubmitAt?: string;
}

export interface ApplicationExecutorBridge {
  /** Opens an isolated browser view for `attemptId`, navigates it to `targetUrl` (refused unless
   * `targetUrl`'s origin is in the resolved policy's allowlist), and returns a fresh snapshot plus
   * a screenshot. Throws if `attemptId` already has an open review. */
  openReview(input: OpenApplicationReviewInput): Promise<OpenApplicationReviewResult>;
  /**
   * Validates `fieldMap` against the attempt's current snapshot and value table (#196 §2.4), then
   * applies every validated `value`/`option` assignment via fill/select and attaches every
   * validated `artifact` assignment.
   *
   * Artifact ownership is resolved in the main process against #198's artifact records (#273): an
   * `artifact` assignment naming anything not registered against *this* attempt is refused as
   * `artifact_not_owned` before anything is applied, and an artifact that is owned but whose staged
   * file is missing, has changed on disk since staging, or exceeds the target's upload constraints
   * is refused with its own specific reason -- always before any upload, never a silent skip. A
   * successful attachment is read back off the control and reported in `attachments`; an upload
   * control this executor may not drive ends in a visible manual handoff instead. No filesystem
   * path ever crosses this bridge in either direction.
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
  /**
   * The one and only way to authorize automatic (unattended) submission for a policy (#203):
   * behind a real native OS confirmation dialog, never a plain call this bridge could grant on its
   * own. Refuses before ever showing that dialog for an unknown policy, one the terms register
   * hasn't cleared, or an out-of-bounds duration.
   */
  requestAutomationGrant(input: RequestAutomationGrantInput): Promise<RequestAutomationGrantResult>;
  /**
   * Runs every #203 guardrail for `attemptId` and, only if all pass, queues it for an automatic
   * submit a few minutes out -- never immediately, even when eligible. Requires an already-open
   * review for the attempt, the same precondition `submitReview` has.
   */
  scheduleAutomaticSubmission(attemptId: string): Promise<ScheduleAutomaticSubmissionResult>;
  /** Cancels a scheduled automatic submit before it fires. Safe to call for an attempt that was
   * never scheduled at all. */
  cancelScheduledAutomaticSubmission(attemptId: string): Promise<void>;
}
