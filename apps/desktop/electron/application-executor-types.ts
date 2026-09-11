import type { FieldMapRefusalReason, FormReadiness, FormSnapshot, HandoffReason, ValueProvenance } from '@agent-dock/application-executor';
import type { ArtifactUploadRefusalReason } from './application-artifact-upload.js';
import type {
  AutomaticSubmissionRefusalReason,
  RecordUserReportedSubmissionResult,
  SubmitApplicationReviewRefusalReason,
} from './application-review-session.js';
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
  /** Re-read the existing live page into a new snapshot instead of reusing the prior generation. */
  refresh?: boolean;
}

export interface OpenApplicationReviewResult {
  snapshot: FormSnapshot;
  /** Base64 PNG, straight from `Page.captureScreenshot`. Evidence that the page rendered, and
   * nothing more: it is never evidence that a field holds a value (#277). */
  screenshotBase64: string;
  /**
   * What the live form actually holds, read back out of the browser (#277). This, not
   * `snapshot.fields.length`, is what a review UI may describe as filled -- see
   * `FormReadiness.verifiedFilledCount` against `discoveredFieldCount`.
   */
  readiness: FormReadiness;
  /** Whether this attempt's live view is currently on screen as a handoff. */
  handoffShown: boolean;
}

export type ShowApplicationHandoffRefusalReason = 'no_open_review' | 'no_window' | 'already_submitting';

export interface ShowApplicationHandoffResult {
  ok: boolean;
  reason?: ShowApplicationHandoffRefusalReason;
  detail?: string;
  /** The employer and role this handoff is for, read from the attempt record in this app's own
   * workspace -- never from the third-party page, which must never get to tell a person what they
   * are looking at. Present only when `ok` is true. */
  company?: string;
  role?: string;
  /**
   * The height, in pixels, of the strip at the top of the window that the live view does NOT cover
   * (`application-view.ts`'s `HANDOFF_BANNER_HEIGHT_PX`). Sent over the bridge rather than
   * duplicated in the renderer so there is one source of truth for it: the main process is what
   * actually sizes the view, and a renderer banner that disagreed would either be painted over by
   * the target page or leave a dead gap. Present only when `ok` is true.
   */
  bannerHeightPx?: number;
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
  /** Writes that were issued. Never the same thing as `verifiedCount` -- a write being issued is
   * not a value being committed, which is the confusion #277 exists to remove. */
  appliedCount?: number;
  /** Writes whose committed value was read back out of the browser and matched (#277). An
   * attachment counts here only once the control itself reported holding the staged file. */
  verifiedCount?: number;
  /** The full readiness reading taken immediately after applying (#277). */
  readiness?: FormReadiness;
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

export interface SaveApplicationArtifactResult {
  saved: boolean;
}

export interface OpenApplicationArtifactResult {
  opened: boolean;
  detail?: string;
}

export interface ApplicationExecutorBridge {
  /** Opens an isolated browser view for `attemptId`, navigates it to `targetUrl` (refused unless
   * `targetUrl`'s origin is in the resolved policy's allowlist), and returns a fresh snapshot, a
   * screenshot and a readiness reading.
   *
   * Calling it again for an attempt that already has an open review reuses that review (#277): the
   * same view, the same executor, the same snapshot generation, re-read. Reopening must preserve
   * the attempt, so closing the modal and coming back (which is exactly what a person does after a
   * live handoff) never discards an authenticated session or a set of verified fields. Only a
   * reopen naming a *different* target for the same attempt throws. */
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
   *
   * Every applied value/option is read back off its own control afterwards (#277), so the result
   * reports `verifiedCount` alongside `appliedCount` and carries a full `readiness` reading: a
   * write being issued has never been the same thing as a value being committed.
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
   * Puts this attempt's live browser view on screen, focused, so a person can complete a CAPTCHA,
   * sign in, or finish a control the executor cannot drive (#277).
   *
   * Only one attempt's view can be on screen at a time. Showing this one hides whichever other one
   * was showing and changes nothing else about it -- no other pending attempt loses its view, its
   * snapshot, or its verified fields. Refused for an attempt that is mid-submit.
   */
  showHandoff(attemptId: string): Promise<ShowApplicationHandoffResult>;
  /** Takes the live view back off screen and returns focus to the app. A no-op for an attempt that
   * is not the one currently showing. */
  hideHandoff(attemptId: string): Promise<void>;
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
  /** Records the person's statement separately from an observed submission receipt. */
  recordUserReportedSubmission(attemptId: string): Promise<RecordUserReportedSubmissionResult>;
  /** Saves one attempt-owned staged document through a native Save dialog. */
  saveArtifact(artifactId: string): Promise<SaveApplicationArtifactResult>;
  /** Opens one attempt-owned staged document in the OS viewer for complete human review. */
  openArtifact(artifactId: string): Promise<OpenApplicationArtifactResult>;
}
