import { hashReviewedSource } from '../../electron/application-brief-service.js';
import { getBrief } from '../../electron/application-brief-service.js';
import * as briefStore from '../../electron/workspace/application-brief-store.js';
import type { WorkspaceDb } from '../../electron/workspace/client.js';
import { vacancyKeyFor } from '../../electron/workspace/cv-evidence-schema.js';
import { createRound } from '../../electron/workspace/interview-round-store.js';
import * as workspace from '../../electron/workspace/repository.js';
import type { CvRequirementMapping } from '../../electron/workspace/cv-evidence-schema.js';
import {
  AGG_URL,
  ATS_URL,
  ATS_URL_OTHER_REQ,
  ELIGIBILITY,
  JD_V1,
  SOURCE,
  makeDeps,
  makeWorld,
  requirement,
  scanRow,
  setScan,
  type BriefWorld,
} from '../application-brief-fixtures.js';

/**
 * A synthetic job-search workspace written ENTIRELY through the app's real writers (repository, brief
 * service, interview-round store) into a migrated SQLite database, so the adapter reads exactly the shapes
 * production produces. Every employer, person and posting is invented. The scan rows carry a real #686
 * `queryProvenance` -- on purpose: the evaluation then shows it does NOT reach the workspace.
 */

export const AS_OF = '2026-10-30T10:00:00.000Z';

export interface RealWorld {
  world: BriefWorld;
  savedIds: Record<string, string>;
  applicationIds: Record<string, string>;
  attemptIds: Record<string, string>;
  cvId: string;
}

const PLAN = {
  planRevision: 3,
  fetchedBy: [{ variantId: 'literal', query: 'platform engineer', language: null, provider: 'ats_roster_greenhouse' }],
  matchedLocally: [{ variantId: 'literal', query: 'platform engineer', language: null, field: 'title' }],
};

function withProvenance<T extends object>(row: T): T {
  return Object.assign(row, { queryProvenance: structuredClone(PLAN) });
}

