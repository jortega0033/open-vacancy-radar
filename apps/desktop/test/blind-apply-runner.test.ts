// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mintFieldRef,
  mintOptionRef,
  type FormSnapshot,
  type SnapshotField,
} from '@agent-dock/application-executor';
import { createBlindApplyFieldMapper, createBlindApplyRunner, type BlindApplyRunnerDeps } from '../electron/blind-apply-runner.js';
import type { BlindApplyCandidate, BlindApplyLiveness } from '../electron/blind-apply-eligibility.js';
import { buildApplicationValueTable } from '../electron/application-value-table.js';
import { BLIND_APPLY_WORKFLOW_VERSION, CAPTCHA_STOP_DETAIL } from '../electron/application-pipeline.js';
import { FIXTURE_REVIEW_POLICY } from '../electron/application-target-policies.js';
import { requestBlindApplyAuthorization } from '../electron/blind-apply-authorization.js';
import { createWorkspaceDb, type WorkspaceDb } from '../electron/workspace/client.js';
import * as store from '../electron/workspace/blind-apply-store.js';
import * as workspace from '../electron/workspace/repository.js';
import type { ApplicationArtifactRecord } from '../electron/workspace/types.js';

/**
 * Drives the real runner, the real SQLite store, the real attempt/duplicate rules and the real
 * deterministic mapper. Only the three things that are genuinely other processes are stood in for: the
 * live browser (`reviews`), the daemon queue and preparation worker (`pipeline`), and the network
 * (`checkLiveness`). Every address here is a reserved `.invalid` name; nothing reaches an employer, and
 * no real CV or profile is read.
 */

let dir: string;
let db: WorkspaceDb;
let close: () => void;

const SUPPORTED = 'https://supported.example.invalid/apply/';
const FIXTURE_POLICY = { ...FIXTURE_REVIEW_POLICY, id: 'synthetic-supported' };

function candidate(n: number, overrides: Partial<BlindApplyCandidate> = {}): BlindApplyCandidate {
  return {
    vacancyKey: `vac-${n}`,
    company: `Company ${n}`,
    role: 'Senior Frontend Engineer',
    applyUrl: `${SUPPORTED}${n}`,
    family: 'frontend',
    filters: 'eligible',
    linkStatus: 'verified',
    ...overrides,
  };
}

interface Harness {
  deps: BlindApplyRunnerDeps;
  runner: ReturnType<typeof createBlindApplyRunner>;
  candidates: BlindApplyCandidate[];
  facts: { cvContentHash: string | null; profileVersion: string };
  clock: { now: Date };
  liveness: Map<string, BlindApplyLiveness>;
  live: Set<string>;
  authorizationId: string;
  spies: {
    start: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    requeue: ReturnType<typeof vi.fn>;
    cancelQueue: ReturnType<typeof vi.fn>;
    submit: ReturnType<typeof vi.fn>;
    checkLiveness: ReturnType<typeof vi.fn>;
    tailoring: ReturnType<typeof vi.fn>;
  };
  /** What the fake click does to the page. */
  clickOutcome: { value: 'receipt' | 'rejected' | 'unknown' };
  /** Marks an item's attempt as prepared, the way the real pipeline would. */
  prepare(itemId: string): void;
}

function harness(overrides: { minIntervalMs?: number } = {}): Harness {
  const clock = { now: new Date('2026-11-04T10:00:00Z') };
  const facts = { cvContentHash: 'cv-1', profileVersion: 'p1' };
  const candidates: BlindApplyCandidate[] = [];
  const liveness = new Map<string, BlindApplyLiveness>();
  const live = new Set<string>();
  const clickOutcome = { value: 'receipt' as 'receipt' | 'rejected' | 'unknown' };
  const tailoring = vi.fn();

  const authorization = store.createBlindApplyAuthorization(db, {
    roleFamilies: ['frontend'],
    filtersSnapshot: { country: 'PT' },
    filtersHash: 'fh',
    profileVersion: 'p1',
    sourceCvId: null,
    sourceCvContentHash: 'cv-1',
    useSavedAnswers: true,
    policyIds: [FIXTURE_POLICY.id],
    confirmTextHash: 'th',
  }, clock.now);

  const start = vi.fn(async (input: { vacancy: { vacancyKey: string | null; company: string; role: string; applyUrl: string }; workflowVersion?: string }) => {
    tailoring(); // preparation is where tailoring happens; an unsupported or skipped item must never get here
    const attempt = workspace.createApplicationAttempt(db, {
      vacancyKey: input.vacancy.vacancyKey,
      canonicalUrl: input.vacancy.applyUrl,
      company: input.vacancy.company,
      role: input.vacancy.role,
      sourceCvContentHash: 'cv-1',
      jdSnapshotHash: 'jd',
      workflowVersion: input.workflowVersion,
      checkpoint: 'queued',
    });
    return { ok: true as const, attemptId: attempt.id };
  });
  const resume = vi.fn(async (attemptId: string) => {
    workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'queued', checkpointDetail: '' });
    return { ok: true };
  });
  const requeue = vi.fn(async (attemptId: string) => {
    workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'queued', checkpointDetail: '' });
  });
  const cancelQueue = vi.fn(async () => {});

  const submit = vi.fn(async (attemptId: string, beforeClick: () => boolean) => {
    if (!beforeClick()) return { ok: false as const, reason: 'stopped' as const, detail: 'stopped' };
    workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'submitting' });
    const observedAt = clock.now.toISOString();
    if (clickOutcome.value === 'receipt') {
      workspace.createApplicationSubmissionReceipt(db, {
        attemptId, outcome: 'submitted', source: 'page_observation', destination: 'x', evidenceKind: 'confirmation_page', evidenceReference: 'Thank you', detail: 'confirmed', observedAt,
      });
      workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'submitted', submittedAt: observedAt, submissionMode: 'automatic', completionEvidence: 'receipt_confirmed' });
      return { ok: true as const };
    }
    if (clickOutcome.value === 'rejected') {
      workspace.createApplicationSubmissionReceipt(db, {
        attemptId, outcome: 'rejected', source: 'page_observation', destination: 'x', evidenceKind: 'none', detail: 'Email is invalid', observedAt,
      });
      workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'needs_user', checkpointDetail: 'Email is invalid' });
      return { ok: false as const, reason: 'submission_rejected' as const, detail: 'Email is invalid' };
    }
    workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'submission_unknown', checkpointDetail: 'no confirmation seen', submittedAt: observedAt });
    return { ok: false as const, reason: 'submission_unknown' as const, detail: 'no confirmation seen' };
  });
  const checkLiveness = vi.fn(async (c: BlindApplyCandidate): Promise<BlindApplyLiveness> => liveness.get(c.vacancyKey) ?? { status: 'open', verificationId: null });

  const deps: BlindApplyRunnerDeps = {
    db,
    now: () => clock.now,
    listCandidates: () => candidates,
    loadCurrentFacts: async () => facts,
    resolvePolicy: (url) => (url.startsWith(SUPPORTED) ? FIXTURE_POLICY : undefined),
    minIntervalMs: () => overrides.minIntervalMs ?? 0,
    checkLiveness,
    pipeline: {
      resolveVacancy: (vacancyKey) => {
        const found = candidates.find((c) => c.vacancyKey === vacancyKey);
        return found
          ? { vacancyKey: found.vacancyKey, company: found.company, role: found.role, applyUrl: found.applyUrl, description: 'A frontend job', descriptionComplete: true }
          : undefined;
      },
      start: start as never,
      resume,
      requeue,
      cancelQueue,
      kick: () => {},
    },
    reviews: {
      hasLive: (attemptId) => live.has(attemptId),
      close: async (attemptId) => {
        live.delete(attemptId);
      },
      submit,
    },
  };

  return {
    deps,
    runner: createBlindApplyRunner(deps),
    candidates,
    facts,
    clock,
    liveness,
    live,
    authorizationId: authorization.id,
    spies: { start, resume, requeue, cancelQueue, submit, checkLiveness, tailoring },
    clickOutcome,
    prepare(itemId) {
      const item = store.getBlindApplyItem(db, itemId)!;
      workspace.updateApplicationAttempt(db, item.attemptId!, { checkpoint: 'ready', checkpointDetail: '' });
      live.add(item.attemptId!);
    },
  };
}

