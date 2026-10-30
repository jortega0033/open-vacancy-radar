// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What TODAY's workspace can answer, proven against a real migrated database written through the app's real
 * writers (see real-world.ts), read back by the read-only adapter. Every "cannot answer" below is an assertion on
 * this database, not a claim from reading code.
 */

vi.mock('electron', () => ({}));
vi.setConfig({ testTimeout: 60_000 });

const { createWorkspaceDb } = await import('../../electron/workspace/client.js');
const briefStore = await import('../../electron/workspace/application-brief-store.js');
const workspace = await import('../../electron/workspace/repository.js');
const { buildRealWorld, AS_OF } = await import('./real-world.js');
const { readWorkspaceObservations } = await import('./observations.js');
const { buildFunnel } = await import('./funnel.js');
const { buildRequirements } = await import('./requirements.js');
const { buildSuggestions, dismiss, EMPTY_REVIEW_STATE } = await import('./suggestions.js');
import type { WorkspaceDb } from '../../electron/workspace/client.js';
import type { RealWorld } from './real-world.js';

let dir: string;
let db: WorkspaceDb;
let closeDb: () => void;
let world: RealWorld;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-693-contract-'));
  ({ db, close: closeDb } = createWorkspaceDb(dir));
  world = await buildRealWorld(db);
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const byKey = (read: ReturnType<typeof readWorkspaceObservations>, suffix: string) => read.observations.find((observation) => observation.requisition.key.endsWith(suffix))!;

describe('what the current workspace tables can answer', () => {
  it('collapses two saved copies of one requisition and keeps a second role at the same employer separate', () => {
    const read = readWorkspaceObservations(db);
    expect(read.sourceRows).toMatchObject({ savedJobs: 6, briefs: 5 });
    expect(read.observations).toHaveLength(5);
    const first = byKey(read, 'northwind:1001');
    const second = byKey(read, 'northwind:1002');
    expect(first.copies).toBe(2); // the ATS row and its aggregator copy, saved twice
    expect(second.copies).toBe(1);
    expect(first.requisition.key).not.toBe(second.requisition.key);
    // Both source copies are visible as contributions, from the brief's aliases.
    expect(first.contributions.map((entry) => entry.provider).sort()).toEqual(['ats_roster_greenhouse', 'remotive']);
    expect(read.observations.filter((observation) => observation.requisition.strength === 'weak')).toHaveLength(0);
  });

  it('reports the reapplication as the same requisition with its own application row and its predecessor', () => {
    const read = readWorkspaceObservations(db);
    const first = byKey(read, 'northwind:1001');
    expect(first.applications).toHaveLength(2);
    const [original, again] = first.applications;
    expect(original).toMatchObject({ submission: 'receipt_backed', evidence: 'receipt_observed', status: 'interview', heldRounds: 1 });
    expect(again).toMatchObject({ submission: 'user_reported', evidence: 'user_reported', reapplicationOf: original!.applicationId });
    const funnel = buildFunnel(read.observations, { dimension: 'source', asOf: AS_OF });
    expect(funnel.totals).toMatchObject({ distinctRequisitions: 5, sentRequisitions: 4, reapplicationRows: 1, copiesCollapsed: 1 });
  });

  it('distinguishes prepared from sent, an undated send, a too-recent send and a recorded rejection', () => {
    const read = readWorkspaceObservations(db);
    expect(byKey(read, 'northwind:1003').applications[0]).toMatchObject({ submission: 'prepared', sentAt: null });
    const solo = read.observations.find((observation) => observation.requisition.key === 'rk1:url:https://jobs.example/listing/solo-role-9')!;
    expect(solo.applications[0]).toMatchObject({ submission: 'user_stated', sentAt: null });
    const funnel = buildFunnel(read.observations, { dimension: 'roleFamily', asOf: AS_OF });
    expect(funnel.totals).toMatchObject({ matureSent: 1, censoredSent: 2, undatedSent: 1, unknownOutcomes: 0 });
    expect(byKey(read, 'northwind:1002').applications[0]).toMatchObject({ status: 'rejected', evidence: 'user_stated' });
    const mature = funnel.cells.reduce((sum, cell) => sum + cell.outcomes.rejected_recorded, 0);
    expect(mature).toBe(1);
  });

  it('keeps an unscored job unscored (null), with no role family inferred from its title', () => {
    const unscored = byKey(readWorkspaceObservations(db), 'northwind:1005');
    expect(unscored.score).toEqual({ state: 'unscored', value: null, roleFamily: null });
    expect(unscored.availability.score).toBe('not_recorded');
    expect(unscored.availability.roleFamily).toBe('not_recorded');
  });

  it('reads requirement-level evidence only where the person ran "Compare with my CV", and nowhere else', () => {
    const read = readWorkspaceObservations(db);
    const assessed = byKey(read, 'northwind:1001');
    expect(assessed.assessment.state).toBe('current');
    expect(assessed.assessment.requirements.map((entry) => `${entry.text}:${entry.evidenceClass}`)).toEqual(['5+ years of TypeScript:direct', 'Kubernetes:unsupported']);
    expect(byKey(read, 'northwind:1003').assessment.requirements.map((entry) => entry.evidenceClass)).toEqual(['candidate_confirmed_gap']);
    for (const suffix of ['northwind:1002', 'northwind:1005']) {
      expect(byKey(read, suffix).assessment).toEqual({ state: 'none', requirements: [], coverage: 'not_run' });
    }
  });

  it('reads eligibility answers through the brief rules: a stated "no" is a known mismatch, unknown stays unknown', () => {
    const read = readWorkspaceObservations(db);
    const us = byKey(read, 'northwind:1002').eligibility;
    expect(us.find((entry) => entry.key === 'candidateWorkCountry')).toMatchObject({ answer: 'no', classification: 'known_mismatch' });
    expect(us.find((entry) => entry.key === 'mandatoryLanguage')).toMatchObject({ answer: 'unknown', classification: 'uncertain' });
  });
});

