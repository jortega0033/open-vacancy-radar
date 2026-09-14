import { describe, expect, it } from 'vitest';
import { assessWorkEligibility } from '@open-vacancy-radar/vacancy-engine';
import type { EligibilityEvidence, WorkEligibilityEvidence } from '@open-vacancy-radar/vacancy-engine';
import {
  assessJdCompleteness,
  buildGenerationInputBundle,
  describeUnsupportedClaims,
  extractCriticalRequirements,
  generationInputFingerprint,
  generationPreferencesFromCandidateProfile,
  isGeneratedArtifactCurrent,
  GENERATION_DOCUMENT_TYPES,
  GENERATION_INPUT_BUDGETS,
  UNCONFIGURED_GENERATION_PREFERENCES,
  type FormFieldRequirement,
  type GenerationDocumentType,
  type GenerationInputBundleInput,
  type GenerationPreferences,
  type GenerationVacancy,
} from '../electron/generation-input.js';
import type { CvProfile } from '../electron/workspace/types.js';
import type { CvSourceDocument } from '../electron/workspace/cv-source-schema.js';
import { buildBundledDocumentPrompt } from '../src/components/generation/prompts.js';
import { MAX_VACANCY_TEXT_CHARS } from '../src/components/cv/prompts.js';

/**
 * Regression tests for issue #281's six acceptance checks.
 *
 * Every fixture here is synthetic: invented employers, an `example.invalid` domain, and a phone
 * number in the reserved 555 range. Nothing in this file is anyone's real CV, contact detail or
 * job posting.
 */

/* --------------------------------------------------------------------- fixtures --------------- */

const SOURCE_CV: CvSourceDocument = {
  contact: {
    name: 'Robin Alvarez',
    title: 'Frontend Engineer',
    location: 'Utrecht, Netherlands',
    // Corrected by the candidate in the #274 review drawer: the extraction read the old address.
    email: 'robin.alvarez@example.invalid',
    phone: '+31 20 555 0142',
    links: ['https://example.invalid/robin'],
  },
  summary: 'Frontend engineer working on design systems.',
  experience: [
    {
      company: 'Northwind Digital',
      title: 'Senior Frontend Engineer',
      dates: '2021 - present',
      engagement: 'client_engagement',
      client: 'Meridian Freight',
      bullets: ['Rebuilt the component library.'],
    },
  ],
  education: [{ institution: 'Utrecht Polytechnic', credential: 'BSc Computer Science', dates: '2013 - 2017' }],
  projects: [
    { id: 'p1', name: 'Atlas Design Kit', role: 'Lead', dates: '2022', organization: 'Northwind Digital', description: 'Component library.', technologies: ['TypeScript'], links: [], pinned: true },
    { id: 'p2', name: 'Harbour Dashboard', role: 'Contributor', dates: '2021', organization: '', description: 'Ops dashboard.', technologies: ['React'], links: [], pinned: false },
    { id: 'p3', name: 'Kestrel Prototype', role: 'Contributor', dates: '2020', organization: '', description: 'Spike.', technologies: [], links: [], pinned: false },
  ],
  maxProjects: 2,
  complete: true,
  incompleteReason: '',
  coveredChars: 4_000,
  sourceChars: 4_000,
  reviewedAt: '2026-09-01T09:00:00.000Z',
};

const PROFILE: CvProfile = {
  title: 'Senior Frontend Engineer',
  years: '8 years',
  location: 'Utrecht, Netherlands',
  languages: 'English (native), Dutch (B2)',
  skills: ['TypeScript', 'React'],
  summary: 'Design systems and frontend architecture.',
  auth: 'EU citizen',
};

const CV = { fileName: 'robin-alvarez-cv.pdf', text: 'Robin Alvarez. Frontend engineer. Eight years of design system work.' };

const VACANCY: GenerationVacancy = {
  title: 'Senior Frontend Engineer',
  company: 'Redwood Software',
  location: 'Amsterdam, Netherlands',
  url: 'https://example.invalid/jobs/1',
  employmentType: 'full_time',
  currency: 'EUR',
  salaryPeriod: 'month',
  advertisedMinimum: 6_500,
  observedAt: '2026-09-05T09:00:00.000Z',
};

/** Filler that deliberately trips none of the requirement vocabulary. */
const FILLER_SENTENCE = 'We build logistics tooling for freight teams across the region.\n';

/** A posting whose only mandatory language line sits well past the interactive 6,000-char clamp. */
const LATE_REQUIREMENT = 'Fluent Japanese is required for this role.';

