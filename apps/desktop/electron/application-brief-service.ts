import { createHash } from 'node:crypto';
import { vacancyIdentityFor, type DiscoveryVacancyAudit, type VacancyIdentity } from '@open-vacancy-radar/vacancy-engine';
import {
  BRIEF_WORKFLOW_VERSION,
  composeBriefView,
  evaluateAssessment,
  freezeBrief,
  matchOverlay,
  pickEligibility,
  preferenceGroups,
  summariseAssessment,
  type ApplicationBriefView,
  type AssessmentSection,
  type AssessmentSummary,
  type BriefAttemptEvidence,
  type BriefCompanyFactSummary,
  type BriefCompanySection,
  type BriefInputs,
  type BriefNotice,
  type BriefPin,
  type BriefPostingSection,
  type BriefPostingStatus,
  type BriefSourceFacts,
  type BriefSourceRef,
  type AssessmentRefusalCode,
  type CommitAssessmentInput,
  type CommitAssessmentResult,
  type PrepareAssessmentResult,
  type PreferenceCorrection,
  type OverlayMatch,
  type PreferenceGroups,
  type PreferenceProfile,
} from './application-brief.js';
import type { PostingVerificationView } from './application-pipeline-types.js';
import type { CompanyEvidenceView } from './company-evidence.js';
import { jobDescriptionBody } from './generation-input.js';
import {
  addBriefNotice,
  attemptAlias,
  getBriefById,
  getPin,
  listAliases,
  pinBriefForAttempt,
  saveAssessment,
  savedJobAlias,
  upsertBrief,
  type BriefAlias,
  type IdentityKind,
  type StoredBrief,
} from './workspace/application-brief-store.js';
import type { WorkspaceDb } from './workspace/client.js';
import { isHistoricalAttempt } from './workspace/posting-verification-store.js';
import * as workspace from './workspace/repository.js';
import { WorkspaceNotFoundError } from './workspace/repository.js';
import { stableCvSourceJson } from './workspace/cv-source-schema.js';
import {
  vacancyKeyFor,
  type CvEvidenceFact,
  type CvRequirementMapping,
} from './workspace/cv-evidence-schema.js';
import { parseCvEvidenceOverlayPatch } from './workspace/validate.js';
import type {
  ApplicationAttemptRecord,
  CvDocumentRecord,
  CvEvidenceOverlayRecord,
  SavedJobRecord,
} from './workspace/types.js';

/**
 * The service behind `application-brief:*` (#688). It composes a brief from three kinds of input and
 * is the only thing that writes one:
 *
 *  - the engine's scan facts for the job (when the latest report still has it) and the saved job /
 *    attempt rows, folded into ONE canonical brief per requisition;
 *  - the CURRENT versions: the posting text, the reviewed CV, the preferences that change relevance;
 *  - the existing grounded assessment (a CV evidence overlay), reused only when it was read against
 *    exactly this posting text and exactly this reviewed CV.
 *
 * `getBrief` makes no network request and no model call: a brief is built from rows already on disk
 * plus the read-only #687 / #689 views. The only AI in this feature is the explicit assessment the
 * renderer runs on top of `prepareAssessment` / `commitAssessment`, and `commitAssessment` refuses a
 * result whose inputs changed while the model was working.
 */

export interface BriefReportRow {
  row: DiscoveryVacancyAudit;
  runId: string;
  generatedAt: string;
  profileVersion: string;
}

export interface BriefProfile extends PreferenceProfile {
  profileVersion: string;
}

export interface BriefServiceDeps {
  db: WorkspaceDb;
  now(): Date;
  /** The latest scan row for a discovery key, or null once a newer scan replaced it. */
  findReportRow(vacancyKey: string): BriefReportRow | null;
  /** The saved candidate profile, or null when it cannot be read. */
  loadProfile(): Promise<BriefProfile | null>;
  /** The stored #687 finding for an attempt. Reads only; never requests anything. */
  postingView(attemptId: string): PostingVerificationView | null;
  /** The #689 evidence for an attempt as a summary. Reads only. */
  companyEvidence(attemptId: string): BriefCompanySection;
  /** Saves an allow-listed profile patch through the app's one serialized profile writer. */
  saveProfilePatch?(patch: { constraints: Record<string, unknown> }): Promise<void>;
  log?(message: string, meta?: Record<string, unknown>): void;
}

export type BriefTarget = { savedJobId: string } | { attemptId: string };

