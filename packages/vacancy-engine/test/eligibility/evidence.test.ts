import { describe, expect, it } from 'vitest';

import {
  assessWorkEligibility,
  type WorkEligibilityInput,
} from '../../src/eligibility/evidence.js';
import { evidenceFreshness } from '../../src/eligibility/models.js';

const NOW = new Date('2026-09-11T12:00:00.000Z');

function input(overrides: Partial<WorkEligibilityInput> = {}): WorkEligibilityInput {
  return {
    description: null,
    location: 'Remote',
    candidateWorkCountry: null,
    candidateLanguages: [],
    candidateRelocationWilling: null,
    employerRegisterMatch: null,
    currency: null,
    salaryPeriod: null,
    advertisedMinimum: null,
    observedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * Synthetic, and deliberately shaped like the real thing: the remote banner is at the top, and the
 * one sentence that actually decides eligibility is far below it. Acceptance check 1 of issue #280.
 */
const US_ONLY_REMOTE_DESCRIPTION = `Senior Frontend Engineer
This is a fully remote role. Work from anywhere, on your own schedule, with a distributed team.

What you will do
Build and own user-facing web applications.
Partner with design on a shared component library.

Compensation
The base salary range for this role is benchmarked to the United States market.

Eligibility
You must be legally authorized to work in the United States.`;

describe('assessWorkEligibility: work country', () => {
  it('does not turn a US-only remote vacancy into verified Netherlands eligibility', () => {
    const evidence = assessWorkEligibility(
      input({
        description: US_ONLY_REMOTE_DESCRIPTION,
        location: 'Remote (Anywhere)',
        candidateWorkCountry: 'Netherlands',
      }),
      NOW,
    );

    expect(evidence.candidateWorkCountry.answer).toBe('no');
    expect(evidence.candidateWorkCountry.source).toBe('vacancy_text');
    expect(evidence.candidateWorkCountry.scope).toBe('this_vacancy');
    expect(evidence.candidateWorkCountry.detail).toContain('United States');
    expect(evidence.candidateWorkCountry.detail).toContain('Netherlands');
  });

  it('leaves a bare remote label unverified rather than reading it as global eligibility', () => {
    const evidence = assessWorkEligibility(
      input({
        description: 'This is a fully remote role on a distributed team. Work from home.',
        location: 'Remote',
        candidateWorkCountry: 'Netherlands',
      }),
      NOW,
    );

    expect(evidence.candidateWorkCountry.answer).toBe('unknown');
    expect(evidence.candidateWorkCountry.detail).toContain('Remote describes where the work happens');
  });

  it('answers yes only from an explicit accepted-location or work-from-anywhere statement', () => {
    const namedCountry = assessWorkEligibility(
      input({
        description: 'We hire in Germany, the Netherlands and Poland.',
        candidateWorkCountry: 'Netherlands',
      }),
      NOW,
    );
    const anywhere = assessWorkEligibility(
      input({
        description: 'Fully remote. You can work from anywhere in the world, with no location restrictions.',
        candidateWorkCountry: 'Netherlands',
      }),
      NOW,
    );

    expect(namedCountry.candidateWorkCountry.answer).toBe('yes');
    expect(anywhere.candidateWorkCountry.answer).toBe('yes');
  });

  it('assumes no country at all when the candidate has configured none', () => {
    const evidence = assessWorkEligibility(
      input({ description: US_ONLY_REMOTE_DESCRIPTION, candidateWorkCountry: null }),
      NOW,
    );

    expect(evidence.candidateWorkCountry.answer).toBe('unknown');
    expect(evidence.candidateWorkCountry.source).toBe('candidate_profile');
    expect(evidence.candidateWorkCountry.scope).toBe('candidate');
  });
});

describe('assessWorkEligibility: sponsorship and Employer of Record stay unknown', () => {
  it('leaves both unknown, never no, when the vacancy says nothing about either', () => {
    const evidence = assessWorkEligibility(
      input({ description: 'Build great web applications with a small, senior team.' }),
      NOW,
    );

    expect(evidence.visaSponsorship.answer).toBe('unknown');
    expect(evidence.visaSponsorship.source).toBe('absent');
    expect(evidence.employerOfRecord.answer).toBe('unknown');
    expect(evidence.employerOfRecord.source).toBe('absent');
  });

  it('reads an explicit statement in either direction, and only an explicit one', () => {
    const refused = assessWorkEligibility(
      input({ description: 'We are unable to sponsor visas, and we do not use an Employer of Record.' }),
      NOW,
    );
    const offered = assessWorkEligibility(
      input({
        description:
          'Visa sponsorship is available for this role. We also hire internationally through an Employer of Record.',
      }),
      NOW,
    );

    expect(refused.visaSponsorship.answer).toBe('no');
    expect(refused.employerOfRecord.answer).toBe('no');
    expect(offered.visaSponsorship.answer).toBe('yes');
    expect(offered.employerOfRecord.answer).toBe('yes');
  });

  it('keeps an IND register match as employer evidence, not a promise to sponsor this vacancy', () => {
    const evidence = assessWorkEligibility(
      input({
        description: 'Senior Frontend Engineer working on our customer portal.',
        location: 'Amsterdam, Netherlands',
        employerRegisterMatch: {
          register: 'IND recognised sponsor register',
          legalName: 'Example Technologies B.V.',
          observedAt: '2026-09-05T00:00:00.000Z',
        },
      }),
      NOW,
    );

    expect(evidence.visaSponsorship.answer).toBe('unknown');
    expect(evidence.visaSponsorship.source).toBe('employer_register');
    expect(evidence.visaSponsorship.scope).toBe('employer');
    expect(evidence.visaSponsorship.detail).toContain('not a commitment to sponsor');
  });

  it('lets an explicit refusal in the vacancy outrank an employer register match', () => {
    const evidence = assessWorkEligibility(
      input({
        description: 'We cannot offer visa sponsorship for this particular role.',
        location: 'Amsterdam, Netherlands',
        employerRegisterMatch: {
          register: 'IND recognised sponsor register',
          legalName: 'Example Technologies B.V.',
          observedAt: '2026-09-05T00:00:00.000Z',
        },
      }),
      NOW,
    );

    expect(evidence.visaSponsorship.answer).toBe('no');
    expect(evidence.visaSponsorship.scope).toBe('this_vacancy');
  });
});

describe('assessWorkEligibility: relocation is two separate facts', () => {
  it('keeps candidate willingness and employer-funded support apart', () => {
    const evidence = assessWorkEligibility(
      input({
        description: 'We do not offer relocation assistance for this role.',
        candidateRelocationWilling: true,
      }),
      NOW,
    );

    expect(evidence.candidateRelocationWillingness.answer).toBe('yes');
    expect(evidence.candidateRelocationWillingness.scope).toBe('candidate');
    expect(evidence.employerRelocationSupport.answer).toBe('no');
    expect(evidence.employerRelocationSupport.scope).toBe('this_vacancy');
  });

  it('never infers one from the other', () => {
    const employerOffers = assessWorkEligibility(
      input({
        description: 'We offer a generous relocation package and cover visa costs.',
        candidateRelocationWilling: null,
      }),
      NOW,
    );

    expect(employerOffers.employerRelocationSupport.answer).toBe('yes');
    expect(employerOffers.candidateRelocationWillingness.answer).toBe('unknown');
    expect(employerOffers.candidateRelocationWillingness.source).toBe('absent');
  });
});

describe('assessWorkEligibility: salary geography stays visible', () => {
  it('preserves currency, period and base-versus-total, and labels the cross-country assumption', () => {
    const evidence = assessWorkEligibility(
      input({
        description: US_ONLY_REMOTE_DESCRIPTION,
        location: 'Remote (United States)',
        candidateWorkCountry: 'Netherlands',
        currency: 'USD',
        salaryPeriod: 'year',
        advertisedMinimum: 150_000,
      }),
      NOW,
    );

    expect(evidence.salaryGeography).toMatchObject({
      currency: 'USD',
      period: 'year',
      basis: 'base',
      statedForCountry: 'United States',
      appliedToCountry: 'Netherlands',
      assumptionApplied: true,
    });
    expect(evidence.salaryGeography.label).toContain('United States');
    expect(evidence.salaryGeography.label).toContain('Netherlands');
    expect(evidence.salaryGeography.label).toMatch(/assum/u);
  });

  it('reports no assumption when the figure is read for the country it is stated for', () => {
    const evidence = assessWorkEligibility(
      input({
        description: 'Base salary for this role is set on the Netherlands market.',
        location: 'Amsterdam, Netherlands',
        candidateWorkCountry: 'Netherlands',
        currency: 'EUR',
        salaryPeriod: 'month',
        advertisedMinimum: 6_500,
      }),
      NOW,
    );

    expect(evidence.salaryGeography.assumptionApplied).toBe(false);
    expect(evidence.salaryGeography.statedForCountry).toBe('Netherlands');
  });

  it('calls the basis unknown when the posting quotes base and total in the same breath', () => {
    const evidence = assessWorkEligibility(
      input({
        description: 'The base salary is complemented by bonus; total compensation is higher.',
        advertisedMinimum: 100_000,
        currency: 'USD',
        salaryPeriod: 'year',
      }),
      NOW,
    );

    expect(evidence.salaryGeography.basis).toBe('unknown');
  });
});

describe('evidence freshness', () => {
  it('grades an observed date and refuses to grade a missing, unparseable or future one', () => {
    expect(evidenceFreshness('2026-09-01T00:00:00.000Z', NOW)).toBe('fresh');
    expect(evidenceFreshness('2026-07-01T00:00:00.000Z', NOW)).toBe('aging');
    expect(evidenceFreshness('2024-01-01T00:00:00.000Z', NOW)).toBe('stale');
    expect(evidenceFreshness(null, NOW)).toBe('unknown');
    expect(evidenceFreshness('not a date', NOW)).toBe('unknown');
    expect(evidenceFreshness('2027-01-01T00:00:00.000Z', NOW)).toBe('unknown');
  });

  it('carries the vacancy posting date onto the answers read from the vacancy text', () => {
    const evidence = assessWorkEligibility(
      input({
        description: 'We are unable to sponsor visas.',
        observedAt: '2026-09-01T00:00:00.000Z',
      }),
      NOW,
    );

    expect(evidence.visaSponsorship.observedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(evidence.visaSponsorship.freshness).toBe('fresh');
  });
});

describe('assessWorkEligibility: mandatory language', () => {
  it('answers no only for a mandatory language the candidate does not have', () => {
    const evidence = assessWorkEligibility(
      input({
        description: 'Requirements\nFluent German is required.\nNice to have\nItalian is a plus.',
        candidateLanguages: ['English'],
      }),
      NOW,
    );

    expect(evidence.mandatoryLanguage.answer).toBe('no');
    expect(evidence.mandatoryLanguage.detail).toContain('German');
    expect(evidence.mandatoryLanguage.detail).not.toContain('Italian');
  });

  it('stays unknown when a mandatory language cannot be checked against anything', () => {
    const evidence = assessWorkEligibility(
      input({
        description: 'Requirements\nFluent German is required.',
        candidateLanguages: [],
      }),
      NOW,
    );

    expect(evidence.mandatoryLanguage.answer).toBe('unknown');
    expect(evidence.mandatoryLanguage.source).toBe('candidate_profile');
  });

  it('stays unknown, never yes, when the posting only names a preferred language', () => {
    const evidence = assessWorkEligibility(
      input({
        description: 'Nice to have\nDutch is a plus.',
        candidateLanguages: ['English'],
      }),
      NOW,
    );

    expect(evidence.mandatoryLanguage.answer).toBe('unknown');
    expect(evidence.mandatoryLanguage.detail).toContain('preferred rather than mandatory');
  });
});
