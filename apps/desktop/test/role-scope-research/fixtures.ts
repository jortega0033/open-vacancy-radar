import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';

/**
 * #694 role-scope research corpus. RESEARCH ONLY: nothing under electron/ or src/ may import this folder
 * (see non-production.test.ts).
 *
 * Provenance and rights: every profile and posting below was written for this research by the fixture author.
 * No text is copied from a real job advert, a real CV, a job site or a private workspace. Company names are
 * placeholders ("Example Co 01" ...). Nothing here is a sample of the live job market.
 *
 * Labels: every `expect` is a FIXTURE-AUTHOR EXPECTATION written from the stated synthetic profile and the
 * posting text alone. They are not human-reviewed relevance labels, not a panel judgement and not hiring
 * truth. A case the author could not label from the text carries `grade: null` and is excluded from every
 * graded count (it is reported, never guessed).
 */

export const CORPUS_VERSION = 'role-scope-corpus/1.0.0-synthetic';
export const LABEL_KIND = 'fixture_author_expectation' as const;
/** Fixed clock for eligibility evidence freshness. Nothing in the evaluation reads the wall clock. */
export const AS_OF = '2026-10-30T00:00:00.000Z';
export const POSTED_AT = '2026-10-20T00:00:00.000Z';

export type ProfileId = 'frontend' | 'backend_research' | 'unsupported_target';

/** A synthetic senior frontend candidate: the product's supported scope. */
export const FRONTEND_PROFILE: CandidateProfile = {
  profileVersion: 'role-scope-synthetic-frontend-v1',
  candidateName: 'Synthetic Candidate F',
  currentRole: 'Senior Frontend Engineer',
  location: 'Netherlands',
  experienceYears: 9,
  strongestSkills: ['TypeScript', 'Angular', 'React', 'RxJS', 'design systems', 'accessibility'],
  additionalSkills: ['Node.js', 'Vue'],
  targetRoles: ['Senior Frontend Engineer', 'Frontend Developer', 'UI Engineer'],
  consideredRoles: ['Full-stack Engineer'],
  excludedRoleFamilies: ['backend only', 'data science', 'embedded'],
  constraints: {
    professionalLanguage: 'English',
    dutchRequired: false,
    primaryCountry: 'Netherlands',
    allowRemoteEuSupportingNetherlands: true,
    minimumMonthlyBaseEur: 0,
  },
};

/**
 * A synthetic backend candidate, used ONLY to measure what today's evaluator does with a non-frontend target
 * and to exercise research option B. Backend is NOT selected for production.
 */
export const BACKEND_RESEARCH_PROFILE: CandidateProfile = {
  profileVersion: 'role-scope-synthetic-backend-research-v1',
  candidateName: 'Synthetic Candidate B',
  currentRole: 'Senior Backend Engineer',
  location: 'Netherlands',
  experienceYears: 8,
  strongestSkills: ['Go', 'PostgreSQL', 'Kafka', 'Node.js', 'TypeScript', 'gRPC'],
  additionalSkills: ['Kubernetes'],
  targetRoles: ['Senior Backend Engineer', 'Backend Developer', 'Platform Engineer'],
  consideredRoles: [],
  excludedRoleFamilies: [],
  constraints: {
    professionalLanguage: 'English',
    dutchRequired: false,
    primaryCountry: 'Netherlands',
    allowRemoteEuSupportingNetherlands: true,
    minimumMonthlyBaseEur: 0,
  },
};

/** A target outside both families, to show explicit unsupported-family behaviour. */
export const UNSUPPORTED_TARGET_PROFILE: CandidateProfile = {
  profileVersion: 'role-scope-synthetic-unsupported-target-v1',
  candidateName: 'Synthetic Candidate D',
  currentRole: 'Data Scientist',
  location: 'Netherlands',
  experienceYears: 6,
  strongestSkills: ['Python', 'statistics', 'SQL'],
  additionalSkills: [],
  targetRoles: ['Data Scientist', 'Machine Learning Engineer'],
  consideredRoles: [],
  excludedRoleFamilies: [],
  constraints: {
    professionalLanguage: 'English',
    dutchRequired: false,
    primaryCountry: 'Netherlands',
    allowRemoteEuSupportingNetherlands: true,
    minimumMonthlyBaseEur: 0,
  },
};

