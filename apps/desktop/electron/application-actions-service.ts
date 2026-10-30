import {
  DUE_ISSUE_MESSAGE,
  SUBMISSION_CLASS_LABEL,
  SUGGESTION_LINE,
  classifySubmission,
  followUpSuggestion,
  resolveDue,
  type ActionOrigin,
  type ResolvedDue,
  type RowFacts,
} from './application-actions-core.js';
import type {
  ActionsResult,
  ActionsView,
  ActionView,
  CreateActionRequest,
  DueRequest,
  OverviewResult,
  RescheduleActionRequest,
  SetSuppressedRequest,
  SuggestionView,
  TransitionActionRequest,
  UpdateActionRequest,
} from './application-actions-types.js';
import { isFollowUpRunning } from './follow-up-runs.js';
import { listDrafts } from './workspace/follow-up-draft-store.js';
import {
  changeAction,
  createAction,
  isSuppressed,
  listActions,
  listAllOpenActions,
  setSuppressed,
  suppressedApplicationIds,
  transitionAction,
  type ActionFields,
  type ActionRecord,
} from './workspace/application-action-store.js';
import type { WorkspaceDb } from './workspace/client.js';
import * as workspace from './workspace/repository.js';
import { WorkspaceNotFoundError } from './workspace/repository.js';
import type { ApplicationRecord } from './workspace/types.js';

/**
 * #692: the service behind local due actions. Everything here is a local read or write on the
 * workspace database. It never calls a model, the network, a mailbox, a calendar or a scheduler, and
 * it never writes the Applications row (`status`, `appliedAt`, `nextStep`, `notes` stay exactly as the
 * person and the existing flows left them): completing, dismissing or rescheduling an action is not
 * evidence of anything about the application.
 */

export interface ActionsDeps {
  db: WorkspaceDb;
  now(): Date;
  /** Runs a write under the application data reset gate. */
  mutate<T>(task: () => T | Promise<T>): Promise<T>;
}

export type FailureCode = Extract<ActionsResult, { ok: false }>['code'];

type BasicCode = 'not_found' | 'outdated' | 'not_open' | 'limit' | 'failed';
const MESSAGES: Record<BasicCode, string> = {
  not_found: 'That application or action is no longer available.',
  outdated: 'This changed since you opened it. Check the details and try again.',
  not_open: 'That follow-up was already completed or dismissed.',
  limit: 'This application already has the most follow-ups this app keeps. Dismiss one you no longer need.',
  failed: 'Something went wrong. Nothing was changed.',
};

function factsOf(record: ApplicationRecord): RowFacts {
  return {
    status: record.status,
    archived: record.archived,
    appliedAt: record.appliedAt,
    attempt: record.attempt ? { checkpoint: record.attempt.checkpoint, evidence: record.attempt.evidence } : null,
  };
}

function rowOf(db: WorkspaceDb, applicationId: string): ApplicationRecord {
  const row = workspace.listApplications(db, 'all').find((candidate) => candidate.id === applicationId);
  if (!row) throw new WorkspaceNotFoundError('application', applicationId);
  return row;
}

function suggestionOf(record: ApplicationRecord, suppressed: boolean, openActions: number): SuggestionView {
  const suggestion = followUpSuggestion(factsOf(record), { suppressed, openActions });
  const line =
    suggestion.eligible && record.appliedAt
      ? `Applied ${record.appliedAt.slice(0, 10)}. ${SUGGESTION_LINE.eligible}`
      : SUGGESTION_LINE[suggestion.reason];
  return { eligible: suggestion.eligible, reason: suggestion.reason, line };
}

const view = (action: ActionRecord): ActionView => action;

/** Submission classes for which a follow-up message is worth drafting: something is recorded as sent. */
export const DRAFTABLE_CLASSES: ReadonlySet<string> = new Set(['receipt_backed', 'user_reported', 'user_stated']);

export const NOT_SUBMITTED_MESSAGE =
  'Nothing here confirms this application was sent, so there is nothing to follow up on yet. Mark it applied first if you did apply.';

