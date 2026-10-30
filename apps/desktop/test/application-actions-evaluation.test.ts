// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #692 evaluation: missed actions and false suggestions, measured at the REAL lifecycle and suggestion
 * entrypoints (the `application-actions:*` handlers over a migrated SQLite database that is also closed
 * and reopened), against labels declared by hand in `application-actions-evaluation-fixtures.ts`.
 *
 * Reproduce:  OVR_EVAL_OUT=<path>/692-evaluation.json pnpm exec vitest run test/application-actions-evaluation.test.ts
 *
 * What this is NOT: a human-labelled set, a sample of real applications, a usability study, or any claim
 * about response rates, timing or outcomes. It checks that the shipped rules do what the written rules say
 * on constructed cases, and shows what two simpler rules would have got wrong on the same cases.
 */

vi.mock('electron', () => ({}));
vi.mock('../electron/application-view.js', () => ({ createApplicationView: vi.fn() }));
vi.setConfig({ testTimeout: 60_000 });

const { createWorkspaceDb } = await import('../electron/workspace/client.js');
const workspace = await import('../electron/workspace/repository.js');
const review = await import('../electron/application-review-session.js');
const { createApplicationActionsHandlers } = await import('../electron/application-actions-ipc.js');
const { parseActionsResult, parseOverviewResult } = await import('../electron/application-actions-types.js');
const { ApplicationDataResetGate } = await import('../electron/application-data-reset-gate.js');
const { dueStateOf } = await import('../electron/application-actions-core.js');
const { actionsDeps } = await import('./application-actions-harness.js');
const { AS_OF, ROW_CASES } = await import('./application-actions-evaluation-fixtures.js');
import type { ActionsView, ActionView } from '../electron/application-actions-types.js';
import type { WorkspaceDb } from '../electron/workspace/client.js';
import type { RowCase } from './application-actions-evaluation-fixtures.js';

const gate = new ApplicationDataResetGate();
const asOfMs = Date.parse(AS_OF);
let dir: string;
let db: WorkspaceDb;
let closeDb: () => void;
let n = 0;

function handlers() {
  return createApplicationActionsHandlers(async () => actionsDeps({ db, gate, now: () => new Date(asOfMs - 86_400_000) }));
}
async function call(channel: string, payload: unknown) {
  return parseActionsResult(JSON.parse(JSON.stringify(await handlers()[channel]!(JSON.parse(JSON.stringify(payload))))));
}

function makeRow(rowCase: RowCase): string {
  const make = rowCase.make;
  if (make.how === 'hand') {
    return workspace.createApplication(db, {
      role: `Role ${rowCase.id}`,
      company: 'Synthetic Co',
      status: make.status,
      appliedAt: make.appliedAt,
      archived: make.archived ?? false,
      nextStep: 'a note the person wrote',
    }).id;
  }
  n += 1;
  const attempt = workspace.createApplicationAttempt(db, {
    vacancyKey: `eval-${n}`,
    canonicalUrl: `https://jobs.example.test/eval/${n}`,
    company: 'Synthetic Co',
    role: `Role ${rowCase.id}`,
    sourceCvContentHash: 'a'.repeat(64),
    jdSnapshotHash: 'b'.repeat(64),
    checkpoint: 'queued',
  });
  if (make.checkpoint === 'submitted') {
    workspace.createApplicationSubmissionReceipt(db, {
      attemptId: attempt.id,
      outcome: 'submitted',
      source: 'page_observation',
      destination: `https://jobs.example.test/eval/${n}`,
      evidenceKind: 'confirmation_page',
      evidenceReference: 'Thank you for applying',
      detail: 'a confirmation page appeared',
      observedAt: '2026-10-12T09:00:00.000Z',
    });
    workspace.updateApplicationAttempt(db, attempt.id, { checkpoint: 'submitted', submittedAt: '2026-10-12T09:00:00.000Z', submissionMode: 'manual', completionEvidence: 'receipt_confirmed' });
  } else if (make.checkpoint === 'user_reported') {
    workspace.updateApplicationAttempt(db, attempt.id, { checkpoint: 'ready' });
    review.recordUserReportedSubmission(db, attempt.id, '', '2026-10-12T09:00:00.000Z');
  } else if (make.checkpoint === 'submission_unknown') {
    workspace.updateApplicationAttempt(db, attempt.id, { checkpoint: 'submission_unknown', submittedAt: '2026-10-12T09:00:00.000Z' });
  } else if (make.checkpoint !== 'queued') {
    workspace.updateApplicationAttempt(db, attempt.id, { checkpoint: make.checkpoint });
  }
  const applicationId = workspace.getApplicationAttempt(db, attempt.id).applicationId!;
  if (make.status) workspace.updateApplication(db, applicationId, { status: make.status });
  return applicationId;
}

