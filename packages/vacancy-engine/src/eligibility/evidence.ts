import { normalizeCountry } from '../geo/countries.js';
import { normalizeForMatching, plainText } from '../text/plain.js';
import {
  candidateCoversLanguage,
  detectLanguageRequirements,
  uncoveredMandatoryLanguages,
  type LanguageRequirement,
} from './language.js';
import {
  recordEvidence,
  type EligibilityEvidence,
  type SalaryBasis,
  type SalaryGeographyEvidence,
  type WorkEligibilityEvidence,
} from './models.js';

/**
 * Reads the four eligibility facts, the two relocation facts and the salary-geography caption out
 * of whatever a vacancy actually says (issue #280).
 *
 * Every extractor here shares one shape: look for an explicit negative, then an explicit positive,
 * and otherwise answer `unknown`. There is no third pass that guesses. A vacancy that never
 * mentions sponsorship gets `unknown`, not `no`; a vacancy labelled "Remote" that names no accepted
 * work country gets `unknown`, not `yes`.
 */

function textOf(description: string | null, location: string): { body: string; normalized: string } {
  const body = plainText(`${description ?? ''}\n${location}`);
  return { body, normalized: normalizeForMatching(body) };
}

function firstSentenceMatching(body: string, pattern: RegExp): string | null {
  for (const rawLine of body.split('\n')) {
    for (const sentence of rawLine.split(/(?<=[.!?;])\s+/u)) {
      const trimmed = sentence.replace(/^\s*[-*•]\s*/u, '').trim();
      if (trimmed.length > 0 && pattern.test(normalizeForMatching(trimmed))) return trimmed;
    }
  }
  return null;
}

const MAXIMUM_QUOTE_LENGTH = 240;

function quote(sentence: string): string {
  return sentence.length <= MAXIMUM_QUOTE_LENGTH
    ? sentence
    : `${sentence.slice(0, MAXIMUM_QUOTE_LENGTH - 1).trimEnd()}…`;
}

/* ------------------------------------------------------------------ work country ------------- */

/**
 * Phrases that restrict hiring to a named set of places. The captured fragment is run through the
 * shared `normalizeCountry`, so an unrecognisable fragment yields nothing rather than a guess.
 */
const RESTRICTION_PATTERNS: readonly RegExp[] = [
  /\b(?:only|exclusively)\s+(?:hiring|recruiting|open|available)\s+(?:to|for|in|from)\s+([^.;\n]{2,80})/gu,
  /\bwe\s+(?:can\s+)?only\s+(?:hire|employ)\s+(?:candidates\s+)?(?:in|from|based\s+in)\s+([^.;\n]{2,80})/gu,
  /\bmust\s+be\s+(?:legally\s+)?(?:authorized|authorised|eligible)\s+to\s+work\s+in\s+([^.;\n]{2,80})/gu,
  /\bmust\s+(?:be\s+(?:based|located|residing|resident)\s+in|reside\s+in|live\s+in)\s+([^.;\n]{2,80})/gu,
  /\bwork\s+authoris?z?ation\s+in\s+([^.;\n]{2,80}?)\s+is\s+required/gu,
  /\bthis\s+(?:role|position|vacancy)\s+is\s+(?:only\s+)?(?:open|available)\s+(?:to|for)\s+(?:candidates\s+|applicants\s+)?(?:based\s+|located\s+|residing\s+)?(?:in\s+)?([^.;\n]{2,80})/gu,
  /\b([a-z.\s]{2,30}?)[\s-]only\s+(?:role|position|vacancy|hiring|candidates|applicants)\b/gu,
  /\b(?:candidates|applicants)\s+must\s+be\s+(?:based|located)\s+in\s+([^.;\n]{2,80})/gu,
];

/** Phrases that name an accepted place without claiming it is the only one. */
const ACCEPTANCE_PATTERNS: readonly RegExp[] = [
  /\bopen\s+to\s+(?:candidates|applicants)\s+(?:in|from|based\s+in|located\s+in)\s+([^.;\n]{2,80})/gu,
  /\bwe\s+(?:hire|employ)\s+(?:in|from|across)\s+([^.;\n]{2,80})/gu,
  /\byou\s+(?:can|may)\s+work\s+from\s+([^.;\n]{2,80})/gu,
  /\beligible\s+to\s+work\s+(?:in|from)\s+([^.;\n]{2,80})/gu,
  /\bcandidates\s+(?:in|from)\s+([^.;\n]{2,60}?)\s+are\s+(?:welcome|encouraged)/gu,
];

