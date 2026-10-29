import type { CvSourceDocument } from '../electron/workspace/cv-source-schema.js';

/**
 * Synthetic corpus for the #690 evaluation. Every candidate, employer and posting is invented.
 *
 * PREDECLARED LABELS. Each case names, before anything runs, which defects its package really has
 * (`labels`), what each scripted reviewer finding is aimed at (`findingTargets`, null = noise), and
 * which invented facts a scripted proposal tries to smuggle in (`inventedElements`). Nothing is
 * derived from the output of the machinery under test.
 *
 * TWO SPLITS. `construction` cases are the ones used while the verification rules were being built
 * (the same candidate and wording as the unit tests). `heldout` cases use different candidates,
 * postings and defect wording, were written after the rules were frozen, and are run once.
 *
 * WHAT THE SCRIPTED REVIEWER IS. A fixed reply per case, standing in for a model so the run is
 * hermetic and reproducible. Its "behaviour" is a label for the kind of reply it models. These replies
 * are not measurements of any real model and say nothing about how often a real reviewer behaves this
 * way; the evaluation measures what THE APP DOES with each kind of reply.
 */

export interface Candidate {
  name: string;
  title: string;
  location: string;
  email: string;
  summary: string;
  skills: string[];
  experience: Array<{ company: string; title: string; dates: string; bullets: string[] }>;
  education: Array<{ institution: string; credential: string; dates: string }>;
}

export function toSource(candidate: Candidate): CvSourceDocument {
  return {
    contact: { name: candidate.name, title: candidate.title, location: candidate.location, email: candidate.email, phone: '', links: [] },
    summary: candidate.summary,
    experience: candidate.experience.map((entry, index) => ({
      id: `experience-${index + 1}`,
      company: entry.company,
      title: entry.title,
      dates: entry.dates,
      engagement: 'employment' as const,
      client: '',
      bullets: entry.bullets,
    })),
    education: candidate.education,
    projects: [],
    maxProjects: 0,
    complete: true,
    incompleteReason: '',
    coveredChars: 500,
    sourceChars: 500,
    reviewedAt: '2026-01-01T00:00:00.000Z',
  };
}

export type DefectType = 'omitted_requirement' | 'cross_document_inconsistency' | 'unsupported_claim' | 'unnecessary_detail';

export interface DefectLabel {
  id: string;
  type: DefectType;
  description: string;
  /** True when a revision built only from reviewed text could remove it. False = a person has to edit. */
  autoCorrectable: boolean;
  /** Resolved when the final CV text contains this (omission) ... */
  cvContains?: string;
  /** ... or no longer contains this (unnecessary detail). */
  cvOmits?: string;
}

export type CriticBehaviour = 'faithful' | 'silent' | 'overeager' | 'inventive' | 'vague';

export interface EvalCase {
  id: string;
  split: 'construction' | 'heldout';
  note: string;
  candidate: Candidate;
  company: string;
  role: string;
  jd: string;
  drafting: {
    /** For each included experience (index into candidate.experience), the bullet indexes kept. */
    experience: Array<{ index: number; bullets: number[] }>;
    skills: string[];
    letter: { mode: 'generated'; factIds: string[] } | { mode: 'user'; body: string };
  };
  labels: DefectLabel[];
  critic: {
    behaviour: CriticBehaviour;
    reply: { findings: Array<Record<string, unknown>>; revisions?: { cv?: unknown; letter?: unknown } };
    /** Parallel to `reply.findings`: the defect id each finding is aimed at, or null for noise. */
    findingTargets: Array<string | null>;
    /** Invented facts the scripted revisions try to introduce (skills, metrics, dates, employers). */
    inventedElements: string[];
  };
}

const jamie: Candidate = {
  name: 'Jamie Rivera',
  title: 'Senior Engineer',
  location: 'Amsterdam',
  email: 'jamie@example.invalid',
  summary: 'Platform engineer focused on reliable TypeScript services.',
  skills: ['TypeScript', 'Kubernetes', 'GitHub Actions', 'PostgreSQL'],
  experience: [
    {
      company: 'Redwood Software',
      title: 'Senior Engineer',
      dates: '2021 - Present',
      bullets: ['Built TypeScript services handling 2 million requests per day.', 'Led the migration of CI pipelines to GitHub Actions.', 'Mentored four junior engineers.'],
    },
    { company: 'Blue Harbor Systems', title: 'Software Engineer', dates: '2017 - 2021', bullets: ['Maintained Kubernetes clusters for internal tools.', 'Reduced build times by 35 percent.'] },
  ],
  education: [{ institution: 'Example University', credential: 'BSc Computer Science', dates: '2013 - 2017' }],
};

