// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { postingContentHash } from '@open-vacancy-radar/vacancy-engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BATCH_LIMITS, type ApplicationBriefView } from '../electron/application-brief.js';
import { getBrief, hashReviewedSource } from '../electron/application-brief-service.js';
import { CV_REQUIREMENT_MAX_BATCHES, vacancyKeyFor } from '../electron/workspace/cv-evidence-schema.js';
import * as briefStore from '../electron/workspace/application-brief-store.js';
import { createWorkspaceDb, type WorkspaceDb } from '../electron/workspace/client.js';
import { recordPostingVerification } from '../electron/workspace/posting-verification-store.js';
import * as workspace from '../electron/workspace/repository.js';
import {
  AGG_URL,
  ATS_URL,
  ATS_URL_OTHER_REQ,
  ELIGIBILITY,
  JD_V1,
  JD_V2,
  SOURCE,
  makeDeps,
  makeWorld,
  requirement,
  scanRow,
  setScan,
  type BriefWorld,
} from './application-brief-fixtures.js';

/**
 * #688 evaluation: can a person make a shortlist decision with fewer context switches?
 *
 * THIS IS A DESK / FIXTURE EVALUATION, NOT A USABILITY STUDY. No person used the app, no time was
 * measured and nothing here estimates decision quality, hiring odds or satisfaction. It does two things:
 *
 *  1. AFTER: builds one fixed synthetic shortlist (5 saved jobs) in a real migrated database, asks the REAL
 *     `getBrief` for each, and records for each decision question whether the brief answers it, and what it
 *     says is still unknown. This part is measured from the shipped code.
 *  2. BEFORE: for the same shortlist and questions, records which screen each answer lived on at
 *     `origin/master 3b0c694`, taking the shortest path that code offered (a Fit check the person kept on the
 *     saved job is read in the Saved jobs drawer itself, with no switch). This part is a SOURCE READING of that
 *     code (file references below), not a runtime measurement: master cannot be executed from this branch.
 *
 * Run with OVR_688_EVALUATION_OUT=<path> to write `688-evaluation.json`; without it the assertions still run.
 */

const NOW = new Date('2026-10-29T10:00:00.000Z');

type Question = 'why_consider' | 'strengths' | 'gaps' | 'eligibility' | 'posting_deadline' | 'company_evidence' | 'sent_history';
const QUESTIONS: Question[] = ['why_consider', 'strengths', 'gaps', 'eligibility', 'posting_deadline', 'company_evidence', 'sent_history'];

interface BeforePath {
  surface: string;
  reachableWhen: string;
  source: string;
}

/** Where the answer lived at master 3b0c694, and the condition under which it was reachable at all. */
const BEFORE: Record<Question, BeforePath & { keptAlternative?: BeforePath }> = {
  why_consider: {
    surface: 'Search page > vacancy detail',
    reachableWhen: 'the job is still in the latest scan report (a rescan replaces it); the saved job only keeps a bare percentage',
    source: 'apps/desktop/src/components/search/VacancyDetail.tsx (FitSummary, "Why this matches you"); SavedJobDrawer shows only matchPercent',
  },
  strengths: {
    surface: 'Search page > Compare with my CV (CV assistant)',
    reachableWhen: 'the job is still in the latest scan report (the assistant opens from the Search detail pane) and an explicit AI run for that one job',
    source: 'apps/desktop/src/components/cv/RequirementMapping.tsx; VacancyDetail "Not compared to your CV yet"',
    keptAlternative: {
      surface: 'Saved jobs page > drawer > Fit check (kept gap analysis), the starting screen: no switch',
      reachableWhen: 'the person earlier ran the CV assistant gap analysis for this job and chose "Save analysis"; it is free text, not tied to the posting or CV version it was made against',
      source: 'apps/desktop/src/components/saved/SavedJobDrawer.tsx at 3b0c694 (job.gapAnalysis / gapAnalysisAt, "Fit check" section); apps/desktop/src/components/cv/GapAnalysis.tsx ("Save analysis")',
    },
  },
  gaps: {
    surface: 'Search page > Compare with my CV (CV assistant)',
    reachableWhen: 'the same conditions as strengths',
    source: 'apps/desktop/src/components/cv/RequirementMapping.tsx',
    keptAlternative: {
      surface: 'Saved jobs page > drawer > Fit check (kept gap analysis), the starting screen: no switch',
      reachableWhen: 'the person earlier ran the CV assistant gap analysis for this job and chose "Save analysis"; it is free text, not tied to the posting or CV version it was made against',
      source: 'apps/desktop/src/components/saved/SavedJobDrawer.tsx at 3b0c694 (job.gapAnalysis / gapAnalysisAt, "Fit check" section); apps/desktop/src/components/cv/GapAnalysis.tsx ("Save analysis")',
    },
  },
  eligibility: {
    surface: 'Search page > vacancy detail',
    reachableWhen: 'the job is still in the latest scan report',
    source: 'apps/desktop/src/components/search/VerificationSection.tsx',
  },
  posting_deadline: {
    surface: 'Applications page > application drawer',
    reachableWhen: 'an application attempt already exists for the job',
    source: 'apps/desktop/src/components/applications/PostingVerificationNotice.tsx (#687)',
  },
  company_evidence: {
    surface: 'Applications page > application drawer',
    reachableWhen: 'an application attempt already exists for the job',
    source: 'apps/desktop/src/components/applications/CompanyEvidencePanel.tsx (#689)',
  },
  sent_history: {
    surface: 'Applications page',
    reachableWhen: 'an application attempt is matched to THIS saved job by its own discovery key (a second saved copy of the same requisition shows "Not started")',
    source: 'apps/desktop/src/components/saved/saved-job-application.ts (newestAttemptBySavedJob: one status badge per row)',
  },
};

