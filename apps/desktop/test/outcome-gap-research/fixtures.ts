import { app, contribution, job, key, req, score, variant } from './builders.js';
import type { ApplicationObservation, EligibilityRecord, JobObservation, NoGoReason, RequirementRecord, SourceContribution } from './contract.js';
import type { PersonAliasGroup } from './requirements.js';

/**
 * Constructed, SYNTHETIC portfolios for the #693 evaluation. Every employer, role and person is invented.
 *
 * Every `expected` value below was declared by the fixture author (the implementer) from the written rules in
 * docs/outcome-gap-research.md BEFORE the code was run against it. They are fixture-author expectations, not human
 * labels, not a sample of anyone's real job search, and not validated by anybody. A portfolio marked
 * `projected_instrumentation` uses fields production does NOT record today (query attribution, status events,
 * exposure counts); its results show what the contract could support if follow-ups A and B shipped, never what the
 * app can do now.
 */

export const AS_OF = '2026-10-30T00:00:00.000Z';
const OLD = '2026-08-01T00:00:00.000Z'; // mature at AS_OF
const RECENT = '2026-10-22T00:00:00.000Z'; // censored at AS_OF (8 days)

export interface Expected {
  funnelOutcome: 'go_review' | 'no_go';
  funnelOutcomeReasons: NoGoReason[];
  requirements: 'go_review' | 'no_go';
  requirementReasons: NoGoReason[];
  /** Sorted `kind:subject` of every suggestion that must exist. */
  suggestions: string[];
}