function itemFor(h: Harness, vacancyKey: string) {
  return store.listBlindApplyItems(db, { authorizationId: h.authorizationId }).find((item) => item.vacancyKey === vacancyKey)!;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-blind-runner-'));
  ({ db, close } = createWorkspaceDb(dir));
});

afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the supported, open, frontend vacancy', () => {
  it('travels selection, liveness, preparation, send and receipt with no per-job review step', async () => {
    const h = harness();
    h.candidates.push(candidate(1));

    await h.runner.tick(); // select + start
    let item = itemFor(h, 'vac-1');
    expect(item.state).toBe('preparing');
    expect(item.gateEvidence).toMatchObject({ family: 'frontend', livenessStatus: 'open', policyId: 'synthetic-supported', duplicateCheck: 'clear' });
    const attempt = workspace.getApplicationAttempt(db, item.attemptId!);
    expect(attempt.workflowVersion).toBe(BLIND_APPLY_WORKFLOW_VERSION);

    h.prepare(item.id); // the existing preparation pipeline finishes
    await h.runner.tick(); // reconcile -> ready (and, in the same turn, send)
    item = itemFor(h, 'vac-1');

    expect(item.state).toBe('submitted');
    expect(h.spies.submit).toHaveBeenCalledTimes(1);
    const receipts = workspace.listApplicationSubmissionReceipts(db, item.attemptId!);
    expect(receipts.map((r) => r.outcome)).toEqual(['submitted']);
    const events = store.listBlindApplyEvents(db, item.id);
    expect(events.map((e) => e.toState)).toEqual(['queued', 'preparing', 'ready', 'submitting', 'submitted']);
    expect(events.find((e) => e.toState === 'submitted')?.receiptId).toBe(receipts[0]!.id);
    expect(workspace.getApplicationAttempt(db, item.attemptId!).completionEvidence).toBe('receipt_confirmed');
  });

  it('running the turn again never evaluates, starts or sends the same vacancy twice', async () => {
    const h = harness();
    h.candidates.push(candidate(1));
    await h.runner.tick();
    h.prepare(itemFor(h, 'vac-1').id);
    await h.runner.tick();
    await h.runner.tick();
    await h.runner.tick();
    expect(h.spies.start).toHaveBeenCalledTimes(1);
    expect(h.spies.submit).toHaveBeenCalledTimes(1);
    expect(h.spies.checkLiveness).toHaveBeenCalledTimes(1);
    expect(store.listBlindApplyItems(db)).toHaveLength(1);
  });

  it('there is no cap: many supported vacancies are all sent', async () => {
    const h = harness();
    for (let n = 1; n <= 12; n += 1) h.candidates.push(candidate(n));
    await h.runner.tick();
    for (const item of store.listBlindApplyItems(db)) h.prepare(item.id);
    await h.runner.tick();
    expect(store.listBlindApplyItems(db, { states: ['submitted'] })).toHaveLength(12);
  });
});