/** An explicit, written statement of global eligibility, as opposed to a feed's location label. */
const WORLDWIDE_STATEMENT =
  /\b(?:work from anywhere(?: in the world)?|anywhere in the world|hire (?:from )?anywhere|from any country|in any country|no location restrictions?|location[- ]independent|globally distributed team hiring anywhere)\b/u;

const REMOTE_LABEL = /\b(?:fully\s+)?remote\b|\bwork\s+from\s+home\b|\bdistributed\s+team\b/u;

function countriesFrom(body: string, patterns: readonly RegExp[]): { countries: string[]; quote: string | null } {
  const countries = new Set<string>();
  let matchedSentence: string | null = null;
  const normalized = normalizeForMatching(body);
  for (const pattern of patterns) {
    // `matchAll` clones the regex before iterating, so these module-level `/g` patterns cannot
    // carry a previous vacancy's `lastIndex` into this one. Reset anyway, so the invariant does
    // not depend on that detail if this ever moves to `exec`.
    pattern.lastIndex = 0;
    for (const match of normalized.matchAll(pattern)) {
      const fragment = match[1];
      if (fragment === undefined) continue;
      for (const piece of fragment.split(/,|\bor\b|\band\b|\//u)) {
        const country = normalizeCountry(piece.trim());
        if (country !== null) countries.add(country);
      }
      if (matchedSentence === null && countries.size > 0) {
        matchedSentence = firstSentenceMatching(body, new RegExp(escapeForRegExp(match[0].trim()), 'u'));
      }
    }
  }
  return { countries: [...countries], quote: matchedSentence };
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type WorkLocationStatement = {
  /** Countries the vacancy says are the only ones it hires in. */
  restrictedTo: string[];
  /** Countries the vacancy names as accepted, without claiming exclusivity. */
  acceptedIn: string[];
  /** A written "anywhere in the world" claim, not a feed location label. */
  worldwideStatement: boolean;
  /** The vacancy calls itself remote. On its own this says nothing about where you may live. */
  remoteLabelled: boolean;
  restrictionQuote: string | null;
  acceptanceQuote: string | null;
};

export function detectWorkLocationStatement(
  description: string | null,
  location: string,
): WorkLocationStatement {
  const { body, normalized } = textOf(description, location);
  const restriction = countriesFrom(body, RESTRICTION_PATTERNS);
  const acceptance = countriesFrom(body, ACCEPTANCE_PATTERNS);
  return {
    restrictedTo: restriction.countries,
    acceptedIn: acceptance.countries,
    worldwideStatement: WORLDWIDE_STATEMENT.test(normalizeForMatching(plainText(description ?? ''))),
    remoteLabelled: REMOTE_LABEL.test(normalized),
    restrictionQuote: restriction.quote,
    acceptanceQuote: acceptance.quote,
  };
}

function assessCandidateWorkCountry(
  statement: WorkLocationStatement,
  candidateWorkCountry: string | null,
  observedAt: string | null,
  now: Date,
): EligibilityEvidence {
  if (candidateWorkCountry === null) {
    return recordEvidence(
      {
        answer: 'unknown',
        source: 'candidate_profile',
        scope: 'candidate',
        observedAt: null,
        detail:
          'No candidate work country is configured, so nothing can be said about working for this vacancy from it. No country is assumed on the candidate’s behalf.',
      },
      now,
    );
  }

  // Order matters: an explicit restriction outranks every softer signal in the same posting,
  // including a "remote, worldwide" banner three paragraphs above it.
  if (statement.restrictedTo.length > 0) {
    const accepted = statement.restrictedTo.includes(candidateWorkCountry);
    return recordEvidence(
      {
        answer: accepted ? 'yes' : 'no',
        source: 'vacancy_text',
        scope: 'this_vacancy',
        observedAt,
        detail: accepted
          ? `The vacancy restricts hiring to ${statement.restrictedTo.join(', ')}, which includes ${candidateWorkCountry}.${statement.restrictionQuote === null ? '' : ` Stated as: "${quote(statement.restrictionQuote)}"`}`
          : `The vacancy restricts hiring to ${statement.restrictedTo.join(', ')}, which does not include ${candidateWorkCountry}.${statement.restrictionQuote === null ? '' : ` Stated as: "${quote(statement.restrictionQuote)}"`}`,
      },
      now,
    );
  }

  if (statement.acceptedIn.includes(candidateWorkCountry)) {
    return recordEvidence(
      {
        answer: 'yes',
        source: 'vacancy_text',
        scope: 'this_vacancy',
        observedAt,
        detail: `The vacancy names ${candidateWorkCountry} among the places it accepts candidates from.${statement.acceptanceQuote === null ? '' : ` Stated as: "${quote(statement.acceptanceQuote)}"`}`,
      },
      now,
    );
  }

  if (statement.worldwideStatement) {
    return recordEvidence(
      {
        answer: 'yes',
        source: 'vacancy_text',
        scope: 'this_vacancy',
        observedAt,
        detail:
          'The vacancy text states an explicit work-from-anywhere policy with no country restriction elsewhere in the posting.',
      },
      now,
    );
  }

  if (statement.remoteLabelled) {
    return recordEvidence(
      {
        answer: 'unknown',
        source: 'vacancy_text',
        scope: 'this_vacancy',
        observedAt,
        detail:
          'The vacancy is labelled remote but names no accepted work country. Remote describes where the work happens, not which countries the employer can legally hire in, so this stays unverified.',
      },
      now,
    );
  }

  return recordEvidence(
    {
      answer: 'unknown',
      source: 'absent',
      scope: 'this_vacancy',
      observedAt,
      detail: 'The vacancy states no accepted or restricted work country.',
    },
    now,
  );
}

/* --------------------------------------------------------------------- language --------------- */

function assessMandatoryLanguage(
  requirements: readonly LanguageRequirement[],
  candidateLanguages: readonly string[],
  observedAt: string | null,
  now: Date,
): EligibilityEvidence {
  const mandatory = requirements.filter((requirement) => requirement.obligation === 'mandatory');
  const preferred = requirements.filter((requirement) => requirement.obligation === 'preferred');

  if (mandatory.length === 0) {
    return recordEvidence(
      {
        answer: 'unknown',
        source: preferred.length > 0 ? 'vacancy_text' : 'absent',
        scope: 'this_vacancy',
        observedAt,
        detail:
          preferred.length > 0
            ? `The vacancy names ${preferred.map((item) => item.language).join(', ')} as preferred rather than mandatory, and states no mandatory language.`
            : 'The vacancy states no mandatory language requirement.',
      },
      now,
    );
  }

  if (candidateLanguages.length === 0) {
    return recordEvidence(
      {
        answer: 'unknown',
        source: 'candidate_profile',
        scope: 'candidate',
        observedAt: null,
        detail: `The vacancy requires ${mandatory.map((item) => item.language).join(', ')}, but no candidate language is configured, so the requirement cannot be checked against anything.`,
      },
      now,
    );
  }

  const uncovered = uncoveredMandatoryLanguages(mandatory, candidateLanguages);
  if (uncovered.length === 0) {
    return recordEvidence(
      {
        answer: 'yes',
        source: 'vacancy_text',
        scope: 'this_vacancy',
        observedAt,
        detail: `Every mandatory language the vacancy names (${mandatory.map((item) => item.language).join(', ')}) is one the candidate profile lists.`,
      },
      now,
    );
  }

  return recordEvidence(
    {
      answer: 'no',
      source: 'vacancy_text',
      scope: 'this_vacancy',
      observedAt,
      detail: `The vacancy requires ${uncovered.map((item) => item.language).join(', ')}, which the candidate profile does not list. Stated as: "${quote(uncovered[0]!.quote)}"`,
    },
    now,
  );
}

/* ------------------------------------------------------------------- sponsorship -------------- */

const SPONSORSHIP_NEGATIVE =
  /\b(?:no|not|cannot|can ?not|cant|unable to|do not|does not|won't|wont|will not|are not able to|is not able to)\b[^.;\n]{0,40}\bsponsor(?:ship|ing|s)?\b|\bsponsorship\b[^.;\n]{0,40}\b(?:not (?:available|offered|provided|possible)|unavailable)\b|\bwithout (?:visa |work[- ]permit )?sponsorship\b/u;

const SPONSORSHIP_POSITIVE =
  /\b(?:visa |work[- ]permit |immigration )?sponsorship (?:is )?(?:available|offered|provided|possible|supported)\b|\bwe (?:will |can |do |happily |gladly )?sponsor\b|\bwe (?:offer|provide|support)\b[^.;\n]{0,40}\bsponsorship\b|\bwe (?:can|will) (?:help|assist) (?:with|you with) (?:a )?(?:visa|work permit)\b/u;

function assessVisaSponsorship(
  body: string,
  normalized: string,
  employerRegister: EmployerRegisterEvidence | null,
  observedAt: string | null,
  now: Date,
): EligibilityEvidence {
  if (SPONSORSHIP_NEGATIVE.test(normalized)) {
    const sentence = firstSentenceMatching(body, SPONSORSHIP_NEGATIVE);
    return recordEvidence(
      {
        answer: 'no',
        source: 'vacancy_text',
        scope: 'this_vacancy',
        observedAt,
        detail: `The vacancy rules out visa sponsorship.${sentence === null ? '' : ` Stated as: "${quote(sentence)}"`}`,
      },
      now,
    );
  }
  if (SPONSORSHIP_POSITIVE.test(normalized)) {
    const sentence = firstSentenceMatching(body, SPONSORSHIP_POSITIVE);
    return recordEvidence(
      {
        answer: 'yes',
        source: 'vacancy_text',
        scope: 'this_vacancy',
        observedAt,
        detail: `The vacancy offers visa sponsorship.${sentence === null ? '' : ` Stated as: "${quote(sentence)}"`}`,
      },
      now,
    );
  }

  /**
   * An employer's presence on a public sponsor register is real evidence, and it is evidence about
   * the *employer*, which is why it can never move this answer off `unknown`. A company recognised
   * as a sponsor has sponsored somebody; whether it will sponsor this particular vacancy is a
   * question the register has no opinion on. Recorded, scoped honestly, and left reviewable.
   */
  if (employerRegister !== null) {
    return recordEvidence(
      {
        answer: 'unknown',
        source: 'employer_register',
        scope: 'employer',
        observedAt: employerRegister.observedAt,
        detail: `${employerRegister.legalName} appears on the ${employerRegister.register}. That is employer-level evidence only: the vacancy itself says nothing about sponsoring this role, and register recognition is not a commitment to sponsor it.`,
      },
      now,
    );
  }

  return recordEvidence(
    {
      answer: 'unknown',
      source: 'absent',
      scope: 'this_vacancy',
      observedAt,
      detail:
        'The vacancy says nothing about visa sponsorship. Silence is not a refusal, so this stays reviewable rather than being read either way.',
    },
    now,
  );
}

/* ---------------------------------------------------------------------- EOR ------------------- */

const EOR_TERMS = /\b(?:employer of record|eor|professional employer organis?z?ation|peo|global employment platform)\b/u;

const EOR_NEGATIVE =
  /\b(?:no|not|cannot|can ?not|cant|unable to|do not|does not|won't|wont|will not)\b[^.;\n]{0,40}\b(?:employer of record|eor)\b|\b(?:employer of record|eor)\b[^.;\n]{0,40}\b(?:not (?:available|offered|supported|possible)|unavailable)\b/u;

function assessEmployerOfRecord(
  body: string,
  normalized: string,
  observedAt: string | null,
  now: Date,
): EligibilityEvidence {
  if (EOR_NEGATIVE.test(normalized)) {
    const sentence = firstSentenceMatching(body, EOR_NEGATIVE);
    return recordEvidence(
      {
        answer: 'no',
        source: 'vacancy_text',
        scope: 'this_vacancy',
        observedAt,
        detail: `The vacancy rules out hiring through an Employer of Record.${sentence === null ? '' : ` Stated as: "${quote(sentence)}"`}`,
      },
      now,
    );
  }
  if (EOR_TERMS.test(normalized)) {
    const sentence = firstSentenceMatching(body, EOR_TERMS);
    return recordEvidence(
      {
        answer: 'yes',
        source: 'vacancy_text',
        scope: 'this_vacancy',
        observedAt,
        detail: `The vacancy states it hires through an Employer of Record.${sentence === null ? '' : ` Stated as: "${quote(sentence)}"`}`,
      },
      now,
    );
  }
  return recordEvidence(
    {
      answer: 'unknown',
      source: 'absent',
      scope: 'this_vacancy',
      observedAt,
      detail:
        'The vacancy says nothing about an Employer of Record. Most postings never mention one, so this stays reviewable rather than being read as a refusal.',
    },
    now,
  );
}

/* ------------------------------------------------------------------- relocation --------------- */

const RELOCATION_NEGATIVE =
  /\b(?:no|not|cannot|can ?not|do not|does not|without)\b[^.;\n]{0,40}\brelocation(?: assistance| package| support| bonus| allowance| budget| stipend)?\b|\brelocation(?: assistance| package| support| bonus| allowance| budget| stipend)?\b[^.;\n]{0,40}\b(?:not (?:offered|provided|available)|unavailable)\b/u;

const RELOCATION_POSITIVE =
  /\brelocation (?:assistance|package|support|bonus|allowance|budget|stipend|help)\b|\bwe (?:offer|provide|cover|fund)\b[^.;\n]{0,40}\brelocation\b|\bwe (?:will )?(?:help|assist) (?:you )?(?:with )?relocat/u;

function assessEmployerRelocationSupport(
  body: string,
  normalized: string,
  observedAt: string | null,
  now: Date,
): EligibilityEvidence {
  if (RELOCATION_NEGATIVE.test(normalized)) {
    const sentence = firstSentenceMatching(body, RELOCATION_NEGATIVE);
    return recordEvidence(
      {
        answer: 'no',
        source: 'vacancy_text',
        scope: 'this_vacancy',
        observedAt,
        detail: `The vacancy rules out employer-funded relocation support.${sentence === null ? '' : ` Stated as: "${quote(sentence)}"`}`,
      },
      now,
    );
  }
  if (RELOCATION_POSITIVE.test(normalized)) {
    const sentence = firstSentenceMatching(body, RELOCATION_POSITIVE);
    return recordEvidence(
      {
        answer: 'yes',
        source: 'vacancy_text',
        scope: 'this_vacancy',
        observedAt,
        detail: `The vacancy offers employer-funded relocation support.${sentence === null ? '' : ` Stated as: "${quote(sentence)}"`}`,
      },
      now,
    );
  }
  return recordEvidence(
    {
      answer: 'unknown',
      source: 'absent',
      scope: 'this_vacancy',
      observedAt,
      detail: 'The vacancy says nothing about employer-funded relocation or visa costs.',
    },
    now,
  );
}

/**
 * The candidate's own answer, and nothing else. It is never inferred from the vacancy, and the
 * vacancy's relocation offer is never inferred from it: a candidate willing to move still needs an
 * employer willing to fund and sponsor the move, and an employer offering a relocation package
 * still needs a candidate who wants one.
 */
function assessCandidateRelocationWillingness(
  willing: boolean | null,
  now: Date,
): EligibilityEvidence {
  if (willing === null) {
    return recordEvidence(
      {
        answer: 'unknown',
        source: 'absent',
        scope: 'candidate',
        observedAt: null,
        detail:
          'The candidate has not recorded whether they are willing to relocate. This is a candidate-side preference and is never inferred from what the employer offers.',
      },
      now,
    );
  }
  return recordEvidence(
    {
      answer: willing ? 'yes' : 'no',
      source: 'candidate_profile',
      scope: 'candidate',
      observedAt: null,
      detail: willing
        ? 'The candidate has confirmed they are willing to relocate. This says nothing about whether any employer will fund or sponsor a move.'
        : 'The candidate has confirmed they are not willing to relocate. This is a candidate-side preference, recorded separately from any employer relocation offer.',
    },
    now,
  );
}

/* ---------------------------------------------------------------- salary geography ------------ */

const BASE_SALARY_MARKER = /\bbase (?:salary|pay|compensation|rate)\b|\bbasissalaris\b|\bexcluding bonus\b/u;
const TOTAL_SALARY_MARKER =
  /\b(?:ote|on[- ]target earnings|total (?:compensation|package|rewards|earnings)|including (?:bonus|equity|commission)|inclusive of bonus)\b/u;

const SALARY_GEOGRAPHY_PATTERN =
  /\b(?:salary|salaries|compensation|pay|pay range|salary range)\b[^.;\n]{0,80}?\b(?:for|in|based on|benchmarked (?:to|against)|calibrated (?:to|for))\s+([^.;\n]{2,60})/u;

function detectSalaryBasis(normalized: string): SalaryBasis {
  const base = BASE_SALARY_MARKER.test(normalized);
  const total = TOTAL_SALARY_MARKER.test(normalized);
  // Both markers present means the posting quotes two different things and the advertised minimum
  // could be either. Saying `unknown` is the only honest read; picking one would invent a fact.
  if (base === total) return 'unknown';
  return base ? 'base' : 'total';
}

function assessSalaryGeography(input: {
  normalized: string;
  location: string;
  currency: string | null;
  period: string | null;
  advertisedMinimum: number | null;
  candidateWorkCountry: string | null;
}): SalaryGeographyEvidence {
  const explicit = SALARY_GEOGRAPHY_PATTERN.exec(input.normalized);
  const statedForCountry =
    (explicit?.[1] === undefined ? null : normalizeCountry(explicit[1])) ??
    normalizeCountry(input.location);
  const basis = detectSalaryBasis(input.normalized);
  const appliedToCountry = input.candidateWorkCountry;
  const assumptionApplied =
    statedForCountry === null || appliedToCountry === null || statedForCountry !== appliedToCountry;

  const figure =
    input.advertisedMinimum === null
      ? 'No salary figure is advertised'
      : `Advertised from ${[input.currency, input.advertisedMinimum.toLocaleString('en-US')].filter((part) => part !== null && String(part).length > 0).join(' ')}${input.period === null || input.period.length === 0 ? '' : ` per ${input.period}`}`;
  const basisLabel =
    basis === 'unknown'
      ? 'on an unstated basis (base versus total is not distinguished in the posting)'
      : basis === 'base'
        ? 'as base pay'
        : 'as total compensation';
  const geographyLabel =
    statedForCountry === null
      ? 'The posting does not say which country the figure is benchmarked to'
      : `The figure is benchmarked to ${statedForCountry}`;
  const assumptionLabel = !assumptionApplied
    ? 'It is being read for the same country it is stated for, so no geographic assumption is applied.'
    : appliedToCountry === null
      ? 'No candidate work country is configured, so reading this figure as local pay would be an unstated assumption.'
      : statedForCountry === null
        ? `Reading it as ${appliedToCountry} market pay would be an unstated assumption.`
        : `Reading it as ${appliedToCountry} market pay assumes ${statedForCountry} rates transfer, which the posting does not claim.`;

  return {
    currency: input.currency,
    period: input.period,
    basis,
    statedForCountry,
    appliedToCountry,
    assumptionApplied,
    label: `${figure}${input.advertisedMinimum === null ? '' : `, ${basisLabel}`}. ${geographyLabel}. ${assumptionLabel}`,
  };
}

/* ------------------------------------------------------------------ composition --------------- */

export type EmployerRegisterEvidence = {
  /** The register's own name, e.g. "IND recognised sponsor register". */
  register: string;
  legalName: string;
  /** ISO-8601 of when the register entry was observed, or null when the register carries no date. */
  observedAt: string | null;
};

export type WorkEligibilityInput = {
  /** Null where the source carried no description text at all. */
  description: string | null;
  /** The vacancy's own free-text location, exactly as the source stated it. */
  location: string;
  /** The country the candidate would actually work from, or null when it is not configured. */
  candidateWorkCountry: string | null;
  /** The languages the candidate configured. Empty leaves every language answer unknown. */
  candidateLanguages: readonly string[];
  /** The candidate's own recorded answer, or null when they have never given one. */
  candidateRelocationWilling: boolean | null;
  /** Employer-scope register evidence. Never upgraded into a sponsorship promise for this vacancy. */
  employerRegisterMatch: EmployerRegisterEvidence | null;
  currency: string | null;
  salaryPeriod: string | null;
  advertisedMinimum: number | null;
  /** ISO-8601 of when the vacancy text was observed (its posting date), or null. */
  observedAt: string | null;
};

export function assessWorkEligibility(
  input: WorkEligibilityInput,
  now: Date = new Date(),
): WorkEligibilityEvidence {
  const { body, normalized } = textOf(input.description, input.location);
  const statement = detectWorkLocationStatement(input.description, input.location);
  const requirements = detectLanguageRequirements(input.description);

  return {
    candidateWorkCountry: assessCandidateWorkCountry(
      statement,
      input.candidateWorkCountry,
      input.observedAt,
      now,
    ),
    mandatoryLanguage: assessMandatoryLanguage(
      requirements,
      input.candidateLanguages,
      input.observedAt,
      now,
    ),
    visaSponsorship: assessVisaSponsorship(
      body,
      normalized,
      input.employerRegisterMatch,
      input.observedAt,
      now,
    ),
    employerOfRecord: assessEmployerOfRecord(body, normalized, input.observedAt, now),
    candidateRelocationWillingness: assessCandidateRelocationWillingness(
      input.candidateRelocationWilling,
      now,
    ),
    employerRelocationSupport: assessEmployerRelocationSupport(
      body,
      normalized,
      input.observedAt,
      now,
    ),
    salaryGeography: assessSalaryGeography({
      normalized,
      location: input.location,
      currency: input.currency,
      period: input.salaryPeriod,
      advertisedMinimum: input.advertisedMinimum,
      candidateWorkCountry: input.candidateWorkCountry,
    }),
  };
}

export { candidateCoversLanguage, detectLanguageRequirements, uncoveredMandatoryLanguages };