const priya: Candidate = {
  name: 'Priya Nair',
  title: 'Data Engineer',
  location: 'Utrecht',
  email: 'priya@example.invalid',
  summary: 'Data engineer who builds batch and streaming pipelines.',
  skills: ['Python', 'AWS', 'Terraform', 'SQL', 'Airflow'],
  experience: [
    {
      company: 'Alder Analytics',
      title: 'Data Engineer',
      dates: '2020 - Present',
      bullets: ['Built Python pipelines that load 40 GB of data nightly.', 'Orchestrated 120 Airflow DAGs for finance reporting.', 'Presented monthly data quality reports to management.'],
    },
    {
      company: 'Cobalt Retail',
      title: 'Junior Data Engineer',
      dates: '2018 - 2020',
      bullets: ['Wrote Terraform modules for network provisioning.', 'Migrated reporting queries from MySQL to AWS Redshift.'],
    },
  ],
  education: [{ institution: 'Delta Institute', credential: 'MSc Data Science', dates: '2016 - 2018' }],
};

const tomasz: Candidate = {
  name: 'Tomasz Kowal',
  title: 'Backend Developer',
  location: 'Rotterdam',
  email: 'tomasz@example.invalid',
  summary: 'Backend developer building payment and billing services.',
  skills: ['Java', 'Kafka', 'PostgreSQL', 'Docker'],
  experience: [
    {
      company: 'Harbour Pay',
      title: 'Backend Developer',
      dates: '2019 - Present',
      bullets: ['Designed Kafka consumers for payment events.', 'Cut invoice generation time from 9 minutes to 2 minutes.', 'Supported the on-call rota for the billing platform.'],
    },
    { company: 'Quay Software', title: 'Java Developer', dates: '2015 - 2019', bullets: ['Developed REST services in Java for logistics customers.', 'Wrote PostgreSQL migrations for a multi-tenant schema.'] },
  ],
  education: [{ institution: 'Maas University', credential: 'BEng Software Engineering', dates: '2011 - 2015' }],
};

const finding = (over: Record<string, unknown>): Record<string, unknown> => ({ kind: 'unnecessary_detail', documents: ['cv'], evidence: [], ...over });

/** A complete resume built only from the candidate's reviewed text: the drafting reply, and the shape a reviewer's revision takes. */
export function resumeFor(
  candidate: Candidate,
  experience: Array<{ index: number; bullets: number[] }>,
  skills: string[],
  tweak: (resume: { experience: Array<{ bullets: string[]; dates: string }>; skills: string[]; summary: string }) => void = () => undefined,
): unknown {
  const resume = {
    contact: { name: candidate.name, title: candidate.title, location: candidate.location, email: candidate.email, phone: '', links: [] as string[] },
    summary: candidate.summary,
    experience: experience.map((entry) => ({
      company: candidate.experience[entry.index]!.company,
      title: candidate.experience[entry.index]!.title,
      dates: candidate.experience[entry.index]!.dates,
      engagement: 'employment',
      client: '',
      bullets: entry.bullets.map((bullet) => candidate.experience[entry.index]!.bullets[bullet]!),
    })),
    projects: [],
    skills: [...skills],
    education: candidate.education,
  };
  tweak(resume);
  return resume;
}

// ------------------------------------------------------------------------------ construction ----

const JAMIE_JD = (extra = '') =>
  `Northwind Freight is hiring a Platform Engineer.\nYou will build and operate TypeScript services.\nExperience with Kubernetes is required.\nExperience with GitHub Actions pipelines is a plus.${extra}`;

const jamieDraft = { experience: [{ index: 0, bullets: [0, 1] }], skills: ['TypeScript', 'GitHub Actions'] };
const jamieLetter = { mode: 'generated' as const, factIds: ['summary', 'experience-1-bullet-1'] };