describe('postings that must cost nothing', () => {
  it('a closed posting is skipped with zero preparation, zero tailoring and zero sends', async () => {
    const h = harness();
    h.candidates.push(candidate(1));
    h.liveness.set('vac-1', { status: 'closed', verificationId: 'v' });
    await h.runner.tick();
    expect(itemFor(h, 'vac-1')).toMatchObject({ state: 'skipped', skipReason: 'closed' });
    expect(h.spies.start).not.toHaveBeenCalled();
    expect(h.spies.tailoring).not.toHaveBeenCalled();
    expect(h.spies.submit).not.toHaveBeenCalled();
  });

  it('a posting that cannot be confirmed open is skipped the same way', async () => {
    const h = harness();
    h.candidates.push(candidate(1));
    h.liveness.set('vac-1', { status: 'unverifiable', verificationId: null });
    await h.runner.tick();
    expect(itemFor(h, 'vac-1')).toMatchObject({ state: 'skipped', skipReason: 'unverifiable_posting' });
    expect(h.spies.start).not.toHaveBeenCalled();
  });

  it('a duplicate of an application already sent is skipped before liveness, preparation or sending', async () => {
    const h = harness();
    const sent = workspace.createApplicationAttempt(db, {
      vacancyKey: 'older-key', canonicalUrl: `${SUPPORTED}1`, company: 'Company 1', role: 'Senior Frontend Engineer',
      sourceCvContentHash: 'cv-1', jdSnapshotHash: 'jd', checkpoint: 'submitted',
    });
    expect(sent.checkpoint).toBe('submitted');
    h.candidates.push(candidate(1));
    await h.runner.tick();
    expect(itemFor(h, 'vac-1')).toMatchObject({ state: 'skipped', skipReason: 'duplicate' });
    expect(h.spies.checkLiveness).not.toHaveBeenCalled();
    expect(h.spies.start).not.toHaveBeenCalled();
    expect(h.spies.tailoring).not.toHaveBeenCalled();
    expect(h.spies.submit).not.toHaveBeenCalled();
  });

  it('a duplicate of an application still being prepared by the reviewed flow is skipped too', async () => {
    const h = harness();
    workspace.createApplicationAttempt(db, {
      vacancyKey: 'older-key', canonicalUrl: `${SUPPORTED}1`, company: 'Company 1', role: 'Senior Frontend Engineer',
      sourceCvContentHash: 'cv-1', jdSnapshotHash: 'jd', checkpoint: 'needs_user',
    });
    h.candidates.push(candidate(1));
    await h.runner.tick();
    expect(itemFor(h, 'vac-1')).toMatchObject({ state: 'skipped', skipReason: 'duplicate' });
    expect(h.spies.start).not.toHaveBeenCalled();
  });

  it('a role the person tracked by hand, with no attempt behind it, is a duplicate too', async () => {
    const h = harness();
    workspace.createApplication(db, { role: 'Senior Frontend Engineer', company: 'Company 1', status: 'applied', appliedAt: '2026-10-01T00:00:00.000Z' });
    h.candidates.push(candidate(1));
    await h.runner.tick();
    expect(itemFor(h, 'vac-1')).toMatchObject({ state: 'skipped', skipReason: 'duplicate' });
    expect(h.spies.start).not.toHaveBeenCalled();
  });

  it('two postings of one role are applied to once', async () => {
    const h = harness();
    h.candidates.push(candidate(1), candidate(2, { company: 'Company 1', applyUrl: `${SUPPORTED}1` }));
    await h.runner.tick();
    expect(h.spies.start).toHaveBeenCalledTimes(1);
    expect(store.listBlindApplyItems(db, { states: ['skipped'] })[0]?.skipReason).toBe('duplicate');
  });

  it('a start that the attempt guard refuses as already applied is a duplicate, never a thrown error', async () => {
    const h = harness();
    const { ApplicationAlreadyCompletedError } = await import('../electron/workspace/repository.js');
    h.spies.start.mockImplementationOnce(async () => {
      throw new ApplicationAlreadyCompletedError({ attemptId: 'a', checkpoint: 'submitted', completionEvidence: 'receipt_confirmed', matchedOn: 'requisition', submittedAt: null });
    });
    h.candidates.push(candidate(1));
    await h.runner.tick();
    expect(itemFor(h, 'vac-1')).toMatchObject({ state: 'skipped', skipReason: 'duplicate' });
  });

  it('out-of-scope roles, filters that are not met and unverified links leave nothing to do', async () => {
    const h = harness();
    h.candidates.push(
      candidate(1, { family: 'backend' }),
      candidate(2, { filters: 'unknown' }),
      candidate(3, { linkStatus: 'unverified' }),
    );
    await h.runner.tick();
    const reasons = store.listBlindApplyItems(db).map((item) => item.skipReason).sort();
    expect(reasons).toEqual(['filters', 'not_frontend', 'unverified_link']);
    expect(h.spies.start).not.toHaveBeenCalled();
    expect(h.spies.checkLiveness).not.toHaveBeenCalled();
  });
});

describe('an unsupported target', () => {
  it('is "Apply yourself": no preparation, no tailoring, and never reported as submitted', async () => {
    const h = harness();
    h.candidates.push(candidate(1, { applyUrl: 'https://careers.unsupported.example.invalid/jobs/1' }));
    await h.runner.tick();
    await h.runner.tick();
    expect(itemFor(h, 'vac-1')).toMatchObject({ state: 'apply_yourself', policyId: null });
    expect(h.spies.start).not.toHaveBeenCalled();
    expect(h.spies.tailoring).not.toHaveBeenCalled();
    expect(h.spies.checkLiveness).not.toHaveBeenCalled();
    expect(h.spies.submit).not.toHaveBeenCalled();
    expect(store.listBlindApplyItems(db, { states: ['submitted'] })).toEqual([]);
  });
});

