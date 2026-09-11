export {
  eligibilityAnswerSchema,
  eligibilityEvidenceSchema,
  evidenceFreshness,
  evidenceFreshnessSchema,
  evidenceScopeSchema,
  evidenceSourceSchema,
  recordEvidence,
  salaryBasisSchema,
  salaryGeographyEvidenceSchema,
  workEligibilityEvidenceSchema,
  EVIDENCE_AGING_MAX_DAYS,
  EVIDENCE_FRESH_MAX_DAYS,
  type EligibilityAnswer,
  type EligibilityEvidence,
  type EvidenceFreshness,
  type EvidenceInput,
  type EvidenceScope,
  type EvidenceSource,
  type SalaryBasis,
  type SalaryGeographyEvidence,
  type WorkEligibilityEvidence,
} from './models.js';

export {
  assessWorkEligibility,
  detectWorkLocationStatement,
  type EmployerRegisterEvidence,
  type WorkEligibilityInput,
  type WorkLocationStatement,
} from './evidence.js';

export {
  candidateCoversLanguage,
  candidateWorkLanguages,
  canonicalLanguageName,
  detectLanguageRequirements,
  parseCandidateLanguages,
  uncoveredMandatoryLanguages,
  type LanguageObligation,
  type LanguageRequirement,
} from './language.js';