let dir: string;
let db: WorkspaceDb;
let closeDb: () => void;
let world: BriefWorld;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-brief-eval-'));
  ({ db, close: closeDb } = createWorkspaceDb(dir));
  world = makeWorld();
  world.clock = NOW;
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

interface FixtureJob {
  id: string;
  label: string;
  /** What the fixture author set up, in words. */
  setup: string;
  inLatestReport: boolean;
  hasAttempt: boolean;
  /** A gap analysis the person kept on the saved job (shown as "Fit check" in the drawer, on master and here). */
  keptFitCheck: boolean;
}

function build(): { jobs: FixtureJob[]; savedIds: Map<string, string> } {
  const cv = workspace.createCvDocument(db, { name: 'Main CV', kind: 'manual', text: 'Jamie Rivera.', profile: { title: 'Senior Engineer' }, source: SOURCE, isDefault: true });

  // Scan 1 saw four of the five jobs; scan 2 (the latest report) lists only J1 and its aggregator copy.
  const j1 = scanRow({ key: 'gh:1001', url: ATS_URL, title: 'Platform Engineer', description: JD_V1 });
  const j1Copy = scanRow({
    key: 'remotive:77',
    url: AGG_URL,
    title: 'Platform Engineer',
    description: JD_V1,
    sources: [
      { provider: 'remotive', key: 'remotive:77', url: AGG_URL },
      { provider: 'ats_roster_greenhouse', key: 'gh:1001', url: ATS_URL },
    ],
  });
  (j1Copy as { identity: unknown }).identity = j1.identity;
  const j2 = scanRow({
    key: 'gh:1002',
    url: ATS_URL_OTHER_REQ,
    title: 'Platform Engineer (US)',
    eligibility: { ...ELIGIBILITY, candidateWorkCountry: { ...ELIGIBILITY.candidateWorkCountry, answer: 'no', detail: 'Only candidates based in the United States.' } },
  });
  const j3 = scanRow({
    key: 'gh:1003',
    url: 'https://job-boards.greenhouse.io/northwind/jobs/1003',
    title: 'Staff Platform Engineer',
    description: JD_V1,
    profileScore: 70,
    eligibility: { ...ELIGIBILITY, candidateWorkCountry: { ...ELIGIBILITY.candidateWorkCountry, answer: 'unknown', detail: 'The posting does not say where it can be done from.' } },
  });
  setScan(world, [j1, j1Copy, j2, j3], '2026-10-19T08:00:00.000Z');

  const save = (row: ReturnType<typeof scanRow>) =>
    workspace.createSavedJob(db, { role: row.title, company: row.company, location: row.location, vacancyKey: row.key, matchPercent: row.profileScore, sourceUrl: row.url, status: 'considering' });
  const s1 = save(j1);
  const s5 = save(j1Copy); // the same requisition, saved a second time through the aggregator
  const s2 = save(j2);
  const s3 = save(j3);
  const s4 = workspace.createSavedJob(db, { role: 'Solo Role', company: 'Harbor Systems', location: 'Lisbon', sourceUrl: 'https://jobs.example/listing/solo-role-9', status: 'considering' });
  // The person ran the CV assistant's gap analysis for J1 and J2 and chose "Save analysis" (free text, invented).
  const keptText = 'Matched: 5+ years of TypeScript (Senior Engineer at Redwood Software). Not matched: Kubernetes is required; the CV does not show it.';
  workspace.updateSavedJob(db, s1.id, { gapAnalysis: keptText });
  workspace.updateSavedJob(db, s2.id, { gapAnalysis: keptText });

  // J1 was assessed (Search assistant) and then prepared; J3 was assessed against an OLDER posting.
  const assess = (row: ReturnType<typeof scanRow>, jd: string) => {
    const overlay = workspace.createCvEvidenceOverlay(db, {
      cvId: cv.id,
      vacancyKey: vacancyKeyFor({ title: row.title, company: row.company, location: row.location, url: row.url }),
      sourceCvContentHash: hashReviewedSource(workspace.getCvDocument(db, cv.id).source),
      jdSnapshot: jd,
      jdSnapshotHash: briefStore.sha256(jd),
    });
    workspace.updateCvEvidenceOverlay(db, overlay.id, {
      requirements: [
        requirement({ requirementId: 'r-ts', text: '5+ years of TypeScript', jdAnchor: 'You have 5+ years of TypeScript experience.' }),
        requirement({ requirementId: 'r-k8s', text: 'Kubernetes', jdAnchor: 'Experience with Kubernetes is required.', evidenceClass: 'unsupported', anchorParentId: '' }),
      ],
      requirementCoverage: { status: 'complete', batches: 1 },
    });
  };
  assess(j1, JD_V1);
  assess(j3, JD_V1);
  const attempt = workspace.createApplicationAttempt(db, {
    vacancyKey: j1.key, canonicalUrl: ATS_URL, company: j1.company, role: j1.title, sourceCvId: cv.id, sourceCvContentHash: 'x', jdSnapshot: JD_V1, jdSnapshotHash: 'j',
  });
  recordPostingVerification(db, {
    attemptId: attempt.id, allowedCheckpoints: ['queued'], observedAt: new Date(NOW.getTime() - 2 * 86_400_000), source: 'ats_api', sourceRef: ATS_URL, outcome: 'open', result: 'confirmed_open',
    reason: 'posting_open', httpStatus: 200, contentHash: postingContentHash(JD_V1), baselineHash: postingContentHash(JD_V1), deadline: '2026-11-15',
    deadlineProvenance: { source: 'posting_text', excerpt: 'Applications close on 15 November 2026.' }, etag: null, lastModified: null, changeSummary: null, observedText: null,
  });

  return {
    jobs: [
      { id: s1.id, label: 'J1 Platform Engineer (ATS copy)', setup: 'scored 78, all eligibility answers stated, assessed against the current posting, a gap analysis kept as a Fit check, application prepared, posting checked open with a stated deadline', inLatestReport: true, hasAttempt: true, keptFitCheck: true },
      { id: s5.id, label: 'J1b Platform Engineer (aggregator copy of J1)', setup: 'the SAME requisition saved a second time through an aggregator', inLatestReport: true, hasAttempt: false, keptFitCheck: false },
      { id: s2.id, label: 'J2 Platform Engineer (US)', setup: 'scored 78 but the posting says only US-based candidates; no grounded assessment, but a gap analysis was kept as a Fit check', inLatestReport: false, hasAttempt: false, keptFitCheck: true },
      { id: s3.id, label: 'J3 Staff Platform Engineer', setup: 'scored 70, work country not stated, assessed against an older posting that has since changed', inLatestReport: true, hasAttempt: false, keptFitCheck: false },
      { id: s4.id, label: 'J4 Solo Role (typed in by hand)', setup: 'no scan result and no posting text', inLatestReport: false, hasAttempt: false, keptFitCheck: false },
    ],
    savedIds: new Map([['j1', s1.id], ['j1b', s5.id]]),
  };
}