function field(label: string, controlType: SnapshotField['controlType'], extra: Partial<SnapshotField> = {}): SnapshotField {
  return { fieldRef: mintFieldRef(), label, controlType, required: false, frameId: 0, active: true, ...extra };
}
function snapshotOf(...fields: SnapshotField[]): FormSnapshot {
  return { generation: 1, fields, submitControls: [], capturedAt: '2026-11-04T10:00:00.000Z', challengeDetected: false, activeFrameId: 0, pageStateFingerprint: 'fp' };
}
const VALUE_TABLE = buildApplicationValueTable({
  cvContact: { name: 'Ada Synthetic', title: 'Frontend Engineer', location: 'Lisbon', email: 'ada@example.invalid', phone: '', links: [] },
  profile: null,
});

function runMapper(h: Harness, itemId: string, snapshot: FormSnapshot) {
  const item = store.getBlindApplyItem(db, itemId)!;
  const attempt = workspace.getApplicationAttempt(db, item.attemptId!);
  const artifacts = [{ id: randomUUID(), kind: 'cv_pdf' }] as ApplicationArtifactRecord[];
  return createBlindApplyFieldMapper({ db, now: () => h.clock.now })({ attempt, snapshot, valueTable: VALUE_TABLE, artifacts });
}

describe('a mandatory question with no truthful stored answer', () => {
  const OPTIONS = ['Select one', 'Remote', 'Hybrid', 'On-site'];
  function arrangementField() {
    return field('Preferred work arrangement', 'select', { required: true, options: OPTIONS.map((label) => ({ optionRef: mintOptionRef(), label })) });
  }

  it('pauses only that application, invents nothing, and lets the others go out', async () => {
    const h = harness();
    h.candidates.push(candidate(1), candidate(2), candidate(3));
    await h.runner.tick();
    const items = store.listBlindApplyItems(db);
    expect(items).toHaveLength(3);

    const [first, ...rest] = ['vac-1', 'vac-2', 'vac-3'].map((key) => itemFor(h, key));
    const name = field('Full name', 'text', { required: true });
    const email = field('Email address', 'text', { required: true });

    const needsAnswer = runMapper(h, first!.id, snapshotOf(name, email, arrangementField()));
    expect(needsAnswer.ok).toBe(false);
    for (const other of rest) {
      expect(runMapper(h, other!.id, snapshotOf(name, email)).ok).toBe(true);
      h.prepare(other!.id);
    }
    await h.runner.tick();

    expect(itemFor(h, 'vac-1')).toMatchObject({
      state: 'needs_answer',
      missingFields: [{ label: 'Preferred work arrangement', controlType: 'select', options: ['Remote', 'Hybrid', 'On-site'] }],
    });
    expect(itemFor(h, 'vac-2').state).toBe('submitted');
    expect(itemFor(h, 'vac-3').state).toBe('submitted');
    expect(h.spies.submit).toHaveBeenCalledTimes(2);
    expect(h.spies.submit.mock.calls.map(([attemptId]) => attemptId)).not.toContain(first!.attemptId);
  });

  it('answering the card re-prepares just that item, and a remembered answer needs no click on the next form', async () => {
    const h = harness();
    h.candidates.push(candidate(1), candidate(2));
    await h.runner.tick();
    const first = itemFor(h, 'vac-1');
    runMapper(h, first.id, snapshotOf(field('Full name', 'text', { required: true }), arrangementField()));
    expect(itemFor(h, 'vac-1').state).toBe('needs_answer');

    expect(await h.runner.answer({ itemId: first.id, answers: [{ label: 'Preferred work arrangement', answer: 'Astronaut' }], remember: true }))
      .toEqual({ ok: false, reason: 'invalid_option' });
    expect(await h.runner.answer({ itemId: first.id, answers: [], remember: true })).toEqual({ ok: false, reason: 'incomplete' });
    expect(h.spies.resume).not.toHaveBeenCalled();

    expect(await h.runner.answer({ itemId: first.id, answers: [{ label: 'Preferred work arrangement', answer: 'Remote' }], remember: true })).toEqual({ ok: true });
    expect(h.spies.resume).toHaveBeenCalledTimes(1);
    expect(itemFor(h, 'vac-1').state).toBe('preparing');

    // Preparation runs again: the very same question is now answered, so the form is filled.
    const refilled = runMapper(h, first.id, snapshotOf(field('Full name', 'text', { required: true }), arrangementField()));
    expect(refilled.ok).toBe(true);
    expect(refilled.ok && refilled.fieldMap.assignments.some((a) => a.source.kind === 'option')).toBe(true);

    // A different employer's form with the same label and the same options needs nothing from the person.
    const second = itemFor(h, 'vac-2');
    expect(runMapper(h, second.id, snapshotOf(field('Full name', 'text', { required: true }), arrangementField())).ok).toBe(true);
    expect(itemFor(h, 'vac-2').state).toBe('preparing');
  });

  it('an answer given without "remember" is for that form only', async () => {
    const h = harness();
    h.candidates.push(candidate(1), candidate(2));
    await h.runner.tick();
    const first = itemFor(h, 'vac-1');
    runMapper(h, first.id, snapshotOf(arrangementField()));
    await h.runner.answer({ itemId: first.id, answers: [{ label: 'Preferred work arrangement', answer: 'Hybrid' }], remember: false });

    expect(runMapper(h, first.id, snapshotOf(arrangementField())).ok).toBe(true);
    const second = itemFor(h, 'vac-2');
    expect(runMapper(h, second.id, snapshotOf(arrangementField())).ok).toBe(false);
    expect(itemFor(h, 'vac-2').state).toBe('needs_answer');
  });

  it('refuses to answer an item that is not waiting for one', async () => {
    const h = harness();
    h.candidates.push(candidate(1));
    await h.runner.tick();
    expect(await h.runner.answer({ itemId: itemFor(h, 'vac-1').id, answers: [], remember: true })).toEqual({ ok: false, reason: 'not_waiting' });
  });
});

