import {
  candidateCoversLanguage,
  detectLanguageRequirements,
  uncoveredMandatoryLanguages,
} from '../eligibility/language.js';
import type {
  DiscoveryDecision,
  GlobalRemoteDecision,
  GlobalRemoteSource,
  OfficialSourceState,
} from './models.js';

const FRONTEND_ROLE = /\b(?:front[\s-]?end|angular)\b.*\b(?:engineer|developer|architect)\b|\b(?:engineer|developer|architect)\b.*\b(?:front[\s-]?end|angular)\b/iu;
const UI_ROLE = /\bui\s+(?:software\s+)?(?:engineer|developer)\b/iu;
const ROLE_EXCLUSIONS = /\b(?:full[\s-]?stack|back[\s-]?end|manager|director|head|vp|vice president|mobile|android|ios|qa|quality assurance|compiler|salesforce)\b/iu;
const ELIGIBLE_LOCATION = /\b(?:worldwide|anywhere|global|europe|emea|netherlands|european union|eu(?: residents?)?|all countries)\b/iu;
const NON_VACANCY = /\b(?:talent (?:network|community|pool)|general application|future opportunities|expression of interest)\b|not an application for (?:a|this) specific job/iu;

export function isFrontendOnlyTitle(title: string): boolean {
  if (ROLE_EXCLUSIONS.test(title)) return false;
  return FRONTEND_ROLE.test(title) || UI_ROLE.test(title);
}

function normalizedPeriod(period: string | null): string {
  return period?.trim().toLowerCase() ?? '';
}

export function annualizedMinimumUsd(
  minimum: number | null,
  currency: string | null,
  period: string | null,
  employmentType: string | null,
): number | null {
  if (minimum === null || currency?.toUpperCase() !== 'USD') return null;
  const normalized = normalizedPeriod(period);
  if (['annual', 'annually', 'year', 'yearly', '1 year'].includes(normalized)) return minimum;
  if (['month', 'monthly'].includes(normalized)) return minimum * 12;
  if (['week', 'weekly'].includes(normalized)) return minimum * 50;
  if (['hour', 'hourly'].includes(normalized)) {
    const fullTime = /\bfull[\s-]?time\b/iu.test(employmentType ?? '');
    return fullTime ? minimum * 40 * 50 : null;
  }
  return null;
}

export function isPotentiallyEligibleLocation(location: string): boolean {
  const normalized = location.trim();
  if (normalized.length === 0) return true;
  return ELIGIBLE_LOCATION.test(normalized);
}

/**
 * The one place a mandatory-language requirement turns into a decision, shared by the discovery
 * classifier below and by the post-discovery pass in `pipeline/global-remote.ts` (issue #280).
 * Discovery sources call `classifyDiscoveryVacancy` from inside `discoveryAudit`, which has no
 * access to the candidate profile, so the pipeline re-applies this one gate afterwards over every
 * source's rows at once; both paths therefore produce the same decision and the same wording.
 *
 * Returns null, and so gates nothing, whenever the candidate has configured no language, whenever
 * the vacancy carries no description to read, and whenever the language is only *preferred*. A
 * "nice to have" language has never excluded anybody and does not start here.
 */
export function mandatoryLanguageGate(input: {
  description: string | null | undefined;
  candidateLanguages: readonly string[];
}): { decision: 'language_mismatch'; reasons: string[] } | null {
  const uncovered = uncoveredMandatoryLanguages(
    detectLanguageRequirements(input.description),
    input.candidateLanguages,
  );
  if (uncovered.length === 0) return null;
  return {
    decision: 'language_mismatch',
    reasons: uncovered.map(
      (requirement) =>
        `The vacancy states ${requirement.language} as a mandatory requirement, which the configured candidate languages do not include: "${requirement.quote}"`,
    ),
  };
}

export function classifyDiscoveryVacancy(input: {
  title: string;
  location: string;
  annualizedMinimumUsd: number | null;
  minimumAnnualBaseUsd: number | null;
  description?: string | null;
  /** Empty (the default) leaves the language gate inert; see `mandatoryLanguageGate`. */
  candidateLanguages?: readonly string[];
}): { decision: DiscoveryDecision; reasons: string[] } {
  if (NON_VACANCY.test(`${input.title}\n${input.description ?? ''}`)) {
    return { decision: 'non_vacancy', reasons: ['Listing is a talent pool, general application, or other non-specific vacancy.'] };
  }
  if (!isFrontendOnlyTitle(input.title)) {
    return { decision: 'role_mismatch', reasons: ['Title is not explicitly frontend-only.'] };
  }
  const languageMismatch = mandatoryLanguageGate({
    description: input.description,
    candidateLanguages: input.candidateLanguages ?? [],
  });
  if (languageMismatch !== null) return languageMismatch;
  if (!isPotentiallyEligibleLocation(input.location)) {
    return {
      decision: 'location_restricted',
      reasons: [`Discovery metadata does not include worldwide, Europe, or Netherlands eligibility: ${input.location}.`],
    };
  }
  if (input.annualizedMinimumUsd === null) {
    return {
      decision: 'salary_unverified',
      reasons: ['No deterministic USD annual base floor can be established from discovery metadata.'],
    };
  }
  if (input.minimumAnnualBaseUsd !== null && input.annualizedMinimumUsd < input.minimumAnnualBaseUsd) {
    return {
      decision: 'salary_below_threshold',
      reasons: [`Advertised minimum is $${Math.round(input.annualizedMinimumUsd).toLocaleString('en-US')}.`],
    };
  }
  return {
    decision: 'official_review_candidate',
    reasons: ['Discovery metadata passes the preliminary role, location, and salary gates; official verification is still required.'],
  };
}

