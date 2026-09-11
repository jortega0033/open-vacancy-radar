export { fieldMapSchema, parseFieldMap, MAX_FIELD_MAP_ENTRIES } from './field-map.js';
export type { FieldMap, FieldAssignment, UnmappedField } from './field-map.js';

export {
  mintFieldRef,
  mintOptionRef,
  mintSubmitControlRef,
  findSnapshotField,
  findSnapshotOption,
  findSnapshotSubmitControl,
  computePageStateFingerprint,
} from './form-snapshot.js';
export type {
  FieldControlType,
  FieldClassification,
  SnapshotOption,
  SnapshotField,
  SnapshotSubmitControl,
  FormSnapshot,
  FieldVerificationStatus,
  VerifiedFieldState,
  PageStateFingerprintInput,
} from './form-snapshot.js';

export { evaluateFormReadiness, describeBlockers } from './form-readiness.js';
export type { FormReadiness, ReadinessBlocker, LiveFieldState, EvaluateFormReadinessInput } from './form-readiness.js';

export { readAxControlState, readAttachmentNames } from './ax-readback.js';
export type { AxControlState, CdpAxNode, CdpAxValue, CdpAxProperty, CdpPartialAxTreeResponse } from './ax-readback.js';

export { resolveSubmitControl } from './submit-control.js';

export { isNavigationAllowed, isActionAllowed } from './target-policy.js';
export type { ExecutorAction, ApplicationTargetPolicy } from './target-policy.js';

export { ALLOWED_CDP_METHODS, DENIED_CDP_DOMAINS, isAllowedCdpMethod, assertAllowedCdpMethod, CdpMethodNotAllowedError } from './cdp-allowlist.js';

export { validateFieldMap } from './validate.js';
export type { ValueProvenance, ValueTableEntry, FieldMapRefusalReason, ValidateFieldMapInput, ValidateFieldMapResult } from './validate.js';

export { ApplicationExecutor, ExecutorPolicyError, SUBMISSION_OBSERVE_TIMEOUT_MS, SUBMISSION_OBSERVE_POLL_INTERVAL_MS } from './executor.js';
export type { CdpTransport, HandoffReason, HandoffResult } from './executor.js';

export { extractSnapshotFields, extractSubmissionSignals, MAX_OBSERVED_PAGE_TEXT_LENGTH } from './dom-extract.js';
export type { CdpDomNode, ExtractedSnapshot, FieldNodeMap, FieldGroup, SubmissionSignals } from './dom-extract.js';

export { classifySubmissionOutcome, classifyDelayedReceipt, readResponseSignals, MAX_EVIDENCE_REFERENCE_LENGTH } from './submission-receipt.js';
export type {
  SubmissionOutcome,
  SubmissionEvidence,
  SubmissionEvidenceKind,
  SubmissionOutcomeReport,
  SubmissionRejectedReason,
  SubmissionUnknownReason,
  SubmissionPageObservation,
  ObservedResponse,
} from './submission-receipt.js';