describe('things only the person can do', () => {
  it('a bot check stops the item for the person and nothing is sent', async () => {
    const h = harness();
    h.candidates.push(candidate(1));
    await h.runner.tick();
    const item = itemFor(h, 'vac-1');
    workspace.updateApplicationAttempt(db, item.attemptId!, { checkpoint: 'needs_user', checkpointDetail: CAPTCHA_STOP_DETAIL });
    await h.runner.tick();
    expect(itemFor(h, 'vac-1')).toMatchObject({ state: 'needs_you', intervention: 'captcha' });
    expect(h.spies.submit).not.toHaveBeenCalled();
  });

  it('a required consent box is never ticked: the item waits for the person', async () => {
    const h = harness();
    h.candidates.push(candidate(1));
    await h.runner.tick();
    const item = itemFor(h, 'vac-1');
    const result = runMapper(h, item.id, snapshotOf(
      field('Full name', 'text', { required: true }),
      field('I agree to the processing of my data', 'checkbox', { required: true, classification: 'consent_field' }),
    ));
    expect(result.ok).toBe(false);
    expect(itemFor(h, 'vac-1')).toMatchObject({ state: 'needs_you', intervention: 'consent' });
    expect(h.spies.submit).not.toHaveBeenCalled();
  });

  it('a posting the preparation found closed is skipped, not left looking prepared', async () => {
    const h = harness();
    h.candidates.push(candidate(1));
    await h.runner.tick();
    const { POSTING_CLOSED_DETAIL } = await import('../electron/application-posting-verification.js');
    workspace.updateApplicationAttempt(db, itemFor(h, 'vac-1').attemptId!, { checkpoint: 'needs_user', checkpointDetail: POSTING_CLOSED_DETAIL });
    await h.runner.tick();
    expect(itemFor(h, 'vac-1')).toMatchObject({ state: 'skipped', skipReason: 'closed' });
  });

  it('a preparation that failed is tried once more, then reported as could not submit', async () => {
    const h = harness();
    h.candidates.push(candidate(1));
    await h.runner.tick();
    const item = itemFor(h, 'vac-1');
    workspace.updateApplicationAttempt(db, item.attemptId!, { checkpoint: 'failed', checkpointDetail: 'boom' });
    await h.runner.tick();
    expect(itemFor(h, 'vac-1')).toMatchObject({ state: 'preparing', prepRetries: 1 });
    expect(h.spies.resume).toHaveBeenCalledTimes(1);

    workspace.updateApplicationAttempt(db, item.attemptId!, { checkpoint: 'failed', checkpointDetail: 'boom again' });
    await h.runner.tick();
    expect(itemFor(h, 'vac-1').state).toBe('could_not_submit');
    expect(h.spies.resume).toHaveBeenCalledTimes(1);
  });
});

describe('what happens at the click', () => {
  it('an employer rejection is "Could not submit" with its evidence, and is never retried', async () => {
    const h = harness();
    h.clickOutcome.value = 'rejected';
    h.candidates.push(candidate(1));
    await h.runner.tick();
    h.prepare(itemFor(h, 'vac-1').id);
    await h.runner.tick();
    await h.runner.tick();
    await h.runner.tick();
    expect(itemFor(h, 'vac-1').state).toBe('could_not_submit');
    expect(h.spies.submit).toHaveBeenCalledTimes(1);
    expect(workspace.listApplicationSubmissionReceipts(db, itemFor(h, 'vac-1').attemptId!).map((r) => r.outcome)).toEqual(['rejected']);
  });

  it('a click with no confirmation is "Sent? Couldn\'t confirm", never "Submitted", and is never retried', async () => {
    const h = harness();
    h.clickOutcome.value = 'unknown';
    h.candidates.push(candidate(1));
    await h.runner.tick();
    h.prepare(itemFor(h, 'vac-1').id);
    await h.runner.tick();
    await h.runner.tick();
    expect(itemFor(h, 'vac-1').state).toBe('outcome_unknown');
    expect(h.spies.submit).toHaveBeenCalledTimes(1);
    expect(store.listBlindApplyItems(db, { states: ['submitted'] })).toEqual([]);
  });

  it('pacing delays a second send on the same target and never drops it', async () => {
    const h = harness({ minIntervalMs: 60_000 });
    h.candidates.push(candidate(1), candidate(2));
    await h.runner.tick();
    for (const item of store.listBlindApplyItems(db)) h.prepare(item.id);
    await h.runner.tick();
    expect(store.listBlindApplyItems(db, { states: ['submitted'] })).toHaveLength(1);
    expect(store.listBlindApplyItems(db, { states: ['ready'] })).toHaveLength(1);

    h.clock.now = new Date(h.clock.now.getTime() + 61_000);
    await h.runner.tick();
    expect(store.listBlindApplyItems(db, { states: ['submitted'] })).toHaveLength(2);
  });

  it('a prepared item whose page was lost is prepared again instead of being sent into nothing', async () => {
    const h = harness();
    h.candidates.push(candidate(1));
    await h.runner.tick();
    const item = itemFor(h, 'vac-1');
    h.prepare(item.id);
    h.live.clear(); // the page view is gone
    await h.runner.tick();
    expect(h.spies.submit).not.toHaveBeenCalled();
    expect(h.spies.requeue).toHaveBeenCalledTimes(1);
    expect(itemFor(h, 'vac-1').state).toBe('preparing');
  });
});

