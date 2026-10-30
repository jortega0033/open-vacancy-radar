import { classifyEligibility, matchOverlay, type BriefEligibility } from '../../electron/application-brief.js';
import { hashReviewedSource } from '../../electron/application-brief-service.js';
import { classifySubmission, type SubmissionClass } from '../../electron/application-actions-core.js';
import { listAliases, listBriefs, type StoredAlias, type StoredBrief } from '../../electron/workspace/application-brief-store.js';
import { listRounds } from '../../electron/workspace/interview-round-store.js';
import type { WorkspaceDb } from '../../electron/workspace/client.js';
import { vacancyKeyFor } from '../../electron/workspace/cv-evidence-schema.js';
import * as workspace from '../../electron/workspace/repository.js';
import type { ApplicationAttemptRecord, ApplicationRecord, CvEvidenceOverlayRecord, SavedJobRecord } from '../../electron/workspace/types.js';
import {
  CONTRACT_VERSION,
  type ApplicationObservation,
  type AssessmentState,
  type Availability,
  type EligibilityRecord,
  type EvidenceType,
  type JobObservation,
  type RequirementRecord,
  type ScoreOpinion,
  type SourceContribution,
} from './contract.js';
import { collapseByRequisition, keyFromBrief, keyFromFields, NO_KEY } from './requisition.js';

/**
 * The REAL-CONTRACT ADAPTER: reads what today's `workspace.db` actually holds -- through the same
 * repository, brief-store and rounds readers the app uses, and the same `classifySubmission`,
 * `classifyEligibility` and `matchOverlay` rules -- and returns observations plus an explicit account of
 * what could not be recovered. It reads only; it calls no writer, no model, no network. It deliberately does
 * not call `getBrief`, which captures (writes) a brief as a side effect.
 *
 * Whatever this function cannot read, it says so in `availability` rather than filling it in. The
 * query-variant attribution, the exposure denominator and the status-change time are `not_recorded` here
 * because no production table stores them (see docs/outcome-gap-research.md for the citations).
 */

export interface WorkspaceReadResult {
  observations: JobObservation[];
  /** Rows read, before collapsing to requisitions: the evidence for the copy accounting (saved rows; alias-merged source copies are in each observation's `contributions`). */
  sourceRows: { savedJobs: number; applications: number; attempts: number; briefs: number; overlays: number };
  /** Things the production data cannot answer, each with the check that proved it on THIS database. */
  unrecoverable: { code: string; detail: string }[];
}

const ASSESSMENT_FIELDS = ['requirements', 'assessmentState'] as const;

interface Index {
  briefs: StoredBrief[];
  aliases: Map<string, StoredAlias[]>;
  byAlias: Map<string, StoredBrief>;
}

function buildIndex(db: WorkspaceDb): Index {
  const briefs = listBriefs(db);
  const aliases = new Map<string, StoredAlias[]>();
  const byAlias = new Map<string, StoredBrief>();
  for (const brief of briefs) {
    const list = listAliases(db, brief.id);
    aliases.set(brief.id, list);
    for (const alias of list) byAlias.set(alias.aliasKey, brief);
  }
  return { briefs, aliases, byAlias };
}

function evidenceOf(submission: SubmissionClass): EvidenceType {
  switch (submission) {
    case 'receipt_backed':
      return 'receipt_observed';
    case 'user_reported':
      return 'user_reported';
    case 'user_stated':
      return 'user_stated';
    case 'unconfirmed':
    case 'prepared':
      return 'app_recorded';
    default:
      return 'not_recorded';
  }
}

interface Pending {
  savedJob: SavedJobRecord | null;
  rows: { app: ApplicationRecord; attempts: ApplicationAttemptRecord[] }[];
  orphanAttempts: ApplicationAttemptRecord[];
  brief: StoredBrief | null;
  keyOrigin: 'brief' | 'derived';
  display: { company: string; role: string; location: string; url: string | null };
}

