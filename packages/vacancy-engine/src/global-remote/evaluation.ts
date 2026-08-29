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

export function classifyDiscoveryVacancy(input: {
  title: string;
  location: string;
  annualizedMinimumUsd: number | null;
  minimumAnnualBaseUsd: number;
  description?: string | null;
}): { decision: DiscoveryDecision; reasons: string[] } {
  if (NON_VACANCY.test(`${input.title}\n${input.description ?? ''}`)) {
    return { decision: 'non_vacancy', reasons: ['Listing is a talent pool, general application, or other non-specific vacancy.'] };
  }
  if (!isFrontendOnlyTitle(input.title)) {
    return { decision: 'role_mismatch', reasons: ['Title is not explicitly frontend-only.'] };
  }
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
  if (input.annualizedMinimumUsd < input.minimumAnnualBaseUsd) {
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
  minimumAnnualBaseUsd: number;
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
  if (source.review.minimumAnnualBaseUsd === null) {
    return { decision: 'salary_unknown', reasons: ['Official source does not advertise a base-pay floor.'] };
  }
  if (source.review.minimumAnnualBaseUsd < input.minimumAnnualBaseUsd) {
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