describe('Stop', () => {
  it('stops everything not yet clicked, leaves completed records byte-identical, and sends nothing afterwards', async () => {
    const h = harness();
    for (let n = 1; n <= 4; n += 1) h.candidates.push(candidate(n));
    await h.runner.tick();
    // vac-1 gets sent; vac-2 is ready; vac-3 is mid-preparation; vac-4 never started.
    h.prepare(itemFor(h, 'vac-1').id);
    await h.runner.tick();
    expect(itemFor(h, 'vac-1').state).toBe('submitted');
    const before = {
      item: itemFor(h, 'vac-1'),
      events: store.listBlindApplyEvents(db, itemFor(h, 'vac-1').id),
      attempt: workspace.getApplicationAttempt(db, itemFor(h, 'vac-1').attemptId!),
      receipts: workspace.listApplicationSubmissionReceipts(db, itemFor(h, 'vac-1').attemptId!),
    };
    h.prepare(itemFor(h, 'vac-2').id);
    h.spies.submit.mockClear();

    const result = await h.runner.stop();
    expect(result.stopped).toBe(true);
    expect(result.itemsStopped).toBe(3);

    expect(['vac-2', 'vac-3', 'vac-4'].map((key) => itemFor(h, key).state)).toEqual(['stopped', 'stopped', 'stopped']);
    // The completed item, its trail, its attempt and its receipt are exactly as they were.
    expect({
      item: itemFor(h, 'vac-1'),
      events: store.listBlindApplyEvents(db, itemFor(h, 'vac-1').id),
      attempt: workspace.getApplicationAttempt(db, itemFor(h, 'vac-1').attemptId!),
      receipts: workspace.listApplicationSubmissionReceipts(db, itemFor(h, 'vac-1').attemptId!),
    }).toEqual(before);
    // The attempts that were not sent keep their real checkpoint for the reviewed flow.
    expect(workspace.getApplicationAttempt(db, itemFor(h, 'vac-2').attemptId!).checkpoint).toBe('ready');
    // Queued/preparing work was cancelled in the queue and its page closed.
    expect(h.spies.cancelQueue).toHaveBeenCalledWith(itemFor(h, 'vac-3').attemptId);

    h.candidates.push(candidate(5));
    await h.runner.tick();
    await h.runner.tick();
    expect(h.spies.submit).not.toHaveBeenCalled();
    expect(store.listBlindApplyItems(db).some((item) => item.vacancyKey === 'vac-5')).toBe(false);
    expect(store.getActiveBlindApplyAuthorization(db)).toBeNull();
  });

  it('a Stop that lands between the last check and the click wins: no send, and the attempt stays ready', async () => {
    const h = harness();
    h.candidates.push(candidate(2));
    await h.runner.tick();
    const second = itemFor(h, 'vac-2');
    h.prepare(second.id);
    h.spies.submit.mockImplementationOnce(async (attemptId: string, beforeClick: () => boolean) => {
      await h.runner.stop(); // Stop lands after the pre-click checks, before the boundary
      if (!beforeClick()) return { ok: false as const, reason: 'stopped' as const, detail: 'stopped' };
      workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'submitting' });
      return { ok: true as const };
    });
    await h.runner.tick();
    expect(itemFor(h, 'vac-2').state).toBe('stopped');
    expect(workspace.getApplicationAttempt(db, second.attemptId!).checkpoint).toBe('ready');
    expect(workspace.listApplicationSubmissionReceipts(db, second.attemptId!)).toEqual([]);
  });

  it('is idempotent, and does not need a second press', async () => {
    const h = harness();
    h.candidates.push(candidate(1));
    await h.runner.tick();
    expect((await h.runner.stop()).stopped).toBe(true);
    expect(await h.runner.stop()).toEqual({ stopped: false, itemsStopped: 0 });
  });

  it('does not close the page of an item that is waiting for the person', async () => {
    const h = harness();
    h.candidates.push(candidate(1));
    await h.runner.tick();
    const item = itemFor(h, 'vac-1');
    h.live.add(item.attemptId!);
    runMapper(h, item.id, snapshotOf(field('I agree', 'checkbox', { required: true, classification: 'consent_field' })));
    expect(itemFor(h, 'vac-1').state).toBe('needs_you');
    await h.runner.stop();
    expect(itemFor(h, 'vac-1').state).toBe('stopped');
    expect(h.live.has(item.attemptId!)).toBe(true);
    expect(h.spies.cancelQueue).not.toHaveBeenCalled();
  });

  it('an authorization stopped before a crash leaves nothing to resume', async () => {
    const h = harness();
    h.candidates.push(candidate(1));
    await h.runner.tick();
    store.stopBlindApplyAuthorization(db, h.authorizationId, 'you pressed Stop'); // crash right after the write
    await h.runner.recoverOnStartup();
    expect(itemFor(h, 'vac-1').state).toBe('stopped');
    await h.runner.tick();
    expect(h.spies.start).toHaveBeenCalledTimes(1);
  });
});

describe('a changed CV or profile', () => {
  it('pauses new work and new sends until Blind Apply is confirmed again', async () => {
    const h = harness();
    h.candidates.push(candidate(1));
    await h.runner.tick();
    h.prepare(itemFor(h, 'vac-1').id);

    h.facts.cvContentHash = 'cv-2'; // the person edited their CV
    h.candidates.push(candidate(2));
    await h.runner.tick();
    expect(h.spies.submit).not.toHaveBeenCalled();
    expect(store.listBlindApplyItems(db).some((item) => item.vacancyKey === 'vac-2')).toBe(false);

    h.facts.cvContentHash = 'cv-1';
    await h.runner.tick();
    expect(itemFor(h, 'vac-1').state).toBe('submitted');
  });

  it('a profile change pauses it the same way', async () => {
    const h = harness();
    h.facts.profileVersion = 'p2';
    h.candidates.push(candidate(1));
    await h.runner.tick();
    expect(store.listBlindApplyItems(db)).toEqual([]);
  });
});