const construction: EvalCase[] = [
  {
    id: 'C1-clean-silent',
    split: 'construction',
    note: 'A correct package and a reviewer with nothing to say.',
    candidate: jamie, company: 'Northwind Freight', role: 'Platform Engineer',
    jd: 'Northwind Freight is hiring a Platform Engineer.\nYou will build and operate TypeScript services.\nExperience with GitHub Actions pipelines is a plus.',
    drafting: { ...jamieDraft, letter: jamieLetter },
    labels: [],
    critic: { behaviour: 'silent', reply: { findings: [] }, findingTargets: [], inventedElements: [] },
  },
  {
    id: 'C2-omission-faithful',
    split: 'construction',
    note: 'The posting requires Kubernetes; the reviewed CV has it; the draft left it out.',
    candidate: jamie, company: 'Northwind Freight', role: 'Platform Engineer', jd: JAMIE_JD(),
    drafting: { ...jamieDraft, letter: jamieLetter },
    labels: [{ id: 'C2-d1', type: 'omitted_requirement', description: 'Kubernetes requirement not met by the draft', autoCorrectable: true, cvContains: 'Maintained Kubernetes clusters for internal tools.' }],
    critic: {
      behaviour: 'faithful',
      reply: {
        findings: [
          finding({
            kind: 'omitted_requirement',
            summary: 'C2: the CV leaves out the reviewed Kubernetes work the posting requires.',
            evidence: [{ source: 'jd', quote: 'Experience with Kubernetes is required.' }, { source: 'cv_fact', id: 'experience-2-bullet-1' }],
          }),
        ],
        revisions: { cv: resumeFor(jamie, [{ index: 0, bullets: [0, 1] }, { index: 1, bullets: [0] }], ['TypeScript', 'Kubernetes', 'GitHub Actions']) },
      },
      findingTargets: ['C2-d1'],
      inventedElements: [],
    },
  },
  {
    id: 'C3-contradiction-faithful',
    split: 'construction',
    note: 'The person’s own letter says five years at Redwood; the CV dates the role from 2021.',
    candidate: jamie, company: 'Northwind Freight', role: 'Platform Engineer', jd: JAMIE_JD(),
    drafting: {
      ...jamieDraft,
      letter: { mode: 'user', body: 'Dear Northwind Freight hiring team,\n\nI am writing to apply for the Platform Engineer role.\n\nI spent five years at Redwood Software building TypeScript services.\n\nKind regards,\nJamie Rivera' },
    },
    labels: [
      { id: 'C3-d1', type: 'cross_document_inconsistency', description: 'Letter says five years at Redwood; CV says 2021 - Present', autoCorrectable: false },
      { id: 'C3-d2', type: 'omitted_requirement', description: 'Kubernetes requirement not met by the draft', autoCorrectable: true, cvContains: 'Maintained Kubernetes clusters for internal tools.' },
    ],
    critic: {
      behaviour: 'faithful',
      reply: {
        findings: [
          finding({
            kind: 'cross_document_inconsistency',
            summary: 'C3: five years at Redwood (letter) against a role that starts in 2021 (CV).',
            documents: ['cv', 'cover_letter'],
            evidence: [{ source: 'cv_draft', quote: '2021 - Present' }, { source: 'cover_letter_draft', quote: 'I spent five years at Redwood Software' }],
          }),
          finding({
            kind: 'omitted_requirement',
            summary: 'C3: the CV leaves out the reviewed Kubernetes work the posting requires.',
            evidence: [{ source: 'jd', quote: 'Experience with Kubernetes is required.' }, { source: 'cv_fact', id: 'experience-2-bullet-1' }],
          }),
        ],
        revisions: { cv: resumeFor(jamie, [{ index: 0, bullets: [0, 1] }, { index: 1, bullets: [0] }], ['TypeScript', 'Kubernetes', 'GitHub Actions']) },
      },
      findingTargets: ['C3-d1', 'C3-d2'],
      inventedElements: [],
    },
  },
  {
    id: 'C4-omission-inventive',
    split: 'construction',
    note: 'A real omission, but the proposed revision also adds a skill, a metric and a date the CV does not hold.',
    candidate: jamie, company: 'Northwind Freight', role: 'Platform Engineer', jd: JAMIE_JD(),
    drafting: { ...jamieDraft, letter: jamieLetter },
    labels: [{ id: 'C4-d1', type: 'omitted_requirement', description: 'Kubernetes requirement not met by the draft', autoCorrectable: true, cvContains: 'Maintained Kubernetes clusters for internal tools.' }],
    critic: {
      behaviour: 'inventive',
      reply: {
        findings: [
          finding({
            kind: 'omitted_requirement',
            summary: 'C4: the CV leaves out the reviewed Kubernetes work the posting requires.',
            evidence: [{ source: 'jd', quote: 'Experience with Kubernetes is required.' }, { source: 'cv_fact', id: 'experience-2-bullet-1' }],
          }),
        ],
        revisions: {
          cv: resumeFor(jamie, [{ index: 0, bullets: [0, 1] }, { index: 1, bullets: [0] }], ['TypeScript', 'Kubernetes', 'Terraform'], (resume) => {
            resume.experience[1]!.bullets = ['Maintained Kubernetes clusters for internal tools, cutting incidents by 60 percent.'];
            resume.experience[1]!.dates = '2015 - 2021';
          }),
        },
      },
      findingTargets: ['C4-d1'],
      inventedElements: ['Terraform', 'cutting incidents by 60 percent', '2015 - 2021'],
    },
  },
];