export function evaluateOfficialReview(input: {
  source: GlobalRemoteSource;
  state: OfficialSourceState;
  currentTitle: string;
  contentHash: string | null;
  minimumAnnualBaseUsd: number | null;
  /** Empty (the default) routes a reviewed mandatory language to confirmation, never to exclusion. */
  candidateLanguages?: readonly string[];
}): { decision: GlobalRemoteDecision; reasons: string[] } {
  const { source } = input;
  if (input.state === 'blocked') {
    return { decision: 'blocked', reasons: ['Official source blocked responsible automated access.'] };
  }
  if (input.state === 'error') {
    return { decision: 'error', reasons: ['Official source could not be verified in this run.'] };
  }
  if (input.state === 'inactive') {
    return { decision: 'inactive', reasons: ['Exact vacancy is absent or explicitly closed on the official source.'] };
  }
  if (!source.review.roleFrontendOnly || !isFrontendOnlyTitle(input.currentTitle)) {
    return { decision: 'excluded_role', reasons: ['Role is not an explicit frontend-only engineering vacancy.'] };
  }
  if (
    source.reviewedContentHash === null ||
    input.contentHash === null ||
    source.reviewedContentHash !== input.contentHash
  ) {
    return {
      decision: 'changed_since_review',
      reasons: ['Official vacancy content is new or changed since the recorded human review.'],
    };
  }
  if (source.review.usMarketRole === 'no') {
    return { decision: 'excluded_not_us_market', reasons: ['Reviewed source is not a US-market vacancy.'] };
  }
  if (source.review.usMarketRole === 'uncertain') {
    return { decision: 'company_confirmation', reasons: ['US-market or employer nexus needs confirmation.'] };
  }
  if (source.review.fullyRemote === 'no') {
    return { decision: 'excluded_not_remote', reasons: ['Vacancy is not fully remote.'] };
  }
  if (source.review.fullyRemote === 'uncertain') {
    return { decision: 'remote_confirmation', reasons: ['Fully remote work model needs confirmation.'] };
  }
  if (source.review.outsideUsEligible === 'no') {
    return {
      decision: 'excluded_location',
      reasons: ['The advertised hiring locations do not include applicants working from the Netherlands.'],
    };
  }
  if (source.review.outsideUsEligible === 'uncertain') {
    return { decision: 'location_confirmation', reasons: ['Netherlands/outside-US eligibility needs confirmation.'] };
  }
  const mandatoryLanguage = source.review.mandatoryLanguage.trim();
  if (mandatoryLanguage.length > 0) {
    const candidateLanguages = input.candidateLanguages ?? [];
    if (candidateLanguages.length === 0) {
      return {
        decision: 'language_confirmation',
        reasons: [
          `The reviewed source records ${mandatoryLanguage} as a mandatory language, and no candidate language is configured to check it against.`,
        ],
      };
    }
    if (!candidateCoversLanguage(candidateLanguages, mandatoryLanguage)) {
      return {
        decision: 'excluded_language',
        reasons: [
          `The reviewed source records ${mandatoryLanguage} as a mandatory language, which the configured candidate languages do not include.`,
        ],
      };
    }
  }
  if (source.review.minimumAnnualBaseUsd === null) {
    return { decision: 'salary_unknown', reasons: ['Official source does not advertise a base-pay floor.'] };
  }
  if (
    input.minimumAnnualBaseUsd !== null &&
    source.review.minimumAnnualBaseUsd < input.minimumAnnualBaseUsd
  ) {
    return {
      decision: 'salary_below_threshold',
      reasons: [`Outside-US base floor is $${source.review.minimumAnnualBaseUsd.toLocaleString('en-US')}.`],
    };
  }
  if (source.review.salaryAppliesOutsideUs !== 'yes') {
    return {
      decision: 'salary_confirmation',
      reasons: ['Advertised salary floor is not guaranteed for an outside-US hire.'],
    };
  }
  return {
    decision: 'strict_match',
    reasons: ['Officially verified frontend-only, fully remote, Netherlands/outside-US eligible, and at or above the USD base-pay floor.'],
  };
}
