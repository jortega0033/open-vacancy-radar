import { z } from 'zod';

/**
 * The evidence vocabulary for work eligibility (issue #280).
 *
 * The pipeline already had two eligibility representations, and neither could carry *why* it
 * believed what it believed: `GlobalRemoteSource.review.outsideUsEligible` (a reviewer's
 * yes/no/uncertain, with no source or date attached to the individual answer) and
 * `DiscoveryVacancyAudit.worldwideSponsorMatch` (an employer-scope register hit that the UI already
 * has to caption by hand so nobody reads it as a promise about a specific vacancy). This module is
 * the shared shape both of those, and the four new facts the ticket asks for, can be expressed in:
 * an answer plus where it came from, what it is actually about, and how old it is.
 *
 * Three rules hold everywhere in here, and the tests in `test/eligibility/` exist to keep them
 * holding:
 *
 * 1. `unknown` is a real answer, never a placeholder that later collapses into `yes` or `no`. An
 *    absent EOR or sponsorship statement stays `unknown` and stays reviewable.
 * 2. Scope is part of the claim. Employer-scope evidence (an entry on a public sponsor register,
 *    say) can never be reported as vacancy-scope evidence, because "this employer has sponsored
 *    somebody before" and "this employer will sponsor this vacancy" are different facts.
 * 3. A candidate-side preference and an employer-side offering are separate fields, never one
 *    merged "relocation" flag. Willingness to move is the candidate's; funding the move is the
 *    employer's.
 */

export const eligibilityAnswerSchema = z.enum(['yes', 'no', 'unknown']);
export type EligibilityAnswer = z.infer<typeof eligibilityAnswerSchema>;

/**
 * Where an answer came from, in roughly descending order of how much weight it can carry for a
 * specific vacancy. `absent` is not a failure state: it is the honest source for "nothing said
 * anything about this", which is what most vacancies say about EOR and sponsorship.
 */
export const evidenceSourceSchema = z.enum([
  'vacancy_text',
  'discovery_metadata',
  'recorded_review',
  'employer_register',
  'candidate_profile',
  'absent',
]);
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;

/** What the claim is about. See rule 2 above. */
export const evidenceScopeSchema = z.enum(['this_vacancy', 'employer', 'candidate']);
export type EvidenceScope = z.infer<typeof evidenceScopeSchema>;

export const evidenceFreshnessSchema = z.enum(['fresh', 'aging', 'stale', 'unknown']);
export type EvidenceFreshness = z.infer<typeof evidenceFreshnessSchema>;

/**
 * Deliberately coarse, and deliberately not a cutoff: nothing in this package drops or downranks
 * evidence for being stale. Freshness is reported so a reader can weigh a two-year-old posting
 * against a two-day-old one; acting on it is the reader's call, not this module's.
 */
export const EVIDENCE_FRESH_MAX_DAYS = 30;
export const EVIDENCE_AGING_MAX_DAYS = 180;

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * `unknown` for a missing or unparseable date, and for a date in the future: a posting stamped
 * next month is a source bug, and treating it as the freshest evidence in the report would reward
 * exactly that bug.
 */
export function evidenceFreshness(observedAt: string | null, now: Date = new Date()): EvidenceFreshness {
  if (observedAt === null) return 'unknown';
  const observed = new Date(observedAt).getTime();
  if (Number.isNaN(observed)) return 'unknown';
  const ageDays = (now.getTime() - observed) / MILLISECONDS_PER_DAY;
  if (ageDays < 0) return 'unknown';
  if (ageDays <= EVIDENCE_FRESH_MAX_DAYS) return 'fresh';
  if (ageDays <= EVIDENCE_AGING_MAX_DAYS) return 'aging';
  return 'stale';
}

