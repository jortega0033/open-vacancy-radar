// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postingContentHash, vacancyIdentityFor, type AtsHttpClient, type DiscoveryVacancyAudit } from '@open-vacancy-radar/vacancy-engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BATCH_LIMITS,
  changedPreferenceGroups,
  classifyEligibility,
  describeBatchOutcome,
  matchOverlay,
  pickEligibility,
  preferenceGroups,
  summariseAssessment,
  type ApplicationBriefView,
  type BriefEligibility,
  type PreferenceProfile,
} from '../electron/application-brief.js';
import { createApplicationBriefHandlers } from '../electron/application-brief-ipc.js';
import {
  parseBriefResult,
  parseCommitAssessment,
  parsePrepareAssessment,
} from '../electron/application-brief-parse.js';
import {
  commitAssessment,
  correctPreference,
  getBrief,
  hashReviewedSource,
  pinForAttempt,
  prepareAssessment,
  type BriefServiceDeps,
} from '../electron/application-brief-service.js';
import { ApplicationDataResetGate } from '../electron/application-data-reset-gate.js';
import { startApplicationAttempt, type ApplicationPipelineDeps } from '../electron/application-pipeline.js';
import { addFact, type CompanyEvidenceDeps } from '../electron/company-evidence-service.js';
import { createWorkspaceDb, type WorkspaceDb } from '../electron/workspace/client.js';
import * as briefStore from '../electron/workspace/application-brief-store.js';
import { recordPostingVerification } from '../electron/workspace/posting-verification-store.js';
import * as workspace from '../electron/workspace/repository.js';
import * as schema from '../electron/workspace/schema.js';
import { vacancyKeyFor, type CvRequirementMapping } from '../electron/workspace/cv-evidence-schema.js';
import type { CvSourceDocument } from '../electron/workspace/cv-source-schema.js';
import * as fx from './application-brief-fixtures.js';
import {
  AGG_ONLY_URL,
  AGG_URL,
  ATS_URL,
  ATS_URL_OTHER_REQ,
  DAY,
  ELIGIBILITY,
  JD_V1,
  JD_V2,
  PROFILE,
  SOURCE,
  T0,
  requirement,
  scanRow,
} from './application-brief-fixtures.js';

/**
 * #688. Everything here drives the REAL store (migrated SQLite), the real service, the real IPC
 * handlers and the real preload parser. Only the world is faked: the scan report is an in-memory object
 * the service reads through its `findReportRow` seam, and every employer, candidate and posting is
 * synthetic. No model, network, provider or live job site is touched: `fetch` is stubbed to fail loudly
 * and the model seam does not exist on `getBrief` at all.
 */

let dir: string;
let db: WorkspaceDb;
let closeDb: () => void;
let world: fx.BriefWorld;
let fetchSpy: ReturnType<typeof vi.fn>;
let calls: { postingView: number };

function setScan(rows: DiscoveryVacancyAudit[], generatedAt: string, profileVersion?: string): void {
  fx.setScan(world, rows, generatedAt, profileVersion);
}

function makeDeps(extra: Partial<BriefServiceDeps> = {}): BriefServiceDeps {
  return fx.makeDeps(db, world, extra, calls);
}

function saveJob(row: DiscoveryVacancyAudit, extra: { sourceUrl?: string | null } = {}) {
  return workspace.createSavedJob(db, {
    role: row.title,
    company: row.company,
    location: row.location,
    vacancyKey: row.key,
    matchPercent: row.profileScore,
    sourceUrl: extra.sourceUrl === undefined ? row.url : extra.sourceUrl,
    status: 'considering',
  });
}

function seedCv(overrides: { source?: CvSourceDocument | null } = {}) {
  return workspace.createCvDocument(db, {
    name: 'Main CV',
    kind: 'manual',
    text: 'Jamie Rivera, Senior Engineer.',
    profile: { title: 'Senior Engineer', skills: ['TypeScript'] },
    source: overrides.source === undefined ? SOURCE : overrides.source,
    isDefault: true,
  });
}