// ------------------------------------------------------------------------------------ identity

function identityKeyOf(identity: VacancyIdentity): string {
  const prefix = identity.kind === 'requisition' ? 'req:' : identity.kind === 'canonical_url' ? 'url:' : 'sem:';
  return `${prefix}${identity.key}`;
}

function aliasForIdentity(
  identity: VacancyIdentity,
  extra: { label: string; provider: string | null; url: string | null },
): BriefAlias {
  return { key: identityKeyOf(identity), kind: identity.kind, ...extra };
}

function hostLabel(url: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).host.replace(/^www\./u, '');
  } catch {
    return '';
  }
}

interface JobFacts {
  title: string;
  company: string;
  location: string;
  url: string;
  provider?: string;
  key?: string;
}

function identityOf(job: JobFacts): VacancyIdentity {
  return vacancyIdentityFor({
    url: job.url,
    company: job.company,
    title: job.title,
    location: job.location,
    ...(job.provider ? { provider: job.provider } : {}),
    ...(job.key ? { key: job.key } : {}),
  });
}

interface Resolved {
  display: { company: string; role: string; location: string };
  identity: VacancyIdentity;
  /** Strongest first. Every alias describes the SAME job. */
  aliases: BriefAlias[];
  /** Every URL this job was reached through (original source references). */
  urls: string[];
  vacancyKeys: string[];
  reportRow: BriefReportRow | null;
  savedJob: SavedJobRecord | null;
  attempt: ApplicationAttemptRecord | null;
}

function resolveContext(deps: BriefServiceDeps, target: BriefTarget): Resolved {
  let savedJob: SavedJobRecord | null = null;
  let attempt: ApplicationAttemptRecord | null = null;
  if ('savedJobId' in target) {
    savedJob = workspace.listSavedJobs(deps.db).find((job) => job.id === target.savedJobId) ?? null;
    if (!savedJob) throw new WorkspaceNotFoundError('saved job', target.savedJobId);
  } else {
    attempt = workspace.getApplicationAttempt(deps.db, target.attemptId);
    if (attempt.vacancyKey) {
      savedJob = workspace.listSavedJobs(deps.db).find((job) => job.vacancyKey === attempt!.vacancyKey) ?? null;
    }
  }
  const vacancyKey = savedJob?.vacancyKey ?? attempt?.vacancyKey ?? null;
  const reportRow = vacancyKey ? deps.findReportRow(vacancyKey) : null;

  const display = reportRow
    ? { company: reportRow.row.company, role: reportRow.row.title, location: reportRow.row.location }
    : savedJob
      ? { company: savedJob.company, role: savedJob.role, location: savedJob.location }
      : { company: attempt!.company, role: attempt!.role, location: '' };

  const identityAliases: BriefAlias[] = [];
  const otherAliases: BriefAlias[] = [];
  const urls: string[] = [];
  const addUrl = (url: string | null | undefined): void => {
    if (url && !urls.includes(url)) urls.push(url);
  };

  let identity: VacancyIdentity;
  if (reportRow) {
    const row = reportRow.row;
    identity =
      row.identity ??
      identityOf({ title: row.title, company: row.company, location: row.location, url: row.url, provider: row.provider, key: row.key });
    identityAliases.push(aliasForIdentity(identity, { label: row.provider, provider: row.provider, url: row.url }));
    addUrl(row.url);
    addUrl(row.applyUrl?.status === 'verified' ? row.applyUrl.url : null);
    otherAliases.push({ key: `key:${row.key}`, kind: 'vacancy_key', label: row.provider, provider: row.provider, url: row.url });
    for (const source of row.sources ?? []) {
      addUrl(source.url);
      otherAliases.push({
        key: `key:${source.key}`,
        kind: 'vacancy_key',
        label: source.provider,
        provider: source.provider,
        url: source.url,
      });
      // A source copy with its own specific identity (another ATS posting, another canonical URL) is
      // an alias for this ONE job; a bare semantic fingerprint is not added a second time.
      const copy = identityOf({ ...display, title: display.role, url: source.url, provider: source.provider, key: source.key });
      if (copy.kind !== 'semantic' && identityKeyOf(copy) !== identityKeyOf(identity)) {
        identityAliases.push(aliasForIdentity(copy, { label: source.provider, provider: source.provider, url: source.url }));
      }
    }
  } else {
    const url = savedJob?.sourceUrl ?? attempt?.canonicalUrl ?? '';
    identity = identityOf({ title: display.role, company: display.company, location: display.location, url, ...(savedJob?.vacancyKey ? { key: savedJob.vacancyKey } : {}) });
    identityAliases.push(aliasForIdentity(identity, { label: hostLabel(url), provider: null, url: url || null }));
    addUrl(url);
  }
  // The saved job's own link and the attempt's apply link are source copies too.
  for (const own of [savedJob?.sourceUrl ?? '', attempt?.canonicalUrl ?? '']) {
    if (!own) continue;
    addUrl(own);
    const copy = identityOf({ title: display.role, company: display.company, location: display.location, url: own });
    if (copy.kind !== 'semantic' && !identityAliases.some((alias) => alias.key === identityKeyOf(copy))) {
      identityAliases.push(aliasForIdentity(copy, { label: hostLabel(own), provider: null, url: own }));
    }
  }
  if (savedJob?.vacancyKey && !otherAliases.some((alias) => alias.key === `key:${savedJob!.vacancyKey}`)) {
    otherAliases.push({ key: `key:${savedJob.vacancyKey}`, kind: 'vacancy_key', label: 'saved', provider: null, url: savedJob.sourceUrl });
  }
  if (attempt?.vacancyKey && !otherAliases.some((alias) => alias.key === `key:${attempt!.vacancyKey}`)) {
    otherAliases.push({ key: `key:${attempt.vacancyKey}`, kind: 'vacancy_key', label: 'prepared', provider: null, url: attempt.canonicalUrl || null });
  }
  const refs: BriefAlias[] = [];
  if (savedJob) refs.push(savedJobAlias(savedJob.id));
  if (attempt) refs.push(attemptAlias(attempt.id));

  // The semantic fingerprint is added only where it IS the identity: a requisition never gets it,
  // so two openings at one employer with the same title cannot be joined through it.
  return {
    display,
    identity,
    aliases: [...identityAliases, ...otherAliases, ...refs],
    urls,
    vacancyKeys: [...new Set(otherAliases.map((alias) => alias.key.slice(4)))],
    reportRow,
    savedJob,
    attempt,
  };
}