export function readWorkspaceObservations(db: WorkspaceDb): WorkspaceReadResult {
  const index = buildIndex(db);
  const savedJobs = workspace.listSavedJobs(db);
  const applications = workspace.listApplications(db, 'all');
  const attempts = workspace.listApplicationAttempts(db);
  const cvs = workspace.listCvDocuments(db);
  const overlays: CvEvidenceOverlayRecord[] = cvs.flatMap((cv) => workspace.listCvEvidenceOverlays(db, cv.id));

  const attemptsByApp = new Map<string, ApplicationAttemptRecord[]>();
  for (const attempt of attempts) {
    if (attempt.applicationId === null) continue;
    const list = attemptsByApp.get(attempt.applicationId) ?? [];
    list.push(attempt);
    attemptsByApp.set(attempt.applicationId, list);
  }
  const attemptById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  const appByAttempt = new Map<string, string>();
  for (const attempt of attempts) if (attempt.applicationId !== null) appByAttempt.set(attempt.id, attempt.applicationId);

  // 1. One pending record per source row (saved job / application), resolved to a brief when one exists.
  const pending: Pending[] = [];
  for (const job of savedJobs) {
    const brief = index.byAlias.get(`saved:${job.id}`) ?? null;
    pending.push({ savedJob: job, rows: [], orphanAttempts: [], brief, keyOrigin: brief ? 'brief' : 'derived', display: { company: job.company, role: job.role, location: job.location, url: job.sourceUrl } });
  }
  for (const app of applications) {
    const rowAttempts = attemptsByApp.get(app.id) ?? [];
    const brief =
      rowAttempts.map((attempt) => index.byAlias.get(`attempt:${attempt.id}`)).find((hit) => hit !== undefined) ??
      (app.savedJobId ? index.byAlias.get(`saved:${app.savedJobId}`) : undefined) ??
      null;
    const url = rowAttempts.find((attempt) => attempt.canonicalUrl !== '')?.canonicalUrl ?? null;
    pending.push({ savedJob: null, rows: [{ app, attempts: rowAttempts }], orphanAttempts: [], brief, keyOrigin: brief ? 'brief' : 'derived', display: { company: app.company, role: app.role, location: app.location, url } });
  }

  // 2. Resolve each to a requisition key, then collapse. A saved job and the application made from it share a brief, so they share a key.
  const keyed = pending.map((entry) => {
    const requisition = entry.brief
      ? keyFromBrief(entry.brief.identityKey, entry.brief.identityKind)
      : entry.display.company.trim() === '' && entry.display.role.trim() === ''
        ? NO_KEY
        : keyFromFields({ url: entry.display.url, company: entry.display.company, title: entry.display.role, location: entry.display.location });
    return { ...entry, requisition };
  });
  const collapsed = collapseByRequisition(keyed);

  const heldRoundsOf = (applicationId: string): number => listRounds(db, applicationId).filter((round) => round.state === 'held').length;

  const observations: JobObservation[] = collapsed.groups.map((group, position) => {
    const head = group[0]!;
    const brief = group.map((entry) => entry.brief).find((hit): hit is StoredBrief => hit !== null) ?? null;
    const availability: Record<string, Availability> = {
      requisitionKey: head.requisition.origin === 'brief_identity' ? 'recorded' : head.requisition.origin === 'derived_at_read' ? 'derived_at_read' : 'not_recorded',
      queryAttribution: 'not_recorded',
      exposureDenominator: 'not_recorded',
      statusTimestamp: 'not_recorded',
      outcomeSource: 'not_recorded',
      outcomeReason: 'not_recorded',
    };

    // Source copies: every alias that names a provider/url for this brief. The query side is not stored.
    const contributions: SourceContribution[] = [];
    if (brief) {
      const seen = new Set<string>();
      for (const alias of index.aliases.get(brief.id) ?? []) {
        if (alias.kind === 'saved_job' || alias.kind === 'attempt' || alias.kind === 'vacancy_key') continue;
        if (alias.provider === null && alias.url === null) continue;
        const tag = `${alias.provider ?? ''}|${alias.url ?? ''}`;
        if (seen.has(tag)) continue;
        seen.add(tag);
        contributions.push({ provider: alias.provider, url: alias.url, queryRefs: 'not_recorded', planRevision: null });
      }
    }
    availability.sourceCopies = contributions.length > 0 ? 'recorded' : 'not_recorded';

    const facts = brief?.facts ?? null;
    const score: ScoreOpinion =
      facts === null || facts.profileScore === null
        ? { state: 'unscored', value: null, roleFamily: null }
        : { state: facts.scoredBeforeProfileSave ? 'stale' : 'scored', value: facts.profileScore, roleFamily: facts.match?.primaryFit ?? null };
    availability.score = facts === null || facts.profileScore === null ? 'not_recorded' : 'recorded';
    availability.roleFamily = score.roleFamily === null ? 'not_recorded' : 'recorded';

    const savedJob = group.map((entry) => entry.savedJob).find((hit): hit is SavedJobRecord => hit !== null) ?? null;
    availability.selectedAt = savedJob ? 'recorded' : 'not_recorded';
    availability.displayTitle = 'recorded';
    availability.scorerHints = facts?.match ? 'recorded' : 'not_recorded';

    const applicationRows = group.flatMap((entry) => entry.rows);
    const observed: ApplicationObservation[] = applicationRows.map(({ app, attempts: rowAttempts }) => {
      const newest = app.attempt ?? null;
      const submission = classifySubmission({ status: app.status, archived: app.archived, appliedAt: app.appliedAt, attempt: newest ? { checkpoint: newest.checkpoint, evidence: newest.evidence } : null });
      const attemptRecord = newest ? attemptById.get(newest.attemptId) : undefined;
      const sentByApp = submission === 'receipt_backed' || submission === 'user_reported';
      const sentAt = sentByApp ? (attemptRecord?.submittedAt ?? app.appliedAt) : submission === 'user_stated' ? app.appliedAt : null;
      const predecessor = attemptRecord?.supersedesAttemptId ?? rowAttempts.map((attempt) => attempt.supersedesAttemptId).find((id) => id !== null) ?? null;
      return {
        applicationId: app.id,
        submission,
        evidence: evidenceOf(submission),
        sentAt,
        status: app.status,
        statusHistory: 'current_value_only' as const,
        heldRounds: heldRoundsOf(app.id),
        reapplicationOf: predecessor === null ? null : (appByAttempt.get(predecessor) ?? predecessor),
      };
    });
    observed.sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? '') || a.applicationId.localeCompare(b.applicationId));

    // Requirements: only an overlay ("Compare with my CV") holds requirement-level evidence classes.
    // The overlay is keyed by `vacancyKeyFor` (a posting URL, else a company/title/location text), a FOURTH identity
    // surface; the brief service looks it up with every URL the job was seen at, then the text form. Do the same.
    const urls = new Set<string>();
    for (const entry of group) {
      if (entry.display.url) urls.add(entry.display.url);
      if (entry.savedJob?.sourceUrl) urls.add(entry.savedJob.sourceUrl);
      for (const attempt of entry.rows.flatMap((row) => row.attempts)) if (attempt.canonicalUrl) urls.add(attempt.canonicalUrl);
    }
    if (brief) for (const alias of index.aliases.get(brief.id) ?? []) if (alias.url) urls.add(alias.url);
    const shown = brief ?? { role: head.display.role, company: head.display.company, location: head.display.location };
    const vacancyKeys = new Set<string>([...urls, ''].map((url) => vacancyKeyFor({ title: shown.role, company: shown.company, location: shown.location, url })));
    const overlay = overlays.filter((candidate) => vacancyKeys.has(candidate.vacancyKey)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;

    let assessmentState: AssessmentState = 'none';
    let requirements: RequirementRecord[] = [];
    let coverage: 'complete' | 'partial' | 'not_run' = 'not_run';
    let cvHash: string | null = null;
    if (overlay) {
      coverage = overlay.requirementCoverage.status === 'complete' ? 'complete' : overlay.requirementCoverage.status === 'partial' ? 'partial' : 'not_run';
      const cv = cvs.find((candidate) => candidate.id === overlay.cvId) ?? null;
      cvHash = cv ? hashReviewedSource(cv.source) : null;
      const match = matchOverlay({ jdSnapshotHash: overlay.jdSnapshotHash, sourceCvContentHash: overlay.sourceCvContentHash }, { jdHash: brief?.jdHash ?? null, cvHash });
      // A posting text known to be truncated (and not confirmed complete by the person) lists fewer requirements than the posting has.
      const jdTruncated = !overlay.jdComplete && !overlay.jdConfirmedComplete;
      assessmentState = match === 'matches' ? (coverage === 'complete' && !jdTruncated ? 'current' : 'partial') : 'stale';
      requirements = overlay.requirements
        .filter((requirement) => !requirement.excluded)
        .map((requirement) => ({
          requirementId: requirement.requirementId,
          text: requirement.text,
          classification: requirement.classification,
          evidenceClass: requirement.evidenceClass,
          reviewed: requirement.reviewed,
          excluded: false,
          jdAnchor: requirement.jdAnchor,
          jdRevisionId: requirement.jdRevisionId,
          quoteSpan: requirement.quoteStart >= 0 && requirement.quoteEnd >= requirement.quoteStart ? { start: requirement.quoteStart, end: requirement.quoteEnd } : null,
          candidateAdded: requirement.candidateAdded,
        }));
    }
    for (const field of ASSESSMENT_FIELDS) availability[field] = overlay ? 'recorded' : 'not_recorded';

    const eligibility: EligibilityRecord[] = facts?.eligibility
      ? classifyEligibility(facts.eligibility as BriefEligibility).map((item) => ({ key: item.key, answer: item.answer, classification: item.classification, source: item.source }))
      : [];
    availability.eligibility = facts?.eligibility ? 'recorded' : 'not_recorded';

    return {
      id: `obs-${String(position + 1).padStart(3, '0')}`,
      requisition: head.requisition,
      savedRows: group.filter((entry) => entry.savedJob !== null).length,
      contributions,
      selectedAt: savedJob?.savedAt ?? null,
      score,
      // Read so a test can plant a skill in them and prove nothing downstream uses them (see `JobObservation.hints`).
      hints: { title: savedJob?.role ?? head.display.role, scorerMatchingSkills: facts?.match?.matchingSkills ?? [], scorerGaps: facts?.match?.gaps ?? [] },
      applications: observed,
      assessment: { state: assessmentState, requirements, coverage },
      eligibility,
      versions: {
        contract: CONTRACT_VERSION,
        profileVersion: null,
        scoredPreferences: facts?.scoredPreferences ?? null,
        jdHash: brief?.jdHash ?? overlay?.jdSnapshotHash ?? null,
        cvHash: overlay?.sourceCvContentHash ?? cvHash,
        assessmentWorkflow: brief?.assessment?.inputs.workflowVersion ?? null,
        planRevision: null,
      },
      availability,
    };
  });

  const unrecoverable = [
    { code: 'query_attribution', detail: 'No workspace table or brief column stores which query variant produced a saved job (LeadQueryProvenance exists only in the scan report JSON).' },
    { code: 'exposure_denominator', detail: 'Leads shown, skipped or ignored are not stored; only jobs the person saved or applied to exist.' },
    { code: 'status_timestamp', detail: 'applications.status is one mutable value with no change time, source or reason; the only application date is applied_at.' },
    { code: 'deleted_saved_jobs', detail: 'Deleting a saved job removes its row (and a brief nothing else references). An application row made from it survives (applications.saved_job_id is set to null) and keeps the requisition; only when the application is deleted too does the requisition disappear. If no attempt references the brief it goes with the saved job and the surviving application is re-keyed from its stored text (weak tier). What the person dropped is therefore invisible, so "selected" describes the jobs and applications the person kept.' },
    { code: 'cv_text_history', detail: 'cv_documents keeps no version history; a CV or JD version is only a hash, so compatibility is hash equality, not a diff.' },
  ];
  return {
    observations,
    sourceRows: { savedJobs: savedJobs.length, applications: applications.length, attempts: attempts.length, briefs: index.briefs.length, overlays: overlays.length },
    unrecoverable,
  };
}
