export { fieldMapSchema, parseFieldMap, MAX_FIELD_MAP_ENTRIES } from './field-map.js';
export type { FieldMap, FieldAssignment, UnmappedField } from './field-map.js';

export { mintFieldRef, mintOptionRef, findSnapshotField, findSnapshotOption } from './form-snapshot.js';
export type {
  FieldControlType,
  FieldClassification,
  SnapshotOption,
  SnapshotField,
  FormSnapshot,
} from './form-snapshot.js';

export { isNavigationAllowed, isActionAllowed } from './target-policy.js';
export type { ExecutorAction, ApplicationTargetPolicy } from './target-policy.js';

export { ALLOWED_CDP_METHODS, DENIED_CDP_DOMAINS, isAllowedCdpMethod, assertAllowedCdpMethod, CdpMethodNotAllowedError } from './cdp-allowlist.js';

export { validateFieldMap } from './validate.js';
export type { ValueProvenance, ValueTableEntry, FieldMapRefusalReason, ValidateFieldMapInput, ValidateFieldMapResult } from './validate.js';

export { ApplicationExecutor, ExecutorPolicyError } from './executor.js';
export type { CdpTransport, HandoffReason, HandoffResult } from './executor.js';

export { extractSnapshotFields } from './dom-extract.js';
export type { CdpDomNode, ExtractedSnapshot, FieldNodeMap } from './dom-extract.js';