export function getActionsView(deps: Pick<ActionsDeps, 'db' | 'now'> & { provider?: string }, applicationId: string): ActionsView {
  const record = rowOf(deps.db, applicationId);
  const actions = listActions(deps.db, applicationId);
  const suppressed = isSuppressed(deps.db, applicationId);
  const facts = factsOf(record);
  const submissionClass = classifySubmission(facts);
  return {
    applicationId,
    asOf: deps.now().toISOString(),
    application: {
      role: record.role,
      company: record.company,
      status: record.status,
      archived: record.archived,
      appliedAt: record.appliedAt,
      submissionClass,
      submissionLabel: SUBMISSION_CLASS_LABEL[submissionClass],
    },
    actions: actions.map(view),
    suggestion: suggestionOf(record, suppressed, actions.filter((action) => action.state === 'open').length),
    suppressed,
    drafts: listDrafts(deps.db, applicationId).map((draft) => ({
      ...draft,
      basis: { ...draft.basis, manifestHash: draft.basis.manifestHash ? draft.basis.manifestHash.slice(0, 12) : null },
    })),
    draft: {
      available: DRAFTABLE_CLASSES.has(submissionClass),
      reason: DRAFTABLE_CLASSES.has(submissionClass) ? null : NOT_SUBMITTED_MESSAGE,
      provider: deps.provider ?? 'claude',
    },
    running: isFollowUpRunning(applicationId),
  };
}

/** One entry per row: its open actions and whether "Plan a follow-up" may be offered. */
export function getOverview(deps: Pick<ActionsDeps, 'db' | 'now'>): OverviewResult {
  const rows = workspace.listApplications(deps.db, 'all');
  const open = new Map<string, ActionRecord[]>();
  for (const action of listAllOpenActions(deps.db)) {
    const list = open.get(action.applicationId) ?? [];
    list.push(action);
    open.set(action.applicationId, list);
  }
  const suppressed = suppressedApplicationIds(deps.db);
  return {
    ok: true,
    asOf: deps.now().toISOString(),
    items: rows.map((record) => {
      const openActions = open.get(record.id) ?? [];
      return {
        applicationId: record.id,
        openActions: openActions.map(view),
        suggestion: suggestionOf(record, suppressed.has(record.id), openActions.length),
      };
    }),
  };
}

/* -------------------------------------------------------------------------------- results ----- */

export function okResult(
  deps: ActionsDeps & { provider?: string },
  applicationId: string,
  actionId: string | null,
  unchanged: boolean,
  draftId: string | null = null,
): ActionsResult {
  return { ok: true, view: getActionsView(deps, applicationId), actionId, draftId, unchanged };
}
const ok = okResult;

export function failureResult(
  deps: ActionsDeps & { provider?: string },
  applicationId: string,
  code: FailureCode,
  message: string,
  extra: Partial<Pick<Extract<ActionsResult, { ok: false }>, 'dueIssue' | 'dueOptions'>> = {},
): ActionsResult {
  let current: ActionsView | null;
  try {
    current = getActionsView(deps, applicationId);
  } catch {
    current = null;
  }
  return { ok: false, code, message, view: current, dueIssue: extra.dueIssue ?? null, dueOptions: extra.dueOptions ?? [] };
}
const failure = failureResult;

type DueOutcome = { due: ResolvedDue } | { failed: ActionsResult };

function dueOf(deps: ActionsDeps, applicationId: string, request: DueRequest): DueOutcome {
  const resolved = resolveDue(request);
  if (resolved.ok) return { due: resolved.due };
  return {
    failed: failure(deps, applicationId, 'invalid_due', DUE_ISSUE_MESSAGE[resolved.code], {
      dueIssue: resolved.code,
      dueOptions: (resolved.options ?? []).map((option) => ({
        choice: option.choice,
        instant: new Date(option.instantMs).toISOString(),
        offsetMinutes: option.offsetMinutes,
      })),
    }),
  };
}

const fieldsOf = (fields: CreateActionRequest['fields']): ActionFields => ({
  kind: fields.kind,
  title: fields.title,
  note: fields.note,
  channel: fields.channel,
  contactDetail: fields.contactDetail,
});