function longPostingWithLateRequirement(): GenerationVacancy {
  const padding = FILLER_SENTENCE.repeat(Math.ceil((MAX_VACANCY_TEXT_CHARS + 2_000) / FILLER_SENTENCE.length));
  return { ...VACANCY, description: `${padding}\n${LATE_REQUIREMENT}` };
}

const GOOD_POSTING: GenerationVacancy = {
  ...VACANCY,
  description: [
    'Redwood Software is hiring a senior frontend engineer to own the design system.',
    'You will work with product teams to ship accessible components and keep the token set coherent.',
    'The team is distributed across three timezones and meets twice a week.',
    'We care about measurable accessibility outcomes and about keeping the build fast.',
    'The role reports to the head of platform and has no direct reports.',
    'Our stack is TypeScript end to end, with a component library used by eleven product teams.',
  ].join('\n'),
  requirements: [
    'At least five years of frontend engineering experience',
    'Deep TypeScript knowledge is required',
    'Experience owning a design system',
  ],
};

function bundleFor(
  documentType: GenerationDocumentType,
  overrides: Partial<GenerationInputBundleInput> = {},
) {
  return buildGenerationInputBundle({
    documentType,
    cv: CV,
    sourceCv: SOURCE_CV,
    profile: PROFILE,
    vacancy: GOOD_POSTING,
    ...overrides,
  });
}

/* ---------------------------------------------------------------- acceptance check 1 ---------- */

describe('#281 check 1: a critical requirement past the interactive JD limit is never silently ignored', () => {
  const posting = longPostingWithLateRequirement();

  it('hoists the late requirement out of the full posting, before any prompt budget is applied', () => {
    expect(extractCriticalRequirements(posting)).toContain(LATE_REQUIREMENT);
  });

  it('still affects the eligibility read, which sees the whole posting', () => {
    const evidence = assessWorkEligibility({
      description: posting.description ?? null,
      location: posting.location,
      candidateWorkCountry: 'Netherlands',
      candidateLanguages: ['English', 'Dutch'],
      candidateRelocationWilling: null,
      employerRegisterMatch: null,
      currency: posting.currency ?? null,
      salaryPeriod: posting.salaryPeriod ?? null,
      advertisedMinimum: posting.advertisedMinimum ?? null,
      observedAt: posting.observedAt ?? null,
    });
    expect(evidence.mandatoryLanguage.answer).toBe('no');
    expect(evidence.mandatoryLanguage.detail).toContain('Japanese');
  });

  it('reaches every generated document even where the vacancy body itself was clamped', () => {
    for (const documentType of GENERATION_DOCUMENT_TYPES) {
      const prompt = buildBundledDocumentPrompt(bundleFor(documentType, { vacancy: posting }));
      expect(prompt).toContain(LATE_REQUIREMENT);
      expect(prompt).toContain('CRITICAL REQUIREMENTS FROM THE FULL POSTING');
    }
  });

  it('clamps the letter path’s vacancy body, so the requirement only survives via the hoisted block', () => {
    const prompt = buildBundledDocumentPrompt(bundleFor('cover_letter', { vacancy: posting }));
    expect(prompt).toContain('…truncated at');
    // The hoisted block is the only reason the requirement is in the prompt at all: the clamped
    // body stops thousands of characters before it.
    const truncationIndex = prompt.indexOf('…truncated at');
    expect(prompt.slice(0, truncationIndex)).not.toContain(LATE_REQUIREMENT);
  });

  it('blocks readiness with a recoverable incomplete-input state, naming what was not read', () => {
    const bundle = bundleFor('cover_letter', { vacancy: posting });
    expect(bundle.readiness.state).toBe('incomplete_input');
    const gap = bundle.readiness.gaps.find((entry) => entry.code === 'input_truncated');
    expect(gap?.detail).toContain('did not reach this document');
    // Recoverable: every gap says what would clear it, so this is a state the user can leave.
    for (const entry of bundle.readiness.gaps) expect(entry.resolution.length).toBeGreaterThan(0);
  });

  it('records the shortfall on the extraction ledger rather than dropping it in silence', () => {
    const bundle = bundleFor('cover_letter', { vacancy: posting });
    const record = bundle.extraction.find((entry) => entry.field === 'job_description');
    expect(record?.truncated).toBe(true);
    expect(record?.includedChars).toBe(GENERATION_INPUT_BUDGETS.interactiveJdChars);
    expect(record?.sourceChars).toBeGreaterThan(GENERATION_INPUT_BUDGETS.interactiveJdChars);
  });
});