// ----------------------------------------------------------------------------------- the facts

function salaryLabel(row: DiscoveryVacancyAudit): string | null {
  if (row.advertisedMinimum === null || row.currency === null) return null;
  return `${row.advertisedMinimum} ${row.currency}${row.salaryPeriod ? ` per ${row.salaryPeriod}` : ''}`;
}

function buildFacts(report: BriefReportRow, profile: BriefProfile | null, now: Date): BriefSourceFacts {
  const row = report.row;
  const sameProfile = profile !== null && report.profileVersion === profile.profileVersion;
  const scored = row.profileScore !== null;
  return {
    capturedAt: now.toISOString(),
    runId: report.runId,
    generatedAt: report.generatedAt,
    profileScore: row.profileScore,
    match: row.profileMatch
      ? {
          technicalFit: row.profileMatch.technicalFit,
          roleFit: row.profileMatch.roleFit,
          seniorityFit: row.profileMatch.seniorityFit,
          primaryFit: row.profileMatch.primaryFit,
          matchingSkills: [...row.profileMatch.matchingSkills],
          gaps: [...row.profileMatch.gaps],
          unmetMandatoryLanguages: [...row.profileMatch.unmetMandatoryLanguages],
        }
      : null,
    eligibility: pickEligibility(row.eligibility),
    salary: salaryLabel(row),
    postedAt: row.postedAt,
    applyUrlStatus: row.applyUrl?.status ?? null,
    scoredPreferences: scored && sameProfile ? preferenceGroups(profile) : null,
    scoredBeforeProfileSave: scored && profile !== null && !sameProfile,
  };
}

// --------------------------------------------------------------------------------- CV + overlay

export function hashReviewedSource(source: CvDocumentRecord['source']): string {
  return createHash('sha256').update(source ? stableCvSourceJson(source) : 'null').digest('hex');
}

/** A source counts as reviewed only once a person confirmed it (`reviewedAt` is stamped by main). */
export function isReviewedSource(source: CvDocumentRecord['source']): boolean {
  return source !== null && source.reviewedAt.trim() !== '';
}

function defaultCv(db: WorkspaceDb): CvDocumentRecord | null {
  const documents = workspace.listCvDocuments(db);
  const defaultCvId = workspace.getSettings(db).defaultCvId;
  return documents.find((document) => document.id === defaultCvId) ?? documents.find((document) => document.isDefault) ?? null;
}