export const PROFILES: Readonly<Record<ProfileId, CandidateProfile>> = {
  frontend: FRONTEND_PROFILE,
  backend_research: BACKEND_RESEARCH_PROFILE,
  unsupported_target: UNSUPPORTED_TARGET_PROFILE,
};

/** relevant > adjacent > not_relevant. null = the author could not label it from the text. */
export type Grade = 'relevant' | 'adjacent' | 'not_relevant' | null;
/** `sparse` = the posting text is missing or too thin to support a confident call either way. */
export type EvidenceLevel = 'sufficient' | 'sparse';

export interface Expectation {
  grade: Grade;
  evidence: EvidenceLevel;
  why: string;
}

export type Tag =
  | 'frontend_control'
  | 'equivalent_title'
  | 'non_english_title'
  | 'mixed_full_stack'
  | 'ambiguous_platform_product'
  | 'out_of_scope'
  | 'backend_family'
  | 'sparse'
  | 'language_mandatory'
  | 'language_preferred'
  | 'language_unclear'
  | 'language_unstated'
  | 'country_known_mismatch'
  | 'country_unknown'
  | 'country_accepted'
  | 'preferred_vs_mandatory'
  | 'discovery_absent'
  | 'plan_matched_hard_negative';

/**
 * Where a posting is, relative to discovery. `in_configured_source`: a configured source would return it to the
 * shared local filter. `not_in_any_configured_source`: posted only where no configured source looks (for example
 * a careers page outside the ATS roster). No evaluator can see the second kind; it is reported as a retrieval
 * limit, never as a ranking error.
 */
export type Availability = 'in_configured_source' | 'not_in_any_configured_source';

export interface CorpusCase {
  id: string;
  title: string;
  company: string;
  location: string;
  description: string | null;
  availability: Availability;
  tags: readonly Tag[];
  expect: Readonly<Record<'frontend' | 'backend_research', Expectation>>;
  /** Eligibility facts the author expects the existing assessor to return for the frontend profile. */
  expectEligibility?: { candidateWorkCountry?: 'yes' | 'no' | 'unknown'; mandatoryLanguage?: 'yes' | 'no' | 'unknown' };
}

const fe = (grade: Grade, why: string, evidence: EvidenceLevel = 'sufficient'): Expectation => ({ grade, evidence, why });
const be = fe;

const FRONTEND_BODY = `Responsibilities
Build and maintain accessible web applications in TypeScript.
Develop reusable UI components for our design system.
Requirements
Strong TypeScript and modern frontend framework experience.
Experience with accessibility (WCAG) and component testing.`;