/* ---------------------------------------------------------------- acceptance check 2 ---------- */

describe('#281 check 2: fitting the character budget does not make a job description complete', () => {
  it('treats a posting with no text at all as incomplete', () => {
    const result = assessJdCompleteness(VACANCY);
    expect(result.complete).toBe(false);
    expect(result.reasons).toContain('no_posting_text');
  });

  it('treats a listing teaser as incomplete even though it fits comfortably', () => {
    const result = assessJdCompleteness({ ...VACANCY, description: 'Senior frontend engineer wanted. Apply now.' });
    expect(result.bodyChars).toBeLessThan(GENERATION_INPUT_BUDGETS.interactiveJdChars);
    expect(result.complete).toBe(false);
    expect(result.reasons).toContain('posting_text_too_thin');
  });

  it('treats a long posting that states no requirement as incomplete, budget notwithstanding', () => {
    const marketing = FILLER_SENTENCE.repeat(30);
    const result = assessJdCompleteness({ ...VACANCY, description: marketing });
    expect(result.bodyChars).toBeGreaterThan(1_000);
    expect(result.bodyChars).toBeLessThan(GENERATION_INPUT_BUDGETS.interactiveJdChars);
    expect(result.complete).toBe(false);
    expect(result.reasons).toContain('no_requirements_captured');
  });

  it('treats text that still carries the source page’s cut-off marker as incomplete', () => {
    const result = assessJdCompleteness({
      ...GOOD_POSTING,
      description: `${GOOD_POSTING.description ?? ''}\nRead more`,
    });
    expect(result.complete).toBe(false);
    expect(result.reasons).toContain('truncated_at_source');
  });

  it('calls a real posting complete, so the check is not simply always false', () => {
    const result = assessJdCompleteness(GOOD_POSTING);
    expect(result.complete).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('never defaults completeness to true on the bundle the way the attempt record did', () => {
    const bundle = bundleFor('cover_letter', { vacancy: { ...VACANCY, description: null, requirements: null } });
    expect(bundle.jd.complete).toBe(false);
    expect(bundle.readiness.state).toBe('incomplete_input');
    expect(bundle.readiness.gaps.some((gap) => gap.code === 'jd_incomplete')).toBe(true);
  });
});

/* ---------------------------------------------------------------- acceptance check 3 ---------- */

describe('#281 check 3: corrected facts and project choices are consistent, and the source CV is never written', () => {
  it('carries the corrected contact facts into every generated artifact', () => {
    for (const documentType of GENERATION_DOCUMENT_TYPES) {
      const prompt = buildBundledDocumentPrompt(bundleFor(documentType));
      expect(prompt).toContain('robin.alvarez@example.invalid');
      expect(prompt).toContain('+31 20 555 0142');
    }
  });

  it('applies the candidate’s project selection identically in every artifact', () => {
    for (const documentType of GENERATION_DOCUMENT_TYPES) {
      const prompt = buildBundledDocumentPrompt(bundleFor(documentType));
      // maxProjects is 2 and one project is pinned, so the pin plus one unpinned project survive
      // and the third never appears -- in the CV and in all four letter types alike.
      expect(prompt).toContain('Atlas Design Kit');
      expect(prompt).toContain('Harbour Dashboard');
      expect(prompt).not.toContain('Kestrel Prototype');
    }
  });

  it('selects the same projects in the same order for every document type', () => {
    const selections = GENERATION_DOCUMENT_TYPES.map((documentType) =>
      bundleFor(documentType).selectedProjects.map((project) => project.id),
    );
    for (const selection of selections) expect(selection).toEqual(['p1', 'p2']);
  });

  it('leaves the caller’s source CV byte-for-byte unchanged after building every document', () => {
    const before = JSON.stringify(SOURCE_CV);
    for (const documentType of GENERATION_DOCUMENT_TYPES) buildBundledDocumentPrompt(bundleFor(documentType));
    expect(JSON.stringify(SOURCE_CV)).toBe(before);
  });

  it('freezes the bundle’s copy, so a document builder cannot write through it either', () => {
    const bundle = bundleFor('tailored_cv');
    expect(Object.isFrozen(bundle.sourceCv)).toBe(true);
    expect(Object.isFrozen(bundle.sourceCv?.contact)).toBe(true);
    expect(Object.isFrozen(bundle.sourceCv?.projects)).toBe(true);
    expect(bundle.sourceCv).not.toBe(SOURCE_CV);
  });

  it('carries the corrected private profile alongside the source, not instead of it', () => {
    const prompt = buildBundledDocumentPrompt(bundleFor('cover_letter'));
    expect(prompt).toContain('CORRECTED CANDIDATE PROFILE');
    expect(prompt).toContain('English (native), Dutch (B2)');
  });
});

/* ---------------------------------------------------------------- acceptance check 4 ---------- */

describe('#281 check 4: each document type respects its target’s required prompts and length', () => {
  const FORM: FormFieldRequirement[] = [
    { id: 'why_here', prompt: 'Why do you want to work at Redwood Software?', required: true, maxChars: 600, maxWords: null },
  ];

  it('gives a cover letter and a motivation letter their own opening requirement', () => {
    const cover = buildBundledDocumentPrompt(bundleFor('cover_letter'));
    const motivation = buildBundledDocumentPrompt(bundleFor('motivation_letter'));
    expect(cover).toContain('opens by naming the role and where it was found');
    expect(motivation).toContain('opens by naming the role and the company and stating, in one specific sentence');
    expect(cover).not.toContain('opens by naming the role and the company and stating, in one specific sentence');
  });

  it('gives short-form answers a form-shaped requirement and a far shorter word range', () => {
    const short = buildBundledDocumentPrompt(bundleFor('short_application_message'));
    expect(short).toContain('no salutation, no sign-off, no letterhead');
    expect(short).toContain('70-110 words');
    expect(buildBundledDocumentPrompt(bundleFor('cover_letter'))).toContain('250-350 words');
  });

  it('respects the length the caller asked for, per document type', () => {
    expect(buildBundledDocumentPrompt(bundleFor('recruiter_message', { length: 'short' }))).toContain('60-90 words');
    expect(buildBundledDocumentPrompt(bundleFor('recruiter_message', { length: 'detailed' }))).toContain('140-200 words');
  });

  it('carries the target’s own question and its hard character limit into the document', () => {
    const bundle = bundleFor('short_application_message', { formRequirements: FORM });
    const prompt = buildBundledDocumentPrompt(bundle);
    expect(bundle.constraints.maxChars).toBe(600);
    expect(prompt).toContain('Why do you want to work at Redwood Software?');
    expect(prompt).toContain('fits inside 600 characters');
    expect(prompt).toContain('say less rather than claiming more');
  });

  it('gives the CV no word range at all, because a CV’s length is the candidate’s real history', () => {
    const bundle = bundleFor('tailored_cv');
    expect(bundle.constraints.wordRange).toBe('');
    expect(buildBundledDocumentPrompt(bundle)).not.toContain('words in total');
  });
});

/* ---------------------------------------------------------------- acceptance check 5 ---------- */

/** Built as literals rather than through `recordEvidence`, which the engine's public barrel does
 * not export. The shape is what matters here; #280's own tests cover how it is derived. */
const UNKNOWN_EVIDENCE: EligibilityEvidence = {
  answer: 'unknown',
  source: 'absent',
  scope: 'this_vacancy',
  observedAt: null,
  freshness: 'unknown',
  detail: 'Not stated.',
};

function evidenceWith(overrides: Partial<WorkEligibilityEvidence>): WorkEligibilityEvidence {
  const unknown = UNKNOWN_EVIDENCE;
  return {
    candidateWorkCountry: unknown,
    mandatoryLanguage: unknown,
    visaSponsorship: unknown,
    employerOfRecord: unknown,
    candidateRelocationWillingness: unknown,
    employerRelocationSupport: unknown,
    salaryGeography: {
      currency: 'EUR',
      period: 'month',
      basis: 'unknown',
      statedForCountry: 'Netherlands',
      appliedToCountry: 'Netherlands',
      assumptionApplied: false,
      label: 'No geographic assumption is applied.',
    },
    ...overrides,
  };
}

describe('#281 check 5: EOR and relocation language follows preferences and evidence, and language stays configurable', () => {
  const eorOffered: EligibilityEvidence = {
    answer: 'yes',
    source: 'vacancy_text',
    scope: 'this_vacancy',
    observedAt: '2026-09-05T09:00:00.000Z',
    freshness: 'fresh',
    detail: 'The vacancy offers hiring through an Employer of Record.',
  };

  it('takes no position on relocation when the candidate has never answered', () => {
    const prompt = buildBundledDocumentPrompt(
      bundleFor('cover_letter', {
        preferences: { ...UNCONFIGURED_GENERATION_PREFERENCES, mobilityDisclosure: 'always_state' },
      }),
    );
    expect(prompt).toContain('never answered whether they would relocate');
    expect(prompt).toContain('never said whether an Employer of Record arrangement is acceptable');
  });

  it('states an EOR arrangement only when the candidate accepts one and the posting offers one', () => {
    const preferences: GenerationPreferences = {
      ...UNCONFIGURED_GENERATION_PREFERENCES,
      workCountry: 'Netherlands',
      relocationWilling: true,
      eorAcceptable: true,
    };
    const prompt = buildBundledDocumentPrompt(
      bundleFor('cover_letter', { preferences, eligibility: evidenceWith({ employerOfRecord: eorOffered }) }),
    );
    expect(prompt).toContain('an Employer of Record arrangement is acceptable to them');
    expect(prompt).toContain('Employer of Record, for this vacancy: yes');
    expect(prompt).toContain('The vacancy offers hiring through an Employer of Record.');
    expect(prompt).toContain('The candidate works from Netherlands.');
  });

  it('keeps the candidate-side and employer-side relocation facts apart, never merged', () => {
    const preferences: GenerationPreferences = {
      ...UNCONFIGURED_GENERATION_PREFERENCES,
      relocationWilling: true,
      mobilityDisclosure: 'always_state',
    };
    const prompt = buildBundledDocumentPrompt(bundleFor('cover_letter', { preferences, eligibility: evidenceWith({}) }));
    expect(prompt).toContain('The candidate has recorded that they are willing to relocate');
    expect(prompt).toContain('Employer-side relocation support, for this vacancy: unknown');
    expect(prompt).toContain('Silence is not a yes');
  });

  it('refuses to raise mobility at all when the candidate asked for it to be left out', () => {
    const preferences: GenerationPreferences = { ...UNCONFIGURED_GENERATION_PREFERENCES, mobilityDisclosure: 'omit' };
    const prompt = buildBundledDocumentPrompt(bundleFor('cover_letter', { preferences }));
    expect(prompt).toContain('the candidate has asked for them to be left out');
    expect(prompt).not.toContain('Employer of Record, for this vacancy');
  });

  it('ships no language default: with nothing configured it follows the vacancy’s own language', () => {
    const prompt = buildBundledDocumentPrompt(bundleFor('cover_letter'));
    expect(prompt).toContain('in the same language the vacancy itself is written in');
    expect(prompt).not.toContain('conversational English');
  });

  it('writes in the configured language when the candidate set one', () => {
    const preferences: GenerationPreferences = { ...UNCONFIGURED_GENERATION_PREFERENCES, documentLanguage: 'Dutch' };
    const prompt = buildBundledDocumentPrompt(bundleFor('cover_letter', { preferences }));
    expect(prompt).toContain('Write in natural, conversational Dutch.');
  });

  it('derives preferences from the candidate profile without inventing a language or an EOR answer', () => {
    const preferences = generationPreferencesFromCandidateProfile({
      profileVersion: 'v1',
      candidateName: '',
      currentRole: '',
      location: '',
      experienceYears: 0,
      strongestSkills: [],
      additionalSkills: [],
      targetRoles: [],
      consideredRoles: [],
      excludedRoleFamilies: [],
      constraints: {
        professionalLanguage: 'English, Dutch',
        dutchRequired: false,
        primaryCountry: 'Netherlands',
        allowRemoteEuSupportingNetherlands: false,
        minimumMonthlyBaseEur: 0,
      },
    });
    expect(preferences.workCountry).toBe('Netherlands');
    expect(preferences.professionalLanguages).toBe('English, Dutch');
    // The languages someone works in are not an answer to "which language is this letter in".
    expect(preferences.documentLanguage).toBe('');
    expect(preferences.relocationWilling).toBeNull();
    expect(preferences.eorAcceptable).toBeNull();
  });
});

/* ---------------------------------------------------------------- acceptance check 6 ---------- */

describe('#281 check 6: input changes invalidate cached artifacts, and no fact can be manufactured to fit', () => {
  it('produces the same fingerprint for the same inputs', () => {
    expect(generationInputFingerprint(bundleFor('cover_letter'))).toBe(
      generationInputFingerprint(bundleFor('cover_letter')),
    );
  });

  it('changes when the job description changes', () => {
    const before = generationInputFingerprint(bundleFor('cover_letter'));
    const after = generationInputFingerprint(
      bundleFor('cover_letter', {
        vacancy: { ...GOOD_POSTING, description: `${GOOD_POSTING.description ?? ''}\nA security clearance is required.` },
      }),
    );
    expect(after).not.toBe(before);
  });

  it('changes when the project selection changes, even though the source CV is otherwise identical', () => {
    const before = generationInputFingerprint(bundleFor('cover_letter'));
    const repinned: CvSourceDocument = {
      ...SOURCE_CV,
      projects: SOURCE_CV.projects.map((project) => ({ ...project, pinned: project.id === 'p3' })),
    };
    expect(generationInputFingerprint(bundleFor('cover_letter', { sourceCv: repinned }))).not.toBe(before);
  });

  it('changes when a corrected contact fact, a preference or the document type changes', () => {
    const before = generationInputFingerprint(bundleFor('cover_letter'));
    const corrected: CvSourceDocument = {
      ...SOURCE_CV,
      contact: { ...SOURCE_CV.contact, email: 'r.alvarez@example.invalid' },
    };
    expect(generationInputFingerprint(bundleFor('cover_letter', { sourceCv: corrected }))).not.toBe(before);
    expect(
      generationInputFingerprint(
        bundleFor('cover_letter', {
          preferences: { ...UNCONFIGURED_GENERATION_PREFERENCES, documentLanguage: 'Dutch' },
        }),
      ),
    ).not.toBe(before);
    expect(generationInputFingerprint(bundleFor('motivation_letter'))).not.toBe(before);
  });

  it('refuses to treat an artifact with a stale or absent fingerprint as still valid', () => {
    const bundle = bundleFor('cover_letter');
    const stale = generationInputFingerprint(bundleFor('cover_letter', { length: 'detailed' }));
    expect(isGeneratedArtifactCurrent(generationInputFingerprint(bundle), bundle)).toBe(true);
    expect(isGeneratedArtifactCurrent(stale, bundle)).toBe(false);
    expect(isGeneratedArtifactCurrent(null, bundle)).toBe(false);
    expect(isGeneratedArtifactCurrent('   ', bundle)).toBe(false);
  });

  it('tells every generator, in every document, that it may not manufacture a fact to fit', () => {
    for (const documentType of GENERATION_DOCUMENT_TYPES) {
      expect(buildBundledDocumentPrompt(bundleFor(documentType))).toContain('Never manufacture a qualification');
    }
  });

  it('detects a contact detail in a finished document that the reviewed source does not carry', () => {
    const bundle = bundleFor('cover_letter');
    const claims = describeUnsupportedClaims(
      'Reach me at recruiter.contact@example.invalid or on +44 20 7946 0999.',
      bundle,
    );
    expect(claims.map((claim) => claim.code)).toEqual(['fabricated_contact_fact', 'fabricated_contact_fact']);
  });

  it('accepts the contact details the reviewed source actually carries', () => {
    const bundle = bundleFor('cover_letter');
    expect(describeUnsupportedClaims('Reach me at robin.alvarez@example.invalid or +31 20 555 0142.', bundle)).toEqual([]);
  });

  it('detects a relocation or EOR offer the candidate never authorised', () => {
    const bundle = bundleFor('cover_letter');
    const claims = describeUnsupportedClaims(
      'I am happy to relocate for this role, and I can be employed through an Employer of Record.',
      bundle,
    );
    expect(claims.map((claim) => claim.code)).toEqual(['unsupported_mobility_claim', 'unsupported_mobility_claim']);
    expect(claims[0]?.detail).toContain('never recorded an answer');
  });

  it('accepts a relocation statement the candidate did record', () => {
    const bundle = bundleFor('cover_letter', {
      preferences: { ...UNCONFIGURED_GENERATION_PREFERENCES, relocationWilling: true },
    });
    expect(describeUnsupportedClaims('I am happy to relocate for this role.', bundle)).toEqual([]);
  });

  it('detects a language proficiency the candidate’s own configuration does not support', () => {
    const bundle = bundleFor('cover_letter');
    const claims = describeUnsupportedClaims('I am fluent in Japanese and comfortable in Dutch.', bundle);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.code).toBe('unsupported_language_claim');
    expect(claims[0]?.quote).toContain('Japanese');
  });

  it('accepts a language the profile does list', () => {
    const bundle = bundleFor('cover_letter');
    expect(describeUnsupportedClaims('I am fluent in Dutch.', bundle)).toEqual([]);
  });
});