export interface Portfolio {
  id: string;
  lane: 'current_shape' | 'projected_instrumentation';
  title: string;
  what: string;
  observations: JobObservation[];
  exposure?: Record<string, number> | null;
  aliasGroups?: PersonAliasGroup[];
  /** Result with NO alias applied (or the only result when there is no alias group). */
  expected: Expected;
  /** Result once the person has confirmed `aliasGroups`. */
  expectedWithAliases?: Expected;
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, index) => from + index);
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(2, '0')}`;
const dayOffset = (n: number): string => new Date(Date.UTC(2026, 6, 1) + n * 86_400_000).toISOString();

function eligibility(key_: string, answer: 'yes' | 'no' | 'unknown'): EligibilityRecord {
  return { key: key_, answer, classification: answer === 'yes' ? 'consistent' : answer === 'no' ? 'known_mismatch' : 'uncertain', source: answer === 'unknown' ? 'absent' : 'vacancy_text' };
}

// ------------------------------------------------------------------------------------------ rich (projected)

function richJob(i: number): JobObservation {
  const providers = i <= 12 ? ['greenhouse'] : i <= 22 ? ['lever'] : ['remotive'];
  if (i <= 4) providers.push('remotive');
  const refs = [variant('literal'), ...(i % 3 === 0 ? [variant('t2-platform')] : []), ...(i % 5 === 0 ? [variant('t3-sre', 'matched_locally')] : [])];
  const contributions: SourceContribution[] = providers.map((provider) => contribution(provider, refs));

  const apps: ApplicationObservation[] = [];
  if (i <= 25) {
    const submission = i % 3 === 0 ? 'user_stated' : i % 3 === 1 ? 'receipt_backed' : 'user_reported';
    const status = i <= 3 ? 'interview' : i <= 6 ? 'recruiter_screen' : i <= 13 ? 'rejected' : i === 14 ? 'withdrawn' : 'applied';
    const hasOutcome = status !== 'applied';
    apps.push(
      app(`a-${id('j', i)}`, submission, {
        sentAt: i <= 22 ? OLD : RECENT,
        status: i <= 22 ? status : 'applied',
        events: i <= 22 && hasOutcome ? { events: [{ status, source: 'user_set', occurredOn: '2026-09-15', recordedAt: '2026-09-16T08:00:00.000Z' }] } : 'current_value_only',
      }),
    );
  } else if (i <= 27) apps.push(app(`a-${id('j', i)}`, 'prepared', { status: 'preparing' }));
  else apps.push(app(`a-${id('j', i)}`, 'not_recorded', { status: 'preparing' }));

  const requirements: RequirementRecord[] = [];
  if (i <= 12) requirements.push(req('r1', 'TypeScript', 'direct'));
  if (i <= 5) requirements.push(req('r2', 'Kubernetes', 'unsupported'));
  else if (i <= 9) requirements.push(req('r2', 'Kubernetes', 'candidate_confirmed_gap'));
  else if (i <= 12) requirements.push(req('r2', 'Kubernetes', 'direct'));
  if (i >= 13 && i <= 16) requirements.push(req('r3', 'Terraform', 'needs_verification'));
  if (i >= 17 && i <= 19) requirements.push(req('r4', 'On-call rota', 'unsupported'));
  if (i === 3 || i === 14) requirements.push(req('r5', 'Go', 'unsupported'));

  const elig: EligibilityRecord[] = [];
  if (i <= 20) elig.push(eligibility('candidateWorkCountry', i >= 7 && i <= 11 ? 'no' : 'yes'));
  if (i === 20 || i === 21) elig.push(eligibility('mandatoryLanguage', 'no'));

  return job(id('j', i), {
    requisition: key('requisition', `ats:acme:${i}`),
    copies: i <= 4 ? 2 : 1,
    contributions,
    score: i % 7 === 0 ? score(null) : score(60 + ((i * 3) % 35), i % 2 === 1 ? 'Platform Engineer' : 'Site Reliability Engineer'),
    applications: apps,
    assessment: i <= 20 ? { state: 'current', requirements } : { state: 'none' },
    eligibility: elig,
    selectedAt: dayOffset(i),
  });
}

export function richObservations(): JobObservation[] {
  return range(1, 30).map(richJob);
}

/** Digest of distinct leads shown per variant: PROJECTED, nothing stores this today. */
export const RICH_EXPOSURE: Record<string, number> = { literal: 200, 't2-platform': 120, 't3-sre': 15 };

// --------------------------------------------------------------------------------------- the other portfolios

function sentJobs(count: number, make: (i: number) => Partial<Parameters<typeof job>[1]>, status: (i: number) => 'applied' | 'interview' | 'rejected' | 'recruiter_screen'): JobObservation[] {
  return range(1, count).map((i) =>
    job(id('s', i), {
      requisition: key('requisition', `ats:co${i}:${i}`),
      contributions: [contribution(i % 2 ? 'greenhouse' : 'lever')],
      applications: [app(`a-${id('s', i)}`, 'user_stated', { sentAt: OLD, status: status(i) })],
      ...make(i),
    }),
  );
}

/** Today's production shape: no query attribution, status history is the current value only, no exposure. */
function smallCurrentShape(): JobObservation[] {
  const jobs: JobObservation[] = [];
  jobs.push(job('c1', { requisition: key('requisition', 'ats:northwind:1001'), copies: 2, contributions: [contribution('ats_roster_greenhouse'), contribution('remotive')], applications: [app('a1', 'receipt_backed', { sentAt: '2026-09-01T09:00:00.000Z', status: 'interview', heldRounds: 1 }), app('a1b', 'user_reported', { sentAt: '2026-10-05T09:00:00.000Z', status: 'applied', reapplicationOf: 'a1' })], assessment: { state: 'current', requirements: [req('r1', 'TypeScript', 'direct'), req('r2', 'Kubernetes', 'unsupported')] } }));
  jobs.push(job('c2', { requisition: key('requisition', 'ats:northwind:1002'), applications: [app('a2', 'user_stated', { sentAt: '2026-09-05T09:00:00.000Z', status: 'rejected' })], eligibility: [eligibility('candidateWorkCountry', 'no')] }));
  jobs.push(job('c3', { requisition: key('requisition', 'ats:northwind:1003'), applications: [app('a3', 'prepared', { status: 'preparing' })], assessment: { state: 'current', requirements: [req('r2', 'Kubernetes', 'candidate_confirmed_gap')] } }));
  jobs.push(job('c4', { requisition: key('requisition', 'ats:northwind:1005'), score: score(null), applications: [app('a5', 'user_stated', { sentAt: RECENT, status: 'applied' })] }));
  jobs.push(job('c5', { requisition: key('canonical_url', 'https://jobs.example/listing/solo-role-9'), score: score(null), contributions: [], applications: [app('a6', 'user_stated', { sentAt: null, status: 'applied' })] }));
  jobs.push(job('c6', { requisition: key('requisition', 'ats:harbor:77'), applications: [] }));
  jobs.push(job('c7', { requisition: key('requisition', 'ats:harbor:78'), applications: [], assessment: { state: 'stale', requirements: [req('r2', 'Kubernetes', 'unsupported')] } }));
  jobs.push(job('c8', { requisition: key('requisition', 'ats:harbor:79'), applications: [] }));
  return jobs;
}

function titleOnly(): JobObservation[] {
  // Titles say "Kubernetes" and scores are high, but nothing was assessed: there is no requirement evidence at all.
  return range(1, 12).map((i) => job(id('t', i), { requisition: key('requisition', `ats:titles:${i}`), score: score(90, 'Platform Engineer'), applications: [app(`a-${id('t', i)}`, 'user_stated', { sentAt: OLD, status: 'rejected' })] }));
}

function mixedVersions(): JobObservation[] {
  const hashes = ['cvA', 'cvA', 'cvA', 'cvA', 'cvA', 'cvB', 'cvB', 'cvB', 'cvB', 'cvC', 'cvC', 'cvC'];
  return hashes.map((cvHash, index) =>
    job(id('v', index + 1), { requisition: key('requisition', `ats:ver:${index}`), assessment: { state: 'current', requirements: [req('r1', 'Kubernetes', 'unsupported')] }, versions: { cvHash } }),
  );
}

function olderRuleVersion(): JobObservation[] {
  return range(1, 12).map((i) => job(id('o', i), { requisition: key('requisition', `ats:old:${i}`), assessment: { state: 'current', requirements: [req('r1', 'Kubernetes', 'unsupported')] }, versions: { assessmentWorkflow: i <= 3 ? 'application-brief-v1' : i <= 9 ? 'application-brief-v0' : null } }));
}

function aliasPortfolio(): JobObservation[] {
  const names = ['Kubernetes', 'Kubernetes', 'K8s', 'K8s', 'Kube'];
  const rest = range(1, 5).map((i) => job(id('x', i), { requisition: key('requisition', `ats:filler:${i}`), assessment: { state: 'current', requirements: [req('r9', 'TypeScript', 'direct')] } }));
  const k8s = names.map((name, index) => job(id('k', index + 1), { requisition: key('requisition', `ats:alias:${index}`), assessment: { state: 'current', requirements: [req('r1', name, 'unsupported')] } }));
  return [...rest, ...k8s];
}

function isolation(): JobObservation[] {
  return [
    job('role-a', { requisition: key('requisition', 'ats:acme:100'), applications: [app('x1', 'user_stated', { sentAt: OLD, status: 'rejected' })], assessment: { state: 'current', requirements: [req('r1', 'Kubernetes', 'unsupported')] } }),
    job('role-b', { requisition: key('requisition', 'ats:acme:101'), applications: [app('x2', 'user_stated', { sentAt: OLD, status: 'applied' })], assessment: { state: 'current', requirements: [req('r1', 'Kubernetes', 'candidate_confirmed_gap')] } }),
    job('reapplied', { requisition: key('requisition', 'ats:acme:102'), applications: [app('x3', 'receipt_backed', { sentAt: '2026-05-01T00:00:00.000Z', status: 'rejected' }), app('x4', 'user_reported', { sentAt: OLD, status: 'interview', reapplicationOf: 'x3' })], assessment: { state: 'current', requirements: [req('r1', 'Kubernetes', 'direct')] } }),
  ];
}

const none: NoGoReason[] = [];

export const PORTFOLIOS: Portfolio[] = [
  {
    id: 'rich_projected',
    lane: 'projected_instrumentation',
    title: 'Enough data, if follow-ups A and B existed',
    what: '30 requisitions: 34 source rows (4 syndicated pairs), 3 sources and 3 query variants recorded, 22 mature sends with 8 unknown outcomes, 20 current assessments, a lead-exposure digest and dated status events. NOT what the app records today.',
    observations: richObservations(),
    exposure: RICH_EXPOSURE,
    expected: {
      funnelOutcome: 'go_review',
      funnelOutcomeReasons: none,
      requirements: 'go_review',
      requirementReasons: none,
      suggestions: [
        'add_cv_evidence:Kubernetes',
        'add_cv_evidence:On-call rota',
        'add_cv_evidence:Terraform',
        'consider_learning_priority:Kubernetes',
        'review_preference_conflict:candidateWorkCountry',
        'review_search_variant:t2-platform',
      ],
    },
  },
  {
    id: 'small_current_shape',
    lane: 'current_shape',
    title: 'What today’s records look like',
    what: '8 requisitions in the exact shape the real adapter returns: no query attribution, current-value status, no exposure, 3 assessments (1 stale), 1 prepared-only, 1 too-recent send, 1 undated send.',
    observations: smallCurrentShape(),
    expected: { funnelOutcome: 'no_go', funnelOutcomeReasons: ['too_few_mature_sent'], requirements: 'no_go', requirementReasons: ['too_few_assessed', 'unassessed_dominate', 'no_recurring_requirement'], suggestions: [] },
  },
  {
    id: 'duplicates_dominate',
    lane: 'projected_instrumentation',
    title: 'Syndicated copies dominate',
    what: '22 mature sends, each seen as 4 copies (88 rows read for 22 requisitions).',
    observations: sentJobs(22, () => ({ copies: 4 }), (i) => (i % 2 ? 'interview' : 'rejected')),
    expected: { funnelOutcome: 'no_go', funnelOutcomeReasons: ['duplicate_copies_dominate'], requirements: 'no_go', requirementReasons: ['too_few_assessed', 'unassessed_dominate', 'no_recurring_requirement'], suggestions: [] },
  },
  {
    id: 'unknown_outcomes_dominate',
    lane: 'projected_instrumentation',
    title: 'Most outcomes are unknown',
    what: '24 mature sends, 20 with no recorded outcome.',
    observations: sentJobs(24, () => ({}), (i) => (i <= 4 ? 'rejected' : 'applied')),
    expected: { funnelOutcome: 'no_go', funnelOutcomeReasons: ['unknown_outcomes_dominate'], requirements: 'no_go', requirementReasons: ['too_few_assessed', 'unassessed_dominate', 'no_recurring_requirement'], suggestions: [] },
  },
  {
    id: 'weak_identity_dominates',
    lane: 'projected_instrumentation',
    title: 'Identity is mostly the weak tier',
    what: '22 mature sends keyed only by company/title/location text.',
    observations: sentJobs(22, (i) => ({ requisition: key('semantic', `co${i} :: role :: nl`) }), (i) => (i % 2 ? 'interview' : 'rejected')),
    expected: { funnelOutcome: 'no_go', funnelOutcomeReasons: ['weak_identity_dominates'], requirements: 'no_go', requirementReasons: ['too_few_assessed', 'unassessed_dominate', 'no_recurring_requirement'], suggestions: [] },
  },
  {
    id: 'titles_only_no_assessment',
    lane: 'current_shape',
    title: 'Titles say Kubernetes, nothing was assessed',
    what: '12 jobs with a high score and a Kubernetes-flavoured title, no assessment: there is no requirement evidence, so there must be no requirement row and no suggestion.',
    observations: titleOnly(),
    expected: { funnelOutcome: 'no_go', funnelOutcomeReasons: ['too_few_mature_sent'], requirements: 'no_go', requirementReasons: ['too_few_assessed', 'unassessed_dominate', 'no_recurring_requirement'], suggestions: [] },
  },
  {
    id: 'mixed_cv_versions',
    lane: 'current_shape',
    title: 'Assessments made against three different CV versions',
    what: '12 current assessments over CV hashes 5/4/3: the evidence classes are not comparable across CV versions.',
    observations: mixedVersions(),
    expected: { funnelOutcome: 'no_go', funnelOutcomeReasons: ['too_few_mature_sent'], requirements: 'no_go', requirementReasons: ['too_few_assessed', 'version_incompatible_dominates'], suggestions: [] },
  },
  {
    id: 'older_rule_version',
    lane: 'current_shape',
    title: 'Assessments summarised under another rule version or an unknown one',
    what: '12 current assessments: 3 under the current rules, 6 under an older rule version, 3 with no recorded version.',
    observations: olderRuleVersion(),
    expected: { funnelOutcome: 'no_go', funnelOutcomeReasons: ['too_few_mature_sent'], requirements: 'no_go', requirementReasons: ['too_few_assessed', 'version_incompatible_dominates', 'no_recurring_requirement'], suggestions: [] },
  },
  {
    id: 'alias_merge',
    lane: 'current_shape',
    title: 'Kubernetes / K8s: merged only by the person',
    what: '10 current assessments; "Kubernetes" in 2, "K8s" in 2, "Kube" in 1. Without a person-confirmed alias no wording reaches the recurrence threshold of 3; the person confirming that they are one thing makes it 5.',
    observations: aliasPortfolio(),
    aliasGroups: [{ label: 'Kubernetes', members: ['K8s', 'Kube'] }],
    expected: { funnelOutcome: 'no_go', funnelOutcomeReasons: ['too_few_mature_sent'], requirements: 'no_go', requirementReasons: ['no_recurring_requirement'], suggestions: [] },
    expectedWithAliases: { funnelOutcome: 'no_go', funnelOutcomeReasons: ['too_few_mature_sent'], requirements: 'go_review', requirementReasons: none, suggestions: ['add_cv_evidence:Kubernetes'] },
  },
  {
    id: 'role_and_reapplication_isolation',
    lane: 'current_shape',
    title: 'Two roles at one employer and a reapplication',
    what: '3 requisitions at the same employer; one was applied for twice. Each role keeps its own requirement lane and outcome.',
    observations: isolation(),
    expected: { funnelOutcome: 'no_go', funnelOutcomeReasons: ['too_few_mature_sent'], requirements: 'no_go', requirementReasons: ['too_few_assessed', 'no_recurring_requirement'], suggestions: [] },
  },
];

// ---------------------------------------------------------------- free-text surfaces for the desk comparison

export interface ManualSurface {
  /** The Fit check the person kept on the saved job (free text, not tied to a posting or CV version), or null. */
  keptFitCheck: string | null;
  nextStep: string;
  notes: string;
}

/** Synthetic free text a person might have written on the rich portfolio's jobs. Invented. */
export function manualSurfaces(): Record<string, ManualSurface> {
  const out: Record<string, ManualSurface> = {};
  for (let i = 1; i <= 30; i += 1) out[id('j', i)] = { keptFitCheck: null, nextStep: '', notes: '' };
  // Kept Fit checks (free text) on some assessed jobs, and on two jobs that have NO structured assessment.
  for (const i of [1, 2, 6, 7, 13, 17]) out[id('j', i)]!.keptFitCheck = 'Matched: TypeScript. Not matched: Kubernetes is required; the CV does not show it.';
  out[id('j', 22)]!.keptFitCheck = 'Not matched: Terraform and a security clearance.';
  out[id('j', 25)]!.keptFitCheck = 'Matched: most of it. Not matched: Terraform.';
  // Notes the structured view cannot see.
  out[id('j', 8)]!.notes = 'Recruiter said they would pay more for Go experience.';
  out[id('j', 9)]!.nextStep = 'Ask about Kubernetes training budget';
  out[id('j', 15)]!.notes = 'Hiring manager is ex-colleague; strong referral.';
  return out;
}
