import {
  CV_EVIDENCE_LIMITS,
  CV_MODEL_EVIDENCE_CLASSES,
  CV_REQUIREMENT_BATCH_SIZE,
  locateJdQuote,
  requirementDedupeKeys,
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
 *
 * The one thing that is not coerced is the quote (#419 step 5): a proposal whose `jdAnchor` is not
 * an exact substring of the JD text is returned in `rejected` with the reason, never accepted and
 * never silently dropped, so the review screen can say how many proposals were turned away.
 */

const CLASSIFICATIONS: readonly CvRequirementClassification[] = ['required', 'preferred', 'unclear'];

export interface RejectedRequirementProposal {
  text: string;
  jdAnchor: string;
  reason: string;
}

export interface RequirementMappingBatch {
  accepted: CvRequirementMapping[];
  rejected: RejectedRequirementProposal[];
  /** True when the model said more requirements remain, or filled the batch (so it may have been
   * cut off by its output cap). The caller asks for another batch while this holds. */
  hasMore: boolean;
}

function toRequirementMapping(
  value: unknown,
  index: number,
  jdText: string,
): CvRequirementMapping | RejectedRequirementProposal | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const text = stringField(record.text, CV_EVIDENCE_LIMITS.requirementText);
  if (!text) return undefined;

  const classification: CvRequirementClassification = CLASSIFICATIONS.includes(
    record.classification as CvRequirementClassification,
  )
    ? (record.classification as CvRequirementClassification)
    : 'unclear';
  const evidenceClass: CvEvidenceClass = CV_MODEL_EVIDENCE_CLASSES.includes(record.evidenceClass as CvEvidenceClass)
    ? (record.evidenceClass as CvEvidenceClass)
    : 'needs_verification';

  const jdAnchor = stringField(record.jdAnchor, CV_EVIDENCE_LIMITS.shortField).trim();
  const span = locateJdQuote(jdText, jdAnchor);
  if (!span) {
    return {
      text,
      jdAnchor,
      reason: jdAnchor ? 'it could not be found in the job description' : 'it did not say where in the job description it came from',
    };
  }

  return {
    // App-assigned, never read from the answer -- same reasoning as every other id in this app.
    requirementId: `requirement-${index + 1}`,
    text,
    jdAnchor,
    classification,
    evidenceClass,
    // Only a supported classification carries an anchor: an id the model attached to a requirement
    // it also called unsupported would be a contradiction this function should not pass along.
    anchorParentId: evidenceClass === 'unsupported' ? '' : stringField(record.anchorParentId, CV_EVIDENCE_LIMITS.shortField),
    // Extracted, not candidate-added; not yet reviewed -- both are the candidate's own state, set
    // once a person actually looks at this row, never inferred from the model's answer.
    candidateAdded: false,
    reviewed: false,
    // Verified here against the text the model was shown; the repository verifies again against
    // the stored revision when this is saved, and stamps the revision id.
    quoteStart: span.start,
    quoteEnd: span.end,
    jdRevisionId: '',
    excluded: false,
    exclusionReason: '',
    sourceIds: [],
    factIds: [],
  };
}

/**
 * Parses one requirement-mapping response end to end against the JD text it was asked about.
 * Throws a user-facing message on anything not recoverable JSON at all; a recoverable-but-malformed
 * shape still returns whatever entries were usable, matching `parseSourceCvResponse`'s stance that
 * a partially-wrong answer should not destroy what it got right. Proposals repeating another's
 * wording or quote are dropped as duplicates.
 */
export function parseRequirementMappingResponse(raw: string, jdText: string): RequirementMappingBatch {
  let value: unknown;
  try {
    value = JSON.parse(extractAiJsonPayload(raw));
  } catch {
    throw new Error('the AI response was not valid JSON: the requirements could not be read into records');
  }
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const requirements = Array.isArray(record.requirements) ? record.requirements : [];
  const accepted: CvRequirementMapping[] = [];
  const rejected: RejectedRequirementProposal[] = [];
  const seen = new Set<string>();
  requirements.slice(0, CV_EVIDENCE_LIMITS.requirements).forEach((entry, index) => {
    const parsed = toRequirementMapping(entry, index, jdText);
    if (!parsed) return;
    if (!('requirementId' in parsed)) {
      rejected.push(parsed);
      return;
    }
    const keys = requirementDedupeKeys(parsed);
    if (keys.some((key) => seen.has(key))) return;
    for (const key of keys) seen.add(key);
    accepted.push(parsed);
  });
  // A full batch is read as possibly cut off even when the model says it finished: an output cap
  // cuts a list at exactly the point it is full, and a false "done" is the costly mistake here.
  const hasMore = record.hasMore === true || requirements.length >= CV_REQUIREMENT_BATCH_SIZE;
  return { accepted, rejected, hasMore };
}
