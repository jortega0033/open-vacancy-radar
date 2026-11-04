import type { BlindApplyCandidate, BlindApplyCurrentFacts } from './blind-apply-eligibility.js';
import {
  BLIND_APPLY_STATE_LABELS,
  type BlindApplyEvidenceView,
  type BlindApplyFeedItem,
  type BlindApplyStatus,
} from './blind-apply-types.js';
import { BLIND_APPLY_ITEM_STATES } from './workspace/blind-apply-schema.js';
import {
  getActiveBlindApplyAuthorization,
  getBlindApplyItem,
  listBlindApplyEvents,
  listBlindApplyItems,
  type BlindApplyItemRecord,
} from './workspace/blind-apply-store.js';
import * as workspace from './workspace/repository.js';
import type { WorkspaceDb } from './workspace/client.js';

/**
 * What the renderer is shown about Blind Apply (#722), built from the local record. Read-only: nothing
 * here writes, and nothing here contains an employer page's text except the one receipt reference,
 * which is bounded display data the renderer must render as plain text.
 */

/** The role-family label the relevance assessment gives a frontend vacancy (`relevance.ts`). The test
 * `blind-apply-eligibility.test.ts` pins this against the live classifier so the two cannot drift. */
export const FRONTEND_PRIMARY_FIT = 'Frontend / UI engineering';

/** The structural slice of a discovery row the gates need. Kept structural so this module does not
 * depend on the whole vacancy-engine report type. */
export interface BlindApplyAuditRow {
  key: string;
  company: string;
  title: string;
  url: string;
  decision: string;
  profileMatch?: { primaryFit?: string } | null;
  eligibility?: { candidateWorkCountry: { answer: string }; mandatoryLanguage: { answer: string } } | null;
  applyUrl?: { status: string; url?: string | null } | null;
}

/** Folds one discovery row into the gate inputs. `unknown` is kept as unknown, never rounded up. */
export function candidateFromAuditRow(row: BlindApplyAuditRow): BlindApplyCandidate {
  const verified = row.applyUrl?.status === 'verified' && typeof row.applyUrl.url === 'string' && row.applyUrl.url !== '';
  let filters: BlindApplyCandidate['filters'];
  if (row.decision !== 'official_review_candidate') {
    filters = 'not_eligible';
  } else if (!row.eligibility) {
    filters = 'unknown';
  } else {
    const country = row.eligibility.candidateWorkCountry.answer;
    const language = row.eligibility.mandatoryLanguage.answer;
    filters = country === 'no' || language === 'no' ? 'not_eligible' : country === 'yes' && language === 'yes' ? 'eligible' : 'unknown';
  }
  return {
    vacancyKey: row.key,
    company: row.company,
    role: row.title,
    applyUrl: verified ? (row.applyUrl!.url as string) : row.url,
    family: row.profileMatch?.primaryFit === FRONTEND_PRIMARY_FIT ? 'frontend' : null,
    filters,
    linkStatus: verified ? 'verified' : row.applyUrl ? 'unverified' : 'unknown',
  };
}

/** The hard filters the person confirms, as the snapshot stored with the authorization. */
export interface BlindApplyProfileFilters {
  targetRoles: string[];
  excludedRoleFamilies: string[];
  primaryCountry: string;
  location: string;
  professionalLanguage: string;
  minimumMonthlyBaseEur: number;
  dutchRequired: boolean;
}

/** One plain line per filter that is actually set. An unset filter is not invented into a line. */
export function blindFilterLines(filters: Partial<BlindApplyProfileFilters>): string[] {
  const lines: string[] = [];
  if (filters.targetRoles && filters.targetRoles.length > 0) lines.push(`Target roles: ${filters.targetRoles.join(', ')}`);
  if (filters.excludedRoleFamilies && filters.excludedRoleFamilies.length > 0) lines.push(`Excluded: ${filters.excludedRoleFamilies.join(', ')}`);
  if (filters.primaryCountry) lines.push(`Work country: ${filters.primaryCountry}`);
  if (filters.location) lines.push(`Based in: ${filters.location}`);
  if (filters.professionalLanguage) lines.push(`Working language: ${filters.professionalLanguage}`);
  if (typeof filters.minimumMonthlyBaseEur === 'number' && filters.minimumMonthlyBaseEur > 0) {
    lines.push(`Minimum base salary: ${filters.minimumMonthlyBaseEur} EUR a month`);
  }
  if (filters.dutchRequired === false) lines.push('Dutch is not required of you');
  return lines;
}