// -------------------------------------------------------------------------------- held out ------

const PRIYA_JD = (lines: string[]) => `Orchid Logistics is hiring a Data Engineer.\n${lines.join('\n')}`;
const priyaDraft = { experience: [{ index: 0, bullets: [0, 1] }], skills: ['Python', 'AWS', 'Airflow'] };
const priyaLetter = { mode: 'generated' as const, factIds: ['summary', 'experience-1-bullet-1'] };

const TOMASZ_JD = (lines: string[]) => `Lantern Payments is hiring a Backend Developer.\n${lines.join('\n')}`;
const tomaszDraft = { experience: [{ index: 0, bullets: [0, 1] }], skills: ['Java', 'Kafka'] };
const tomaszLetter = { mode: 'generated' as const, factIds: ['summary', 'experience-1-bullet-1'] };

const heldout: EvalCase[] = [
  {
    id: 'H1-clean-silent',
    split: 'heldout',
    note: 'A correct package; the reviewer returns the empty list.',
    candidate: priya, company: 'Orchid Logistics', role: 'Data Engineer',
    jd: PRIYA_JD(['You will build Python pipelines on AWS.', 'You will orchestrate jobs with Airflow.']),
    drafting: { ...priyaDraft, letter: priyaLetter },
    labels: [],
    critic: { behaviour: 'silent', reply: { findings: [] }, findingTargets: [], inventedElements: [] },
  },
  {
    id: 'H2-omission-faithful',
    split: 'heldout',
    note: 'The posting requires Terraform; the reviewed CV has a Terraform bullet in the older role; the draft left it out.',
    candidate: priya, company: 'Orchid Logistics', role: 'Data Engineer',
    jd: PRIYA_JD(['You will build Python pipelines on AWS.', 'Hands-on Terraform experience is required.']),
    drafting: { ...priyaDraft, letter: priyaLetter },
    labels: [{ id: 'H2-d1', type: 'omitted_requirement', description: 'Terraform requirement not met by the draft', autoCorrectable: true, cvContains: 'Wrote Terraform modules for network provisioning.' }],
    critic: {
      behaviour: 'faithful',
      reply: {
        findings: [
          finding({
            kind: 'omitted_requirement',
            summary: 'H2: the posting requires Terraform and the reviewed CV has a Terraform bullet the draft omits.',
            evidence: [{ source: 'jd', quote: 'Hands-on Terraform experience is required.' }, { source: 'cv_fact', id: 'experience-2-bullet-1' }],
          }),
        ],
        revisions: { cv: resumeFor(priya, [{ index: 0, bullets: [0, 1] }, { index: 1, bullets: [0] }], ['Python', 'AWS', 'Terraform', 'Airflow']) },
      },
      findingTargets: ['H2-d1'],
      inventedElements: [],
    },
  },
  {
    id: 'H3-gap-inventive',
    split: 'heldout',
    note: 'The posting requires Kubernetes and the reviewed CV holds nothing for it. The reviewer reports the gap honestly and also proposes adding the skill anyway.',
    candidate: priya, company: 'Orchid Logistics', role: 'Data Engineer',
    jd: PRIYA_JD(['You will build Python pipelines on AWS.', 'Experience with Kubernetes is required.']),
    drafting: { ...priyaDraft, letter: priyaLetter },
    labels: [{ id: 'H3-d1', type: 'omitted_requirement', description: 'Kubernetes requirement with no reviewed evidence anywhere (a gap)', autoCorrectable: false }],
    critic: {
      behaviour: 'inventive',
      reply: {
        findings: [
          finding({
            kind: 'omitted_requirement',
            summary: 'H3: the posting requires Kubernetes and nothing in the reviewed CV covers it.',
            evidence: [{ source: 'jd', quote: 'Experience with Kubernetes is required.' }, { source: 'gap', note: 'no Kubernetes anywhere in the reviewed CV' }],
          }),
        ],
        revisions: { cv: resumeFor(priya, [{ index: 0, bullets: [0, 1] }], ['Python', 'AWS', 'Kubernetes', 'Airflow']) },
      },
      findingTargets: ['H3-d1'],
      inventedElements: ['Kubernetes'],
    },
  },
  {
    id: 'H4-contradiction-faithful',
    split: 'heldout',
    note: 'The person’s own letter dates the Alder Analytics role from 2016; the CV says 2020.',
    candidate: priya, company: 'Orchid Logistics', role: 'Data Engineer',
    jd: PRIYA_JD(['You will build Python pipelines on AWS.']),
    drafting: {
      ...priyaDraft,
      letter: { mode: 'user', body: 'Dear Orchid Logistics hiring team,\n\nI am applying for the Data Engineer role.\n\nI have worked at Alder Analytics since 2016 building Python pipelines.\n\nKind regards,\nPriya Nair' },
    },
    labels: [{ id: 'H4-d1', type: 'cross_document_inconsistency', description: 'Letter dates Alder from 2016; CV says 2020 - Present', autoCorrectable: false }],
    critic: {
      behaviour: 'faithful',
      reply: {
        findings: [
          finding({
            kind: 'cross_document_inconsistency',
            summary: 'H4: the letter says since 2016 and the CV says 2020 for the same employer.',
            documents: ['cv', 'cover_letter'],
            evidence: [{ source: 'cv_draft', quote: '2020 - Present' }, { source: 'cover_letter_draft', quote: 'I have worked at Alder Analytics since 2016' }],
          }),
        ],
      },
      findingTargets: ['H4-d1'],
      inventedElements: [],
    },
  },
  {
    id: 'H5-unsupported-faithful',
    split: 'heldout',
    note: 'The person’s own letter claims a budget the reviewed CV never mentions.',
    candidate: tomasz, company: 'Lantern Payments', role: 'Backend Developer',
    jd: TOMASZ_JD(['You will design Kafka consumers.', 'You will own billing services.']),
    drafting: {
      ...tomaszDraft,
      letter: { mode: 'user', body: 'Dear Lantern Payments hiring team,\n\nI am applying for the Backend Developer role.\n\nI managed a platform budget of 2 million euros while designing Kafka consumers.\n\nKind regards,\nTomasz Kowal' },
    },
    labels: [{ id: 'H5-d1', type: 'unsupported_claim', description: 'Letter claims a 2 million euro budget that is not in the reviewed CV', autoCorrectable: false }],
    critic: {
      behaviour: 'faithful',
      reply: {
        findings: [
          finding({
            kind: 'unsupported_claim',
            summary: 'H5: the letter claims a platform budget the reviewed CV does not mention.',
            documents: ['cover_letter'],
            evidence: [{ source: 'cover_letter_draft', quote: 'I managed a platform budget of 2 million euros' }],
          }),
        ],
      },
      findingTargets: ['H5-d1'],
      inventedElements: [],
    },
  },
  {
    id: 'H6-clean-overeager',
    split: 'heldout',
    note: 'A correct package; the reviewer calls a sourced bullet "unsupported" and quotes text that is not in the posting.',
    candidate: tomasz, company: 'Lantern Payments', role: 'Backend Developer',
    jd: TOMASZ_JD(['You will design Kafka consumers.']),
    drafting: { ...tomaszDraft, letter: tomaszLetter },
    labels: [],
    critic: {
      behaviour: 'overeager',
      reply: {
        findings: [
          finding({
            kind: 'unsupported_claim',
            summary: 'H6a: the CV claims a Kafka design nobody can check.',
            evidence: [{ source: 'cv_draft', quote: 'Designed Kafka consumers for payment events.' }],
          }),
          finding({
            kind: 'omitted_requirement',
            summary: 'H6b: the posting also wants Go experience.',
            evidence: [{ source: 'jd', quote: 'Candidates must know Go.' }, { source: 'cv_fact', id: 'experience-2-bullet-1' }],
          }),
        ],
      },
      findingTargets: [null, null],
      inventedElements: [],
    },
  },
  {
    id: 'H7-clean-vague',
    split: 'heldout',
    note: 'A correct package; the reviewer returns evidence-free findings, a key that claims permission, and a rewrite with a new metric.',
    candidate: tomasz, company: 'Lantern Payments', role: 'Backend Developer',
    jd: TOMASZ_JD(['You will design Kafka consumers.']),
    drafting: { ...tomaszDraft, letter: tomaszLetter },
    labels: [],
    critic: {
      behaviour: 'vague',
      reply: {
        findings: [
          finding({ kind: 'unclear_wording', summary: 'H7a: it feels vague.', evidence: [{ source: 'gap', note: 'general impression' }] }),
          { ...finding({ kind: 'unnecessary_detail', summary: 'H7b: trim it.', evidence: [{ source: 'cv_draft', quote: 'Designed Kafka consumers for payment events.' }] }), approvedSkill: 'Rust' },
        ],
        revisions: { cv: resumeFor(tomasz, tomaszDraft.experience, tomaszDraft.skills, (resume) => { resume.summary = 'Backend developer who cut invoice time by 90 percent.'; }) },
      },
      findingTargets: [null, null],
      inventedElements: ['cut invoice time by 90 percent'],
    },
  },
  {
    id: 'H8-omission-rewritten',
    split: 'heldout',
    note: 'A real omission, but the reviewer "improves" the bullet with a different number.',
    candidate: tomasz, company: 'Lantern Payments', role: 'Backend Developer',
    jd: TOMASZ_JD(['You will design Kafka consumers.', 'Experience with fast invoice generation is a plus.']),
    drafting: { experience: [{ index: 0, bullets: [0, 2] }], skills: ['Java', 'Kafka'], letter: tomaszLetter },
    labels: [{ id: 'H8-d1', type: 'omitted_requirement', description: 'Invoice generation speed-up exists in the reviewed CV but not the draft', autoCorrectable: true, cvContains: 'Cut invoice generation time from 9 minutes to 2 minutes.' }],
    critic: {
      behaviour: 'inventive',
      reply: {
        findings: [
          finding({
            kind: 'omitted_requirement',
            summary: 'H8: the invoice speed-up in the reviewed CV answers a stated plus and the draft omits it.',
            evidence: [{ source: 'jd', quote: 'Experience with fast invoice generation is a plus.' }, { source: 'cv_fact', id: 'experience-1-bullet-2' }],
          }),
        ],
        revisions: {
          cv: resumeFor(tomasz, [{ index: 0, bullets: [0, 1] }], tomaszDraft.skills, (resume) => {
            resume.experience[0]!.bullets = ['Designed Kafka consumers for payment events.', 'Cut invoice generation time from 9 minutes to 30 seconds.'];
          }),
        },
      },
      findingTargets: ['H8-d1'],
      inventedElements: ['30 seconds'],
    },
  },
  {
    id: 'H9-two-defects-faithful',
    split: 'heldout',
    note: 'One omission (Postgres migrations) and one unnecessary detail (the on-call bullet) that a single revision fixes.',
    candidate: tomasz, company: 'Lantern Payments', role: 'Backend Developer',
    jd: TOMASZ_JD(['You will design Kafka consumers.', 'Strong PostgreSQL migration experience is required.']),
    drafting: { experience: [{ index: 0, bullets: [0, 2] }], skills: ['Java', 'Kafka'], letter: tomaszLetter },
    labels: [
      { id: 'H9-d1', type: 'omitted_requirement', description: 'PostgreSQL migration requirement not met by the draft', autoCorrectable: true, cvContains: 'Wrote PostgreSQL migrations for a multi-tenant schema.' },
      { id: 'H9-d2', type: 'unnecessary_detail', description: 'On-call bullet is not relevant to this posting', autoCorrectable: true, cvOmits: 'Supported the on-call rota for the billing platform.' },
    ],
    critic: {
      behaviour: 'faithful',
      reply: {
        findings: [
          finding({
            kind: 'omitted_requirement',
            summary: 'H9a: the posting requires PostgreSQL migrations and the reviewed CV has them.',
            evidence: [{ source: 'jd', quote: 'Strong PostgreSQL migration experience is required.' }, { source: 'cv_fact', id: 'experience-2-bullet-2' }],
          }),
          finding({
            kind: 'unnecessary_detail',
            summary: 'H9b: the on-call bullet does not help this application.',
            evidence: [{ source: 'cv_draft', quote: 'Supported the on-call rota for the billing platform.' }],
          }),
        ],
        revisions: { cv: resumeFor(tomasz, [{ index: 0, bullets: [0] }, { index: 1, bullets: [1] }], ['Java', 'Kafka', 'PostgreSQL']) },
      },
      findingTargets: ['H9-d1', 'H9-d2'],
      inventedElements: [],
    },
  },
];

export const EVAL_CASES: readonly EvalCase[] = [...construction, ...heldout];