export async function buildRealWorld(db: WorkspaceDb): Promise<RealWorld> {
  const world = makeWorld();
  const cv = workspace.createCvDocument(db, { name: 'Main CV', kind: 'manual', text: 'Jamie Rivera.', profile: { title: 'Senior Engineer' }, source: SOURCE, isDefault: true });

  const j1 = withProvenance(scanRow({ key: 'gh:1001', url: ATS_URL, title: 'Platform Engineer', description: JD_V1 }));
  const j1Copy = withProvenance(
    scanRow({
      key: 'remotive:77',
      url: AGG_URL,
      title: 'Platform Engineer',
      description: JD_V1,
      sources: [
        { provider: 'remotive', key: 'remotive:77', url: AGG_URL },
        { provider: 'ats_roster_greenhouse', key: 'gh:1001', url: ATS_URL },
      ],
    }),
  );
  (j1Copy as { identity: unknown }).identity = j1.identity;
  const j2 = withProvenance(scanRow({ key: 'gh:1002', url: ATS_URL_OTHER_REQ, title: 'Platform Engineer', eligibility: { ...ELIGIBILITY, candidateWorkCountry: { ...ELIGIBILITY.candidateWorkCountry, answer: 'no', detail: 'Only candidates based in the United States.' } } }));
  const j3 = withProvenance(scanRow({ key: 'gh:1003', url: 'https://job-boards.greenhouse.io/northwind/jobs/1003', title: 'Staff Platform Engineer', description: JD_V1, profileScore: 70 }));
  const j5 = withProvenance(scanRow({ key: 'gh:1005', url: 'https://job-boards.greenhouse.io/northwind/jobs/1005', title: 'Release Engineer', description: JD_V1, profileScore: null }));
  // A job whose TITLE, posting text and scorer hints all say Kubernetes but that the person never assessed ("Compare with my CV" was not run):
  // the negative control for "no requirement or gap is ever derived from a title, a posting or a scorer hint". It has no overlay and no application.
  const j6 = withProvenance(scanRow({ key: 'gh:1006', url: 'https://job-boards.greenhouse.io/northwind/jobs/1006', title: 'Kubernetes Platform Engineer', description: JD_V1, profileScore: 82 }));
  Object.assign(j6.profileMatch as object, { matchingSkills: ['Kubernetes', 'TypeScript'], gaps: ['No Kubernetes production experience listed', 'Kubernetes is the main skill requested'] });
  setScan(world, [j1, j1Copy, j2, j3, j5, j6], '2026-10-19T08:00:00.000Z');

  const save = (row: ReturnType<typeof scanRow>) =>
    workspace.createSavedJob(db, { role: row.title, company: row.company, location: row.location, vacancyKey: row.key, matchPercent: row.profileScore, sourceUrl: row.url, status: 'considering' });
  const sj = { j1: save(j1), j1b: save(j1Copy), j2: save(j2), j3: save(j3), j5: save(j5), k8s: save(j6) };
  const solo = workspace.createSavedJob(db, { role: 'Solo Role', company: 'Harbor Systems', location: 'Lisbon', sourceUrl: 'https://jobs.example/listing/solo-role-9', status: 'considering' });
  const deps = () => makeDeps(db, world);
  for (const job of [sj.j1, sj.j1b, sj.j2, sj.j3, sj.j5, sj.k8s, solo]) await getBrief(deps(), { savedJobId: job.id });

  // Requirement-level evidence exists only where the person ran "Compare with my CV" (an overlay).
  const overlayFor = (row: ReturnType<typeof scanRow>, reqs: CvRequirementMapping[]) => {
    const overlay = workspace.createCvEvidenceOverlay(db, {
      cvId: cv.id,
      vacancyKey: vacancyKeyFor({ title: row.title, company: row.company, location: row.location, url: row.url }),
      sourceCvContentHash: hashReviewedSource(workspace.getCvDocument(db, cv.id).source),
      jdSnapshot: JD_V1,
      jdSnapshotHash: briefStore.sha256(JD_V1),
    });
    // The app's completeness heuristic flags this short synthetic posting; the person read it and confirmed it is complete.
    workspace.updateCvEvidenceOverlay(db, overlay.id, { requirements: reqs, requirementCoverage: { status: 'complete', batches: 1 }, jdConfirmedComplete: true });
  };
  overlayFor(j1, [
    requirement({ requirementId: 'r-ts', text: '5+ years of TypeScript', jdAnchor: 'You have 5+ years of TypeScript experience.' }),
    requirement({ requirementId: 'r-k8s', text: 'Kubernetes', jdAnchor: 'Experience with Kubernetes is required.', evidenceClass: 'unsupported', anchorParentId: '' }),
  ]);
  overlayFor(j3, [
    // The person added this one themselves (candidateAdded) and said they lack it; it is preferred, not mandatory, in this posting.
    requirement({ requirementId: 'r-k8s', text: 'Kubernetes', jdAnchor: 'Experience with Kubernetes is required.', evidenceClass: 'candidate_confirmed_gap', anchorParentId: '', candidateAdded: true, classification: 'preferred' }),
  ]);

  const attemptIds: Record<string, string> = {};
  const applicationIds: Record<string, string> = {};
  const attempt = async (name: string, row: ReturnType<typeof scanRow>, extra: Partial<Parameters<typeof workspace.createApplicationAttempt>[1]> = {}) => {
    const created = workspace.createApplicationAttempt(db, {
      vacancyKey: row.key, canonicalUrl: row.url, company: row.company, role: row.title, sourceCvId: cv.id, sourceCvContentHash: 'cv-hash-1', jdSnapshot: JD_V1, jdSnapshotHash: 'jd-hash-1', ...extra,
    });
    attemptIds[name] = created.id;
    applicationIds[name] = workspace.getApplicationAttempt(db, created.id).applicationId!;
    await getBrief(deps(), { attemptId: created.id });
    return created;
  };

  // A1: J1 sent with an observed receipt, then an interview round was held; status left at "interview".
  const a1 = await attempt('a1', j1);
  workspace.createApplicationSubmissionReceipt(db, { attemptId: a1.id, outcome: 'submitted', source: 'page_observation', destination: ATS_URL, evidenceKind: 'confirmation_page', evidenceReference: 'Thank you for applying', detail: 'a confirmation page appeared', observedAt: '2026-09-01T09:00:00.000Z' });
  workspace.updateApplicationAttempt(db, a1.id, { checkpoint: 'submitted', submittedAt: '2026-09-01T09:00:00.000Z', submissionMode: 'manual', completionEvidence: 'receipt_confirmed' });
  workspace.updateApplication(db, applicationIds.a1!, { status: 'interview' });
  db.transaction((tx) => createRound(tx, applicationIds.a1!, { roundType: 'recruiter_screen', scheduledOn: '2026-09-10', state: 'held', feedback: '', openTopics: [] }, new Date('2026-09-10T12:00:00.000Z')));

  // A2: the SAME requisition applied for again after a document fix (reapplication), reported by the person.
  const a1b = await attempt('a1b', j1, { reapply: { supersedesAttemptId: a1.id, reason: 'Corrected the CV' } });
  workspace.updateApplicationAttempt(db, a1b.id, { checkpoint: 'ready' });
  const { recordUserReportedSubmission } = await import('../../electron/application-review-session.js');
  recordUserReportedSubmission(db, a1b.id, '', '2026-10-05T09:00:00.000Z');
  // The writer stamps the attempt with the wall clock; pin it so this synthetic history is the same on every run.
  workspace.updateApplicationAttempt(db, a1b.id, { submittedAt: '2026-10-05T09:00:00.000Z' });

  // J2: a DIFFERENT requisition at the same employer, tracked by hand as applied, then rejected (no reason recorded).
  workspace.updateSavedJob(db, sj.j2.id, { status: 'applied' });
  const a2 = workspace.createApplication(db, { role: j2.title, company: j2.company, location: j2.location, savedJobId: sj.j2.id, status: 'rejected', appliedAt: '2026-09-05T09:00:00.000Z' });
  applicationIds.a2 = a2.id;

  // J3: prepared, never sent.
  await attempt('a3', j3, { checkpoint: 'ready' });

  // J5 (unscored): applied recently by hand, so it is too young to count as "no outcome".
  const a5 = workspace.createApplication(db, { role: j5.title, company: j5.company, location: j5.location, savedJobId: sj.j5.id, status: 'applied', appliedAt: '2026-10-20T09:00:00.000Z' });
  applicationIds.a5 = a5.id;

  // Solo: applied by hand with no date at all.
  const a6 = workspace.createApplication(db, { role: 'Solo Role', company: 'Harbor Systems', location: 'Lisbon', savedJobId: solo.id, status: 'applied', appliedAt: null });
  applicationIds.a6 = a6.id;

  return { world, savedIds: { j1: sj.j1.id, j1b: sj.j1b.id, j2: sj.j2.id, j3: sj.j3.id, j5: sj.j5.id, k8s: sj.k8s.id, solo: solo.id }, applicationIds, attemptIds, cvId: cv.id };
}