interface Built {
  rowCase: RowCase;
  applicationId: string;
  actionIds: Map<string, string>;
}

async function build(): Promise<Built[]> {
  const built: Built[] = [];
  for (const rowCase of ROW_CASES) {
    const applicationId = makeRow(rowCase);
    const actionIds = new Map<string, string>();
    for (const action of rowCase.actions ?? []) {
      n += 1;
      const created = await call('application-actions:create', {
        applicationId,
        requestId: `eval-request-${String(n).padStart(6, '0')}`,
        fields: { kind: 'follow_up', title: action.id, note: '', channel: 'unspecified', contactDetail: '' },
        due: action.due,
        origin: 'user',
      });
      if (!created.ok) throw new Error(`fixture ${action.id} was refused: ${created.code} ${created.message}`);
      const stored = created.view.actions.find((entry) => entry.title === action.id)!;
      actionIds.set(action.id, stored.id);
      if (action.final !== 'open') {
        const done = await call(action.final === 'completed' ? 'application-actions:complete' : 'application-actions:dismiss', { applicationId, actionId: stored.id, expectedVersion: stored.version });
        if (!done.ok) throw new Error(`fixture ${action.id} could not be ${action.final}`);
      }
    }
    if (rowCase.suppressed) await call('application-actions:set-suppressed', { applicationId, suppressed: true });
    built.push({ rowCase, applicationId, actionIds });
  }
  return built;
}

const stateOf = (action: ActionView) =>
  dueStateOf(
    { state: action.state, dueKind: action.dueKind, dueDate: action.dueDate, dueLocal: action.dueLocal, dueTimeZone: action.dueTimeZone, dueAtMs: Date.parse(action.dueAt) },
    asOfMs,
  );

interface Observation {
  suggestion: boolean;
  reason: string;
  submissionClass: string;
  status: string;
  actions: Array<{ id: string; state: string }>;
}