describe('restart recovery', () => {
  it('an item left mid-send becomes "couldn\'t confirm" and is never sent again', async () => {
    const h = harness();
    h.candidates.push(candidate(1));
    await h.runner.tick();
    const item = itemFor(h, 'vac-1');
    h.prepare(item.id);
    store.transitionBlindApplyItem(db, item.id, ['preparing'], 'ready', {}, { kind: 'prepare' });
    store.transitionBlindApplyItem(db, item.id, ['ready'], 'submitting', {}, { kind: 'submit_click' });
    workspace.updateApplicationAttempt(db, item.attemptId!, { checkpoint: 'submission_unknown', checkpointDetail: 'the app closed during submission' });

    const restarted = createBlindApplyRunner(h.deps);
    await restarted.recoverOnStartup();
    expect(itemFor(h, 'vac-1').state).toBe('outcome_unknown');
    await restarted.tick();
    await restarted.tick();
    expect(h.spies.submit).not.toHaveBeenCalled();
  });

  /** An item past the click boundary: the attempt says `submitting`, the item says `submitting`. */
  async function sendInFlight(h: Harness, n: number) {
    h.candidates.push(candidate(n));
    await h.runner.tick();
    const item = itemFor(h, `vac-${n}`);
    h.prepare(item.id);
    store.transitionBlindApplyItem(db, item.id, ['preparing'], 'ready', {}, { kind: 'prepare' });
    store.transitionBlindApplyItem(db, item.id, ['ready'], 'submitting', {}, { kind: 'submit_click' });
    workspace.updateApplicationAttempt(db, item.attemptId!, { checkpoint: 'submitting' });
    return itemFor(h, `vac-${n}`);
  }

  it("Stop during a send, then the app closes: the item becomes \"couldn't confirm\", not \"Sending\" forever", async () => {
    const h = harness();
    const item = await sendInFlight(h, 1);

    await h.runner.stop(); // a send in flight is past the boundary: Stop leaves it alone
    expect(itemFor(h, 'vac-1').state).toBe('submitting');
    expect(store.getActiveBlindApplyAuthorization(db)).toBeNull();

    // The app closes; the pipeline's own recovery marks the attempt, it never re-sends.
    workspace.updateApplicationAttempt(db, item.attemptId!, { checkpoint: 'submission_unknown', checkpointDetail: 'the app closed during submission' });
    const restarted = createBlindApplyRunner(h.deps);
    await restarted.recoverOnStartup();

    expect(itemFor(h, 'vac-1')).toMatchObject({ state: 'outcome_unknown', stateDetail: "Sent? Couldn't confirm" });
    await restarted.tick();
    expect(itemFor(h, 'vac-1').state).toBe('outcome_unknown');
    expect(h.spies.submit).not.toHaveBeenCalled();
  });

  it('a stopped authorization is also reconciled on every tick, with no restart needed', async () => {
    const h = harness();
    const item = await sendInFlight(h, 1);
    await h.runner.stop();
    workspace.updateApplicationAttempt(db, item.attemptId!, { checkpoint: 'submission_unknown', checkpointDetail: 'no confirmation seen' });

    await h.runner.tick(); // no active authorization: this used to return before looking at the item
    expect(itemFor(h, 'vac-1').state).toBe('outcome_unknown');
    expect(h.spies.submit).not.toHaveBeenCalled();
  });

  it('a send in flight under a replaced authorization is settled the same way', async () => {
    const h = harness();
    const item = await sendInFlight(h, 1);
    const replacement = store.createBlindApplyAuthorization(db, {
      roleFamilies: ['frontend'], filtersSnapshot: {}, filtersHash: 'fh', profileVersion: 'p2', sourceCvId: null,
      sourceCvContentHash: 'cv-2', useSavedAnswers: true, policyIds: [FIXTURE_POLICY.id], confirmTextHash: 'th2',
    }, h.clock.now);
    workspace.updateApplicationAttempt(db, item.attemptId!, { checkpoint: 'submission_unknown', checkpointDetail: 'the app closed during submission' });

    await createBlindApplyRunner(h.deps).recoverOnStartup();
    expect(itemFor(h, 'vac-1').state).toBe('outcome_unknown');
    expect(store.getActiveBlindApplyAuthorization(db)?.id).toBe(replacement.id);
    expect(h.spies.submit).not.toHaveBeenCalled();
  });

  it('a stopped authorization whose attempt is still genuinely submitting is left alone', async () => {
    const h = harness();
    await sendInFlight(h, 1);
    await h.runner.stop();
    await h.runner.tick();
    expect(itemFor(h, 'vac-1').state).toBe('submitting');
  });

  it('a ready item that lost its page is prepared again after a restart', async () => {
    const h = harness();
    h.candidates.push(candidate(1));
    await h.runner.tick();
    const item = itemFor(h, 'vac-1');
    store.transitionBlindApplyItem(db, item.id, ['preparing'], 'ready', {}, { kind: 'prepare' });
    workspace.updateApplicationAttempt(db, item.attemptId!, { checkpoint: 'ready' });

    await createBlindApplyRunner(h.deps).recoverOnStartup();
    expect(itemFor(h, 'vac-1').state).toBe('preparing');
    expect(h.spies.requeue).toHaveBeenCalledWith(item.attemptId);
    expect(h.spies.submit).not.toHaveBeenCalled();
  });
});