function traceRow<T extends { job: string; briefId: string; before: { contextSwitches: number; questionsReachable: number; paths: Array<{ question: string; via: string }> }; after: { surfacesOpened: string[]; modelRequestsToView: number; questionsShownInOneSurface: number; questionsWithBriefData: number; questionsAnsweredOnlyByKeptFitCheck: number; contextSwitches: number; answers: Record<string, { answered: boolean; evidence: string }>; remainingUnknowns: string[] } }>(row: T): T {
  return row;
}

function answers(view: ApplicationBriefView): Record<Question, { answered: boolean; evidence: string }> {
  const a = view.assessment;
  return {
    why_consider: view.relevance.score !== null
      ? { answered: true, evidence: `Search score ${view.relevance.score} (${view.relevance.provenance}), ${view.relevance.signals.length} matching signals, ${view.relevance.caveats.length} score gaps${view.relevance.status === 'stale' ? ' [out of date]' : ''}` }
      : { answered: false, evidence: view.relevance.reason ?? 'not scored' },
    strengths: a.summary && a.summary.strengths.length > 0
      ? { answered: true, evidence: `${a.summary.strengths.length} CV-backed strength(s)${a.state === 'stale' ? ' [earlier assessment, out of date]' : ''}` }
      : { answered: false, evidence: a.state === 'missing' ? 'not assessed yet' : (a.reason ?? a.state) },
    gaps: a.summary
      ? { answered: true, evidence: `${a.summary.gaps.length} material gap(s)${a.state === 'stale' ? ' [earlier assessment, out of date]' : ''}` }
      : { answered: false, evidence: a.state === 'missing' ? 'not assessed yet' : (a.reason ?? a.state) },
    eligibility: view.eligibility.items.length > 0
      ? { answered: true, evidence: `${view.eligibility.counts.knownMismatch} known mismatch, ${view.eligibility.counts.uncertain} not known, ${view.eligibility.counts.consistent} fine, ${view.eligibility.counts.informational} stated` }
      : { answered: false, evidence: view.eligibility.reason ?? 'not assessed' },
    posting_deadline: view.postingCheck.status !== 'not_checked'
      ? { answered: true, evidence: `${view.postingCheck.status}${view.postingCheck.deadline ? `, deadline ${view.postingCheck.deadline.date}` : ''}${view.postingCheck.stale ? ' [stale]' : ''}` }
      : { answered: false, evidence: 'posting not checked yet (checked when an application is prepared)' },
    company_evidence: view.companyEvidence.available && view.companyEvidence.facts.length > 0
      ? { answered: true, evidence: `${view.companyEvidence.facts.length} sourced claim(s)` }
      : { answered: false, evidence: view.companyEvidence.note },
    sent_history: { answered: true, evidence: view.submission.attempts.length === 0 ? 'nothing prepared or sent' : view.submission.attempts.map((attempt) => attempt.label).join('; ') },
  };
}