/** What the person-facing entrypoints report for each row, from both `get` and `overview`. */
async function observe(built: Built[]): Promise<{ viaGet: Map<string, Observation>; viaOverview: Map<string, Observation>; allViews: Map<string, ActionsView> }> {
  const viaGet = new Map<string, Observation>();
  const viaOverview = new Map<string, Observation>();
  const allViews = new Map<string, ActionsView>();
  const overview = parseOverviewResult(JSON.parse(JSON.stringify(await handlers()['application-actions:overview']!({}))));
  if (!overview.ok) throw new Error('overview failed');
  for (const entry of built) {
    const result = await call('application-actions:get', { applicationId: entry.applicationId });
    if (!result.ok) throw new Error(`get failed for ${entry.rowCase.id}`);
    const view = result.view;
    allViews.set(entry.rowCase.id, view);
    const names = new Map([...entry.actionIds].map(([name, id]) => [id, name]));
    viaGet.set(entry.rowCase.id, {
      suggestion: view.suggestion.eligible,
      reason: view.suggestion.reason,
      submissionClass: view.application.submissionClass,
      status: view.application.status,
      actions: view.actions.map((action) => ({ id: names.get(action.id) ?? action.id, state: stateOf(action) })),
    });
    const item = overview.items.find((candidate) => candidate.applicationId === entry.applicationId)!;
    viaOverview.set(entry.rowCase.id, {
      suggestion: item.suggestion.eligible,
      reason: item.suggestion.reason,
      submissionClass: viaGet.get(entry.rowCase.id)!.submissionClass,
      status: viaGet.get(entry.rowCase.id)!.status,
      actions: item.openActions.map((action) => ({ id: names.get(action.id) ?? action.id, state: stateOf(action) })),
    });
  }
  return { viaGet, viaOverview, allViews };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-eval-692-'));
  ({ db, close: closeDb } = createWorkspaceDb(dir));
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('#692 evaluation on constructed, predeclared cases', () => {
  it('reports no missed action and no false suggestion at the real entrypoints, before and after a restart', async () => {
    const built = await build();
    const first = await observe(built);
    closeDb();
    ({ db, close: closeDb } = createWorkspaceDb(dir));
    const afterRestart = await observe(built);

    const rawCases: Array<Record<string, unknown>> = [];
    let expectedOverdue = 0;
    let reportedOverdueCorrect = 0;
    let missedActions = 0;
    let falseOverdue = 0;
    let stateMismatches = 0;
    let actionsTotal = 0;
    let expectedEligible = 0;
    let falseSuggestions = 0;
    let missedSuggestions = 0;
    let reasonMismatches = 0;
    let classMismatches = 0;
    let overviewVsGet = 0;
    let restartDifferences = 0;
    let baselineStatusOnlyFalse = 0;
    let baselineStatusOnlyMissed = 0;
    let baselineUtcDateMismatches = 0;
    let baselineUtcDateMissed = 0;
    let baselineUtcDateFalse = 0;
    const perGroup: Record<string, { rows: number; falseSuggestions: number; missedSuggestions: number }> = {};

    for (const { rowCase, actionIds } of built) {
      const got = first.viaGet.get(rowCase.id)!;
      const viaOverview = first.viaOverview.get(rowCase.id)!;
      const restarted = afterRestart.viaGet.get(rowCase.id)!;
      const group = (perGroup[rowCase.group] ??= { rows: 0, falseSuggestions: 0, missedSuggestions: 0 });
      group.rows += 1;
      if (rowCase.expected.suggestion) expectedEligible += 1;
      const falsePositive = got.suggestion && !rowCase.expected.suggestion;
      const missed = !got.suggestion && rowCase.expected.suggestion;
      if (falsePositive) {
        falseSuggestions += 1;
        group.falseSuggestions += 1;
      }
      if (missed) {
        missedSuggestions += 1;
        group.missedSuggestions += 1;
      }
      if (got.reason !== rowCase.expected.reason) reasonMismatches += 1;
      if (got.submissionClass !== rowCase.expected.submissionClass) classMismatches += 1;
      if (viaOverview.suggestion !== got.suggestion || viaOverview.reason !== got.reason) overviewVsGet += 1;
      if (JSON.stringify(restarted) !== JSON.stringify(got)) restartDifferences += 1;
      // Constructed comparison: a rule that looks at the status only.
      const naiveEligible = got.status === 'applied';
      if (naiveEligible && !rowCase.expected.suggestion) baselineStatusOnlyFalse += 1;
      if (!naiveEligible && rowCase.expected.suggestion) baselineStatusOnlyMissed += 1;

      const actionObservations: Array<Record<string, unknown>> = [];
      for (const action of rowCase.actions ?? []) {
        actionsTotal += 1;
        const observed = got.actions.find((entry) => entry.id === action.id)?.state ?? 'not_listed';
        const listedInOverview = viaOverview.actions.some((entry) => entry.id === action.id);
        if (action.expected === 'overdue') expectedOverdue += 1;
        if (action.expected === 'overdue' && observed === 'overdue') reportedOverdueCorrect += 1;
        if (action.expected === 'overdue' && observed !== 'overdue') missedActions += 1;
        if (action.expected !== 'overdue' && observed === 'overdue') falseOverdue += 1;
        if (observed !== action.expected) stateMismatches += 1;
        // Open actions must be in the overview too; closed ones must not be.
        if ((action.final === 'open') !== listedInOverview) overviewVsGet += 1;
        // Constructed comparison: a date read as the start of that day in UTC; a time read in UTC.
        const naiveDueMs = action.due.kind === 'date' ? Date.parse(`${action.due.date}T00:00:00Z`) : Date.parse(`${action.due.local}:00Z`);
        const naiveOverdue = action.final === 'open' && asOfMs >= naiveDueMs;
        if (naiveOverdue !== (action.expected === 'overdue')) baselineUtcDateMismatches += 1;
        if (!naiveOverdue && action.expected === 'overdue') baselineUtcDateMissed += 1;
        if (naiveOverdue && action.expected !== 'overdue') baselineUtcDateFalse += 1;
        actionObservations.push({ id: action.id, due: action.due, final: action.final, storedId: actionIds.get(action.id), expectedState: action.expected, observedState: observed, listedInOverview, match: observed === action.expected });
      }
      rawCases.push({
        id: rowCase.id,
        group: rowCase.group,
        expected: rowCase.expected,
        observed: { suggestion: got.suggestion, reason: got.reason, submissionClass: got.submissionClass, status: got.status },
        suggestionMatch: got.suggestion === rowCase.expected.suggestion && got.reason === rowCase.expected.reason,
        actions: actionObservations,
      });
    }

    const report = {
      issue: 692,
      title: 'Local due actions and follow-up suggestions: constructed-case evaluation',
      kind: 'constructed synthetic cases with predeclared labels',
      asOf: AS_OF,
      method: [
        'Synthetic Applications rows and actions are created through the real migrated workspace database and the real application-actions IPC handlers.',
        'Expected labels (overdue/due today/upcoming/closed per action; suggestion yes/no, reason and submission class per row) are declared by hand in test/application-actions-evaluation-fixtures.ts from the written rules, before any code is run.',
        'Observed values come from the same entrypoints the app uses: application-actions:get and application-actions:overview, with each action judged by the shared dueStateOf at the fixed clock. The database is then closed and reopened and every row is observed again.',
        'Two simpler rules are scored on the same cases as constructed comparisons only: a status-only suggestion rule, and reading a whole-day date or a typed time as UTC. They are not shipped behaviour.',
        'No inferred cadence exists in the feature, so none is evaluated; the suggestion has no day-count threshold.',
      ],
      counts: {
        rows: ROW_CASES.length,
        actions: actionsTotal,
        rowsExpectedEligibleForSuggestion: expectedEligible,
        rowsExpectedNotEligible: ROW_CASES.length - expectedEligible,
      },
      shipped: {
        missedActions: { expectedOverdue, reportedOverdue: reportedOverdueCorrect, missed: missedActions },
        falseOverdue,
        actionStateMismatches: stateMismatches,
        falseSuggestions,
        missedSuggestions,
        reasonMismatches,
        submissionClassMismatches: classMismatches,
        overviewVersusGetDisagreements: overviewVsGet,
        rowsDifferentAfterRestart: restartDifferences,
        perGroup,
      },
      constructedComparisons: {
        statusOnlySuggestionRule: { falseSuggestions: baselineStatusOnlyFalse, missedSuggestions: baselineStatusOnlyMissed, note: 'Suggests whenever status is Applied, ignoring evidence of sending, archive, the person’s switch and existing plans.' },
        dateReadAsUtc: { actionsMislabelled: baselineUtcDateMismatches, missedOverdue: baselineUtcDateMissed, falselyOverdue: baselineUtcDateFalse, note: 'Reads a whole-day date as the start of that day in UTC and a typed time as UTC, ignoring the zone the person named.' },
      },
      rawCases,
      unknowns: [
        'No human labels: every expected value was written by the implementer from the written rules.',
        'Not a sample of real applications: no coverage claim for real-world data, employers, applicant tracking systems or user behaviour.',
        'Says nothing about whether follow-ups improve response rates, outcomes, usability or effort, and nothing about how well a draft reads (no model was called).',
        'Whether people want a prompt on a sent, quiet application is untested; the suggestion is an affordance that can be switched off, with no timing assumption.',
        'A future "employer page opened" handoff (#658) is represented only by a prepared attempt whose status is still Preparing; its real shape is not tested.',
        'The machine time zone never enters any judgement; it was not varied because there is nothing to vary.',
      ],
    };

    if (process.env.OVR_EVAL_OUT) writeFileSync(process.env.OVR_EVAL_OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    expect(report.counts.rows).toBeGreaterThanOrEqual(40);
    expect(report.counts.actions).toBeGreaterThanOrEqual(16);
    expect(expectedOverdue).toBeGreaterThanOrEqual(8);
    expect(report.shipped).toMatchObject({
      falseOverdue: 0,
      actionStateMismatches: 0,
      falseSuggestions: 0,
      missedSuggestions: 0,
      reasonMismatches: 0,
      submissionClassMismatches: 0,
      overviewVersusGetDisagreements: 0,
      rowsDifferentAfterRestart: 0,
    });
    expect(report.shipped.missedActions).toEqual({ expectedOverdue, reportedOverdue: expectedOverdue, missed: 0 });
    // The comparisons are there to show what the distinctions prevent; they must actually differ from the shipped result.
    expect(baselineStatusOnlyFalse).toBeGreaterThan(0);
    expect(baselineUtcDateMismatches).toBeGreaterThan(0);
  });
});

describe('the fixtures are a fair test of themselves', () => {
  it('declares a label for every case, covers every submission class and every suggestion reason, and uses unique ids', () => {
    expect(new Set(ROW_CASES.map((row) => row.id)).size).toBe(ROW_CASES.length);
    expect(new Set(ROW_CASES.map((row) => row.expected.submissionClass))).toEqual(
      new Set(['receipt_backed', 'user_reported', 'user_stated', 'unconfirmed', 'prepared', 'not_recorded']),
    );
    expect(new Set(ROW_CASES.map((row) => row.expected.reason))).toEqual(
      new Set(['eligible', 'archived', 'suppressed', 'terminal', 'in_conversation', 'not_submitted', 'unknown_submission', 'has_open_action']),
    );
    for (const row of ROW_CASES) expect(row.expected.suggestion).toBe(row.expected.reason === 'eligible');
  });
});