function evidenceLabel(
  requirement: CvRequirementMapping,
  source: CvDocumentRecord['source'],
  facts: readonly CvEvidenceFact[],
): string | null {
  const ids = [requirement.anchorParentId, ...requirement.sourceIds].filter((id) => id !== '');
  for (const id of ids) {
    const experience = source?.experience.find((entry) => entry.id === id);
    if (experience) return `${experience.title || 'Role'} at ${experience.company || 'unknown employer'}`;
    const project = source?.projects.find((entry) => entry.id === id);
    if (project) return `Project: ${project.name || 'unnamed'}`;
  }
  for (const factId of requirement.factIds) {
    const fact = facts.find((candidate) => candidate.factId === factId);
    if (fact) return `Your confirmed statement: ${fact.activity.slice(0, 80)}`;
  }
  return null;
}

interface OverlayPick {
  overlay: CvEvidenceOverlayRecord | null;
  match: OverlayMatch;
  keys: string[];
}

function pickOverlay(
  deps: BriefServiceDeps,
  cv: CvDocumentRecord | null,
  display: Resolved['display'],
  urls: readonly string[],
  current: { jdHash: string | null; cvHash: string | null },
): OverlayPick {
  const keys = [
    ...new Set([
      ...urls.map((url) => vacancyKeyFor({ title: display.role, company: display.company, location: display.location, url })),
      vacancyKeyFor({ title: display.role, company: display.company, location: display.location, url: '' }),
    ]),
  ];
  if (!cv) return { overlay: null, match: 'none', keys };
  let best: CvEvidenceOverlayRecord | null = null;
  let bestMatch: OverlayMatch = 'none';
  for (const key of keys) {
    const overlay = workspace.getCvEvidenceOverlay(deps.db, cv.id, key);
    if (!overlay) continue;
    const match = matchOverlay(overlay, current);
    if (match === 'matches') return { overlay, match, keys };
    if (best === null || overlay.updatedAt > best.updatedAt) {
      best = overlay;
      bestMatch = match;
    }
  }
  return { overlay: best, match: bestMatch, keys };
}

// ----------------------------------------------------------------------------- other sections

const ATTEMPT_LABEL: Record<string, string> = {
  queued: 'Preparing (queued)',
  reading_jd: 'Preparing',
  tailoring: 'Preparing',
  rendering: 'Preparing',
  filling: 'Preparing',
  ready: 'Prepared, not sent',
  needs_user: 'Needs your input, not sent',
  submitting: 'Sending now',
  submitted: 'Sent (the app observed a receipt)',
  user_reported: 'You reported applying (not observed by the app)',
  submission_unknown: 'Sent, unconfirmed',
  failed: 'Preparation failed, nothing sent',
  skipped: 'Skipped, nothing sent',
};