export const eligibilityEvidenceSchema = z.object({
  answer: eligibilityAnswerSchema,
  source: evidenceSourceSchema,
  scope: evidenceScopeSchema,
  /** ISO-8601 timestamp of the underlying fact, or null when the source carried no date at all. */
  observedAt: z.string().nullable(),
  freshness: evidenceFreshnessSchema,
  /** The plain-language reason, including a quoted fragment of the vacancy where there is one. */
  detail: z.string(),
});
export type EligibilityEvidence = z.infer<typeof eligibilityEvidenceSchema>;

export type EvidenceInput = {
  answer: EligibilityAnswer;
  source: EvidenceSource;
  scope: EvidenceScope;
  observedAt: string | null;
  detail: string;
};

/** The single constructor, so no call site can record an answer without deriving its freshness. */
export function recordEvidence(input: EvidenceInput, now: Date = new Date()): EligibilityEvidence {
  return {
    answer: input.answer,
    source: input.source,
    scope: input.scope,
    observedAt: input.observedAt,
    freshness: evidenceFreshness(input.observedAt, now),
    detail: input.detail,
  };
}

export const salaryBasisSchema = z.enum(['base', 'total', 'unknown']);
export type SalaryBasis = z.infer<typeof salaryBasisSchema>;

/**
 * What an advertised figure actually says, and what reading it from somewhere else assumes.
 *
 * Currency, period and base-versus-total are preserved exactly as the source stated them (or
 * `unknown`), never normalized into one house currency: the existing `annualizedMinimumUsd` path
 * already refuses to convert anything it cannot convert deterministically, and this record keeps
 * the same discipline for the geographic half of the question.
 *
 * `assumptionApplied` is the point of the whole record. A salary quoted for one country read as if
 * it were the going rate in another is an assumption, and the ticket's requirement is that it stays
 * visible rather than being silently baked into a number. It is true whenever the two countries
 * differ *and* whenever either of them is unknown, because an unstated assumption is still an
 * assumption.
 */
export const salaryGeographyEvidenceSchema = z.object({
  currency: z.string().nullable(),
  period: z.string().nullable(),
  basis: salaryBasisSchema,
  /** The country the figure is advertised for, or null when the vacancy never says. */
  statedForCountry: z.string().nullable(),
  /** The country the candidate would actually work from, or null when it is not configured. */
  appliedToCountry: z.string().nullable(),
  assumptionApplied: z.boolean(),
  /** Reader-facing caption. Always present, including when no figure was advertised at all. */
  label: z.string(),
});
export type SalaryGeographyEvidence = z.infer<typeof salaryGeographyEvidenceSchema>;

/**
 * The four evidence-backed eligibility facts the ticket asks for, plus the two relocation facts
 * kept deliberately apart, plus the geographic salary caption.
 *
 * Note what is *not* here: any composite "eligible: true" verdict. Collapsing six independent
 * three-valued answers into one boolean is precisely the conversion of `unknown` into `yes`/`no`
 * that rule 1 forbids, and every consumer that wants a summary can state its own rule over these
 * fields and say which of them it was reading.
 */
export const workEligibilityEvidenceSchema = z.object({
  /** May the candidate work for this vacancy from the country they are actually in? */
  candidateWorkCountry: eligibilityEvidenceSchema,
  /** Does the candidate meet every language the vacancy states as mandatory? */
  mandatoryLanguage: eligibilityEvidenceSchema,
  /** Will the employer sponsor a work visa for this vacancy? */
  visaSponsorship: eligibilityEvidenceSchema,
  /** Will the employer hire through an Employer of Record for this vacancy? */
  employerOfRecord: eligibilityEvidenceSchema,
  /** Candidate-side preference. Never evidence about what the employer offers. */
  candidateRelocationWillingness: eligibilityEvidenceSchema,
  /** Employer-side offering. Never evidence about what the candidate wants. */
  employerRelocationSupport: eligibilityEvidenceSchema,
  salaryGeography: salaryGeographyEvidenceSchema,
});
export type WorkEligibilityEvidence = z.infer<typeof workEligibilityEvidenceSchema>;