export const CORPUS: readonly CorpusCase[] = [
  // ---- Frontend controls: explicit frontend titles the current classifier recognises ----
  {
    id: 'F01',
    title: 'Senior Frontend Engineer',
    company: 'Example Co 01',
    location: 'Remote',
    description: `Responsibilities
Build and own an Angular and TypeScript web application.
Create accessible UI components for our design system.
Requirements
Strong Angular, RxJS and frontend architecture experience.`,
    availability: 'in_configured_source',
    tags: ['frontend_control', 'language_unstated', 'country_unknown'],
    expect: { frontend: fe('relevant', 'Core Angular/TypeScript frontend work.'), backend_research: be('not_relevant', 'Frontend only.') },
    expectEligibility: { candidateWorkCountry: 'unknown', mandatoryLanguage: 'unknown' },
  },
  {
    id: 'F02',
    title: 'Frontend Developer (React)',
    company: 'Example Co 02',
    location: 'Remote',
    description: `Responsibilities
Build React and TypeScript user interfaces for our web app.
Improve performance and accessibility of the frontend.
Requirements
Professional React and TypeScript experience.`,
    availability: 'in_configured_source',
    tags: ['frontend_control'],
    expect: { frontend: fe('relevant', 'React/TypeScript frontend.'), backend_research: be('not_relevant', 'Frontend only.') },
  },
  {
    id: 'F03',
    title: 'UI Engineer',
    company: 'Example Co 03',
    location: 'Remote',
    description: FRONTEND_BODY,
    availability: 'in_configured_source',
    tags: ['frontend_control'],
    expect: { frontend: fe('relevant', 'UI engineering on a design system.'), backend_research: be('not_relevant', 'Frontend only.') },
  },
  {
    id: 'F04',
    title: 'Design Systems Engineer',
    company: 'Example Co 04',
    location: 'Remote',
    description: `Responsibilities
Build web components and React components for our design system.
Own design tokens, documentation and accessibility checks.
Requirements
TypeScript, React and accessibility experience.`,
    availability: 'in_configured_source',
    tags: ['frontend_control'],
    expect: { frontend: fe('relevant', 'Design-system frontend.'), backend_research: be('not_relevant', 'Frontend only.') },
  },
  {
    id: 'F05',
    title: 'Web Platform Engineer',
    company: 'Example Co 05',
    location: 'Remote',
    description: `Responsibilities
Improve browser performance of our web applications.
Build Web Components and shared TypeScript tooling for product teams.
Requirements
Deep knowledge of browsers, TypeScript and frontend build tooling.`,
    availability: 'in_configured_source',
    tags: ['frontend_control', 'ambiguous_platform_product'],
    expect: { frontend: fe('relevant', 'Browser/web-platform frontend work despite "platform" in the title.'), backend_research: be('not_relevant', 'Browser work.') },
  },
  {
    id: 'F06',
    title: 'Frontend ontwikkelaar',
    company: 'Example Co 06',
    location: 'Utrecht, Netherlands',
    description: `Je bouwt webapplicaties met Angular en TypeScript.
Je werkt aan toegankelijke componenten voor ons design system.`,
    availability: 'in_configured_source',
    tags: ['frontend_control', 'non_english_title'],
    expect: { frontend: fe('relevant', 'Dutch-language frontend posting (Angular/TypeScript).'), backend_research: be('not_relevant', 'Frontend only.') },
  },

  // ---- Equivalent frontend titles the current title rule does not name ----
  {
    id: 'F07',
    title: 'Senior UI Developer',
    company: 'Example Co 07',
    location: 'Remote',
    description: FRONTEND_BODY,
    availability: 'in_configured_source',
    tags: ['equivalent_title'],
    expect: { frontend: fe('relevant', 'Same work as F03 under a "UI Developer" title.'), backend_research: be('not_relevant', 'Frontend only.') },
  },
  {
    id: 'F08',
    title: 'Senior Vue.js Developer',
    company: 'Example Co 08',
    location: 'Remote',
    description: `Responsibilities
Build our customer web app with Vue 3, Nuxt and TypeScript.
Create reusable, accessible UI components.
Requirements
Strong Vue and TypeScript experience; CSS architecture.`,
    availability: 'in_configured_source',
    tags: ['equivalent_title'],
    expect: { frontend: fe('relevant', 'Frontend role in a framework the candidate lists as an additional skill.'), backend_research: be('not_relevant', 'Frontend only.') },
  },
  {
    id: 'F09',
    title: 'Client-side Engineer',
    company: 'Example Co 09',
    location: 'Remote',
    description: `Responsibilities
Develop single-page applications in TypeScript and React.
Own client-side state management and rendering performance.
Requirements
Strong JavaScript, TypeScript and browser fundamentals.`,
    availability: 'in_configured_source',
    tags: ['equivalent_title'],
    expect: { frontend: fe('relevant', 'Client-side SPA work.'), backend_research: be('not_relevant', 'Frontend only.') },
  },
  {
    id: 'F10',
    title: 'Senior Web Engineer',
    company: 'Example Co 10',
    location: 'Remote',
    description: `Responsibilities
Build accessible user interfaces in TypeScript and React.
Work on our web application and its component library.
Requirements
React, TypeScript, CSS and accessibility experience.`,
    availability: 'in_configured_source',
    tags: ['equivalent_title'],
    expect: { frontend: fe('relevant', 'Web/UI work under a generic web title.'), backend_research: be('not_relevant', 'Frontend only.') },
  },
  {
    id: 'F11',
    title: 'Frontend-Entwickler (m/w/d)',
    company: 'Example Co 11',
    location: 'Berlin, Germany',
    description: `Responsibilities
Build React and TypeScript features for our web application.
Requirements
Strong React and TypeScript experience.`,
    availability: 'in_configured_source',
    tags: ['equivalent_title', 'non_english_title'],
    expect: { frontend: fe('relevant', 'German-titled frontend role with English text.'), backend_research: be('not_relevant', 'Frontend only.') },
  },

  // ---- Mixed / full-stack ----
  {
    id: 'M01',
    title: 'Full-Stack Engineer (TypeScript)',
    company: 'Example Co 12',
    location: 'Remote',
    description: `Responsibilities
Build React user interfaces for our web app.
Develop accessible UI components and frontend features.
Build Node.js APIs that serve those features.
Requirements
TypeScript, React and Node.js experience.`,
    availability: 'in_configured_source',
    tags: ['mixed_full_stack'],
    expect: { frontend: fe('adjacent', 'Frontend-weighted full-stack (a considered role).'), backend_research: be('adjacent', 'Some Node.js API work.') },
  },
  {
    id: 'M02',
    title: 'Full-Stack Developer',
    company: 'Example Co 13',
    location: 'Remote',
    description: `Responsibilities
Build Java and Spring Boot microservices.
Maintain Kafka event pipelines and backend services.
Occasionally fix small issues in a React admin screen.
Requirements
Java, Spring Boot and Kafka experience.`,
    availability: 'in_configured_source',
    tags: ['mixed_full_stack'],
    expect: { frontend: fe('not_relevant', 'Backend-dominated despite the full-stack title.'), backend_research: be('adjacent', 'Backend, but a JVM stack the candidate does not list.') },
  },
  {
    id: 'M03',
    title: 'Software Engineer',
    company: 'Example Co 14',
    location: 'Remote',
    description: `Responsibilities
Build features end to end in a full-stack TypeScript codebase.
Develop React user interfaces and the Node.js APIs behind them.
Design PostgreSQL schemas for new features.
Requirements
TypeScript, React, Node.js and PostgreSQL experience.`,
    availability: 'in_configured_source',
    tags: ['mixed_full_stack'],
    expect: { frontend: fe('adjacent', 'Balanced full-stack.'), backend_research: be('adjacent', 'Balanced full-stack.') },
  },
  {
    id: 'M04',
    title: 'Product Engineer',
    company: 'Example Co 15',
    location: 'Remote',
    description: `Responsibilities
Ship product features across the UI and the API.
Talk to customers and prototype quickly.
Requirements
Comfortable across the stack; we use TypeScript.`,
    availability: 'in_configured_source',
    tags: ['ambiguous_platform_product', 'mixed_full_stack'],
    expect: { frontend: fe('adjacent', 'Ambiguous product-engineering role; neither family dominates.'), backend_research: be('adjacent', 'Same ambiguity.') },
  },

  // ---- Ambiguous platform / clearly out of scope ----
  {
    id: 'A01',
    title: 'Platform Engineer',
    company: 'Example Co 16',
    location: 'Remote',
    description: `Responsibilities
Build our internal developer platform on Kubernetes and Terraform.
Own CI/CD pipelines and service templates for backend teams.
Requirements
Kubernetes, Terraform and Go experience.`,
    availability: 'in_configured_source',
    tags: ['ambiguous_platform_product'],
    expect: { frontend: fe('not_relevant', 'Infrastructure platform work.'), backend_research: be('adjacent', 'Listed target title, but infrastructure-heavy; neither backend nor frontend family.') },
  },
  {
    id: 'A02',
    title: 'Senior Product Designer',
    company: 'Example Co 17',
    location: 'Remote',
    description: `Responsibilities
Design user flows and high-fidelity prototypes in Figma.
Requirements
A portfolio of product design work.`,
    availability: 'in_configured_source',
    tags: ['out_of_scope'],
    expect: { frontend: fe('not_relevant', 'Design, not engineering.'), backend_research: be('not_relevant', 'Design.') },
  },
  {
    id: 'O01',
    title: 'Account Executive',
    company: 'Example Co 18',
    location: 'Remote',
    description: `Responsibilities
Own a sales quota for mid-market customers.
Requirements
Three years of SaaS sales experience.`,
    availability: 'in_configured_source',
    tags: ['out_of_scope'],
    expect: { frontend: fe('not_relevant', 'Sales.'), backend_research: be('not_relevant', 'Sales.') },
  },
  {
    id: 'O02',
    title: 'Data Scientist',
    company: 'Example Co 19',
    location: 'Remote',
    description: `Responsibilities
Build statistical models in Python.
Requirements
Python, SQL and statistics.`,
    availability: 'in_configured_source',
    tags: ['out_of_scope'],
    expect: { frontend: fe('not_relevant', 'Data science.'), backend_research: be('not_relevant', 'Data science.') },
  },
  {
    id: 'O03',
    title: 'Embedded Firmware Engineer',
    company: 'Example Co 20',
    location: 'Remote',
    description: `Responsibilities
Write C firmware for microcontrollers.
Requirements
Embedded C and RTOS experience.`,
    availability: 'in_configured_source',
    tags: ['out_of_scope'],
    expect: { frontend: fe('not_relevant', 'Embedded.'), backend_research: be('not_relevant', 'Embedded.') },
  },

  // ---- Backend family (research only) ----
  {
    id: 'B01',
    title: 'Senior Backend Engineer (Go)',
    company: 'Example Co 21',
    location: 'Remote',
    description: `Responsibilities
Build Go microservices and gRPC APIs.
Design PostgreSQL schemas and Kafka consumers.
Requirements
Go, PostgreSQL and distributed systems experience.`,
    availability: 'in_configured_source',
    tags: ['backend_family'],
    expect: { frontend: fe('not_relevant', 'Backend only.'), backend_research: be('relevant', 'Core Go backend work.') },
  },
  {
    id: 'B02',
    title: 'Senior Go Engineer',
    company: 'Example Co 22',
    location: 'Remote',
    description: `Responsibilities
Build Go services that process payments.
Own PostgreSQL data models and gRPC APIs.
Requirements
Go and PostgreSQL in production.`,
    availability: 'in_configured_source',
    tags: ['backend_family'],
    expect: { frontend: fe('not_relevant', 'Backend only.'), backend_research: be('relevant', 'Go backend under a language title.') },
  },
  {
    id: 'B03',
    title: 'Node.js Engineer',
    company: 'Example Co 23',
    location: 'Remote',
    description: `Responsibilities
Build Node.js and TypeScript API services.
Design PostgreSQL schemas and message queues.
Requirements
Node.js, TypeScript and PostgreSQL experience.`,
    availability: 'in_configured_source',
    tags: ['backend_family'],
    expect: { frontend: fe('not_relevant', 'Server-side TypeScript, no UI work.'), backend_research: be('relevant', 'Node.js backend.') },
  },
  {
    id: 'B04',
    title: 'Backend Developer (Python/Django)',
    company: 'Example Co 24',
    location: 'Remote',
    description: `Responsibilities
Build Django REST APIs and Celery workers.
Requirements
Python and Django experience.`,
    availability: 'in_configured_source',
    tags: ['backend_family'],
    expect: { frontend: fe('not_relevant', 'Backend only.'), backend_research: be('adjacent', 'Backend, other stack.') },
  },

  // ---- Sparse descriptions ----
  {
    id: 'S01',
    title: 'Senior Frontend Developer',
    company: 'Example Co 25',
    location: 'Remote',
    description: null,
    availability: 'in_configured_source',
    tags: ['sparse'],
    expect: { frontend: fe('relevant', 'The title alone names the target role; the text is missing.', 'sparse'), backend_research: be('not_relevant', 'Frontend title.', 'sparse') },
  },
  {
    id: 'S02',
    title: 'Frontend Engineer',
    company: 'Example Co 26',
    location: 'Remote',
    description: 'Join our team.',
    availability: 'in_configured_source',
    tags: ['sparse'],
    expect: { frontend: fe('relevant', 'Title names the target role; one-line text.', 'sparse'), backend_research: be('not_relevant', 'Frontend title.', 'sparse') },
  },
  {
    id: 'S03',
    title: 'Software Engineer',
    company: 'Example Co 27',
    location: 'Remote',
    description: null,
    availability: 'in_configured_source',
    tags: ['sparse'],
    expect: {
      frontend: fe(null, 'Generic title, no text: the author cannot label it.', 'sparse'),
      backend_research: be(null, 'Generic title, no text: the author cannot label it.', 'sparse'),
    },
  },
  {
    id: 'S04',
    title: 'Senior Backend Engineer',
    company: 'Example Co 28',
    location: 'Remote',
    description: null,
    availability: 'in_configured_source',
    tags: ['sparse', 'backend_family'],
    expect: { frontend: fe('not_relevant', 'Backend title.', 'sparse'), backend_research: be('relevant', 'Title names the target role; no text.', 'sparse') },
  },

  // ---- Language (frontend role, English-only candidate) ----
  {
    id: 'L01',
    title: 'Senior Frontend Engineer',
    company: 'Example Co 29',
    location: 'Remote',
    description: `${FRONTEND_BODY}
Fluent German is required.`,
    availability: 'in_configured_source',
    tags: ['language_mandatory'],
    expect: { frontend: fe('relevant', 'Role fits; the mandatory German is an eligibility fact, not a role fact.'), backend_research: be('not_relevant', 'Frontend only.') },
    expectEligibility: { mandatoryLanguage: 'no' },
  },
  {
    id: 'L02',
    title: 'Senior Frontend Engineer',
    company: 'Example Co 30',
    location: 'Remote',
    description: `${FRONTEND_BODY}
German is a plus.`,
    availability: 'in_configured_source',
    tags: ['language_preferred'],
    expect: { frontend: fe('relevant', 'Preferred language never gates.'), backend_research: be('not_relevant', 'Frontend only.') },
    expectEligibility: { mandatoryLanguage: 'unknown' },
  },
  {
    id: 'L03',
    title: 'Senior Frontend Engineer',
    company: 'Example Co 31',
    location: 'Remote',
    description: `${FRONTEND_BODY}
Our team speaks German and English day to day.`,
    availability: 'in_configured_source',
    tags: ['language_unclear'],
    expect: { frontend: fe('relevant', 'The sentence states no obligation; it sits after the Requirements heading.'), backend_research: be('not_relevant', 'Frontend only.') },
    expectEligibility: { mandatoryLanguage: 'unknown' },
  },
  {
    id: 'L05',
    title: 'Senior Frontend Engineer',
    company: 'Example Co 41',
    location: 'Remote',
    description: `Our team speaks German and English day to day.
${FRONTEND_BODY}`,
    availability: 'in_configured_source',
    tags: ['language_unclear'],
    expect: { frontend: fe('relevant', 'Same unclear sentence as L03, placed before any requirements heading.'), backend_research: be('not_relevant', 'Frontend only.') },
    expectEligibility: { mandatoryLanguage: 'unknown' },
  },
  {
    id: 'L06',
    title: 'Senior Frontend Engineer',
    company: 'Example Co 42',
    location: 'Remote',
    description: `${FRONTEND_BODY}
About us
Our team speaks German and English day to day.`,
    availability: 'in_configured_source',
    tags: ['language_unclear'],
    expect: { frontend: fe('relevant', 'Same unclear sentence as L03, under a later "About us" heading.'), backend_research: be('not_relevant', 'Frontend only.') },
    expectEligibility: { mandatoryLanguage: 'unknown' },
  },
  {
    id: 'L04',
    title: 'Frontend ontwikkelaar',
    company: 'Example Co 32',
    location: 'Amsterdam, Netherlands',
    description: `Je bouwt webapplicaties met Angular en TypeScript.
Vloeiend Nederlands is vereist.`,
    availability: 'in_configured_source',
    tags: ['language_mandatory', 'non_english_title'],
    expect: {
      frontend: fe('relevant', 'Role fits; Dutch is stated as required in Dutch ("vereist"), an eligibility fact the author reads as mandatory.'),
      backend_research: be('not_relevant', 'Frontend only.'),
    },
    // The author reads this as mandatory Dutch. The assessor's markers are English, so it is expected to stay
    // unknown -- recorded as a detection limit, never turned into "no" by this research.
    expectEligibility: { mandatoryLanguage: 'unknown' },
  },

  // ---- Work-country eligibility (frontend role) ----
  {
    id: 'E01',
    title: 'Senior Frontend Engineer',
    company: 'Example Co 33',
    location: 'Remote',
    description: `${FRONTEND_BODY}
This role is open to candidates based in the United States only.`,
    availability: 'in_configured_source',
    tags: ['country_known_mismatch'],
    expect: { frontend: fe('relevant', 'Role fits; the US-only statement is a known work-country mismatch, kept apart from role fit.'), backend_research: be('not_relevant', 'Frontend only.') },
    expectEligibility: { candidateWorkCountry: 'no' },
  },
  {
    id: 'E02',
    title: 'Senior Frontend Engineer',
    company: 'Example Co 34',
    location: 'Remote',
    description: `${FRONTEND_BODY}
We are a fully remote team.`,
    availability: 'in_configured_source',
    tags: ['country_unknown'],
    expect: { frontend: fe('relevant', '"Remote" alone says nothing about where the candidate may live.'), backend_research: be('not_relevant', 'Frontend only.') },
    expectEligibility: { candidateWorkCountry: 'unknown' },
  },
  {
    id: 'E03',
    title: 'Senior Frontend Engineer',
    company: 'Example Co 35',
    location: 'Remote',
    description: `${FRONTEND_BODY}
This role is open to candidates in the Netherlands or Germany.`,
    availability: 'in_configured_source',
    tags: ['country_accepted'],
    expect: { frontend: fe('relevant', 'Stated country restriction includes the candidate country.'), backend_research: be('not_relevant', 'Frontend only.') },
    expectEligibility: { candidateWorkCountry: 'yes' },
  },

  // ---- Preferred versus mandatory requirements ----
  {
    id: 'R01',
    title: 'Senior Frontend Engineer',
    company: 'Example Co 36',
    location: 'Remote',
    description: `Responsibilities
Build our Angular and TypeScript web application.
Requirements
Strong Angular and TypeScript experience.
Nice to have
Kubernetes, Terraform and Go.`,
    availability: 'in_configured_source',
    tags: ['preferred_vs_mandatory'],
    expect: { frontend: fe('relevant', 'Backend/infra terms are only nice-to-have.'), backend_research: be('not_relevant', 'Frontend core; Go is only a nice-to-have.') },
  },
  {
    id: 'R02',
    title: 'Software Engineer',
    company: 'Example Co 37',
    location: 'Remote',
    description: `Responsibilities
Build Java microservices and Kafka pipelines.
Own backend services and their PostgreSQL databases.
Requirements
Java, Spring Boot and Kafka.
Nice to have
Angular, React and TypeScript.`,
    availability: 'in_configured_source',
    tags: ['preferred_vs_mandatory'],
    expect: { frontend: fe('not_relevant', 'Frontend terms are only nice-to-have; core is backend.'), backend_research: be('adjacent', 'Backend, JVM stack.') },
  },
  {
    id: 'R03',
    title: 'Frontend Engineer',
    company: 'Example Co 38',
    location: 'Remote',
    description: `Responsibilities
Build React and TypeScript features for our web app.
Requirements
Must have: React, TypeScript.
Must have: 3+ years of Kubernetes operations experience.`,
    availability: 'in_configured_source',
    tags: ['preferred_vs_mandatory'],
    expect: { frontend: fe('relevant', 'Frontend role with a mandatory non-frontend requirement; the candidate should see it and the gap.'), backend_research: be('not_relevant', 'Frontend role.') },
  },

  // ---- Hard negatives that a frontend query plan DOES retrieve (added so frontend ranking has real pairs) ----
  {
    id: 'N01',
    title: 'Full-Stack Engineer',
    company: 'Example Co 43',
    location: 'Remote',
    description: `Responsibilities
Build Java and Spring Boot services and Kafka pipelines.
Own PostgreSQL databases and backend APIs.
Partner with our Senior Frontend Engineer on API contracts.
Requirements
Java, Spring Boot and Kafka experience.`,
    availability: 'in_configured_source',
    tags: ['plan_matched_hard_negative', 'mixed_full_stack'],
    expect: { frontend: fe('not_relevant', 'Backend work; the frontend title appears only as a colleague.'), backend_research: be('adjacent', 'Backend, JVM stack.') },
  },
  {
    id: 'N02',
    title: 'Senior UI Engineer in Test',
    company: 'Example Co 44',
    location: 'Remote',
    description: `Responsibilities
Build automated end-to-end tests for our web UI with Playwright.
Own the test strategy and CI test reports.
Requirements
Test automation experience with Playwright or Cypress.`,
    availability: 'in_configured_source',
    tags: ['plan_matched_hard_negative'],
    expect: { frontend: fe('not_relevant', 'Test automation role; frontend-adjacent tooling, not frontend product engineering.'), backend_research: be('not_relevant', 'Test automation.') },
  },
  {
    id: 'N03',
    title: 'Frontend Engineering Manager',
    company: 'Example Co 45',
    location: 'Remote',
    description: `Responsibilities
Manage a team of eight frontend engineers.
Own hiring, career growth and delivery planning.
Requirements
People management experience in frontend teams.`,
    availability: 'in_configured_source',
    tags: ['plan_matched_hard_negative'],
    expect: { frontend: fe('not_relevant', 'People management; the profile targets hands-on roles.'), backend_research: be('not_relevant', 'Management.') },
  },
  {
    id: 'N04',
    title: 'UI Developer (Unity)',
    company: 'Example Co 46',
    location: 'Remote',
    description: `Responsibilities
Build in-game user interfaces in Unity with C#.
Work with game designers on HUD and menu flows.
Requirements
Unity and C# experience.`,
    availability: 'in_configured_source',
    tags: ['plan_matched_hard_negative'],
    expect: { frontend: fe('not_relevant', 'Game UI in Unity/C#, not web frontend.'), backend_research: be('not_relevant', 'Game UI.') },
  },

  // ---- Discovery absence ----
  {
    id: 'D01',
    title: 'Senior Frontend Engineer',
    company: 'Example Co 39',
    location: 'Remote',
    description: FRONTEND_BODY,
    availability: 'not_in_any_configured_source',
    tags: ['discovery_absent', 'frontend_control'],
    expect: { frontend: fe('relevant', 'A perfect fit that no configured source returns.'), backend_research: be('not_relevant', 'Frontend only.') },
  },
  {
    id: 'D02',
    title: 'Senior Backend Engineer',
    company: 'Example Co 40',
    location: 'Remote',
    description: `Responsibilities
Build Go services and PostgreSQL data models.
Requirements
Go and PostgreSQL.`,
    availability: 'not_in_any_configured_source',
    tags: ['discovery_absent', 'backend_family'],
    expect: { frontend: fe('not_relevant', 'Backend.'), backend_research: be('relevant', 'A fit no configured source returns.') },
  },
];

/**
 * Outcome records that must never become role or skill truth. Attached to some cases in the invariance check
 * only; nothing in the evaluation reads them.
 */
export const OUTCOME_NOISE: Readonly<Record<string, 'applied' | 'rejected' | 'no_response' | 'interview'>> = {
  F01: 'rejected',
  F07: 'no_response',
  M01: 'interview',
  B01: 'applied',
  S01: 'rejected',
  L01: 'no_response',
};