function attemptsFor(
  deps: BriefServiceDeps,
  brief: StoredBrief,
  vacancyKeys: readonly string[],
  urls: readonly string[],
): { evidence: BriefAttemptEvidence[]; records: ApplicationAttemptRecord[] } {
  const wantedKeys = new Set(vacancyKeys);
  const requisition = brief.identityKind === 'requisition' ? brief.identityKey : null;
  const urlSet = new Set(urls.map((url) => url.trim()).filter(Boolean));
  const records = workspace
    .listApplicationAttempts(deps.db)
    .filter((attempt) => {
      if (attempt.vacancyKey && wantedKeys.has(attempt.vacancyKey)) return true;
      if (requisition && attempt.requisitionId && `${attempt.employerKey}:${attempt.requisitionId}` === requisition) return true;
      return attempt.canonicalUrl !== '' && urlSet.has(attempt.canonicalUrl.trim());
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return {
    records,
    evidence: records.map((attempt) => ({
      attemptId: attempt.id,
      checkpoint: attempt.checkpoint,
      label: ATTEMPT_LABEL[attempt.checkpoint] ?? 'In progress',
      createdAt: attempt.createdAt,
      submittedAt: attempt.submittedAt,
      receipts: workspace.listApplicationSubmissionReceipts(deps.db, attempt.id).length,
    })),
  };
}

const NOT_CHECKED: BriefPostingSection = {
  status: 'not_checked',
  checkedAt: null,
  source: null,
  sourceRef: null,
  deadline: null,
  noDeadlineStated: false,
  stale: true,
  note: 'The live posting is checked when you prepare an application. Nothing is requested until then.',
};

function postingSection(deps: BriefServiceDeps, attempt: ApplicationAttemptRecord | null): BriefPostingSection {
  if (!attempt) return NOT_CHECKED;
  if (isHistoricalAttempt(attempt)) {
    return { ...NOT_CHECKED, status: 'not_applicable', stale: false, note: 'An application was already sent for this job, so the posting is not checked again.' };
  }
  let view: PostingVerificationView | null = null;
  try {
    view = deps.postingView(attempt.id);
  } catch (error) {
    deps.log?.('posting view failed', { error: error instanceof Error ? error.name : 'unknown' });
  }
  if (!view) return NOT_CHECKED;
  const notes: Record<BriefPostingStatus, string> = {
    not_checked: NOT_CHECKED.note,
    confirmed_open: 'The posting was open when it was last checked.',
    confirmed_closed: 'The posting looked closed when it was last checked.',
    materially_changed: 'The posting changed since your application was prepared.',
    unable_to_verify: 'The posting could not be checked. That is not a sign it is closed.',
    not_applicable: 'Not checked again.',
  };
  const status = view.status as BriefPostingStatus;
  return {
    status,
    checkedAt: view.checkedAt,
    source: view.source,
    sourceRef: view.sourceRef,
    deadline: view.deadline,
    noDeadlineStated: view.noDeadlineStated,
    stale: view.stale,
    note: notes[status] ?? '',
  };
}

const NO_COMPANY: BriefCompanySection = {
  available: false,
  note: 'Company evidence is added once you prepare an application for this job. Nothing is looked up until you ask.',
  facts: [],
  counts: { current: 0, expired: 0, leads: 0 },
};

function companySection(deps: BriefServiceDeps, attempt: ApplicationAttemptRecord | null): BriefCompanySection {
  if (!attempt) return NO_COMPANY;
  try {
    return deps.companyEvidence(attempt.id);
  } catch (error) {
    deps.log?.('company evidence summary failed', { error: error instanceof Error ? error.name : 'unknown' });
    return { ...NO_COMPANY, note: 'Company evidence could not be read right now.' };
  }
}

/**
 * The #689 evidence as the brief shows it: counts and a few claims with their source and dates, never
 * more than the evidence view already allows. A claim is "current" only when #689's own policy supports it
 * today; "out of date" when it expired; everything else is an unconfirmed lead.
 */
export function summariseCompanyView(view: CompanyEvidenceView, now: Date): BriefCompanySection {
  if (view.state === 'no_identity') {
    return {
      available: false,
      note: 'The employer is not verified yet, so nothing counts as company evidence. You can confirm the employer’s own domain in the application.',
      facts: [],
      counts: { current: 0, expired: 0, leads: 0 },
    };
  }
  const facts: BriefCompanyFactSummary[] = [];
  const counts = { current: 0, expired: 0, leads: 0 };
  for (const fact of view.facts) {
    if (fact.status !== 'active') continue;
    const expired = Date.parse(fact.expiresAt) <= now.getTime() || fact.reasons.includes('expired');
    const state: BriefCompanyFactSummary['state'] = fact.support === 'supported' && !expired ? 'current' : expired ? 'expired' : 'lead';
    if (state === 'current') counts.current += 1;
    else if (state === 'expired') counts.expired += 1;
    else counts.leads += 1;
    facts.push({ claim: fact.claim, sourceUrl: fact.sourceUrl, scope: fact.scope, retrievedAt: fact.retrievedAt, expiresAt: fact.expiresAt, state });
  }
  const order = { current: 0, expired: 1, lead: 2 } as const;
  facts.sort((a, b) => order[a.state] - order[b.state]);
  const total = counts.current + counts.expired + counts.leads;
  return {
    available: true,
    note:
      total === 0
        ? 'No company evidence has been added yet. Nothing is looked up until you ask.'
        : `${counts.current} current, ${counts.expired} out of date, ${counts.leads} not yet confirmed.`,
    facts: facts.slice(0, 4),
    counts,
  };
}

// --------------------------------------------------------------------------------------- brief

interface Built {
  view: ApplicationBriefView;
  brief: StoredBrief;
  context: Resolved;
  cv: CvDocumentRecord | null;
  cvHash: string | null;
  overlay: CvEvidenceOverlayRecord | null;
  overlayMatch: OverlayMatch;
  overlayKeys: string[];
  attemptRecords: ApplicationAttemptRecord[];
}

function sourceRefs(deps: BriefServiceDeps, briefId: string): BriefSourceRef[] {
  return listAliases(deps.db, briefId)
    .filter((alias) => alias.url !== null || alias.kind === 'vacancy_key')
    .filter((alias) => alias.url !== null)
    .map((alias) => ({
      aliasKey: alias.aliasKey,
      kind: alias.kind,
      label: alias.label || hostLabel(alias.url),
      provider: alias.provider,
      url: alias.url,
      firstSeenAt: alias.firstSeenAt,
      lastSeenAt: alias.lastSeenAt,
    }))
    .filter((ref, index, all) => all.findIndex((other) => other.url === ref.url) === index);
}

async function build(deps: BriefServiceDeps, target: BriefTarget): Promise<Built> {
  const now = deps.now();
  const context = resolveContext(deps, target);
  const profile = await deps.loadProfile().catch(() => null);
  const currentPreferences: PreferenceGroups | null = profile ? preferenceGroups(profile) : null;

  const reportRow = context.reportRow;
  const description = reportRow ? reportRow.row.description : context.attempt?.jdSnapshot || null;
  const body = description === null ? '' : jobDescriptionBody({ title: '', company: '', location: '', url: '', description });
  const complete = reportRow ? true : (context.attempt?.jdComplete ?? true);

  const { brief } = upsertBrief(deps.db, {
    identity: {
      kind: context.identity.kind as IdentityKind,
      key: identityKeyOf(context.identity),
      employerKey: context.identity.employerKey,
      requisitionId: context.identity.requisitionId,
    },
    aliases: context.aliases,
    display: context.display,
    facts: reportRow ? buildFacts(reportRow, profile, now) : null,
    jd: body.length > 0 ? { text: body, complete } : null,
    now,
  });

  const cv = defaultCv(deps.db);
  const cvHash = cv ? hashReviewedSource(cv.source) : null;
  const picked = pickOverlay(deps, cv, context.display, context.urls, { jdHash: brief.jdHash, cvHash });

  let fresh: AssessmentSummary | null = null;
  if (picked.match === 'matches' && picked.overlay && cv) {
    fresh = summariseAssessment(picked.overlay, (requirement) => evidenceLabel(requirement, cv.source, picked.overlay!.facts));
    const stored = brief.assessment;
    const changed =
      stored === null ||
      stored.inputs.cvId !== cv.id ||
      stored.inputs.cvHash !== cvHash ||
      stored.inputs.jdHash !== brief.jdHash ||
      stored.inputs.overlayId !== picked.overlay.id ||
      stored.inputs.workflowVersion !== BRIEF_WORKFLOW_VERSION ||
      JSON.stringify(stored.summary) !== JSON.stringify(fresh);
    if (changed && brief.jdHash !== null && cvHash !== null) {
      saveAssessment(
        deps.db,
        brief.id,
        { summary: fresh, inputs: { cvId: cv.id, cvHash, jdHash: brief.jdHash, overlayId: picked.overlay.id, derivedAt: now.toISOString(), workflowVersion: BRIEF_WORKFLOW_VERSION } },
        { jdHash: brief.jdHash, factsVersion: brief.factsVersion },
        now,
      );
    }
  }
  const reread = getBriefById(deps.db, brief.id) ?? brief;

  const assessment: AssessmentSection = evaluateAssessment({
    stored: reread.assessment,
    fresh,
    match: picked.match,
    hasJd: reread.jdHash !== null,
    jdChangedAt: reread.jdChangedAt,
    cvAvailable: cv !== null,
    cvReviewed: cv !== null && isReviewedSource(cv.source),
    cvChangedSinceAssessment: reread.assessment !== null && cv !== null && reread.assessment.inputs.cvId !== cv.id,
    now,
  });

  const { evidence, records } = attemptsFor(deps, reread, context.vacancyKeys, context.urls);
  const activeAttempt =
    context.attempt ?? records.find((attempt) => !isHistoricalAttempt(attempt)) ?? records[0] ?? null;
  const pinRow = context.attempt ? getPin(deps.db, context.attempt.id) : null;
  const pin: BriefPin | null =
    context.attempt && pinRow ? { attemptId: context.attempt.id, pinnedAt: pinRow.pinnedAt, snapshot: pinRow.snapshot } : null;

  const inputs: BriefInputs = {
    now,
    briefId: reread.id,
    identity: { kind: reread.identityKind, key: reread.identityKey },
    role: reread.role,
    company: reread.company,
    location: reread.location,
    facts: reread.facts,
    jd: {
      hasText: reread.jdHash !== null,
      hash: reread.jdHash,
      complete: reread.jdComplete,
      changedAt: reread.jdChangedAt,
      capturedAt: reread.jdCapturedAt,
    },
    currentPreferences,
    assessment,
    cv: { name: cv?.name ?? null, reviewed: cv !== null && isReviewedSource(cv.source) },
    sources: sourceRefs(deps, reread.id),
    attempts: evidence,
    postingCheck: postingSection(deps, activeAttempt),
    companyEvidence: companySection(deps, activeAttempt),
    notices: reread.notices,
    pin,
  };
  const view = composeBriefView(inputs);

  // Persist the reasons a section went out of date (once each), so the history survives a restart.
  const reasons: Array<[BriefNotice['section'], string | null]> = [
    ['relevance', view.relevance.status === 'stale' ? view.relevance.reason : null],
    ['eligibility', view.eligibility.status === 'stale' ? view.eligibility.reason : null],
    ['assessment', view.assessment.state === 'stale' ? view.assessment.reason : null],
  ];
  for (const [section, text] of reasons) {
    if (text && !reread.notices.some((notice) => notice.text === text)) {
      addBriefNotice(deps.db, reread.id, { at: now.toISOString(), section, text }, now);
    }
  }

  const withNotices = reasons.some(([, text]) => text)
    ? { ...view, notices: getBriefById(deps.db, reread.id)?.notices ?? view.notices }
    : view;
  return {
    view: withNotices,
    brief: reread,
    context,
    cv,
    cvHash,
    overlay: picked.overlay,
    overlayMatch: picked.match,
    overlayKeys: picked.keys,
    attemptRecords: records,
  };
}

export async function getBrief(deps: BriefServiceDeps, target: BriefTarget): Promise<ApplicationBriefView> {
  return (await build(deps, target)).view;
}

/** Pins the brief for an attempt the moment preparation starts. Insert-only; failure is the caller's to log. */
export async function pinForAttempt(deps: BriefServiceDeps, attemptId: string): Promise<boolean> {
  const { view } = await build(deps, { attemptId });
  return pinBriefForAttempt(deps.db, attemptId, freezeBrief(view), deps.now());
}

// ----------------------------------------------------------------------------- explicit assessment

const REFUSAL_TEXT: Record<AssessmentRefusalCode, string> = {
  not_found: 'That saved job is no longer in your list.',
  no_cv: 'Add a CV first.',
  cv_not_reviewed: 'Review your CV’s source details first so the assessment can point at real evidence.',
  no_posting_text: 'No job description was captured for this job, so it cannot be assessed.',
  already_current: 'This job already has an up-to-date assessment.',
  jd_differs:
    'An earlier assessment of this job used a different job description. Open it in Search and use Compare with my CV to redo it.',
};

function refuse(code: AssessmentRefusalCode): PrepareAssessmentResult {
  return { ok: false, code, message: REFUSAL_TEXT[code] };
}

/** No AI, no network: decides whether a saved job can be assessed and fixes the inputs a result must match. */
export async function prepareAssessment(deps: BriefServiceDeps, savedJobId: string): Promise<PrepareAssessmentResult> {
  let built: Built;
  try {
    built = await build(deps, { savedJobId });
  } catch (error) {
    if (error instanceof WorkspaceNotFoundError) return refuse('not_found');
    throw error;
  }
  const { brief, cv, cvHash, overlay, overlayMatch, context } = built;
  if (!cv || cvHash === null) return refuse('no_cv');
  if (!isReviewedSource(cv.source)) return refuse('cv_not_reviewed');
  if (brief.jdText === null || brief.jdHash === null) return refuse('no_posting_text');
  if (built.view.assessment.state === 'current') return refuse('already_current');
  if (overlay && (overlayMatch === 'jd_differs' || overlayMatch === 'both_differ')) return refuse('jd_differs');
  const job = context.savedJob!;
  const reusable = overlay && (overlayMatch === 'matches' || overlayMatch === 'cv_differs') ? overlay : null;
  return {
    ok: true,
    plan: {
      savedJobId,
      briefId: brief.id,
      cvId: cv.id,
      lead: {
        key: built.overlayKeys[0] ?? vacancyKeyFor({ title: job.role, company: job.company, location: job.location, url: job.sourceUrl ?? '' }),
        title: job.role,
        company: job.company,
        location: job.location,
        url: job.sourceUrl ?? '',
        description: brief.jdText,
      },
      fence: {
        briefId: brief.id,
        factsVersion: brief.factsVersion,
        jdHash: brief.jdHash,
        cvId: cv.id,
        cvHash,
        overlayId: reusable?.id ?? null,
        overlayCaseRevision: reusable?.caseRevision ?? null,
      },
      existing: reusable ? reusable.requirements : [],
    },
  };
}

const STALE_TEXT =
  'The job description, your CV or this assessment changed while it was running, so the result was discarded. Nothing was saved.';

/**
 * Saves an assessment the renderer produced, but only if every input it was produced against is still
 * the current one. Anything else is refused, not merged: a late result can never overwrite newer work.
 */
export async function commitAssessment(deps: BriefServiceDeps, input: CommitAssessmentInput): Promise<CommitAssessmentResult> {
  let built: Built;
  try {
    built = await build(deps, { savedJobId: input.savedJobId });
  } catch (error) {
    if (error instanceof WorkspaceNotFoundError) return { ok: false, code: 'not_found', message: REFUSAL_TEXT.not_found };
    throw error;
  }
  const { brief, cv, cvHash, overlay, context } = built;
  const fence = input.fence;
  const sameInputs =
    brief.id === fence.briefId &&
    brief.factsVersion === fence.factsVersion &&
    brief.jdHash === fence.jdHash &&
    cv !== null &&
    cv.id === fence.cvId &&
    cvHash === fence.cvHash &&
    isReviewedSource(cv.source);
  if (!sameInputs || !cv || brief.jdText === null) return { ok: false, code: 'stale', message: STALE_TEXT };
  if (fence.overlayId !== null) {
    if (!overlay || overlay.id !== fence.overlayId || overlay.caseRevision !== fence.overlayCaseRevision) {
      return { ok: false, code: 'stale', message: STALE_TEXT };
    }
  } else if (overlay) {
    return { ok: false, code: 'stale', message: STALE_TEXT };
  }

  let patch: ReturnType<typeof parseCvEvidenceOverlayPatch>;
  try {
    patch = parseCvEvidenceOverlayPatch({
      sourceCvContentHash: fence.cvHash,
      requirements: input.requirements,
      requirementCoverage: input.requirementCoverage,
    });
  } catch {
    return { ok: false, code: 'invalid', message: 'The assessment result could not be read, so nothing was saved.' };
  }

  const job = context.savedJob!;
  try {
    let target = overlay;
    if (!target) {
      target = workspace.createCvEvidenceOverlay(deps.db, {
        cvId: cv.id,
        vacancyKey: built.overlayKeys[0] ?? vacancyKeyFor({ title: job.role, company: job.company, location: job.location, url: job.sourceUrl ?? '' }),
        caseTitle: job.role,
        caseCompany: job.company,
        sourceCvContentHash: fence.cvHash,
        jdSnapshot: brief.jdText,
        jdSnapshotHash: fence.jdHash,
        jdComplete: brief.jdComplete,
        origin: 'vacancy',
        jdOrigin: 'found',
        ...(job.sourceUrl ? { jdUrl: job.sourceUrl } : {}),
      });
    }
    workspace.updateCvEvidenceOverlay(deps.db, target.id, patch);
  } catch (error) {
    deps.log?.('assessment commit failed', { error: error instanceof Error ? error.name : 'unknown' });
    return { ok: false, code: 'invalid', message: 'The assessment could not be saved. Nothing was changed.' };
  }
  const view = (await build(deps, { savedJobId: input.savedJobId })).view;
  return { ok: true, view };
}

// ------------------------------------------------------------------------------ preference fix

export async function correctPreference(deps: BriefServiceDeps, correction: PreferenceCorrection): Promise<void> {
  if (!deps.saveProfilePatch) throw new Error('preferences cannot be changed here');
  const constraints: Record<string, unknown> = {};
  if (correction.relocationWilling !== undefined) constraints.relocationWilling = correction.relocationWilling;
  if (correction.primaryCountry !== undefined) constraints.primaryCountry = correction.primaryCountry;
  if (correction.professionalLanguage !== undefined) constraints.professionalLanguage = correction.professionalLanguage;
  if (Object.keys(constraints).length === 0) return;
  // Only the person's preferences are written. No brief row, scan fact, assessment or attempt is
  // touched here: the next read finds the preference changed and says which sections it affects.
  await deps.saveProfilePatch({ constraints });
}