/* --------------------------------------------------------------------------------- writes ----- */

export async function createActionRequest(deps: ActionsDeps, input: CreateActionRequest): Promise<ActionsResult> {
  const outcome = dueOf(deps, input.applicationId, input.due);
  if ('failed' in outcome) return outcome.failed;
  const result = await deps.mutate(() =>
    deps.db.transaction((tx) => {
      const db = tx as unknown as WorkspaceDb;
      const record = workspace.listApplications(db, 'all').find((candidate) => candidate.id === input.applicationId);
      if (!record) return { ok: false as const, code: 'not_found' as const };
      // "Accepted a suggestion" is only recorded when the app really offered one at this moment.
      let origin: ActionOrigin = 'user';
      if (input.origin === 'suggestion_accepted') {
        const open = listActions(db, input.applicationId).filter((action) => action.state === 'open').length;
        if (followUpSuggestion(factsOf(record), { suppressed: isSuppressed(db, input.applicationId), openActions: open }).eligible) {
          origin = 'suggestion_accepted';
        }
      }
      return createAction(
        tx,
        {
          applicationId: input.applicationId,
          requestId: input.requestId,
          fields: fieldsOf(input.fields),
          due: outcome.due,
          origin,
          basisClass: classifySubmission(factsOf(record)),
        },
        deps.now(),
      );
    }),
  );
  if (!result.ok) return failure(deps, input.applicationId, result.code, MESSAGES[result.code]);
  return ok(deps, input.applicationId, result.action.id, result.reused);
}

async function change(
  deps: ActionsDeps,
  input: { applicationId: string; actionId: string; expectedVersion: number },
  fields: ActionFields | undefined,
  dueRequest: DueRequest | undefined,
): Promise<ActionsResult> {
  let due: ResolvedDue | undefined;
  if (dueRequest) {
    const outcome = dueOf(deps, input.applicationId, dueRequest);
    if ('failed' in outcome) return outcome.failed;
    due = outcome.due;
  }
  const result = await deps.mutate(() =>
    deps.db.transaction((tx) => changeAction(tx, { ...input, ...(fields ? { fields } : {}), ...(due ? { due } : {}) }, deps.now())),
  );
  if (!result.ok) return failure(deps, input.applicationId, result.code, MESSAGES[result.code]);
  return ok(deps, input.applicationId, result.action.id, result.unchanged);
}

export function updateActionRequest(deps: ActionsDeps, input: UpdateActionRequest): Promise<ActionsResult> {
  return change(deps, input, fieldsOf(input.fields), input.due);
}

/** Moves only the due moment; the action's own fields are left exactly as stored. */
export function rescheduleActionRequest(deps: ActionsDeps, input: RescheduleActionRequest): Promise<ActionsResult> {
  return change(deps, input, undefined, input.due);
}

async function transition(
  deps: ActionsDeps,
  input: TransitionActionRequest & { applicationId: string },
  to: 'completed' | 'dismissed',
): Promise<ActionsResult> {
  const result = await deps.mutate(() => deps.db.transaction((tx) => transitionAction(tx, { ...input, to }, deps.now())));
  if (!result.ok) return failure(deps, input.applicationId, result.code, MESSAGES[result.code]);
  return ok(deps, input.applicationId, result.action.id, result.unchanged);
}

export const completeActionRequest = (deps: ActionsDeps, input: TransitionActionRequest): Promise<ActionsResult> =>
  transition(deps, input, 'completed');
export const dismissActionRequest = (deps: ActionsDeps, input: TransitionActionRequest): Promise<ActionsResult> =>
  transition(deps, input, 'dismissed');

export async function setSuppressedRequest(deps: ActionsDeps, input: SetSuppressedRequest): Promise<ActionsResult> {
  const found = await deps.mutate(() => deps.db.transaction((tx) => setSuppressed(tx, input.applicationId, input.suppressed, deps.now())));
  if (!found) return failure(deps, input.applicationId, 'not_found', MESSAGES.not_found);
  return ok(deps, input.applicationId, null, false);
}