// ------------------------------------------------------------------------------- status

export function buildBlindApplyStatus(
  db: WorkspaceDb,
  input: {
    current: BlindApplyCurrentFacts | null;
    cvName: string | null;
    targets: ReadonlyArray<{ displayName: string; testOnly: boolean }>;
  },
): BlindApplyStatus {
  const auth = getActiveBlindApplyAuthorization(db);
  const counts = Object.fromEntries(BLIND_APPLY_ITEM_STATES.map((state) => [state, 0])) as BlindApplyStatus['counts'];
  for (const item of listBlindApplyItems(db)) counts[item.state] += 1;

  let paused: BlindApplyStatus['paused'] = null;
  if (auth && input.current) {
    if (input.current.cvContentHash === null || input.current.cvContentHash !== auth.sourceCvContentHash) {
      paused = { reason: 'cv_changed', detail: 'Your CV changed. Confirm Blind Apply again to continue.' };
    } else if (input.current.profileVersion !== auth.profileVersion) {
      paused = { reason: 'profile_changed', detail: 'Your profile changed. Confirm Blind Apply again to continue.' };
    }
  }

  return {
    active: auth !== null,
    paused,
    authorization: auth
      ? {
          createdAt: auth.createdAt,
          roleFamilies: auth.roleFamilies,
          filters: blindFilterLines(auth.filtersSnapshot as Partial<BlindApplyProfileFilters>),
          cvName: input.cvName,
        }
      : null,
    supported: {
      real: input.targets.filter((target) => !target.testOnly).map((target) => target.displayName),
      testOnly: input.targets.filter((target) => target.testOnly).map((target) => target.displayName),
    },
    counts,
  };
}

// --------------------------------------------------------------------------------- feed

function feedItemOf(item: BlindApplyItemRecord): BlindApplyFeedItem {
  const hasReview = item.attemptId !== null && (item.state === 'needs_you' || item.state === 'could_not_submit' || item.state === 'outcome_unknown');
  return {
    id: item.id,
    company: item.company,
    role: item.role,
    state: item.state,
    label: BLIND_APPLY_STATE_LABELS[item.state],
    detail: item.stateDetail,
    intervention: item.intervention,
    missingFields: item.missingFields,
    updatedAt: item.updatedAt,
    attemptId: item.attemptId,
    open: item.state === 'apply_yourself' ? 'apply_yourself' : hasReview ? 'review' : null,
  };
}

/** The activity feed, newest first. Skipped roles are counted in the status, not listed one by one: they
 * are the ones nothing was done for, and listing hundreds of them would bury the ones that matter. */
export function buildBlindApplyFeed(db: WorkspaceDb): BlindApplyFeedItem[] {
  return listBlindApplyItems(db)
    .filter((item) => item.state !== 'skipped')
    .map(feedItemOf);
}

// ----------------------------------------------------------------------------- evidence

export function buildBlindApplyEvidence(db: WorkspaceDb, itemId: string): BlindApplyEvidenceView | null {
  const item = getBlindApplyItem(db, itemId);
  if (!item) return null;
  const events = listBlindApplyEvents(db, item.id);
  const withCv = events.filter((event) => event.cvArtifactHash !== null).at(-1);
  const withLetter = events.filter((event) => event.letterArtifactHash !== null).at(-1);
  const answers = events.filter((event) => event.kind === 'answer_used').at(-1)?.answers ?? [];
  const receipt = item.attemptId
    ? (workspace.listApplicationSubmissionReceipts(db, item.attemptId).at(-1) ?? null)
    : null;
  return {
    itemId: item.id,
    gate: item.gateEvidence,
    events: events.map((event) => ({ at: event.at, kind: event.kind, from: event.fromState, to: event.toState, detail: event.detail })),
    documents: { cvHash: withCv?.cvArtifactHash ?? null, letterHash: withLetter?.letterArtifactHash ?? null },
    answers,
    receipt: receipt
      ? {
          outcome: receipt.outcome,
          evidenceKind: receipt.evidenceKind,
          evidenceReference: receipt.evidenceReference,
          destination: receipt.destination,
          observedAt: receipt.observedAt,
          detail: receipt.detail,
        }
      : null,
  };
}