describe('shortlist decision context: fixed-fixture desk evaluation (not a usability study)', () => {
  it('measures what the brief answers per job, derives the before-path from master, and records the limits', async () => {
    const { jobs, savedIds } = build();
    // Capture while the first scan is loaded, as saving a job does.
    for (const job of jobs) await getBrief(makeDeps(db, world), { savedJobId: job.id });
    // Scan 2: the report now lists only J1 and its copy, and J3's posting text changed.
    world.clock = new Date(NOW.getTime() + 24 * 3600_000);
    setScan(world, [world.rows.get('gh:1001')!, world.rows.get('remotive:77')!, scanRow({ key: 'gh:1003', url: 'https://job-boards.greenhouse.io/northwind/jobs/1003', title: 'Staff Platform Engineer', description: JD_V2, profileScore: 70 })], '2026-10-22T08:00:00.000Z');

    const perJob: Array<ReturnType<typeof traceRow>> = [];
    for (const job of jobs) {
      const view = await getBrief(makeDeps(db, world), { savedJobId: job.id });
      const after = answers(view);
      const reportHasJob = job.inLatestReport;
      const beforeRows = QUESTIONS.map((question) => {
        const spec = BEFORE[question];
        // Score reasons, eligibility and the CV assistant all start from the job's row in the LATEST scan
        // report (the assistant is opened from the Search detail pane, and the posting text lives on that
        // row). Posting check, company evidence and sent history need an application attempt for THIS saved job.
        // A Fit check kept on the saved job answers strengths and gaps in the drawer itself: the shortest path.
        if (spec.keptAlternative && job.keptFitCheck) {
          return { question, surface: 'Saved jobs page', via: spec.keptAlternative.surface, reachable: true, reachableWhen: spec.keptAlternative.reachableWhen };
        }
        const reachable =
          question === 'why_consider' || question === 'eligibility' || question === 'strengths' || question === 'gaps'
            ? reportHasJob
            : job.hasAttempt;
        return { question, surface: spec.surface, via: spec.surface, reachable, reachableWhen: spec.reachableWhen };
      });
      const beforeSurfaces = new Set(['Saved jobs page', ...beforeRows.filter((row) => row.reachable).map((row) => row.surface)]);
      const answeredAfter = QUESTIONS.filter((question) => after[question].answered);
      // The drawer still shows the kept Fit check next to the brief. Where the brief has no data for strengths or
      // gaps, that kept free text is the only answer in the drawer; it is counted separately, never as brief data.
      const keptOnly = job.keptFitCheck ? (['strengths', 'gaps'] as const).filter((question) => !after[question].answered) : [];
      for (const question of keptOnly) {
        after[question] = { answered: true, evidence: 'not from the brief: the kept Fit check text shown in the same drawer (free text, not tied to a posting or CV version)' };
      }
      const unknowns = [
        ...view.eligibility.items.filter((item) => item.classification === 'uncertain').map((item) => `eligibility not known: ${item.label}`),
        ...(view.assessment.state !== 'current' ? [`assessment ${view.assessment.state}${view.assessment.reason ? `: ${view.assessment.reason}` : ''}`] : []),
        ...(view.postingCheck.status === 'not_checked' ? ['posting not checked yet'] : []),
        ...(!view.companyEvidence.available || view.companyEvidence.facts.length === 0 ? ['no sourced company evidence'] : []),
        ...(view.relevance.status === 'stale' ? [`score out of date: ${view.relevance.reason}`] : []),
      ];
      perJob.push(traceRow({
        job: job.label,
        setup: job.setup,
        briefId: view.briefId,
        before: {
          surfacesOpened: [...beforeSurfaces],
          contextSwitches: beforeSurfaces.size - 1,
          // "Reachable" = a screen for this question exists for this job. It does not mean that screen held data.
          questionsReachable: beforeRows.filter((row) => row.reachable).length,
          paths: beforeRows.filter((row) => row.reachable).map((row) => ({ question: row.question, via: row.via })),
          unreachable: beforeRows.filter((row) => !row.reachable).map((row) => ({ question: row.question, because: row.reachableWhen })),
          modelRequestsNeededForAssessment: `at least 1 (up to ${CV_REQUIREMENT_MAX_BATCHES}) per job, started one job at a time in the Search assistant`,
        },
        after: {
          surfacesOpened: ['Saved jobs page (drawer)'],
          contextSwitches: 0,
          // Every question has a section in the one drawer; "with brief data" counts the ones the brief actually fills.
          questionsShownInOneSurface: QUESTIONS.length,
          questionsWithBriefData: answeredAfter.length,
          questionsAnsweredOnlyByKeptFitCheck: keptOnly.length,
          answers: Object.fromEntries(QUESTIONS.map((question) => [question, after[question]])),
          remainingUnknowns: unknowns,
          modelRequestsToView: 0,
        },
      }));
    }

    // ---- invariants the evaluation rests on (they fail if the shipped behaviour regresses)
    expect(new Set(perJob.map((row) => row.briefId)).size).toBe(4); // J1 and its aggregator copy share one brief
    expect(perJob[0]!.briefId).toBe(perJob[1]!.briefId);
    expect(savedIds.size).toBe(2);
    for (const row of perJob) {
      expect(row.after.surfacesOpened).toHaveLength(1);
      expect(row.after.modelRequestsToView).toBe(0);
    }
    const byLabel = (prefix: string) => perJob.find((row) => row.job.startsWith(prefix))!;
    expect(byLabel('J1 ').after.answers.posting_deadline?.evidence).toContain('deadline 2026-11-15');
    expect(byLabel('J2').after.answers.eligibility?.evidence).toContain('2 known mismatch');
    expect(byLabel('J2').after.remainingUnknowns.join(' ')).toContain('assessment missing');
    // The kept Fit check path from master is counted: zero switches for strengths and gaps where one was kept.
    expect(byLabel('J1 ').before.paths.filter((path) => path.via.startsWith('Saved jobs page > drawer > Fit check'))).toHaveLength(2);
    expect(byLabel('J2').before.questionsReachable).toBe(2);
    expect(byLabel('J2').before.contextSwitches).toBe(0);
    expect(byLabel('J2').after.questionsAnsweredOnlyByKeptFitCheck).toBe(2);
    expect(byLabel('J1 ').after.questionsAnsweredOnlyByKeptFitCheck).toBe(0);
    expect(byLabel('J3').after.remainingUnknowns.join(' ')).toContain('assessment stale');
    expect(byLabel('J4').after.answers.why_consider?.answered).toBe(false);
    expect(byLabel('J4').after.remainingUnknowns.join(' ')).toContain('assessment unavailable');

    const totals = {
      jobs: perJob.length,
      distinctBriefs: new Set(perJob.map((row) => row.briefId)).size,
      before: {
        contextSwitches: perJob.reduce((sum, row) => sum + row.before.contextSwitches, 0),
        questionsReachable: perJob.reduce((sum, row) => sum + row.before.questionsReachable, 0),
      },
      after: {
        contextSwitches: perJob.reduce((sum, row) => sum + row.after.contextSwitches, 0),
        questionsShownInOneSurface: perJob.reduce((sum, row) => sum + row.after.questionsShownInOneSurface, 0),
        questionsWithBriefData: perJob.reduce((sum, row) => sum + row.after.questionsWithBriefData, 0),
        questionsAnsweredOnlyByKeptFitCheck: perJob.reduce((sum, row) => sum + row.after.questionsAnsweredOnlyByKeptFitCheck, 0),
      },
      questionsAskedPerJob: QUESTIONS.length,
      questionsAskedTotal: QUESTIONS.length * perJob.length,
    };
    expect(totals.after.contextSwitches).toBe(0);
    expect(totals.before.contextSwitches).toBeGreaterThan(totals.after.contextSwitches);

    const report = {
      issue: 688,
      kind: 'DESK / FIXTURE EVALUATION. Not a usability study: no person used the app, nothing was timed, and no decision quality, satisfaction, hiring probability or time saving is measured or claimed.',
      repository: { baseCommit: '3b0c694', branch: 'codex/688-application-brief' },
      method: [
        'One fixed synthetic shortlist of 5 saved jobs is built in a real migrated SQLite workspace (test/application-brief-evaluation.test.ts); every employer, posting, score and requirement is invented.',
        'AFTER (measured on this branch): the REAL getBrief is called for each saved job. A question counts as "with brief data" only when the brief returns data for it (a score, a CV-backed strength, an eligibility answer, a posting check, a sourced company claim, sent history). The Saved jobs drawer still shows a kept Fit check next to the brief; where that kept free text is the only answer to strengths or gaps it is counted separately as "answered only by the kept Fit check", never as brief data. "remainingUnknowns" are what the brief itself reports as not known, not assessed, stale or unavailable.',
        'BEFORE (source reading of origin/master 3b0c694, not a runtime measurement): for the same questions, the screen each answer lived on, with the condition for reaching it, from the files named in `beforeMap`. Master cannot be run from this branch. The reading assumes the person already knows which screens to open and takes the shortest path master offered: where a Fit check (kept gap analysis) is on the saved job, strengths and gaps are read in the Saved jobs drawer with no switch.',
        '"Context switch" = moving to another screen or panel for one more fact about one job. Counts are per job; the Saved jobs page itself is the start, not a switch.',
        'Questions: why consider it, CV-backed strengths, material gaps, eligibility (mismatch / unknown), posting still open + deadline, sourced company evidence, what was already sent.',
      ],
      limits: [
        'Desk evaluation on 5 invented jobs. Counts show where information lives; they do not show that people decide better or faster. "Reachable" before means a screen for the question exists for that job, not that it held data; "shown in one surface" after is true by construction, which is why "with data" and "remainingUnknowns" are reported next to it.',
        'The before-path is a source reading, not a runtime measurement. If a screen existed that the reading missed, the before counts are too high. The first independent review found one such miss (the kept Fit check in the Saved jobs drawer); it is now included.',
        'The kept Fit check is free text the person chose to keep. It is not tied to the posting or CV version it was made against and is not anchored to CV evidence, so counting it as reachable or answered says only that text exists, not that it is current. The fixture gives J1 and J2 one; a real shortlist may have none, or one on every job, which would lower the before switches further.',
        'The brief does not create information: a missing assessment, an unchecked posting or absent company evidence stay "unknown" and still need an explicit action (Assess selected jobs, preparing an application).',
        'Assessment still needs model requests (capped at 2 per job and 5 jobs per action here, versus up to 8 per job in the Search assistant). The cap can leave a job partly read, which the brief says.',
        'No live provider, job site or private data was used.',
      ],
      beforeMap: BEFORE,
      fixture: jobs.map((job) => ({ job: job.label, setup: job.setup, inLatestScanReportAtEvaluation: job.inLatestReport, hasApplicationAttempt: job.hasAttempt })),
      perJob,
      totals,
      batchLimits: BATCH_LIMITS,
    };
    const out = process.env.OVR_688_EVALUATION_OUT;
    if (out) {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
  });
});
