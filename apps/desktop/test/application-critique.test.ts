// @vitest-environment node
/* eslint-disable @typescript-eslint/no-explicit-any -- fixtures mutate loosely-typed critic JSON on purpose */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #690 at the real service boundary: a real migrated SQLite workspace, the real preparation pipeline
 * (so the drafts the critique reads are exactly what preparation recorded), the real staging path and
 * document acceptance contract over real PDF bytes, and the real critique service. Only two things are
 * stood in for: Chromium's `printToPDF` (replaced by a renderer that makes a real text PDF from the HTML
 * it was asked to print) and the model session (a hermetic scripted reviewer that records every call).
 */

const { html } = vi.hoisted(() => ({ html: [] as string[] }));
vi.mock('electron', async () => {
  const { htmlToPdf } = await import('./application-critique-fixtures.js');
  return {
    BrowserWindow: class {
      #html = '';
      webContents = { printToPDF: async (): Promise<Buffer> => Buffer.from(htmlToPdf(this.#html)) };
      async loadURL(url: string): Promise<void> {
        this.#html = decodeURIComponent(url.replace(/^data:text\/html;charset=utf-8,/u, ''));
        html.push(this.#html);
      }
      destroy(): void {}
    },
  };
});
vi.mock('../electron/application-view.js', () => ({ createApplicationView: vi.fn() }));
const { closeSpy } = vi.hoisted(() => ({ closeSpy: vi.fn(async (_attemptId: string): Promise<void> => undefined) }));
vi.mock('../electron/application-review-session.js', async (original) => ({
  ...(await original<typeof import('../electron/application-review-session.js')>()),
  closeApplicationReview: closeSpy,
}));

const { createWorkspaceDb } = await import('../electron/workspace/client.js');
const workspace = await import('../electron/workspace/repository.js');
const pipeline = await import('../electron/application-pipeline.js');
const service = await import('../electron/application-critique-service.js');
const store = await import('../electron/workspace/application-critique-store.js');
const { applicationAttempts, applicationCritiques, applicationPostingVerifications } = await import('../electron/workspace/schema.js');
const fx = await import('./application-critique-fixtures.js');
import type { WorkspaceDb } from '../electron/workspace/client.js';
import type { CompanyEvidenceProseFact } from '../electron/company-evidence.js';
import type { CritiqueDeps, CritiqueGenerateResult } from '../electron/application-critique-service.js';

let dir: string;
let db: WorkspaceDb;
let closeDb: () => void;
let companyFacts: CompanyEvidenceProseFact[];
let tailor: ReturnType<typeof vi.fn>;
let letterSelect: ReturnType<typeof vi.fn>;
let cvId: string;

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

function pipelineDeps(): import('../electron/application-pipeline.js').ApplicationPipelineDeps {
  return {
    db,
    storageRoot: join(dir, 'artifacts'),
    queue: {
      enqueue: async () => undefined,
      acquireLease: async () => null,
      release: async () => undefined,
      entryState: async () => 'active',
    },
    generateFieldMap: async () => {
      throw new Error('the form is not part of these tests');
    },
    generateTailoredResume: tailor as never,
    generateCoverLetter: letterSelect as never,
    loadProfile: async () => null,
    loadCompanyEvidence: () => companyFacts,
    now: () => new Date(),
  };
}

function critiqueDeps(generate: CritiqueDeps['generate']): CritiqueDeps {
  return {
    db,
    storageRoot: join(dir, 'artifacts'),
    now: () => new Date(),
    generate,
    loadCompanyEvidence: () => companyFacts,
    provider: 'claude',
  };
}

const reply = (value: unknown): CritiqueGenerateResult => ({ ok: true, text: JSON.stringify(value) });
const scripted = (value: unknown) => vi.fn(async (_prompt: string, _signal: AbortSignal) => reply(value));

/** Prepares one package through the real pipeline and returns the attempt id. */
async function prepare(options: { userLetter?: boolean; checkpoint?: 'ready'; other?: boolean } = {}): Promise<string> {
  if (options.userLetter) {
    workspace.createLetter(db, {
      title: fx.USER_LETTER_TITLE,
      company: fx.COMPANY,
      role: fx.ROLE,
      type: 'cover_letter',
      tone: 'formal',
      length: 'standard',
      status: 'final',
      vacancyKey: 'vac-1',
      cvId,
      body: fx.USER_LETTER_BODY,
    });
  }
  const attempt = workspace.createApplicationAttempt(db, {
    vacancyKey: options.other ? 'vac-2' : 'vac-1',
    canonicalUrl: options.other ? `${fx.APPLY_URL}-other` : fx.APPLY_URL,
    company: options.other ? 'Contoso Logistics' : fx.COMPANY,
    role: fx.ROLE,
    sourceCvId: cvId,
    sourceCvContentHash: sha(workspace.listCvDocuments(db)[0]!.text),
    jdSnapshot: fx.JD,
    jdSnapshotHash: sha(fx.JD),
    jdComplete: true,
    workflowVersion: pipeline.APPLICATION_PIPELINE_WORKFLOW_VERSION,
    checkpoint: 'queued',
  });
  const result = await pipeline.runApplicationAttempt(pipelineDeps(), attempt.id);
  expect(result.outcome).toBe('needs_user');
  expect(result.detail).toContain('Your application documents are ready');
  if (options.checkpoint === 'ready') {
    workspace.updateApplicationAttempt(db, attempt.id, { checkpoint: 'ready', checkpointDetail: '' });
    workspace.recordPreparedApplicationFields(db, attempt.id, { preparedAt: new Date().toISOString(), fields: [] } as never);
    workspace.updateApplicationAttempt(db, attempt.id, { scheduledAutomaticSubmitAt: new Date(Date.now() + 60_000).toISOString() });
  }
  return attempt.id;
}

function setAttempt(attemptId: string, patch: Partial<typeof applicationAttempts.$inferInsert>): void {
  db.update(applicationAttempts).set(patch).where(eq(applicationAttempts.id, attemptId)).run();
}

const artifacts = (attemptId: string) =>
  workspace.listApplicationArtifacts(db, attemptId).map((a) => ({ kind: a.kind, hash: a.contentHash, path: a.storagePath }));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-critique-test-'));
  ({ db, close: closeDb } = createWorkspaceDb(dir));
  html.length = 0;
  closeSpy.mockClear();
  companyFacts = [];
  tailor = vi.fn(async () => ({ ok: true, text: fx.tailoredResumeReply() }));
  letterSelect = vi.fn(async () => ({ ok: true, text: fx.LETTER_SELECTION_REPLY }));
  cvId = workspace.createCvDocument(db, {
    name: 'Main CV',
    kind: 'manual',
    text: 'Jamie Rivera, Senior Engineer at Redwood Software.',
    profile: { title: 'Senior Engineer', location: 'Amsterdam', skills: fx.PROFILE_SKILLS, summary: fx.SOURCE.summary, years: '8', languages: 'English' },
    source: fx.SOURCE,
    isDefault: true,
  }).id;
});

afterEach(() => {
  service.cancelAllCritiques();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('the package the critique reads', () => {
  it('records the exact drafts preparation rendered, tied to the artifacts they produced', async () => {
    const attemptId = await prepare();
    const drafts = store.currentDrafts(db, attemptId);
    expect(drafts.map((d) => [d.kind, d.version, d.origin])).toEqual([
      ['cover_letter', 1, 'prepared'],
      ['cv', 1, 'prepared'],
    ]);
    const files = artifacts(attemptId);
    for (const draft of drafts) expect(files.some((f) => f.hash === draft.artifactHash)).toBe(true);
    const letter = drafts.find((d) => d.kind === 'cover_letter')!;
    expect(letter.content).toMatchObject({ type: 'letter', authored: 'generated', factIds: ['summary', 'experience-1-bullet-1'] });
  });

  it('opening the panel never starts a model session', async () => {
    const attemptId = await prepare();
    const generate = scripted({ findings: [] });
    const view = await service.getCritiqueView(critiqueDeps(generate), attemptId);
    expect(view.canReview).toBe(true);
    expect(view.documents.map((d) => d.kind).sort()).toEqual(['cover_letter', 'cv']);
    expect(view.review).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('a correct package', () => {
  it('can receive no findings, with no forced rewrite and no change to any document', async () => {
    const attemptId = await prepare();
    const before = { files: artifacts(attemptId), drafts: store.listDrafts(db, attemptId).length };
    const generate = scripted({ findings: [], revisions: { cv: null, letter: null } });
    const result = await service.runCritique(critiqueDeps(generate), attemptId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.review).toMatchObject({ noFindings: true, findings: [], proposals: [], refused: [], calls: 1, state: 'current' });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(artifacts(attemptId)).toEqual(before.files);
    expect(store.listDrafts(db, attemptId)).toHaveLength(before.drafts);

    // Looking at it again is a local read: still one model call in total.
    await service.getCritiqueView(critiqueDeps(generate), attemptId);
    await service.getCritiqueView(critiqueDeps(generate), attemptId);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('discards a revision proposed without any accepted finding', async () => {
    const attemptId = await prepare();
    const generate = scripted({ findings: [], revisions: { cv: fx.validCvRevision(), letter: null } });
    const result = await service.runCritique(critiqueDeps(generate), attemptId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.review?.proposals).toEqual([]);
    expect(result.view.review?.refused).toEqual([expect.objectContaining({ kind: 'revision', code: 'insufficient_evidence' })]);
  });

  it('refuses a finding the reviewed CV contradicts: a correct, sourced bullet is not "unsupported"', async () => {
    const attemptId = await prepare();
    const generate = scripted({
      findings: [
        fx.finding({
          kind: 'unsupported_claim',
          summary: 'This number looks invented.',
          documents: ['cv'],
          evidence: [{ source: 'cv_draft', quote: 'Built TypeScript services handling 2 million requests per day.' }],
        }),
      ],
    });
    const result = await service.runCritique(critiqueDeps(generate), attemptId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.review?.findings).toEqual([]);
    expect(result.view.review?.refused).toEqual([expect.objectContaining({ code: 'supported_by_reviewed_evidence' })]);
  });
});

describe('what the critic is allowed to claim', () => {
  it('surfaces a known omitted requirement with the posting quote and the reviewed fact', async () => {
    const attemptId = await prepare();
    const result = await service.runCritique(critiqueDeps(scripted({ findings: [fx.OMISSION_FINDING] })), attemptId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [found] = result.view.review!.findings;
    expect(found).toMatchObject({ kind: 'omitted_requirement', documents: ['cv'], current: true });
    expect(found!.evidence).toEqual([
      { source: 'jd', quote: 'Experience with Kubernetes is required.' },
      { source: 'cv_fact', id: 'experience-2-bullet-1', text: 'Maintained Kubernetes clusters for internal tools.' },
    ]);
    expect(result.view.review!.proposals).toEqual([]);
  });

  it('flags a requirement as a gap without a revision when the reviewed CV holds nothing for it', async () => {
    const attemptId = await prepare();
    const gap = fx.finding({
      kind: 'omitted_requirement',
      summary: 'No reviewed evidence of mentoring beyond one bullet.',
      documents: ['cv'],
      evidence: [{ source: 'jd', quote: 'You will mentor junior engineers.' }, { source: 'gap', note: 'no reviewed mentoring evidence' }],
    });
    const result = await service.runCritique(critiqueDeps(scripted({ findings: [gap] })), attemptId);
    expect(result.ok && result.view.review?.findings[0]?.evidence[1]).toEqual({ source: 'gap', note: 'no reviewed mentoring evidence' });
  });

  it.each([
    ['a quote that is not in the posting', fx.finding({ kind: 'omitted_requirement', documents: ['cv'], evidence: [{ source: 'jd', quote: 'Experience with Terraform is required.' }, { source: 'cv_fact', id: 'experience-2-bullet-1' }] }), 'evidence_not_found'],
    ['a fact id that was never offered', fx.finding({ kind: 'omitted_requirement', documents: ['cv'], evidence: [{ source: 'jd', quote: 'Experience with Kubernetes is required.' }, { source: 'cv_fact', id: 'experience-9-bullet-1' }] }), 'unknown_reference'],
    ['an omission the draft already covers', fx.finding({ kind: 'omitted_requirement', documents: ['cv'], evidence: [{ source: 'jd', quote: 'You will build and operate TypeScript services.' }, { source: 'cv_fact', id: 'experience-1-bullet-1' }] }), 'already_in_draft'],
    ['a vague finding with no evidence the app can check', fx.finding({ kind: 'unclear_wording', evidence: [{ source: 'gap', note: 'feels vague' }] }), 'insufficient_evidence'],
    ['a contradiction quoting only one document', fx.finding({ kind: 'cross_document_inconsistency', documents: ['cv', 'cover_letter'], evidence: [{ source: 'cv_draft', quote: 'Platform engineer focused on reliable TypeScript services.' }] }), 'insufficient_evidence'],
    ['an extra key claiming permission', { ...fx.OMISSION_FINDING, approvedSkill: 'Terraform' }, 'malformed'],
  ])('refuses and shows %s', async (_name, bad, code) => {
    const attemptId = await prepare();
    const result = await service.runCritique(critiqueDeps(scripted({ findings: [bad] })), attemptId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.review?.findings).toEqual([]);
    expect(result.view.review?.refused).toEqual([expect.objectContaining({ code })]);
    expect(result.view.review?.noFindings).toBe(false);
  });

  it('surfaces a cross-document contradiction with a quote from each document', async () => {
    const attemptId = await prepare({ userLetter: true });
    const contradiction = fx.finding({
      kind: 'cross_document_inconsistency',
      summary: 'The letter says five years at Redwood Software; the CV dates the role from 2021.',
      documents: ['cv', 'cover_letter'],
      evidence: [
        { source: 'cv_draft', quote: '2021 - Present' },
        { source: 'cover_letter_draft', quote: 'I spent five years at Redwood Software' },
      ],
    });
    const unsupported = fx.finding({
      kind: 'unsupported_claim',
      summary: 'Leading a team of 40 engineers is not in the reviewed CV.',
      documents: ['cover_letter'],
      evidence: [{ source: 'cover_letter_draft', quote: 'I led a team of 40 engineers' }],
    });
    const result = await service.runCritique(critiqueDeps(scripted({ findings: [contradiction, unsupported] })), attemptId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.review!.findings.map((f) => [f.kind, f.documents])).toEqual([
      ['cross_document_inconsistency', ['cv', 'cover_letter']],
      ['unsupported_claim', ['cover_letter']],
    ]);
    // The letter is the person's own text, so no machine rewrite is ever offered for it.
    const revise = scripted({ findings: [unsupported], revisions: { letter: { kind: 'cover_letter', factIds: ['summary'] } } });
    const again = await service.runCritique(critiqueDeps(revise), attemptId);
    expect(again.ok && again.view.review?.proposals).toEqual([
      expect.objectContaining({ document: 'cover_letter', status: 'refused', reasons: [expect.stringContaining('your own text')] }),
    ]);
  });
});

describe('revisions are checked by the validators drafting uses', () => {
  async function review(revision: unknown) {
    const attemptId = await prepare();
    const result = await service.runCritique(
      critiqueDeps(scripted({ findings: [fx.OMISSION_FINDING], revisions: { cv: revision } })),
      attemptId,
    );
    expect(result.ok).toBe(true);
    return { attemptId, view: result.ok ? result.view : null };
  }
  const withExperience = (mutate: (revision: Record<string, any>) => void) => {
    const revision = fx.validCvRevision() as Record<string, any>;
    mutate(revision);
    return revision;
  };

  it('offers a revision that only uses reviewed text, with the change spelled out', async () => {
    const { view } = await review(fx.validCvRevision());
    const [proposal] = view!.review!.proposals;
    expect(proposal).toMatchObject({ document: 'cv', status: 'pending', acceptable: true, current: true });
    expect(proposal!.changes).toEqual(
      expect.arrayContaining([
        'Adds the role "Software Engineer at Blue Harbor Systems".',
        'Adds the skill "Kubernetes" (it is in your reviewed profile).',
      ]),
    );
    expect(proposal!.preview).toContain('Maintained Kubernetes clusters for internal tools.');
  });

  it.each([
    ['a skill the reviewed profile does not hold', (r: Record<string, any>) => r.skills.push('Terraform'), 'Terraform'],
    ['a metric the reviewed bullet does not state', (r: Record<string, any>) => (r.experience[1].bullets = ['Reduced build times by 60 percent.']), 'rewritten bullet'],
    ['a date the reviewed CV does not state', (r: Record<string, any>) => (r.experience[1].dates = '2015 - 2021'), '2015 - 2021'],
    ['an employer that is not in the reviewed CV', (r: Record<string, any>) => r.experience.push({ company: 'Fabricated Labs', title: 'CTO', dates: '2024', engagement: 'employment', client: '', bullets: ['Invented result.'] }), 'Fabricated Labs'],
    ['a rewritten summary', (r: Record<string, any>) => (r.summary = 'Platform engineer who cut cloud cost by 80 percent.'), 'summary'],
    ['a different contact email', (r: Record<string, any>) => (r.contact.email = 'someone@else.example'), 'someone@else.example'],
  ])('refuses %s and offers nothing', async (_name, mutate, expected) => {
    const { attemptId, view } = await review(withExperience(mutate));
    const [proposal] = view!.review!.proposals;
    expect(proposal).toMatchObject({ document: 'cv', status: 'refused', acceptable: false, preview: null });
    expect(proposal!.reasons.join(' ')).toContain(expected);
    // The refused proposal is not even acceptable by id: nothing is pending.
    const accept = await service.acceptProposal(critiqueDeps(scripted({})), {
      attemptId,
      runId: view!.review!.runId,
      document: 'cv',
      baseContentHash: proposal!.baseContentHash,
    });
    expect(accept.ok).toBe(false);
    expect(store.currentDrafts(db, attemptId).find((d) => d.kind === 'cv')!.version).toBe(1);
  });

  it('refuses a letter revision that selects a fact id which does not exist', async () => {
    const attemptId = await prepare();
    const finding = fx.finding({
      kind: 'unnecessary_detail',
      summary: 'The letter opens with the summary.',
      documents: ['cover_letter'],
      evidence: [{ source: 'cover_letter_draft', quote: 'Platform engineer focused on reliable TypeScript services' }],
    });
    const result = await service.runCritique(
      critiqueDeps(scripted({ findings: [finding], revisions: { letter: { kind: 'cover_letter', factIds: ['experience-1-bullet-1', 'experience-9-bullet-4'] } } })),
      attemptId,
    );
    expect(result.ok && result.view.review?.proposals[0]).toMatchObject({ status: 'refused', reasons: [expect.stringContaining('experience-9-bullet-4')] });
  });
});

describe('accepting a revision', () => {
  it('creates a new CV version, replaces only that artifact, and keeps the old version on record', async () => {
    const attemptId = await prepare();
    const first = await service.runCritique(
      critiqueDeps(scripted({ findings: [fx.OMISSION_FINDING], revisions: { cv: fx.validCvRevision() } })),
      attemptId,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const before = artifacts(attemptId);
    const letterBefore = before.find((f) => f.kind === 'cover_letter_pdf')!;
    const cvBefore = before.find((f) => f.kind === 'cv_pdf')!;
    const proposal = first.view.review!.proposals[0]!;

    const accepted = await service.acceptProposal(critiqueDeps(scripted({})), {
      attemptId,
      runId: first.view.review!.runId,
      document: 'cv',
      baseContentHash: proposal.baseContentHash,
    });
    expect(accepted.ok ? 'ok' : accepted.message).toBe('ok');
    if (!accepted.ok) return;

    const all = store.listDrafts(db, attemptId).filter((d) => d.kind === 'cv');
    expect(all.map((d) => [d.version, d.status, d.origin])).toEqual([
      [1, 'superseded', 'prepared'],
      [2, 'current', 'critique_revision'],
    ]);
    const after = artifacts(attemptId);
    expect(after.find((f) => f.kind === 'cv_pdf')!.hash).not.toBe(cvBefore.hash);
    expect(after.find((f) => f.kind === 'cover_letter_pdf')).toEqual(letterBefore);
    expect(after.find((f) => f.kind === 'cv_pdf')!.hash).toBe(all[1]!.artifactHash);
    expect(accepted.view.review!.proposals[0]).toMatchObject({ status: 'accepted', acceptedVersion: 2, acceptable: false });
    // The finding was about the old CV draft, so it is now marked as describing the earlier version.
    expect(accepted.view.review!.findings[0]).toMatchObject({ current: false, outdatedBecause: ['the CV draft'] });
    expect(accepted.view.review!.state).not.toBe('current');
    expect(accepted.view.documents.find((d) => d.kind === 'cv')).toMatchObject({ version: 2, origin: 'critique_revision' });
  });

  it('invalidates the scheduled send and the open form that held the old file, and only those', async () => {
    const attemptId = await prepare({ checkpoint: 'ready' });
    expect(workspace.getApplicationAttempt(db, attemptId).scheduledAutomaticSubmitAt).not.toBeNull();
    const run = await service.runCritique(critiqueDeps(scripted({ findings: [fx.OMISSION_FINDING], revisions: { cv: fx.validCvRevision() } })), attemptId);
    if (!run.ok) throw new Error('review failed');
    const receiptsBefore = workspace.listApplicationSubmissionReceipts(db, attemptId);
    const accepted = await service.acceptProposal(critiqueDeps(scripted({})), {
      attemptId,
      runId: run.view.review!.runId,
      document: 'cv',
      baseContentHash: run.view.review!.proposals[0]!.baseContentHash,
    });
    expect(accepted.ok).toBe(true);
    const attempt = workspace.getApplicationAttempt(db, attemptId);
    expect(attempt).toMatchObject({ checkpoint: 'needs_user', scheduledAutomaticSubmitAt: null, preparedFields: null, submittedAt: null });
    expect(attempt.checkpointDetail).toContain('Prepare the application again');
    expect(attempt.checkpointDetail).not.toContain('Your application documents are ready');
    expect(closeSpy).toHaveBeenCalledWith(attemptId);
    expect(workspace.listApplicationSubmissionReceipts(db, attemptId)).toEqual(receiptsBefore);
  });

  it('keeps a manual hand-off where it was and says what changed', async () => {
    const attemptId = await prepare();
    const run = await service.runCritique(critiqueDeps(scripted({ findings: [fx.OMISSION_FINDING], revisions: { cv: fx.validCvRevision() } })), attemptId);
    if (!run.ok) throw new Error('review failed');
    await service.acceptProposal(critiqueDeps(scripted({})), {
      attemptId,
      runId: run.view.review!.runId,
      document: 'cv',
      baseContentHash: run.view.review!.proposals[0]!.baseContentHash,
    });
    const attempt = workspace.getApplicationAttempt(db, attemptId);
    expect(attempt.checkpoint).toBe('needs_user');
    expect(attempt.checkpointDetail).toContain('Your application documents are ready');
    expect(attempt.checkpointDetail).toContain('Revised CV accepted from your review (version 2)');
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('survives preparing the form again: the accepted revision is reused, not regenerated', async () => {
    const attemptId = await prepare();
    const run = await service.runCritique(critiqueDeps(scripted({ findings: [fx.OMISSION_FINDING], revisions: { cv: fx.validCvRevision() } })), attemptId);
    if (!run.ok) throw new Error('review failed');
    await service.acceptProposal(critiqueDeps(scripted({})), {
      attemptId,
      runId: run.view.review!.runId,
      document: 'cv',
      baseContentHash: run.view.review!.proposals[0]!.baseContentHash,
    });
    const tailorCalls = tailor.mock.calls.length;
    workspace.restartApplicationTailoring(db, attemptId, 'ai');
    const again = await pipeline.runApplicationAttempt(pipelineDeps(), attemptId);
    expect(again.outcome).toBe('needs_user');
    expect(tailor.mock.calls.length).toBe(tailorCalls);
    const cv = store.currentDrafts(db, attemptId).find((d) => d.kind === 'cv')!;
    expect(cv).toMatchObject({ version: 2, origin: 'critique_revision' });
    expect(artifacts(attemptId).find((f) => f.kind === 'cv_pdf')!.hash).toBe(cv.artifactHash);
    expect(html.join('\n')).toContain('Maintained Kubernetes clusters for internal tools.');
  });

  it('applies a letter revision built only from reviewed facts, and records the company fact it used', async () => {
    companyFacts = [fx.companyFact()];
    const attemptId = await prepare();
    const detail = fx.finding({
      kind: 'unnecessary_detail',
      summary: 'The letter could use the reviewed Kubernetes work instead of the summary line.',
      documents: ['cover_letter'],
      evidence: [{ source: 'cover_letter_draft', quote: 'Platform engineer focused on reliable TypeScript services' }],
    });
    const run = await service.runCritique(
      critiqueDeps(scripted({ findings: [detail], revisions: { letter: { kind: 'cover_letter', factIds: ['experience-2-bullet-1', 'experience-1-bullet-1', 'company-1'] } } })),
      attemptId,
    );
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const [proposal] = run.view.review!.proposals;
    expect(proposal).toMatchObject({ document: 'cover_letter', status: 'pending' });
    expect(proposal!.preview).toContain('Maintained Kubernetes clusters for internal tools.');
    expect(proposal!.preview).toContain('depot network');

    const accepted = await service.acceptProposal(critiqueDeps(scripted({})), {
      attemptId,
      runId: run.view.review!.runId,
      document: 'cover_letter',
      baseContentHash: proposal!.baseContentHash,
    });
    expect(accepted.ok).toBe(true);
    expect(store.currentDrafts(db, attemptId).find((d) => d.kind === 'cover_letter')).toMatchObject({ version: 2, origin: 'critique_revision' });
    expect(store.currentDrafts(db, attemptId).find((d) => d.kind === 'cv')!.version).toBe(1);
  });

  it('applies nothing when the stored suggestion no longer passes the validators at accept time', async () => {
    const attemptId = await prepare();
    const run = await service.runCritique(critiqueDeps(scripted({ findings: [fx.OMISSION_FINDING], revisions: { cv: fx.validCvRevision() } })), attemptId);
    if (!run.ok) throw new Error('review failed');
    const before = artifacts(attemptId);
    // Corrupt the stored proposal so re-validation at accept time refuses it.
    const record = store.getCritique(db, attemptId)!;
    const tampered = record.proposals.map((p) => (p.proposed?.type === 'cv' ? { ...p, proposed: { type: 'cv' as const, resume: { ...p.proposed.resume, skills: [...p.proposed.resume.skills, 'Terraform'] } } } : p));
    store.saveProposals(db, attemptId, tampered, new Date());
    const accept = await service.acceptProposal(critiqueDeps(scripted({})), {
      attemptId,
      runId: run.view.review!.runId,
      document: 'cv',
      baseContentHash: run.view.review!.proposals[0]!.baseContentHash,
    });
    expect(accept).toMatchObject({ ok: false, code: 'not_accepted' });
    expect(artifacts(attemptId)).toEqual(before);
    expect(store.currentDrafts(db, attemptId).find((d) => d.kind === 'cv')!.version).toBe(1);
  });

  it('rejecting a suggestion changes nothing but its status', async () => {
    const attemptId = await prepare();
    const run = await service.runCritique(critiqueDeps(scripted({ findings: [fx.OMISSION_FINDING], revisions: { cv: fx.validCvRevision() } })), attemptId);
    if (!run.ok) throw new Error('review failed');
    const before = artifacts(attemptId);
    const rejected = await service.rejectProposal(critiqueDeps(scripted({})), {
      attemptId,
      runId: run.view.review!.runId,
      document: 'cv',
      baseContentHash: run.view.review!.proposals[0]!.baseContentHash,
    });
    expect(rejected.ok && rejected.view.review!.proposals[0]).toMatchObject({ status: 'rejected', acceptable: false });
    expect(artifacts(attemptId)).toEqual(before);
    expect(store.currentDrafts(db, attemptId).find((d) => d.kind === 'cv')!.version).toBe(1);
  });
});

describe('input versions', () => {
  async function reviewed() {
    const attemptId = await prepare({ userLetter: true });
    const generate = scripted({
      findings: [
        fx.OMISSION_FINDING,
        fx.finding({
          kind: 'unsupported_claim',
          summary: 'Leading a team of 40 engineers is not in the reviewed CV.',
          documents: ['cover_letter'],
          evidence: [{ source: 'cover_letter_draft', quote: 'I led a team of 40 engineers' }],
        }),
      ],
      revisions: { cv: fx.validCvRevision() },
    });
    const run = await service.runCritique(critiqueDeps(generate), attemptId);
    if (!run.ok) throw new Error('review failed');
    return { attemptId, view: run.view };
  }
  const current = async (attemptId: string) => (await service.getCritiqueView(critiqueDeps(scripted({})), attemptId)).review!;

  it('a changed job description outdates the findings and the suggestion that depended on it', async () => {
    const { attemptId } = await reviewed();
    setAttempt(attemptId, { jdSnapshot: `${fx.JD}\nYou will own the on-call rota.`, jdSnapshotHash: sha(`${fx.JD}\nYou will own the on-call rota.`) });
    const review = await current(attemptId);
    expect(review.findings.find((f) => f.kind === 'omitted_requirement')).toMatchObject({ current: false, outdatedBecause: expect.arrayContaining(['the job description']) });
    expect(review.proposals[0]).toMatchObject({ current: false, acceptable: false });
    const accept = await service.acceptProposal(critiqueDeps(scripted({})), { attemptId, runId: review.runId, document: 'cv', baseContentHash: review.proposals[0]!.baseContentHash });
    expect(accept).toMatchObject({ ok: false, code: 'outdated' });
    expect(store.currentDrafts(db, attemptId).find((d) => d.kind === 'cv')!.version).toBe(1);
  });

  it('a changed reviewed CV outdates what was checked against it', async () => {
    const { attemptId } = await reviewed();
    workspace.updateCvDocument(db, cvId, { text: 'Jamie Rivera, Staff Engineer at Redwood Software.' });
    const review = await current(attemptId);
    expect(review.findings.every((f) => !f.current)).toBe(true);
    expect(review.proposals[0]!.acceptable).toBe(false);
    expect(review.outdatedBecause).toContain('your reviewed CV');
  });

  it('changed company facts outdate only what depended on them', async () => {
    const { attemptId } = await reviewed();
    companyFacts = [fx.companyFact()];
    const review = await current(attemptId);
    expect(review.findings.find((f) => f.kind === 'unsupported_claim')).toMatchObject({ current: false, outdatedBecause: ['the company facts'] });
    expect(review.findings.find((f) => f.kind === 'omitted_requirement')!.current).toBe(true);
  });

  it('accepting a CV revision outdates CV findings but leaves a letter-only finding current', async () => {
    const { attemptId, view } = await reviewed();
    const accepted = await service.acceptProposal(critiqueDeps(scripted({})), {
      attemptId,
      runId: view.review!.runId,
      document: 'cv',
      baseContentHash: view.review!.proposals[0]!.baseContentHash,
    });
    expect(accepted.ok).toBe(true);
    const review = await current(attemptId);
    expect(review.findings.find((f) => f.kind === 'omitted_requirement')!.current).toBe(false);
    expect(review.findings.find((f) => f.kind === 'unsupported_claim')!.current).toBe(true);
  });
});

describe('late results and runs that do not finish', () => {
  it('discards a result whose inputs changed while the session was running', async () => {
    const attemptId = await prepare();
    let release!: (result: CritiqueGenerateResult) => void;
    const generate = vi.fn(() => new Promise<CritiqueGenerateResult>((resolve) => (release = resolve)));
    const running = service.runCritique(critiqueDeps(generate), attemptId);
    await vi.waitFor(() => expect(generate).toHaveBeenCalled());
    expect(service.isCritiqueRunning(attemptId)).toBe(true);
    // A second click while one is running is refused, not queued.
    expect(await service.runCritique(critiqueDeps(generate), attemptId)).toMatchObject({ ok: false, code: 'already_running' });
    // The posting changes under the running review.
    setAttempt(attemptId, { jdSnapshot: `${fx.JD}\nNew requirement.`, jdSnapshotHash: sha(`${fx.JD}\nNew requirement.`) });
    release(reply({ findings: [fx.OMISSION_FINDING] }));
    const result = await running;
    expect(result).toMatchObject({ ok: false, code: 'discarded' });
    expect(store.getCritique(db, attemptId)).toMatchObject({ reviewedAt: null, findings: [], lastRunOutcome: 'discarded' });
    expect(service.isCritiqueRunning(attemptId)).toBe(false);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('cancelling stops the session, records it, and leaves every document alone', async () => {
    const attemptId = await prepare();
    const before = { files: artifacts(attemptId), drafts: store.listDrafts(db, attemptId) };
    const generate = vi.fn(
      (_prompt: string, signal: AbortSignal) =>
        new Promise<CritiqueGenerateResult>((resolve) => signal.addEventListener('abort', () => resolve({ ok: false, text: '', error: 'the document generation session was cancelled' }))),
    );
    const running = service.runCritique(critiqueDeps(generate), attemptId);
    await vi.waitFor(() => expect(service.isCritiqueRunning(attemptId)).toBe(true));
    expect(service.cancelCritique(attemptId)).toBe(true);
    expect(await running).toMatchObject({ ok: false, code: 'cancelled', view: { lastRun: { outcome: 'cancelled' } } });
    expect(artifacts(attemptId)).toEqual(before.files);
    expect(store.listDrafts(db, attemptId)).toEqual(before.drafts);
  });

  it.each([
    ['no response after 240s: the session was stopped', 'timed_out'],
    ["You've hit your usage limit. Your limit resets 5pm.", 'provider_limit'],
    ['the agent runtime is not running', 'failed'],
  ])('a failed run (%s) keeps the package and the previous review, and says so', async (error, code) => {
    const attemptId = await prepare();
    const first = await service.runCritique(critiqueDeps(scripted({ findings: [fx.OMISSION_FINDING] })), attemptId);
    expect(first.ok).toBe(true);
    const before = { files: artifacts(attemptId), drafts: store.listDrafts(db, attemptId) };
    const result = await service.runCritique(critiqueDeps(vi.fn(async () => ({ ok: false, text: '', error }))), attemptId);
    expect(result).toMatchObject({ ok: false, code });
    if (result.ok || !result.view) throw new Error('expected a failed view');
    expect(result.view.lastRun).toMatchObject({ outcome: code });
    expect(result.view.review!.findings).toHaveLength(1);
    expect(artifacts(attemptId)).toEqual(before.files);
    expect(store.listDrafts(db, attemptId)).toEqual(before.drafts);
  });

  it.each([
    ['plain text', 'Looks fine to me!'],
    ['a key outside the review format', JSON.stringify({ findings: [], approvedSkills: ['Terraform'] })],
    ['a non-object', '[1,2,3]'],
  ])('unusable output (%s) keeps nothing', async (_name, text) => {
    const attemptId = await prepare();
    const result = await service.runCritique(critiqueDeps(vi.fn(async () => ({ ok: true, text }))), attemptId);
    expect(result).toMatchObject({ ok: false, code: 'invalid_output' });
    expect(store.getCritique(db, attemptId)).toMatchObject({ reviewedAt: null, findings: [], proposals: [] });
  });
});

describe('what the critic is shown', () => {
  it('sends the exact drafts, the posting, reviewed facts and only approved company facts', async () => {
    companyFacts = [fx.companyFact()];
    const attemptId = await prepare();
    const generate = scripted({ findings: [] });
    await service.runCritique(critiqueDeps(generate), attemptId);
    const prompt = generate.mock.calls[0]![0];
    expect(prompt).toContain('Experience with Kubernetes is required.');
    expect(prompt).toContain('Built TypeScript services handling 2 million requests per day.');
    expect(prompt).toContain('Maintained Kubernetes clusters for internal tools.');
    expect(prompt).toContain('"id":"company-1"');
    expect(prompt).toContain('operates a depot network');
    expect(prompt).toContain('Do not use tools, files, or the web');
    expect(prompt).toContain('untrusted data');
  });

  it('shows no company section when no fact is currently adequate', async () => {
    const attemptId = await prepare();
    const generate = scripted({ findings: [] });
    await service.runCritique(critiqueDeps(generate), attemptId);
    expect(generate.mock.calls[0]![0]).not.toContain('COMPANY FACTS');
  });

  it('does not let a failing company-fact store block the review', async () => {
    const attemptId = await prepare();
    const deps = { ...critiqueDeps(scripted({ findings: [] })), loadCompanyEvidence: () => { throw new Error('store down'); } };
    expect(await service.runCritique(deps, attemptId)).toMatchObject({ ok: true });
  });
});

describe('a package that was already sent', () => {
  it('cannot be reviewed or revised, and nothing about it changes', async () => {
    const attemptId = await prepare();
    const run = await service.runCritique(critiqueDeps(scripted({ findings: [fx.OMISSION_FINDING], revisions: { cv: fx.validCvRevision() } })), attemptId);
    if (!run.ok) throw new Error('review failed');
    const sent = new Date().toISOString();
    workspace.updateApplicationAttempt(db, attemptId, { checkpoint: 'submitted', submittedAt: sent, submissionMode: 'manual', completionEvidence: 'receipt_confirmed' });
    workspace.createApplicationSubmissionReceipt(db, { attemptId, outcome: 'submitted', source: 'page_observation', destination: fx.APPLY_URL, evidenceKind: 'confirmation_page', evidenceReference: 'Thanks for applying', observedAt: sent });
    const snapshot = {
      files: artifacts(attemptId),
      drafts: store.listDrafts(db, attemptId),
      receipts: workspace.listApplicationSubmissionReceipts(db, attemptId),
      critique: store.getCritique(db, attemptId),
    };

    const generate = scripted({ findings: [] });
    const view = await service.getCritiqueView(critiqueDeps(generate), attemptId);
    expect(view).toMatchObject({ canReview: false, unavailable: { code: 'sent' } });
    expect(view.review!.proposals[0]!.acceptable).toBe(false);
    expect(await service.runCritique(critiqueDeps(generate), attemptId)).toMatchObject({ ok: false, code: 'not_available' });
    expect(
      await service.acceptProposal(critiqueDeps(generate), { attemptId, runId: run.view.review!.runId, document: 'cv', baseContentHash: run.view.review!.proposals[0]!.baseContentHash }),
    ).toMatchObject({ ok: false, code: 'not_available' });
    expect(generate).not.toHaveBeenCalled();

    // Even a direct store write is refused for a sent attempt.
    expect(store.recordPreparedDraft(db, { attemptId, kind: 'cv', origin: 'prepared', content: snapshot.drafts[0]!.content, artifactHash: 'x', jdHash: 'x', sourceCvHash: 'x', now: new Date() })).toBeNull();
    expect(store.saveRunOutcome(db, { attemptId, runId: 'r', outcome: 'failed', detail: '', provider: 'claude', now: new Date() })).toBe(false);

    expect({
      files: artifacts(attemptId),
      drafts: store.listDrafts(db, attemptId),
      receipts: workspace.listApplicationSubmissionReceipts(db, attemptId),
      critique: store.getCritique(db, attemptId),
    }).toEqual(snapshot);
  });

  it('a revised package is a new version of the same attempt, never presented as the sent one', async () => {
    const attemptId = await prepare();
    const sentBefore = await prepare({ other: true });
    workspace.updateApplicationAttempt(db, sentBefore, { checkpoint: 'submitted', submittedAt: new Date().toISOString(), submissionMode: 'manual' });
    const sentSnapshot = { files: artifacts(sentBefore), drafts: store.listDrafts(db, sentBefore) };
    const run = await service.runCritique(critiqueDeps(scripted({ findings: [fx.OMISSION_FINDING], revisions: { cv: fx.validCvRevision() } })), attemptId);
    if (!run.ok) throw new Error('review failed');
    await service.acceptProposal(critiqueDeps(scripted({})), { attemptId, runId: run.view.review!.runId, document: 'cv', baseContentHash: run.view.review!.proposals[0]!.baseContentHash });
    expect({ files: artifacts(sentBefore), drafts: store.listDrafts(db, sentBefore) }).toEqual(sentSnapshot);
    expect(workspace.getApplicationAttempt(db, attemptId).submittedAt).toBeNull();
  });
});

describe('local data lifecycle', () => {
  it('a data reset removes drafts and critiques and reports them', async () => {
    const attemptId = await prepare();
    await service.runCritique(critiqueDeps(scripted({ findings: [fx.OMISSION_FINDING] })), attemptId);
    expect(db.select().from(applicationCritiques).all()).toHaveLength(1);
    const result = workspace.resetApplicationData(db);
    expect(result.deleted).toMatchObject({ applicationCritiques: 1, applicationDocumentDrafts: 2 });
    expect(store.listDrafts(db, attemptId)).toEqual([]);
    expect(db.select().from(applicationCritiques).all()).toEqual([]);
  });

  it('deleting the attempt removes its drafts and critique with it', async () => {
    const attemptId = await prepare();
    await service.runCritique(critiqueDeps(scripted({ findings: [] })), attemptId);
    workspace.deleteApplicationAttempt(db, attemptId);
    expect(store.listDrafts(db, attemptId)).toEqual([]);
    expect(store.getCritique(db, attemptId)).toBeNull();
  });

  it('a package prepared before drafts were kept says so instead of guessing', async () => {
    const attemptId = await prepare();
    db.run(sql`delete from application_document_drafts`);
    const view = await service.getCritiqueView(critiqueDeps(scripted({})), attemptId);
    expect(view).toMatchObject({ canReview: false, unavailable: { code: 'package_not_recorded' } });
  });
});

describe('boundaries the critique must not cross', () => {
  it('a full review and an accepted revision change no CV, letter, saved job or reviewed profile fact', async () => {
    const attemptId = await prepare();
    const snapshot = () => JSON.stringify({ cvs: workspace.listCvDocuments(db), letters: workspace.listLetters(db), jobs: workspace.listSavedJobs(db) });
    const before = snapshot();
    const run = await service.runCritique(critiqueDeps(scripted({ findings: [fx.OMISSION_FINDING], revisions: { cv: fx.validCvRevision() } })), attemptId);
    if (!run.ok) throw new Error('review failed');
    await service.acceptProposal(critiqueDeps(scripted({})), { attemptId, runId: run.view.review!.runId, document: 'cv', baseContentHash: run.view.review!.proposals[0]!.baseContentHash });
    expect(snapshot()).toBe(before);
    // The revision lives in the draft history of this attempt only.
    expect(store.listDrafts(db, attemptId).filter((d) => d.kind === 'cv')).toHaveLength(2);
  });

  it('the model is called exactly once per explicit review and never by reading, rejecting or accepting', async () => {
    const attemptId = await prepare();
    const generate = scripted({ findings: [fx.OMISSION_FINDING], revisions: { cv: fx.validCvRevision() } });
    const deps = critiqueDeps(generate);
    const run = await service.runCritique(deps, attemptId);
    if (!run.ok) throw new Error('review failed');
    await service.getCritiqueView(deps, attemptId);
    const target = { attemptId, runId: run.view.review!.runId, document: 'cv' as const, baseContentHash: run.view.review!.proposals[0]!.baseContentHash };
    await service.acceptProposal(deps, target);
    await service.rejectProposal(deps, target);
    await service.getCritiqueView(deps, attemptId);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('refuses to review or change a package that a posting finding is holding out of review', async () => {
    const attemptId = await prepare();
    db.insert(applicationPostingVerifications)
      .values({
        attemptId,
        observedAt: new Date(),
        source: 'greenhouse',
        outcome: 'closed',
        result: 'confirmed_closed',
        reason: 'not_found',
        baselineHash: 'x',
        heldCheckpoint: 'needs_user',
        heldCheckpointDetail: 'held',
      })
      .run();
    const generate = scripted({ findings: [] });
    const view = await service.getCritiqueView(critiqueDeps(generate), attemptId);
    expect(view).toMatchObject({ canReview: false, unavailable: { code: 'held' } });
    expect(await service.runCritique(critiqueDeps(generate), attemptId)).toMatchObject({ ok: false, code: 'not_available' });
    expect(generate).not.toHaveBeenCalled();
  });
});