/** A grounded assessment exactly as the Search assistant leaves it: an overlay read against `jd` and the reviewed CV. */
function seedAssessment(row: DiscoveryVacancyAudit, cvId: string, jd = JD_V1, coverage: 'complete' | 'partial' = 'complete') {
  const overlay = workspace.createCvEvidenceOverlay(db, {
    cvId,
    vacancyKey: vacancyKeyFor({ title: row.title, company: row.company, location: row.location, url: row.url }),
    caseTitle: row.title,
    caseCompany: row.company,
    sourceCvContentHash: hashReviewedSource(workspace.getCvDocument(db, cvId).source),
    jdSnapshot: jd,
    jdSnapshotHash: briefStore.sha256(jd),
  });
  return workspace.updateCvEvidenceOverlay(db, overlay.id, {
    requirements: [
      requirement({ requirementId: 'r-ts', text: '5+ years of TypeScript', jdAnchor: 'You have 5+ years of TypeScript experience.' }),
      requirement({ requirementId: 'r-k8s', text: 'Kubernetes', jdAnchor: 'Experience with Kubernetes is required.', evidenceClass: 'unsupported', anchorParentId: '' }),
      requirement({ requirementId: 'r-nl', text: 'Dutch language', jdAnchor: 'Dutch language is a plus.', classification: 'preferred', evidenceClass: 'needs_verification', anchorParentId: '', reviewed: false }),
    ],
    requirementCoverage: { status: coverage, batches: 1 },
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-brief-test-'));
  ({ db, close: closeDb } = createWorkspaceDb(dir));
  world = fx.makeWorld();
  calls = { postingView: 0 };
  fetchSpy = vi.fn(() => {
    throw new Error('network is not available to the application brief');
  });
  vi.stubGlobal('fetch', fetchSpy);
  setScan([scanRow({ key: 'gh:1001', url: ATS_URL })], '2026-10-19T08:00:00.000Z');
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function reopen(): void {
  closeDb();
  ({ db, close: closeDb } = createWorkspaceDb(dir));
}

async function view(jobId: string, deps = makeDeps()): Promise<ApplicationBriefView> {
  return getBrief(deps, { savedJobId: jobId });
}

/* ================================================================== 1. survives navigation + restart, no AI */

describe('save -> view -> navigation/restart, with no AI and no network', () => {
  it('captures the brief when the job is first read, and still shows it after a restart with the scan gone', async () => {
    const job = saveJob(world.rows.get('gh:1001')!);
    const first = await view(job.id);
    expect(first.relevance).toMatchObject({ status: 'current', score: 78, provenance: 'Search scan 2026-10-19' });
    expect(first.relevance.signals).toEqual(['TypeScript', 'Kubernetes']);
    expect(first.relevance.caveats).toEqual(['No Go experience listed']);
    expect(first.posting).toMatchObject({ hasText: true, complete: true });
    // No CV in the library yet: the assessment is "unavailable" (with the reason), not a score of any kind.
    expect(first.assessment).toMatchObject({ state: 'unavailable', reason: 'Add a CV first to assess this job.', summary: null });

    // "Restart": reopen the database, and the next scan no longer has the job at all.
    reopen();
    world.rows = new Map();
    const second = await view(job.id);
    expect(second.briefId).toBe(first.briefId);
    expect(second.relevance).toMatchObject({ status: 'current', score: 78, signals: ['TypeScript', 'Kubernetes'] });
    expect(second.eligibility.items.length).toBe(first.eligibility.items.length);
    expect(second.posting.hasText).toBe(true);
    expect(second.sources.map((source) => source.url)).toContain(ATS_URL);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is available during preparation: starting a real attempt pins the brief, and the attempt view shows both', async () => {
    seedCv();
    const row = world.rows.get('gh:1001')!;
    const job = saveJob(row);
    await view(job.id);
    const enqueue = vi.fn(async () => undefined);
    const pipelineDeps = {
      db,
      queue: { enqueue, entryState: vi.fn(), release: vi.fn(), cancel: vi.fn() },
      pinApplicationBrief: async (attempt: { id: string }) => {
        await pinForAttempt(makeDeps(), attempt.id);
      },
      log: vi.fn(),
    } as unknown as ApplicationPipelineDeps;
    const started = await startApplicationAttempt(pipelineDeps, {
      vacancy: { vacancyKey: row.key, company: row.company, role: row.title, applyUrl: ATS_URL, description: row.description, descriptionComplete: true },
    });
    expect(started.ok).toBe(true);
    const attemptId = started.attemptId;
    if (!started.ok || !attemptId) throw new Error('preparation did not start');
    expect(enqueue).toHaveBeenCalledWith(attemptId);

    const pin = briefStore.getPin(db, attemptId);
    expect(pin?.snapshot).toMatchObject({ company: 'Northwind Freight', relevance: { status: 'current', score: 78 }, assessment: { state: 'missing' } });

    const fromAttempt = await getBrief(makeDeps(), { attemptId });
    expect(fromAttempt.briefId).toBe((await view(job.id)).briefId);
    expect(fromAttempt.pin?.snapshot.relevance.score).toBe(78);
    expect(fromAttempt.submission.attempts).toHaveLength(1);
    expect(fromAttempt.submission.attempts[0]).toMatchObject({ checkpoint: 'queued', label: 'Preparing (queued)', submittedAt: null });
  });

  it('a failing pin never blocks preparation', async () => {
    seedCv();
    const row = world.rows.get('gh:1001')!;
    const log = vi.fn();
    const enqueue = vi.fn(async () => undefined);
    const started = await startApplicationAttempt(
      {
        db,
        queue: { enqueue, entryState: vi.fn(), release: vi.fn(), cancel: vi.fn() },
        pinApplicationBrief: async () => {
          throw new Error('disk full');
        },
        log,
      } as unknown as ApplicationPipelineDeps,
      { vacancy: { vacancyKey: row.key, company: row.company, role: row.title, applyUrl: ATS_URL, description: row.description, descriptionComplete: true } },
    );
    expect(started.ok).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('application brief could not be pinned', expect.objectContaining({ error: 'disk full' }));
  });
});

/* ======================================================= 2. canonical identity: source copies vs requisitions */

describe('canonical identity', () => {
  it('two source copies of one requisition share ONE brief; a different requisition stays independent', async () => {
    // Scan 1 found the job through an aggregator first and merged the ATS copy in.
    const merged = scanRow({
      key: 'remotive:77',
      url: AGG_URL,
      sources: [
        { provider: 'remotive', key: 'remotive:77', url: AGG_URL },
        { provider: 'ats_roster_greenhouse', key: 'gh:1001', url: ATS_URL },
      ],
    });
    // The merged row's identity is the requisition even though its key/url are the aggregator's.
    (merged as { identity: unknown }).identity = vacancyIdentityFor({ url: ATS_URL, company: 'Northwind Freight', title: 'Platform Engineer', location: 'Remote - Europe' });
    setScan([merged], '2026-10-19T08:00:00.000Z');
    const savedFromAggregator = saveJob(merged);
    const first = await view(savedFromAggregator.id);

    // Scan 2 (a different report, a different row key) saw only the ATS copy.
    const atsOnly = scanRow({ key: 'gh:1001', url: ATS_URL });
    setScan([atsOnly], '2026-10-22T08:00:00.000Z');
    const savedFromAts = saveJob(atsOnly);
    const second = await view(savedFromAts.id);

    expect(second.briefId).toBe(first.briefId);
    expect(briefStore.listBriefs(db)).toHaveLength(1);
    const urls = second.sources.map((source) => source.url);
    expect(urls).toEqual(expect.arrayContaining([AGG_URL, ATS_URL]));
    // Original source provenance stays visible per copy.
    expect(second.sources.find((source) => source.url === AGG_URL)?.provider).toBe('remotive');

    // The aggregator-saved job with no report row at all still reads the same brief.
    world.rows = new Map();
    expect((await view(savedFromAggregator.id)).briefId).toBe(first.briefId);

    // A different requisition at the same employer, same title and location: independent.
    const other = scanRow({ key: 'gh:1002', url: ATS_URL_OTHER_REQ });
    setScan([other], '2026-10-22T09:00:00.000Z');
    const savedOther = saveJob(other);
    const otherView = await view(savedOther.id);
    expect(otherView.briefId).not.toBe(first.briefId);
    expect(briefStore.listBriefs(db)).toHaveLength(2);
    expect(otherView.identity.key).not.toBe(second.identity.key);
    // ... and it is unaffected by the first brief's data.
    expect(otherView.sources.map((source) => source.url)).toEqual([ATS_URL_OTHER_REQ]);
  });

  it('never merges two requisitions even when a weak alias collides', async () => {
    const a = scanRow({ key: 'gh:1001', url: ATS_URL });
    const b = scanRow({ key: 'gh:1002', url: ATS_URL_OTHER_REQ });
    setScan([a, b], '2026-10-19T08:00:00.000Z');
    const [first, second] = await Promise.all([view(saveJob(a).id), view(saveJob(b).id)]);
    expect(first.briefId).not.toBe(second.briefId);
    // Pretend one scan claims the second job also lives at the first job's URL: still two briefs.
    const claim = scanRow({ key: 'gh:1002', url: ATS_URL_OTHER_REQ, sources: [{ provider: 'x', key: 'x:1', url: ATS_URL }] });
    setScan([claim], '2026-10-25T08:00:00.000Z');
    await getBrief(makeDeps(), { savedJobId: workspace.listSavedJobs(db).find((job) => job.vacancyKey === 'gh:1002')!.id });
    expect(briefStore.listBriefs(db).map((brief) => brief.identityKey).sort()).toEqual([
      'req:greenhouse:northwind:1001',
      'req:greenhouse:northwind:1002',
    ]);
  });

  it('a manual saved job with no scan row gets its own brief and says what is missing', async () => {
    const manual = workspace.createSavedJob(db, { role: 'Solo Role', company: 'Harbor Systems', location: 'Lisbon', sourceUrl: AGG_ONLY_URL, status: 'considering' });
    const brief = await view(manual.id);
    expect(brief.relevance).toMatchObject({ status: 'not_scored', score: null });
    expect(brief.relevance.reason).toContain('No scan result');
    expect(brief.posting.hasText).toBe(false);
    expect(brief.assessment.state).toBe('unavailable');
    expect(brief.assessment.reason).toContain('No job description');
    expect(brief.eligibility.status).toBe('not_assessed');
  });
});

/* ====================================================== 3. invalidation with reasons; submission evidence kept */

describe('version invalidation', () => {
  it('a changed posting marks the assessment out of date with a plain reason and keeps the earlier summary labelled as earlier', async () => {
    const cv = seedCv();
    const row = world.rows.get('gh:1001')!;
    const job = saveJob(row);
    seedAssessment(row, cv.id, JD_V1);
    const current = await view(job.id);
    expect(current.assessment.state).toBe('current');
    expect(current.assessment.summary?.strengths.map((s) => s.text)).toEqual(['5+ years of TypeScript']);

    world.clock = new Date(T0.getTime() + 2 * DAY);
    setScan([scanRow({ key: 'gh:1001', url: ATS_URL, description: JD_V2 })], '2026-10-22T08:00:00.000Z');
    const changed = await view(job.id);
    expect(changed.assessment.state).toBe('stale');
    expect(changed.assessment.reason).toBe(
      'The job description changed on 2026-10-22, so the earlier assessment no longer describes this posting.',
    );
    expect(changed.assessment.summary?.strengths).toHaveLength(1); // the earlier one, still shown as earlier
    expect(changed.posting.changedAt).toBe('2026-10-22T09:00:00.000Z');
    expect(changed.notices.map((notice) => notice.text)).toEqual(
      expect.arrayContaining([expect.stringContaining('The job description changed on 2026-10-22')]),
    );
    // Relevance and eligibility were not derived from the posting text, so they are untouched.
    expect(changed.relevance.status).toBe('current');
    expect(changed.eligibility.status).toBe('current');
  });

  it('changed CV facts invalidate the assessment, not the employer facts', async () => {
    const cv = seedCv();
    const row = world.rows.get('gh:1001')!;
    const job = saveJob(row);
    seedAssessment(row, cv.id);
    expect((await view(job.id)).assessment.state).toBe('current');
    workspace.updateCvDocument(db, cv.id, {
      source: { ...SOURCE, experience: [{ ...SOURCE.experience[0]!, bullets: ['Built TypeScript services.', 'Ran Kubernetes clusters.'] }] },
    });
    const after = await view(job.id);
    expect(after.assessment).toMatchObject({ state: 'stale', reason: expect.stringContaining('reviewed CV changed') });
    expect(after.relevance.status).toBe('current');
    expect(after.posting.hasText).toBe(true);
  });

  it('relevant preferences invalidate only the sections that read them, and say which preference changed', async () => {
    const row = world.rows.get('gh:1001')!;
    const job = saveJob(row);
    expect((await view(job.id)).relevance.status).toBe('current');

    // An irrelevant edit (a new profile version, but nothing the score reads) changes nothing.
    world.profile = { ...world.profile!, profileVersion: 'candidate-profile-2' };
    expect((await view(job.id)).relevance.status).toBe('current');

    // Target roles changed: relevance is out of date; eligibility answers do not depend on roles.
    world.profile = { ...world.profile!, profileVersion: 'candidate-profile-3', targetRoles: ['Data Engineer'] };
    const roles = await view(job.id);
    expect(roles.relevance).toMatchObject({ status: 'stale', reason: 'You changed your target roles after this score was calculated. Search again to refresh it.' });
    expect(roles.eligibility.status).toBe('current');

    // The working language changed: the eligibility answer about languages is now out of date too, and
    // the employer's own statements are explicitly called out as unchanged.
    world.profile = { ...world.profile!, profileVersion: 'candidate-profile-4', constraints: { ...world.profile!.constraints, professionalLanguage: 'English, Dutch' } };
    const language = await view(job.id);
    expect(language.eligibility.status).toBe('stale');
    expect(language.eligibility.reason).toContain('your working languages');
    expect(language.eligibility.reason).toContain('employer’s own statements below are unchanged');
    // The stored employer facts were never rewritten by any of this.
    const stored = briefStore.listBriefs(db)[0]!;
    expect(stored.facts?.profileScore).toBe(78);
    expect(stored.facts?.eligibility?.visaSponsorship?.detail).toBe('We cannot sponsor visas.');
  });

  it('a scan made under an older profile version is reported as possibly out of date, not trusted', async () => {
    setScan([scanRow({ key: 'gh:1001', url: ATS_URL })], '2026-10-19T08:00:00.000Z', 'candidate-profile-OLD');
    const job = saveJob(world.rows.get('gh:1001')!);
    const brief = await view(job.id);
    expect(brief.relevance.status).toBe('stale');
    expect(brief.relevance.reason).toContain('saved your search profile after this scan');
  });

  it('a summary kept from an older brief version is history only, and a current assessment re-derives under the current one', async () => {
    const cv = seedCv();
    const row = world.rows.get('gh:1001')!;
    const job = saveJob(row);
    seedAssessment(row, cv.id);
    expect((await view(job.id)).assessment.state).toBe('current');
    // Pretend the stored summary was written by an older version of the brief.
    const stored = briefStore.listBriefs(db)[0]!;
    db.update(schema.applicationBriefs)
      .set({ assessment: { ...stored.assessment!, inputs: { ...stored.assessment!.inputs, workflowVersion: 'application-brief-v0' } } })
      .run();
    // The overlay still matches, so the current rules simply re-derive it.
    expect((await view(job.id)).assessment.state).toBe('current');
    expect(briefStore.listBriefs(db)[0]!.assessment!.inputs.workflowVersion).toBe('application-brief-v1');

    // Once the grounded assessment itself is gone, only the old summary is left, and it says why it is only history.
    db.update(schema.applicationBriefs)
      .set({ assessment: { ...stored.assessment!, inputs: { ...stored.assessment!.inputs, workflowVersion: 'application-brief-v0' } } })
      .run();
    db.delete(schema.cvEvidenceOverlays).run();
    const history = await view(job.id);
    expect(history.assessment.state).toBe('stale');
    expect(history.assessment.reason).toContain('older version of the brief');
  });

  it('submitted evidence, the attempt and the pinned brief are never rewritten by any of those changes', async () => {
    const cv = seedCv();
    const row = world.rows.get('gh:1001')!;
    const job = saveJob(row);
    seedAssessment(row, cv.id);
    const attempt = workspace.createApplicationAttempt(db, {
      vacancyKey: row.key,
      canonicalUrl: ATS_URL,
      company: row.company,
      role: row.title,
      sourceCvId: cv.id,
      sourceCvContentHash: 'cv-hash',
      jdSnapshot: JD_V1,
      jdSnapshotHash: 'jd-hash',
      checkpoint: 'submitted',
    });
    workspace.createApplicationSubmissionReceipt(db, {
      attemptId: attempt.id,
      outcome: 'user_reported',
      source: 'user_reported',
      evidenceKind: 'user_statement',
      detail: 'I applied on the employer page.',
    });
    expect(await pinForAttempt(makeDeps(), attempt.id)).toBe(true);
    const before = {
      attempt: JSON.stringify(workspace.getApplicationAttempt(db, attempt.id)),
      receipts: JSON.stringify(workspace.listApplicationSubmissionReceipts(db, attempt.id)),
      pin: JSON.stringify(briefStore.getPin(db, attempt.id)),
      overlayCount: workspace.listCvEvidenceOverlays(db, cv.id).length,
    };

    world.clock = new Date(T0.getTime() + 3 * DAY);
    setScan([scanRow({ key: 'gh:1001', url: ATS_URL, description: JD_V2, profileScore: 40 })], '2026-10-23T08:00:00.000Z');
    world.profile = { ...world.profile!, profileVersion: 'candidate-profile-9', targetRoles: ['Designer'] };
    workspace.updateCvDocument(db, cv.id, { source: { ...SOURCE, summary: 'Changed summary.' } });
    const after = await view(job.id);
    await pinForAttempt(makeDeps(), attempt.id); // a second pin is ignored: the first is the record

    expect(JSON.stringify(workspace.getApplicationAttempt(db, attempt.id))).toBe(before.attempt);
    expect(JSON.stringify(workspace.listApplicationSubmissionReceipts(db, attempt.id))).toBe(before.receipts);
    expect(JSON.stringify(briefStore.getPin(db, attempt.id))).toBe(before.pin);
    expect(workspace.listCvEvidenceOverlays(db, cv.id)).toHaveLength(before.overlayCount);
    // The live brief moved on (new score, new posting), the pinned one did not.
    expect(after.relevance.score).toBe(40);
    const fromAttempt = await getBrief(makeDeps(), { attemptId: attempt.id });
    expect(fromAttempt.pin?.snapshot.relevance.score).toBe(78);
    expect(fromAttempt.submission.attempts[0]).toMatchObject({ label: 'Sent (the app observed a receipt)', receipts: 1 });
    expect(fromAttempt.postingCheck.status).toBe('not_applicable');
  });
});

/* ================================================== 4. distinct states: mismatch / unknown / missing assessment */

describe('known mismatch, uncertain eligibility and a missing assessment are three different things', () => {
  it('classifies eligibility from what a source said, never from a gap', async () => {
    const answers = pickEligibility({ ...ELIGIBILITY, candidateWorkCountry: { ...ELIGIBILITY.candidateWorkCountry, answer: 'no' } }) as BriefEligibility;
    const items = classifyEligibility(answers);
    const by = (key: string) => items.find((item) => item.key === key)!;
    expect(by('candidateWorkCountry').classification).toBe('known_mismatch');
    expect(by('mandatoryLanguage').classification).toBe('uncertain');
    // A refused visa is a mismatch only because the person cannot work from where they are.
    expect(by('visaSponsorship').classification).toBe('known_mismatch');
    expect(by('employerRelocationSupport').classification).toBe('informational');
    expect(by('candidateRelocationWillingness')).toMatchObject({ classification: 'uncertain', fromPreferences: true });

    const fine = classifyEligibility(pickEligibility(ELIGIBILITY) as BriefEligibility);
    expect(fine.find((item) => item.key === 'visaSponsorship')!.classification).toBe('informational');
    expect(fine.find((item) => item.key === 'candidateWorkCountry')!.classification).toBe('consistent');
  });

  it('shows all three at once without inventing a score for the missing assessment', async () => {
    seedCv();
    setScan(
      [scanRow({ key: 'gh:1001', url: ATS_URL, eligibility: { ...ELIGIBILITY, mandatoryLanguage: { ...ELIGIBILITY.mandatoryLanguage, answer: 'no', detail: 'Dutch is mandatory.' } } })],
      '2026-10-19T08:00:00.000Z',
    );
    const brief = await view(saveJob(world.rows.get('gh:1001')!).id);
    expect(brief.eligibility.counts).toMatchObject({ knownMismatch: 1, uncertain: 2, consistent: 1, informational: 2 });
    expect(brief.assessment).toMatchObject({ state: 'missing', reason: null, summary: null });
    expect(brief.readiness.assessment).toBe('missing');
    expect(brief.actions.canAssess).toBe(true);
    // The only number anywhere is the engine's scan score, with its provenance; the assessment adds none.
    expect(JSON.stringify(brief.assessment)).not.toMatch(/score|probability|percent/iu);
    expect(brief.relevance.score).toBe(78);
  });

  it('an unscored job is "not scored", which is neither a mismatch nor a low score', async () => {
    setScan([scanRow({ key: 'gh:1001', url: ATS_URL, profileScore: null, eligibility: null })], '2026-10-19T08:00:00.000Z');
    const brief = await view(saveJob(world.rows.get('gh:1001')!).id);
    expect(brief.relevance).toMatchObject({ status: 'not_scored', score: null });
    expect(brief.eligibility).toMatchObject({ status: 'not_assessed', items: [] });
    expect(brief.eligibility.counts.knownMismatch).toBe(0);
  });
});

/* =================================================================== 5. reusing a matching grounded assessment */

describe('grounded assessment reuse', () => {
  it('reuses an existing overlay only when its posting text and reviewed CV match, with evidence provenance', async () => {
    const cv = seedCv();
    const row = world.rows.get('gh:1001')!;
    const job = saveJob(row);
    seedAssessment(row, cv.id);
    const brief = await view(job.id);
    expect(brief.assessment.state).toBe('current');
    const summary = brief.assessment.summary!;
    expect(summary.strengths).toEqual([
      expect.objectContaining({ text: '5+ years of TypeScript', evidenceClass: 'direct', evidenceLabel: 'Senior Engineer at Redwood Software', jdAnchor: 'You have 5+ years of TypeScript experience.' }),
    ]);
    expect(summary.gaps.map((gap) => gap.text)).toEqual(['Kubernetes']);
    expect(summary.openQuestions.map((item) => item.text)).toEqual(['Dutch language']);
    expect(summary.counts).toMatchObject({ requirements: 3, direct: 1, unsupported: 1, needsVerification: 1, unreviewed: 1 });
    expect(brief.readiness.notes).toContain('1 requirement still need your review.');
    expect(fetchSpy).not.toHaveBeenCalled();

    // The same assessment is found through ANY source copy of the same requisition.
    const aggregatorCopy = scanRow({ key: 'remotive:77', url: AGG_URL, sources: [{ provider: 'ats_roster_greenhouse', key: 'gh:1001', url: ATS_URL }, { provider: 'remotive', key: 'remotive:77', url: AGG_URL }] });
    setScan([aggregatorCopy], '2026-10-24T08:00:00.000Z');
    const second = await view(saveJob(aggregatorCopy).id);
    expect(second.briefId).toBe(brief.briefId);
    expect(second.assessment.state).toBe('current');
  });

  it('a partial requirement read is labelled partial, never complete', async () => {
    const cv = seedCv();
    const row = world.rows.get('gh:1001')!;
    seedAssessment(row, cv.id, JD_V1, 'partial');
    const brief = await view(saveJob(row).id);
    expect(brief.assessment.state).toBe('partial');
    expect(brief.assessment.reason).toContain('Only part of the posting');
  });

  it('refuses to describe a job against an overlay that read a different description', async () => {
    const cv = seedCv();
    const row = world.rows.get('gh:1001')!;
    seedAssessment(row, cv.id, `${JD_V1} (pasted by the candidate)`);
    const brief = await view(saveJob(row).id);
    expect(brief.assessment.state).toBe('stale');
    expect(brief.assessment.reason).toContain('different job description');
  });

  it('summariseAssessment calls an unlinked "direct" mapping an open question, never a strength', () => {
    const summary = summariseAssessment(
      { state: 'draft', requirementCoverage: { status: 'complete' }, requirements: [requirement({ requirementId: 'a', text: 'Go', jdAnchor: 'Go', anchorParentId: '' })] },
      () => null,
    );
    expect(summary.strengths).toHaveLength(0);
    expect(summary.openQuestions.map((item) => item.text)).toEqual(['Go']);
  });
});

/* ===================================== 6. explicit assessment: plan, fence, commit, refusal, stale-result race */

describe('assess: prepare + commit with version fencing', () => {
  const mapped = (jdAnchor: string, over: Partial<CvRequirementMapping> = {}) =>
    requirement({ requirementId: `new-${jdAnchor.length}`, text: 'Requirement', jdAnchor, ...over });

  async function ready() {
    const cv = seedCv();
    const row = world.rows.get('gh:1001')!;
    const job = saveJob(row);
    await view(job.id);
    return { cv, row, job };
  }

  it('refuses up front, with a reason, when nothing can be assessed', async () => {
    const row = world.rows.get('gh:1001')!;
    const job = saveJob(row);
    expect(await prepareAssessment(makeDeps(), job.id)).toMatchObject({ ok: false, code: 'no_cv' });
    const unreviewed = seedCv();
    // `createCvDocument` stamps reviewedAt itself; an unreviewed source is one that was never confirmed.
    db.update(schema.cvDocuments).set({ sourceCv: { ...SOURCE, reviewedAt: '' } }).run();
    void unreviewed;
    expect(await prepareAssessment(makeDeps(), job.id)).toMatchObject({ ok: false, code: 'cv_not_reviewed' });
    expect(await prepareAssessment(makeDeps(), 'missing-id')).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('refuses a job with no posting text and one that is already current', async () => {
    const cv = seedCv();
    const manual = workspace.createSavedJob(db, { role: 'Solo Role', company: 'Harbor Systems', location: 'Lisbon', sourceUrl: AGG_ONLY_URL, status: 'considering' });
    expect(await prepareAssessment(makeDeps(), manual.id)).toMatchObject({ ok: false, code: 'no_posting_text' });
    const row = world.rows.get('gh:1001')!;
    const job = saveJob(row);
    seedAssessment(row, cv.id);
    expect(await prepareAssessment(makeDeps(), job.id)).toMatchObject({ ok: false, code: 'already_current' });
  });

  it('plans with a fence, commits a grounded result, and the brief reads it back as current', async () => {
    const { cv, job } = await ready();
    const prepared = await prepareAssessment(makeDeps(), job.id);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.plan.lead).toMatchObject({ title: 'Platform Engineer', company: 'Northwind Freight', description: JD_V1 });
    expect(prepared.plan.fence).toMatchObject({ cvId: cv.id, jdHash: briefStore.sha256(JD_V1), overlayId: null });

    const result = await commitAssessment(makeDeps(), {
      savedJobId: job.id,
      fence: prepared.plan.fence,
      requirements: [mapped('Experience with Kubernetes is required.', { evidenceClass: 'unsupported', anchorParentId: '' }), mapped('You have 5+ years of TypeScript experience.')],
      requirementCoverage: { status: 'complete', batches: 1 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.assessment.state).toBe('current');
    expect(result.view.assessment.summary?.gaps.map((gap) => gap.jdAnchor)).toEqual(['Experience with Kubernetes is required.']);
    const overlay = workspace.listCvEvidenceOverlays(db, cv.id)[0]!;
    expect(overlay.jdSnapshot).toBe(JD_V1);
    expect(overlay.requirements.every((requirement) => requirement.quoteStart >= 0)).toBe(true);
  });

  it('discards a result when the posting changed while the model was working: nothing is saved', async () => {
    const { cv, job } = await ready();
    const prepared = await prepareAssessment(makeDeps(), job.id);
    if (!prepared.ok) throw new Error('not ready');
    // The next scan arrives while the model is "running" and the posting text changed.
    setScan([scanRow({ key: 'gh:1001', url: ATS_URL, description: JD_V2 })], '2026-10-22T08:00:00.000Z');
    const result = await commitAssessment(makeDeps(), {
      savedJobId: job.id,
      fence: prepared.plan.fence,
      requirements: [mapped('You have 5+ years of TypeScript experience.')],
      requirementCoverage: { status: 'complete', batches: 1 },
    });
    expect(result).toMatchObject({ ok: false, code: 'stale' });
    expect(workspace.listCvEvidenceOverlays(db, cv.id)).toHaveLength(0);
  });

  it('discards a result when the reviewed CV changed, and when the case was edited meanwhile', async () => {
    const { cv, row, job } = await ready();
    const prepared = await prepareAssessment(makeDeps(), job.id);
    if (!prepared.ok) throw new Error('not ready');
    workspace.updateCvDocument(db, cv.id, { source: { ...SOURCE, summary: 'A different, newly reviewed summary.' } });
    expect(
      await commitAssessment(makeDeps(), { savedJobId: job.id, fence: prepared.plan.fence, requirements: [], requirementCoverage: { status: 'partial', batches: 1 } }),
    ).toMatchObject({ ok: false, code: 'stale' });
    expect(workspace.listCvEvidenceOverlays(db, cv.id)).toHaveLength(0);

    // Case edited while a continuation was running: caseRevision no longer matches.
    seedAssessment(row, cv.id, JD_V1, 'partial');
    const again = await prepareAssessment(makeDeps(), job.id);
    if (!again.ok) throw new Error(`not ready: ${again.code}`);
    expect(again.plan.fence.overlayId).not.toBeNull();
    const overlayId = again.plan.fence.overlayId!;
    workspace.updateCvEvidenceOverlay(db, overlayId, { listingStatus: 'open' });
    expect(
      await commitAssessment(makeDeps(), { savedJobId: job.id, fence: again.plan.fence, requirements: [], requirementCoverage: { status: 'complete', batches: 2 } }),
    ).toMatchObject({ ok: false, code: 'stale' });
  });

  it('a malformed result, a deleted job and a reset all refuse without writing', async () => {
    const { cv, job } = await ready();
    const prepared = await prepareAssessment(makeDeps(), job.id);
    if (!prepared.ok) throw new Error('not ready');
    expect(
      await commitAssessment(makeDeps(), { savedJobId: job.id, fence: prepared.plan.fence, requirements: [{ nonsense: true }], requirementCoverage: { status: 'complete', batches: 1 } }),
    ).toMatchObject({ ok: false, code: 'invalid' });
    workspace.deleteSavedJob(db, job.id);
    expect(
      await commitAssessment(makeDeps(), { savedJobId: job.id, fence: prepared.plan.fence, requirements: [], requirementCoverage: { status: 'complete', batches: 1 } }),
    ).toMatchObject({ ok: false, code: 'not_found' });
    expect(workspace.listCvEvidenceOverlays(db, cv.id)).toHaveLength(0);
  });
});

/* ================================================ 7. preference correction changes preferences only */

describe('correcting a preference', () => {
  it('writes the preference through the profile saver and nothing else; employer facts and history are untouched', async () => {
    const row = world.rows.get('gh:1001')!;
    const job = saveJob(row);
    const attempt = workspace.createApplicationAttempt(db, {
      vacancyKey: row.key, canonicalUrl: ATS_URL, company: row.company, role: row.title, sourceCvContentHash: 'x', jdSnapshot: JD_V1, jdSnapshotHash: 'j', checkpoint: 'submitted',
    });
    await view(job.id);
    const beforeBrief = JSON.stringify(briefStore.listBriefs(db)[0]!.facts) + briefStore.listBriefs(db)[0]!.factsVersion;
    const beforeAttempt = JSON.stringify(workspace.getApplicationAttempt(db, attempt.id));
    const saved: unknown[] = [];
    const deps = makeDeps({
      async saveProfilePatch(patch) {
        saved.push(patch);
        world.profile = { ...world.profile!, profileVersion: 'candidate-profile-5', constraints: { ...world.profile!.constraints, relocationWilling: true } };
      },
    });
    await correctPreference(deps, { relocationWilling: true });
    expect(saved).toEqual([{ constraints: { relocationWilling: true } }]);
    const after = await view(job.id, deps);
    expect(JSON.stringify(briefStore.listBriefs(db)[0]!.facts) + briefStore.listBriefs(db)[0]!.factsVersion).toBe(beforeBrief);
    expect(JSON.stringify(workspace.getApplicationAttempt(db, attempt.id))).toBe(beforeAttempt);
    // The sections that read relocation are out of date and say why; the employer's statement is intact.
    expect(after.eligibility.status).toBe('stale');
    expect(after.eligibility.reason).toContain('your relocation preference');
    expect(after.eligibility.items.find((item) => item.key === 'visaSponsorship')?.detail).toBe('We cannot sponsor visas.');
    await expect(correctPreference(makeDeps(), { relocationWilling: false })).rejects.toThrow();
  });
});

/* ============================================== 8. optional #687 posting evidence and #689 company evidence */

describe('posting verification (#687) and company evidence (#689) in the brief', () => {
  async function preparedAttempt() {
    seedCv();
    const row = world.rows.get('gh:1001')!;
    const job = saveJob(row);
    const attempt = workspace.createApplicationAttempt(db, {
      vacancyKey: row.key, canonicalUrl: ATS_URL, company: row.company, role: row.title, sourceCvContentHash: 'x', jdSnapshot: JD_V1, jdSnapshotHash: 'j',
    });
    return { row, job, attempt };
  }

  it('is "not checked" with no attempt, then shows the stored check, its deadline, and when it is stale', async () => {
    const { job, attempt } = await preparedAttempt();
    // No request is made for a brief that has no attempt; the posting section says so.
    const none = await view(job.id);
    expect(none.postingCheck.status).toBe('not_checked');
    expect(none.postingCheck.note).toContain('Nothing is requested until then');

    recordPostingVerification(db, {
      attemptId: attempt.id,
      allowedCheckpoints: ['queued'],
      observedAt: new Date(world.clock),
      source: 'ats_api',
      sourceRef: ATS_URL,
      outcome: 'open',
      result: 'confirmed_open',
      reason: 'posting_open',
      httpStatus: 200,
      contentHash: postingContentHash(JD_V1),
      baselineHash: postingContentHash(JD_V1),
      deadline: '2026-11-15',
      deadlineProvenance: { source: 'posting_text', excerpt: 'Applications close on 15 November 2026.' },
      etag: null,
      lastModified: null,
      changeSummary: null,
      observedText: null,
    });
    const fresh = await view(job.id);
    expect(fresh.postingCheck).toMatchObject({ status: 'confirmed_open', stale: false, deadline: { date: '2026-11-15', excerpt: 'Applications close on 15 November 2026.' } });
    expect(fresh.postingCheck.checkedAt).toBe(T0.toISOString());

    world.clock = new Date(T0.getTime() + 30 * DAY);
    const stale = await view(job.id);
    expect(stale.postingCheck.stale).toBe(true);
    expect(stale.postingCheck.checkedAt).toBe(T0.toISOString()); // the original check time, never a fresh one
    expect(calls.postingView).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows company evidence as current, then out of date, with its source and retrieval time; and "not yet" without an attempt', async () => {
    const { job, attempt } = await preparedAttempt();
    // A saved job with no attempt has no company-evidence target yet: said plainly, nothing looked up.
    const solo = workspace.createSavedJob(db, { role: 'Solo Role', company: 'Harbor Systems', location: 'Lisbon', sourceUrl: AGG_ONLY_URL, status: 'considering' });
    expect((await view(solo.id)).companyEvidence).toMatchObject({ available: false, facts: [] });
    expect((await view(job.id)).companyEvidence).toMatchObject({ available: true, facts: [], counts: { current: 0, expired: 0, leads: 0 } });

    const quote = 'Northwind Freight operates 14 depots across the Netherlands and Belgium';
    const web: AtsHttpClient = {
      get: async (url) => ({ status: 200, finalUrl: url, headers: {}, body: `<html><body><p>${quote}.</p></body></html>` }),
      postJson: async () => {
        throw new Error('not used');
      },
    };
    const evidenceDeps: CompanyEvidenceDeps = { db, now: () => new Date(world.clock), getHttp: async () => web };
    const added = await addFact(evidenceDeps, { attemptId: attempt.id }, {
      claim: `${quote}.`,
      sourceUrl: 'https://job-boards.greenhouse.io/northwind/jobs/1001',
      quote,
      scope: 'company',
      topic: 'general',
    });
    expect(added.ok).toBe(true);
    const current = await view(job.id);
    expect(current.companyEvidence.available).toBe(true);
    expect(current.companyEvidence.counts.current + current.companyEvidence.counts.leads).toBe(1);
    expect(current.companyEvidence.facts[0]).toMatchObject({ sourceUrl: 'https://job-boards.greenhouse.io/northwind/jobs/1001', scope: 'company' });

    world.clock = new Date(T0.getTime() + 400 * DAY);
    const old = await view(job.id);
    expect(old.companyEvidence.counts.expired).toBe(1);
    expect(old.companyEvidence.facts[0]!.state).toBe('expired');
    expect(old.companyEvidence.note).toContain('1 out of date');
  });
});

/* ===================================================== 9. IPC handlers + real preload bridge, end to end */

describe('IPC handlers and the real preload bridge', () => {
  const gate = new ApplicationDataResetGate();

  it('parses strictly, never echoes stored text on failure, and a rebuilt view equals the real one', async () => {
    const handlers = createApplicationBriefHandlers({ service: async () => makeDeps(), mutate: (task) => gate.runMutation(task) });
    const job = saveJob(world.rows.get('gh:1001')!);
    const raw = await handlers['application-brief:get']!({ savedJobId: job.id });
    const wire = JSON.parse(JSON.stringify(raw)); // what crosses the Electron boundary
    const parsed = parseBriefResult(wire);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || !(raw as { ok: boolean; view: ApplicationBriefView }).ok) return;
    // Nothing the main process sent was silently dropped by the preload parser.
    expect(parsed.view).toEqual((wire as { view: unknown }).view);

    expect(await handlers['application-brief:get']!({ savedJobId: job.id, attemptId: 'x' })).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await handlers['application-brief:get']!({ savedJobId: job.id, extra: 1 })).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(await handlers['application-brief:get']!({ savedJobId: 'nope' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(await handlers['application-brief:prepare-assessment']!({ savedJobId: job.id, cv: 'text' })).toMatchObject({ ok: false });
    expect(await handlers['application-brief:correct-preference']!({})).toMatchObject({ ok: false });
    expect(await handlers['application-brief:correct-preference']!({ cvText: 'secret' })).toMatchObject({ ok: false });
    // Unknown fields from a hostile page collapse to a refusal rather than being forwarded.
    expect(parseBriefResult({ ok: true, view: { briefId: 'x' } })).toMatchObject({ ok: false, code: 'failed' });
    expect(parsePrepareAssessment({ ok: true, plan: {} })).toMatchObject({ ok: false });
    expect(parseCommitAssessment('garbage')).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('is refused while a data reset is running, and a reset empties every brief table with counts', async () => {
    const job = saveJob(world.rows.get('gh:1001')!);
    seedCv();
    const attempt = workspace.createApplicationAttempt(db, { vacancyKey: 'gh:1001', canonicalUrl: ATS_URL, company: 'Northwind Freight', role: 'Platform Engineer', sourceCvContentHash: 'x', jdSnapshot: JD_V1, jdSnapshotHash: 'j' });
    await view(job.id);
    await pinForAttempt(makeDeps(), attempt.id);
    const result = workspace.resetApplicationData(db);
    expect(result.deleted).toMatchObject({ applicationBriefs: 1, applicationBriefPins: 1 });
    expect(result.deleted.applicationBriefAliases).toBeGreaterThan(0);
    expect(db.select().from(schema.applicationBriefs).all()).toHaveLength(0);
    expect(db.select().from(schema.applicationBriefAliases).all()).toHaveLength(0);
    expect(db.select().from(schema.applicationBriefPins).all()).toHaveLength(0);
  });

  it('deleting the last saved job removes its brief; a brief an attempt still references survives', async () => {
    const row = world.rows.get('gh:1001')!;
    const job = saveJob(row);
    const second = saveJob(row);
    await view(job.id);
    await view(second.id);
    expect(briefStore.listBriefs(db)).toHaveLength(1);
    workspace.deleteSavedJob(db, job.id);
    expect(briefStore.listBriefs(db)).toHaveLength(1); // the other saved job still points at it
    const attempt = workspace.createApplicationAttempt(db, { vacancyKey: 'gh:1001', canonicalUrl: ATS_URL, company: row.company, role: row.title, sourceCvContentHash: 'x', jdSnapshot: JD_V1, jdSnapshotHash: 'j' });
    await getBrief(makeDeps(), { attemptId: attempt.id });
    workspace.deleteSavedJob(db, second.id);
    expect(briefStore.listBriefs(db)).toHaveLength(1); // the attempt still references it
    db.delete(schema.applicationAttempts).run();
    workspace.deleteSavedJob(db, saveJob(row).id);
    expect(briefStore.listBriefs(db)).toHaveLength(0);
  });
});

/* ===================================================================================== pure policy */

describe('pure policy', () => {
  const profile: PreferenceProfile = PROFILE;

  it('groups only the preferences that change a verdict, order- and case-insensitively', () => {
    const base = preferenceGroups(profile);
    expect(preferenceGroups({ ...profile, strongestSkills: ['typescript '] })).toEqual(base);
    expect(preferenceGroups({ ...profile, targetRoles: [' platform  engineer'] })).toEqual(base);
    expect(changedPreferenceGroups(base, preferenceGroups({ ...profile, targetRoles: ['Designer'] }))).toEqual(['roles']);
    expect(
      changedPreferenceGroups(base, preferenceGroups({ ...profile, constraints: { ...profile.constraints, relocationWilling: false, minimumMonthlyBaseEur: 4000 } })).sort(),
    ).toEqual(['relocation', 'salary']);
    expect(changedPreferenceGroups(null, base)).toEqual([]);
  });

  it('matchOverlay compares both versions', () => {
    const current = { jdHash: 'j', cvHash: 'c' };
    expect(matchOverlay(null, current)).toBe('none');
    expect(matchOverlay({ jdSnapshotHash: 'j', sourceCvContentHash: 'c' }, current)).toBe('matches');
    expect(matchOverlay({ jdSnapshotHash: 'x', sourceCvContentHash: 'c' }, current)).toBe('jd_differs');
    expect(matchOverlay({ jdSnapshotHash: 'j', sourceCvContentHash: 'x' }, current)).toBe('cv_differs');
    expect(matchOverlay({ jdSnapshotHash: 'x', sourceCvContentHash: 'x' }, current)).toBe('both_differ');
    expect(matchOverlay({ jdSnapshotHash: 'j', sourceCvContentHash: 'c' }, { jdHash: null, cvHash: 'c' })).toBe('jd_differs');
  });

  it('describes a batch honestly: only a fully assessed batch is "Finished"', () => {
    expect(describeBatchOutcome({ total: 3, assessed: 3, partial: 0, unassessed: 0, failed: 0, cancelled: 0, discarded: 0 }, false)).toBe('Finished: 3 of 3 assessed.');
    expect(describeBatchOutcome({ total: 5, assessed: 2, partial: 0, unassessed: 1, failed: 1, cancelled: 1, discarded: 0 }, true)).toBe(
      'Stopped: 2 of 5 assessed, 1 failed, 1 could not be assessed, 1 not finished.',
    );
    expect(describeBatchOutcome({ total: 2, assessed: 1, partial: 0, unassessed: 0, failed: 0, cancelled: 0, discarded: 1 }, false)).toContain('Finished with gaps');
    expect(BATCH_LIMITS).toMatchObject({ maxJobs: 5, concurrency: 1, passesPerJob: 2 });
  });

  it('composeBriefView keeps relevance, readiness and submission evidence in separate fields', async () => {
    const job = saveJob(world.rows.get('gh:1001')!);
    const brief = await view(job.id);
    expect(Object.keys(brief)).toEqual(expect.arrayContaining(['relevance', 'eligibility', 'assessment', 'readiness', 'submission', 'postingCheck', 'companyEvidence']));
    expect(brief.submission).toEqual({ attempts: [] });
    expect(brief.readiness.notes).toEqual(['Add a CV before preparing an application.']);
  });
});
