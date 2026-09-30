import {
  CV_EVIDENCE_LIMITS,
  type CvEvidenceClass,
  type CvRequirementClassification,
  type CvRequirementMapping,
} from '../../../electron/workspace/cv-evidence-schema.js';
import { extractAiJsonPayload } from '../cv-library/cv-ai-parse.js';
import { stringField } from './source-cv-response.js';

/**
 * Coerces one requirement-mapping answer (#419, step 2) into `CvRequirementMapping[]`.
 *
 * Follows `toCvSourceDocument`'s stance exactly: drop what is malformed, keep what is not, never
 * throw away a whole answer over one bad array element. Unlike that module, an invalid enum value
 * here is not dropped either -- it is coerced to the most conservative label in that field's set
 * (`'unclear'` for classification, `'needs_verification'` for evidence class), the same "unknown
 * defaults to the honest gap, never silently resolved either way" rule `CvEvidenceClass`'s own doc
 * comment states. A requirement with a malformed classification is still a requirement a person
 * should see and correct, not one that silently disappears.
 */

const CLASSIFICATIONS: readonly CvRequirementClassification[] = ['required', 'preferred', 'unclear'];
const EVIDENCE_CLASSES: readonly CvEvidenceClass[] = ['direct', 'transferable', 'unsupported', 'needs_verification'];

function toRequirementMapping(value: unknown, index: number): CvRequirementMapping | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const text = stringField(record.text, CV_EVIDENCE_LIMITS.requirementText);
  if (!text) return undefined;

  const classification: CvRequirementClassification = CLASSIFICATIONS.includes(
    record.classification as CvRequirementClassification,
  )
    ? (record.classification as CvRequirementClassification)
    : 'unclear';
  const evidenceClass: CvEvidenceClass = EVIDENCE_CLASSES.includes(record.evidenceClass as CvEvidenceClass)
    ? (record.evidenceClass as CvEvidenceClass)
    : 'needs_verification';

  return {
    // App-assigned, never read from the answer -- same reasoning as every other id in this app.
    requirementId: `requirement-${index + 1}`,
    text,
    jdAnchor: stringField(record.jdAnchor, CV_EVIDENCE_LIMITS.shortField),
    classification,
    evidenceClass,
    // Only a supported classification carries an anchor: an id the model attached to a requirement
    // it also called unsupported would be a contradiction this function should not pass along.
    anchorParentId: evidenceClass === 'unsupported' ? '' : stringField(record.anchorParentId, CV_EVIDENCE_LIMITS.shortField),
    // Extracted, not candidate-added; not yet reviewed -- both are the candidate's own state, set
    // once a person actually looks at this row, never inferred from the model's answer.
    candidateAdded: false,
    reviewed: false,
  };
}

/**
 * Parses one requirement-mapping response end to end. Throws a user-facing message on anything not
 * recoverable JSON at all; a recoverable-but-malformed shape still returns whatever entries were
 * usable, matching `parseSourceCvResponse`'s stance that a partially-wrong answer should not
 * destroy what it got right.
 */
export function parseRequirementMappingResponse(raw: string): CvRequirementMapping[] {
  let value: unknown;
  try {
    value = JSON.parse(extractAiJsonPayload(raw));
  } catch {
    throw new Error('the AI response was not valid JSON: the requirements could not be read into records');
  }
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const requirements = Array.isArray(record.requirements) ? record.requirements : [];
  return requirements
    .map(toRequirementMapping)
    .filter((entry): entry is CvRequirementMapping => entry !== undefined)
    .slice(0, CV_EVIDENCE_LIMITS.requirements);
}