describe('confirming again after a CV or profile change', () => {
  const FACTS = {
    roleFamilies: ['frontend'],
    roleFamilyNames: ['Frontend / UI engineering'],
    filtersSnapshot: { country: 'PT' },
    filterLines: ['Based in PT'],
    profileVersion: 'p2',
    cv: { id: 'cv-1', name: 'Main CV', contentHash: 'cv-2' },
    policyIds: [FIXTURE_POLICY.id],
    realTargets: [],
  };

  it("stops the old authorization's unsent work: nothing stays Preparing, Sending or Needs you", async () => {
    const h = harness();
    for (let n = 1; n <= 4; n += 1) h.candidates.push(candidate(n));
    await h.runner.tick();
    // vac-1 is mid-preparation (page open), vac-2 is ready, vac-3 waits for the person, vac-4 is queued.
    h.live.add(itemFor(h, 'vac-1').attemptId!);
    h.prepare(itemFor(h, 'vac-2').id);
    runMapper(h, itemFor(h, 'vac-3').id, snapshotOf(field('I agree', 'checkbox', { required: true, classification: 'consent_field' })));
    h.live.add(itemFor(h, 'vac-3').attemptId!);
    expect(itemFor(h, 'vac-3').state).toBe('needs_you');
    const oldAuthorizationId = h.authorizationId;

    const result = await requestBlindApplyAuthorization(
      {
        db,
        parent: undefined,
        confirm: async () => true,
        beforeReplace: async () => {
          await h.runner.stop('replaced by a newer confirmation');
        },
      },
      FACTS,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(['vac-1', 'vac-2', 'vac-3', 'vac-4'].map((key) => itemFor(h, key).state)).toEqual(['stopped', 'stopped', 'stopped', 'stopped']);
    // Queued/preparing work is cancelled and its page closed; the item waiting on the person keeps its page.
    expect(h.spies.cancelQueue).toHaveBeenCalledWith(itemFor(h, 'vac-1').attemptId);
    expect(h.spies.cancelQueue).toHaveBeenCalledWith(itemFor(h, 'vac-2').attemptId);
    expect(h.live.has(itemFor(h, 'vac-1').attemptId!)).toBe(false);
    expect(h.live.has(itemFor(h, 'vac-2').attemptId!)).toBe(false);
    expect(h.live.has(itemFor(h, 'vac-3').attemptId!)).toBe(true);
    // The old authorization is stopped; the new one is the only active one.
    expect(store.getBlindApplyAuthorization(db, oldAuthorizationId)?.stoppedAt).not.toBeNull();
    expect(store.getActiveBlindApplyAuthorization(db)?.id).toBe(result.authorization.id);
    // Nothing from the old authorization is sent afterwards, and the unsent attempts keep their checkpoint.
    h.facts.cvContentHash = 'cv-2';
    h.facts.profileVersion = 'p2';
    await h.runner.tick();
    expect(h.spies.submit).not.toHaveBeenCalled();
    expect(workspace.getApplicationAttempt(db, itemFor(h, 'vac-2').attemptId!).checkpoint).toBe('ready');
  });

  it('leaves completed records alone', async () => {
    const h = harness();
    h.candidates.push(candidate(1), candidate(2));
    await h.runner.tick();
    h.prepare(itemFor(h, 'vac-1').id);
    await h.runner.tick();
    expect(itemFor(h, 'vac-1').state).toBe('submitted');
    const snapshot = () => ({
      item: itemFor(h, 'vac-1'),
      events: store.listBlindApplyEvents(db, itemFor(h, 'vac-1').id),
      receipts: workspace.listApplicationSubmissionReceipts(db, itemFor(h, 'vac-1').attemptId!),
    });
    const before = snapshot();
    await requestBlindApplyAuthorization(
      { db, parent: undefined, confirm: async () => true, beforeReplace: async () => { await h.runner.stop('replaced by a newer confirmation'); } },
      FACTS,
    );
    expect(snapshot()).toEqual(before);
    expect(itemFor(h, 'vac-2').state).toBe('stopped');
  });

  it('declining the confirmation changes nothing about the running authorization', async () => {
    const h = harness();
    h.candidates.push(candidate(1));
    await h.runner.tick();
    const beforeReplace = vi.fn(async () => {});
    const result = await requestBlindApplyAuthorization({ db, parent: undefined, confirm: async () => false, beforeReplace }, FACTS);
    expect(result).toEqual({ ok: false, reason: 'declined' });
    expect(beforeReplace).not.toHaveBeenCalled();
    expect(itemFor(h, 'vac-1').state).toBe('preparing');
    expect(store.getActiveBlindApplyAuthorization(db)?.id).toBe(h.authorizationId);
  });

  it('authorizes nothing new when the cleanup fails', async () => {
    const h = harness();
    const result = requestBlindApplyAuthorization(
      { db, parent: undefined, confirm: async () => true, beforeReplace: async () => { throw new Error('cleanup failed'); } },
      FACTS,
    );
    await expect(result).rejects.toThrow('cleanup failed');
    expect(store.getActiveBlindApplyAuthorization(db)?.id).toBe(h.authorizationId);
  });
});

describe('a Blind Apply attempt is never mapped by a model', () => {
  it('the mapper refuses an attempt that has no live item, so nothing is typed', () => {
    const h = harness();
    const stray = workspace.createApplicationAttempt(db, {
      vacancyKey: 'stray', canonicalUrl: `${SUPPORTED}9`, company: 'Stray', role: 'Frontend', sourceCvContentHash: 'cv-1', jdSnapshotHash: 'jd',
      workflowVersion: BLIND_APPLY_WORKFLOW_VERSION, checkpoint: 'filling',
    });
    const result = createBlindApplyFieldMapper({ db })({ attempt: stray, snapshot: snapshotOf(field('Full name', 'text', { required: true })), valueTable: VALUE_TABLE, artifacts: [] });
    expect(result).toEqual({ ok: false, detail: expect.stringContaining('not being handled by Blind Apply') });
    void h;
  });

  it('the mapper refuses once the authorization is stopped', async () => {
    const h = harness();
    h.candidates.push(candidate(1));
    await h.runner.tick();
    const item = itemFor(h, 'vac-1');
    store.stopBlindApplyAuthorization(db, h.authorizationId, 'stop');
    const result = runMapper(h, item.id, snapshotOf(field('Full name', 'text', { required: true })));
    expect(result).toEqual({ ok: false, detail: expect.stringContaining('stopped') });
  });
});