describe('what the current workspace tables CANNOT answer (each proven on this database)', () => {
  it('has no query-variant attribution: #686 provenance reached the scan rows but was never stored with the saved job or brief', () => {
    expect(world.world.rows.get('gh:1001')).toHaveProperty('queryProvenance.planRevision', 3);
    const briefs = briefStore.listBriefs(db);
    expect(briefs.length).toBeGreaterThan(0);
    for (const brief of briefs) {
      const stored = JSON.stringify(brief.facts);
      expect(stored).not.toContain('queryProvenance');
      expect(stored).not.toContain('fetchedBy');
      expect(stored).not.toContain('planRevision');
    }
    const read = readWorkspaceObservations(db);
    for (const observation of read.observations) {
      expect(observation.availability.queryAttribution).toBe('not_recorded');
      for (const entry of observation.contributions) expect(entry.queryRefs).toBe('not_recorded');
    }
    const funnel = buildFunnel(read.observations, { dimension: 'queryVariant', asOf: AS_OF });
    expect(funnel.cells.map((cell) => cell.label)).toEqual(['(query variant not recorded)']);
    expect(funnel.metrics.perCellOutcomeComparison.reasons).toContain('no_query_attribution');
  });

  it('has no status-change time, source or reason: applications keeps one mutable status and one date', () => {
    const columns = Object.keys(workspace.listApplications(db)[0]!);
    expect(columns).toEqual(expect.arrayContaining(['status', 'appliedAt']));
    expect(columns.filter((name) => /updated|changed|statusAt|outcome|reason|history/iu.test(name))).toEqual([]);
    const read = readWorkspaceObservations(db);
    for (const observation of read.observations) {
      for (const application of observation.applications) expect(application.statusHistory).toBe('current_value_only');
      expect(observation.availability.statusTimestamp).toBe('not_recorded');
    }
    const funnel = buildFunnel(read.observations, { dimension: 'source', asOf: AS_OF });
    expect(funnel.metrics.timeToReply).toEqual({ verdict: 'no_go', reasons: ['no_status_timestamps'] });
  });

  it('has no exposure denominator: only jobs the person saved or applied to exist', () => {
    const read = readWorkspaceObservations(db);
    const funnel = buildFunnel(read.observations, { dimension: 'source', asOf: AS_OF });
    expect(funnel.metrics.leadToSelected).toEqual({ verdict: 'no_go', reasons: ['no_exposure_denominator'] });
    expect(read.unrecoverable.map((entry) => entry.code)).toEqual(expect.arrayContaining(['exposure_denominator', 'query_attribution', 'status_timestamp', 'deleted_saved_jobs', 'cv_text_history']));
  });

  it('forgets a saved job the person deletes: selection is survivorship-filtered', () => {
    const before = readWorkspaceObservations(db).observations.length;
    workspace.deleteSavedJob(db, world.savedIds.j3!);
    const after = readWorkspaceObservations(db);
    // The prepared application for J3 keeps the requisition alive; delete the application too and nothing remains of it.
    expect(after.observations.length).toBe(before);
    workspace.deleteApplication(db, world.applicationIds.a3!);
    expect(readWorkspaceObservations(db).observations.some((observation) => observation.requisition.key.endsWith('northwind:1003'))).toBe(false);
  });

  it('refuses to compute outcome rates on this data: too few mature sent applications, and the verdict says why', () => {
    const funnel = buildFunnel(readWorkspaceObservations(db).observations, { dimension: 'source', asOf: AS_OF });
    expect(funnel.metrics.outcomeDistribution.verdict).toBe('no_go');
    expect(funnel.metrics.outcomeDistribution.reasons).toContain('too_few_mature_sent');
  });

  it('is read-only: reading twice changes nothing and matches byte for byte', () => {
    const first = JSON.stringify(readWorkspaceObservations(db));
    const second = JSON.stringify(readWorkspaceObservations(db));
    expect(second).toBe(first);
    expect(briefStore.listBriefs(db)).toHaveLength(5);
  });

  it('changes no candidate, CV, preference, saved job, application, brief or assessment when the whole pipeline runs and a suggestion is dismissed', () => {
    const snapshot = () =>
      JSON.stringify({
        savedJobs: workspace.listSavedJobs(db),
        applications: workspace.listApplications(db, 'all'),
        attempts: workspace.listApplicationAttempts(db),
        cvs: workspace.listCvDocuments(db),
        settings: workspace.getSettings(db),
        briefs: briefStore.listBriefs(db),
        overlays: workspace.listCvDocuments(db).flatMap((cv) => workspace.listCvEvidenceOverlays(db, cv.id)),
      });
    const before = snapshot();
    const read = readWorkspaceObservations(db);
    const funnel = buildFunnel(read.observations, { dimension: 'source', asOf: AS_OF });
    const requirements = buildRequirements(read.observations);
    const suggestions = buildSuggestions({ asOf: AS_OF, requirements, variantFunnel: buildFunnel(read.observations, { dimension: 'queryVariant', asOf: AS_OF }), selectedAtByJob: {} });
    // Today's data supports no suggestion, so exercise dismissal on a hand-made one as well: it is only ever a value.
    const state = dismiss(EMPTY_REVIEW_STATE, { id: 'x', support: { count: 3 } as never }, AS_OF);
    expect(funnel.totals.distinctRequisitions).toBe(5);
    expect(suggestions.suggestions).toEqual([]);
    expect(Object.keys(state.dismissed)).toEqual(['x']);
    expect(snapshot()).toBe(before);
  });

  it('does not pool an assessment made over a posting text known to be truncated', () => {
    const cv = workspace.listCvDocuments(db)[0]!;
    const overlay = workspace.listCvEvidenceOverlays(db, cv.id).find((entry) => entry.requirements.some((requirement) => requirement.text === '5+ years of TypeScript'))!;
    workspace.updateCvEvidenceOverlay(db, overlay.id, { jdComplete: false, jdConfirmedComplete: false } as never);
    const read = readWorkspaceObservations(db);
    expect(byKey(read, 'northwind:1001').assessment.state).toBe('partial');
    expect(buildRequirements(read.observations).assessment).toMatchObject({ current: 1, partial: 1 });
  });
});
