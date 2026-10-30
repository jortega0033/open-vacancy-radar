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
const { evidenceOriginOf } = await import('./contract.js');
const { JD_V1 } = await import('../application-brief-fixtures.js');
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
    expect(read.sourceRows).toMatchObject({ savedJobs: 7, briefs: 6 });
    expect(read.observations).toHaveLength(6);
    const first = byKey(read, 'northwind:1001');
    const second = byKey(read, 'northwind:1002');
    expect(first.savedRows).toBe(2); // the ATS row and its aggregator copy, saved twice
    expect(second.savedRows).toBe(1);
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
    expect(funnel.totals).toMatchObject({ distinctRequisitions: 6, sentRequisitions: 4, reapplicationRows: 1, copiesCollapsed: 1 });
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

  it('derives no requirement, lane count or suggestion from a title, posting text or scorer hint when the job was never assessed', () => {
    const read = readWorkspaceObservations(db);
    const titled = byKey(read, 'northwind:1006');
    // The control really carries the skill everywhere a rule could be tempted to read it from...
    expect(titled.hints).toMatchObject({ title: 'Kubernetes Platform Engineer' });
    expect(titled.hints!.scorerMatchingSkills).toContain('Kubernetes');
    expect(titled.hints!.scorerGaps.join(' ')).toMatch(/Kubernetes/u);
    expect(world.world.rows.get('gh:1006')!.description).toMatch(/Kubernetes/u);
    expect(titled.score).toMatchObject({ state: 'scored', value: 82 });
    expect(titled.availability).toMatchObject({ displayTitle: 'recorded', scorerHints: 'recorded', requirements: 'not_recorded', assessmentState: 'not_recorded' });
    // ...yet it has no overlay, no application and no requirement.
    expect(titled.assessment).toEqual({ state: 'none', requirements: [], coverage: 'not_run' });
    expect(titled.applications).toEqual([]);

    const withJob = buildRequirements(read.observations);
    const withoutJob = buildRequirements(read.observations.filter((observation) => observation !== titled));
    const shape = (view: ReturnType<typeof buildRequirements>) =>
      view.requirements.map((row) => ({ key: row.key, jobsPresent: row.jobsPresent, byLane: row.byLane, byClassification: row.byClassification, jobs: row.supportingJobs.map((entry) => entry.requisitionKey) }));
    expect(shape(withJob)).toEqual(shape(withoutJob));
    expect(withJob.requirements.flatMap((row) => row.supportingJobs).some((entry) => entry.jobId === titled.id)).toBe(false);
    // It is counted, as not assessed (unknown): one more selected job, one more with no assessment, nothing else.
    expect(withJob.selected - withoutJob.selected).toBe(1);
    expect(withJob.assessment.none - withoutJob.assessment.none).toBe(1);
    expect(withJob.assessment.current).toBe(withoutJob.assessment.current);
    const laneTotal = (view: ReturnType<typeof buildRequirements>) => view.requirements.reduce((sum, row) => sum + Object.values(row.byLane).reduce((a, b) => a + b, 0), 0);
    expect(laneTotal(withJob)).toBe(laneTotal(withoutJob));
    const suggestionsOf = (view: ReturnType<typeof buildRequirements>) => buildSuggestions({ asOf: AS_OF, requirements: view, variantFunnel: null, selectedAtByJob: {} }).suggestions;
    expect(suggestionsOf(withJob).filter((suggestion) => suggestion.kind === 'add_cv_evidence' || suggestion.kind === 'consider_learning_priority')).toEqual([]);
    expect(suggestionsOf(withJob)).toEqual(suggestionsOf(withoutJob));
    // Eligibility is read from the scan's answers, not the title: this job's answers are consistent, so it adds no mismatch row.
    expect(withJob.eligibility.map((row) => `${row.key}:${row.jobsKnownMismatch}`)).toEqual(withoutJob.eligibility.map((row) => `${row.key}:${row.jobsKnownMismatch}`));
  });

  it('carries the JD quote, the JD revision and who added each requirement, so a suggestion can be checked against the posting', () => {
    const read = readWorkspaceObservations(db);
    const extracted = byKey(read, 'northwind:1001').assessment.requirements.find((entry) => entry.text === 'Kubernetes')!;
    expect(extracted).toMatchObject({ jdAnchor: 'Experience with Kubernetes is required.', candidateAdded: false, reviewed: true, classification: 'required', evidenceClass: 'unsupported' });
    expect(typeof extracted.jdRevisionId).toBe('string');
    if (extracted.quoteSpan) expect(JD_V1.slice(extracted.quoteSpan.start, extracted.quoteSpan.end)).toBe(extracted.jdAnchor);
    const personAdded = byKey(read, 'northwind:1003').assessment.requirements[0]!;
    expect(personAdded).toMatchObject({ candidateAdded: true, classification: 'preferred', evidenceClass: 'candidate_confirmed_gap', jdAnchor: 'Experience with Kubernetes is required.' });
    // Origin of the evidence class: the person's own statement vs a model-proposed mapping the person reviewed.
    expect(evidenceOriginOf(personAdded)).toBe('person_statement');
    expect(evidenceOriginOf(extracted)).toBe('model_proposed_person_reviewed');
    expect(evidenceOriginOf({ ...extracted, reviewed: false })).toBe('model_proposed_unreviewed');
    // The same fields reach the requirement row's supporting jobs.
    const supporting = buildRequirements(read.observations).requirements.flatMap((row) => row.supportingJobs);
    expect(supporting.find((entry) => entry.requisitionKey.endsWith('northwind:1003'))).toMatchObject({ candidateAdded: true, evidenceOrigin: 'person_statement', classification: 'preferred', jdAnchor: personAdded.jdAnchor });
    expect(supporting.find((entry) => entry.requisitionKey.endsWith('northwind:1001') && entry.evidenceClass === 'unsupported')).toMatchObject({ candidateAdded: false, evidenceOrigin: 'model_proposed_person_reviewed', classification: 'required' });
  });

  it('reports saved copies and source copies merged before saving as two measures, and counts the larger, never their sum', () => {
    const read = readWorkspaceObservations(db);
    const totals = buildFunnel(read.observations, { dimension: 'source', asOf: AS_OF }).totals;
    const larger = read.observations.reduce((sum, observation) => sum + Math.max(1, observation.savedRows, observation.contributions.length), 0);
    expect(totals.savedRowsRead).toBe(read.sourceRows.savedJobs);
    expect(totals.savedRowsCollapsed).toBe(1); // the two saved copies of 1001
    expect(totals.aliasContributionsMerged).toBe(read.observations.reduce((sum, observation) => sum + Math.max(0, observation.contributions.length - 1), 0));
    expect(totals.copiesSeen).toBe(larger);
    expect(totals.copiesCollapsed).toBe(larger - read.observations.length);
    // The two measures overlap (1001's ATS and aggregator copies are BOTH saved rows and source contributions): adding them would double count.
    const first = byKey(read, 'northwind:1001');
    expect(first.savedRows).toBe(2);
    expect(first.contributions).toHaveLength(2);
    expect(totals.copiesCollapsed).toBeLessThan(totals.savedRowsCollapsed + totals.aliasContributionsMerged);
    expect(totals.copiesCollapsed).toBeGreaterThanOrEqual(Math.max(totals.savedRowsCollapsed, totals.aliasContributionsMerged));
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
    // The prepared application for J3 keeps the requisition alive (applications.saved_job_id is ON DELETE SET NULL), but the saved copy and its
    // selection date are gone: deleting a saved job removes it from the aggregate ONLY when no application row still keeps the requisition.
    expect(after.observations.length).toBe(before);
    const kept = byKey(after, 'northwind:1003');
    expect(kept).toMatchObject({ savedRows: 0, selectedAt: null });
    expect(kept.applications).toHaveLength(1);
    workspace.deleteApplication(db, world.applicationIds.a3!);
    expect(readWorkspaceObservations(db).observations.some((observation) => observation.requisition.key.endsWith('northwind:1003'))).toBe(false);
  });

  it('keeps a hand-tracked application after its saved job is deleted, but re-keys it from stored text (the brief went with the saved job)', () => {
    const before = byKey(readWorkspaceObservations(db), 'northwind:1005');
    expect(before.requisition).toMatchObject({ tier: 'requisition', origin: 'brief_identity' });
    workspace.deleteSavedJob(db, world.savedIds.j5!);
    const after = readWorkspaceObservations(db);
    // No attempt references that brief, so it is pruned with the saved job; the application row survives and keeps a requisition,
    // but only the weak text tier can key it now (never merged with anything on proof).
    const survivor = after.observations.find((observation) => observation.applications.some((application) => application.applicationId === world.applicationIds.a5));
    expect(survivor).toBeDefined();
    expect(survivor!.savedRows).toBe(0);
    expect(survivor!.requisition).toMatchObject({ tier: 'semantic', strength: 'weak', origin: 'derived_at_read' });
    expect(after.observations).toHaveLength(6);
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
    expect(briefStore.listBriefs(db)).toHaveLength(6);
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
    expect(funnel.totals.distinctRequisitions).toBe(6);
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
