/**
 * Keeps the Applications list and the saved job in step with the application attempt that produced
 * them (#444).
 *
 * Two models used to exist side by side and never met: the manual tracker (`applications`) and the
 * pipeline's attempts (`application_attempts`). After a real submission the Active tab still said
 * "No applications yet" and the saved job still said "Considering".
 *
 * The link is one column, `application_attempts.application_id`. Every function here is idempotent
 * and derives the row from the attempt's *current* state, so a repeated event or an app restart
 * updates the same row and can never create a second one.
 *
 * What counts as Applied is deliberately narrow. Only `submitted` (a receipt this app observed) and
 * `user_reported` (the person said so) move a row to Applied. A prepared, failed, skipped or
 * uncertain (`submission_unknown`) attempt never does: an unconfirmed send is shown as exactly
 * that, with a next step telling the person how to find out.
 */

import { and, desc, eq, inArray, or } from 'drizzle-orm';
import type { WorkspaceDb } from './client.js';
import { applicationAttempts, applications, savedJobs } from './schema.js';
import { NON_TERMINAL_ATTEMPT_CHECKPOINTS, type ApplicationAttemptCheckpoint } from './types.js';

type AttemptRow = typeof applicationAttempts.$inferSelect;

export interface DerivedApplicationState {
  status: 'preparing' | 'applied';
  appliedAt: Date | null;
  /** Written to `applications.next_step` only while the person has not replaced it with their own. */
  nextStep: string;
  /** True for an attempt the person skipped: the row leaves the Active list but is kept. */
  archived: boolean;
  /** What the saved job's own status should become, or null to leave it as it is. */
  savedJobStatus: 'considering' | 'preparing' | 'applied' | null;
}

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/** Same format as the Applied column in the tracker, so one row never mixes date styles. */
export const displayDay = (date: Date): string =>
  date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** Every sentence this module writes into `next_step`. Anything else there is the person's own. */
const AUTO_NEXT_STEPS = [
  'Preparing the application.',
  'Ready for your review in the Review queue.',
  'Sending now.',
  'Needs your input in the Review queue.',
  'Preparation failed. Open the Review queue to retry.',
  'Skipped from the Review queue.',
  'Sent, but no confirmation was seen.',
  'Sent ',
  'You said you applied on ',
  'Reported by you ',
] as const;

export function isAutomaticNextStep(value: string): boolean {
  return value.trim() === '' || AUTO_NEXT_STEPS.some((prefix) => value.startsWith(prefix));
}

/**
 * Pure mapping from an attempt's checkpoint to what the tracker should show. The three ways an
 * attempt can have reached the employer are kept apart, with their source and date visible:
 * `submitted` (receipt observed), `user_reported`, and `submission_unknown` (not confirmed).
 */
export function deriveApplicationState(
  attempt: Pick<AttemptRow, 'checkpoint' | 'submittedAt' | 'updatedAt'>,
): DerivedApplicationState {
  const when = attempt.submittedAt ?? attempt.updatedAt;
  const base = { appliedAt: null, archived: false } as const;
  switch (attempt.checkpoint) {
    case 'submitted':
      return {
        status: 'applied',
        appliedAt: when,
        archived: false,
        nextStep: `Sent ${isoDay(when)}: the employer page confirmed it.`,
        savedJobStatus: 'applied',
      };
    case 'user_reported':
      return {
        status: 'applied',
        appliedAt: when,
        archived: false,
        nextStep: `You said you applied on ${displayDay(when)}. The app did not see a confirmation.`,
        savedJobStatus: 'applied',
      };
    case 'submission_unknown':
      return {
        ...base,
        status: 'preparing',
        nextStep: 'Sent, but no confirmation was seen. Check the employer site or your email, then mark it applied.',
        savedJobStatus: 'preparing',
      };
    case 'skipped':
      return { ...base, status: 'preparing', archived: true, nextStep: 'Skipped from the Review queue.', savedJobStatus: 'considering' };
    case 'failed':
      return { ...base, status: 'preparing', nextStep: 'Preparation failed. Open the Review queue to retry.', savedJobStatus: 'preparing' };
    case 'needs_user':
      return { ...base, status: 'preparing', nextStep: 'Needs your input in the Review queue.', savedJobStatus: 'preparing' };
    case 'ready':
      return { ...base, status: 'preparing', nextStep: 'Ready for your review in the Review queue.', savedJobStatus: 'preparing' };
    case 'submitting':
      return { ...base, status: 'preparing', nextStep: 'Sending now.', savedJobStatus: 'preparing' };
    default:
      return { ...base, status: 'preparing', nextStep: 'Preparing the application.', savedJobStatus: 'preparing' };
  }
}

function findSavedJob(tx: WorkspaceDb, vacancyKey: string | null) {
  if (!vacancyKey) return undefined;
  return tx.select().from(savedJobs).where(eq(savedJobs.vacancyKey, vacancyKey)).get();
}

/**
 * The tracker row this attempt belongs to: its own link if it has one, else the row an earlier
 * attempt at the same posting left behind while it was still only being prepared (a retry after a
 * skip or a failure must not leave two rows), else a new one.
 */
function resolveApplicationRow(tx: WorkspaceDb, attempt: AttemptRow): typeof applications.$inferSelect {
  if (attempt.applicationId) {
    const linked = tx.select().from(applications).where(eq(applications.id, attempt.applicationId)).get();
    if (linked) return linked;
  }

  const sameOpening = [
    attempt.vacancyKey ? eq(applicationAttempts.vacancyKey, attempt.vacancyKey) : undefined,
    attempt.canonicalUrlKey ? eq(applicationAttempts.canonicalUrlKey, attempt.canonicalUrlKey) : undefined,
  ].filter((clause): clause is NonNullable<typeof clause> => clause !== undefined);
  if (sameOpening.length > 0) {
    const siblings = tx
      .select({ applicationId: applicationAttempts.applicationId })
      .from(applicationAttempts)
      .where(and(or(...sameOpening), eq(applicationAttempts.applicationDetached, false)))
      .orderBy(desc(applicationAttempts.createdAt))
      .all();
    for (const sibling of siblings) {
      if (!sibling.applicationId) continue;
      const row = tx.select().from(applications).where(eq(applications.id, sibling.applicationId)).get();
      if (row && row.status === 'preparing') return row;
    }
  }

  const savedJob = findSavedJob(tx, attempt.vacancyKey);
  const [created] = tx
    .insert(applications)
    .values({
      savedJobId: savedJob?.id ?? null,
      role: savedJob?.role ?? attempt.role,
      company: savedJob?.company ?? attempt.company,
      location: savedJob?.location ?? '',
      verification: savedJob?.verification ?? null,
      status: 'preparing',
      cvId: attempt.sourceCvId,
    })
    .returning()
    .all();
  if (!created) throw new Error('failed to insert the application row for an attempt');
  return created;
}

/**
 * Brings the tracker row and the saved job in line with one attempt. Safe to call after every write
 * to the attempt, and again on start-up.
 *
 * Only moves a row forward. A row the person has already advanced (an interview, a withdrawal) is
 * never pulled back to Applied, and a `next_step` the person wrote is never overwritten.
 */
export function syncApplicationForAttempt(tx: WorkspaceDb, attemptId: string): void {
  const attempt = tx.select().from(applicationAttempts).where(eq(applicationAttempts.id, attemptId)).get();
  if (!attempt || attempt.applicationDetached) return;

  const derived = deriveApplicationState(attempt);
  const row = resolveApplicationRow(tx, attempt);
  if (attempt.applicationId !== row.id) {
    tx.update(applicationAttempts).set({ applicationId: row.id }).where(eq(applicationAttempts.id, attempt.id)).run();
  }

  const patch: Partial<typeof applications.$inferInsert> = {};
  if (row.status === 'preparing') {
    if (derived.status === 'applied') {
      patch.status = 'applied';
      patch.appliedAt = row.appliedAt ?? derived.appliedAt;
    }
    if (row.archived !== derived.archived) patch.archived = derived.archived;
  }
  // The attempt's own words describe the row only while the person has not written their own, and
  // only while the row is still in the stage that attempt state belongs to.
  const finalStatus = patch.status ?? row.status;
  if (finalStatus === derived.status && isAutomaticNextStep(row.nextStep) && row.nextStep !== derived.nextStep) {
    patch.nextStep = derived.nextStep;
  }
  if (row.cvId === null && attempt.sourceCvId) patch.cvId = attempt.sourceCvId;
  if (Object.keys(patch).length > 0) tx.update(applications).set(patch).where(eq(applications.id, row.id)).run();

  syncSavedJobStatus(tx, attempt, row.savedJobId, derived);
}

function syncSavedJobStatus(
  tx: WorkspaceDb,
  attempt: AttemptRow,
  linkedSavedJobId: string | null,
  derived: DerivedApplicationState,
): void {
  if (derived.savedJobStatus === null) return;
  const savedJob = linkedSavedJobId
    ? tx.select().from(savedJobs).where(eq(savedJobs.id, linkedSavedJobId)).get()
    : findSavedJob(tx, attempt.vacancyKey);
  if (!savedJob) return;

  let next: 'considering' | 'preparing' | 'applied' | null = null;
  if (derived.savedJobStatus === 'applied') next = 'applied';
  else if (derived.savedJobStatus === 'preparing' && savedJob.status === 'considering') next = 'preparing';
  else if (derived.savedJobStatus === 'considering' && savedJob.status === 'preparing') {
    // Backing out of "preparing" is only right when no other attempt at this posting is still live.
    const stillLive = attempt.vacancyKey
      ? tx
          .select({ id: applicationAttempts.id })
          .from(applicationAttempts)
          .where(
            and(
              eq(applicationAttempts.vacancyKey, attempt.vacancyKey),
              inArray(applicationAttempts.checkpoint, NON_TERMINAL_ATTEMPT_CHECKPOINTS as ApplicationAttemptCheckpoint[]),
            ),
          )
          .all().length > 0
      : false;
    if (!stillLive) next = 'considering';
  }
  if (next !== null && next !== savedJob.status) {
    tx.update(savedJobs).set({ status: next }).where(eq(savedJobs.id, savedJob.id)).run();
  }
}

const HISTORY_ONLY_CHECKPOINTS: ReadonlySet<ApplicationAttemptCheckpoint> = new Set(['failed', 'skipped']);

/**
 * Start-up reconcile: gives every attempt that has no tracker row one, and refreshes the rest.
 * Reads and writes the workspace database only; it never contacts an employer and never resends
 * anything, so an older sent attempt simply appears in the list.
 */
export function reconcileApplicationRows(db: WorkspaceDb): number {
  return db.transaction((tx) => {
    const attempts = tx
      .select({
        id: applicationAttempts.id,
        applicationId: applicationAttempts.applicationId,
        checkpoint: applicationAttempts.checkpoint,
      })
      .from(applicationAttempts)
      .where(eq(applicationAttempts.applicationDetached, false))
      .orderBy(applicationAttempts.createdAt)
      .all();
    let synced = 0;
    for (const attempt of attempts) {
      // An old failed or skipped attempt that never had a row is history, not work: giving it one
      // would fill the Active list with rows nobody asked for after an upgrade.
      const worthARow = attempt.applicationId !== null || !HISTORY_ONLY_CHECKPOINTS.has(attempt.checkpoint);
      if (!worthARow) continue;
      syncApplicationForAttempt(tx, attempt.id);
      synced += 1;
    }
    return synced;
  });
}
