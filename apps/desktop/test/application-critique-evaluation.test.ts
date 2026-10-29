// @vitest-environment node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * #690 evaluation: the current validated generation/package against that same package plus ONE
 * critique pass, over a synthetic corpus with predeclared defect/clean labels, split into a
 * `construction` set (used while the rules were built) and a `heldout` set (written after the rules were
 * frozen, run once). Run with `OVR_690_EVAL_OUT=<file>` to also write the raw result as JSON.
 *
 * What this measures: what THE APP DOES with each kind of scripted reply, through the real preparation
 * pipeline, the real critique service, the real validators and document acceptance contract, over a real
 * migrated SQLite database. What it does NOT measure: how good any real reviewer model is. The scripted
 * replies are fixed text; nothing here calls a provider, reads private data, or reports token usage.
 * The assertions below are SAFETY invariants (nothing invented reaches a package; a silent reviewer
 * forces no edit; one call per review). No assertion pins a quality ratio.
 */

vi.mock('electron', async () => {
  const { htmlToPdf } = await import('./application-critique-fixtures.js');
  return {
    BrowserWindow: class {
      #html = '';
      webContents = { printToPDF: async (): Promise<Buffer> => Buffer.from(htmlToPdf(this.#html)) };
      async loadURL(url: string): Promise<void> {
        this.#html = decodeURIComponent(url.replace(/^data:text\/html;charset=utf-8,/u, ''));
      }
      destroy(): void {}
    },
  };
});
vi.mock('../electron/application-view.js', () => ({ createApplicationView: vi.fn() }));
vi.setConfig({ testTimeout: 120_000 });

const { createWorkspaceDb } = await import('../electron/workspace/client.js');
const workspace = await import('../electron/workspace/repository.js');
const pipeline = await import('../electron/application-pipeline.js');
const service = await import('../electron/application-critique-service.js');
const store = await import('../electron/workspace/application-critique-store.js');
const { renderResumePlainText } = await import('../electron/resume-text.js');
const { EVAL_CASES, resumeFor, toSource } = await import('./application-critique-eval-cases.js');
import type { WorkspaceDb } from '../electron/workspace/client.js';
import type { EvalCase } from './application-critique-eval-cases.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

let dir: string;
let db: WorkspaceDb;
let closeDb: () => void;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-critique-eval-'));
  ({ db, close: closeDb } = createWorkspaceDb(dir));
});
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

interface CaseResult {
  id: string;
  split: string;
  behaviour: string;
  labelledDefects: number;
  armA: { draftingModelCalls: number; documents: string[]; defectsLeftForThePerson: number };
  armB: {
    critiqueModelCalls: number;
    tokenUsage: 'unavailable';
    findingsShown: Array<{ summary: string; kind: string; target: string | null; truePositive: boolean }>;
    findingsRefused: Array<{ summary: string; code: string; target: string | null; intendedAsNoise: boolean }>;
    proposals: Array<{ document: string; status: string; reasons: string[]; inventedElementsAttempted: string[] }>;
    proposalsAccepted: number;
    defectsSurfaced: string[];
    defectsCorrectedByAcceptedProposal: string[];
    defectsLeftForThePerson: string[];
    inventedElementsAttempted: string[];
    inventedElementsInFinalPackage: string[];
    factualViolationsInFinalPackage: string[];
    finalCvVersion: number;
    forcedEditsOnCleanPackage: number;
  };
  operationProxy: { armA: number; armB: number };
}

/** An oracle written independently of the validators: plain set membership against the reviewed text. */
type ResumeLike = {
  contact: Record<string, string>;
  summary: string;
  skills: string[];
  experience: Array<{ company: string; title: string; dates: string; bullets: string[] }>;
    education: Array<{ institution: string; credential: string; dates: string }>;
};

function factualViolations(c: EvalCase, r: ResumeLike): string[] {
  const out: string[] = [];
  const known = new Set(c.candidate.skills.map((s) => s.toLowerCase()));
  for (const skill of r.skills) if (!known.has(skill.toLowerCase())) out.push(`skill "${skill}"`);
  if (r.summary !== c.candidate.summary) out.push('summary changed');
  for (const field of ['name', 'title', 'location', 'email'] as const) {
    if (r.contact[field] !== (c.candidate as unknown as Record<string, string>)[field]) out.push(`contact ${field}`);
  }
  for (const entry of r.experience) {
    const source = c.candidate.experience.find((e) => e.company === entry.company && e.title === entry.title);
    if (!source) {
      out.push(`employer "${entry.company}"`);
      continue;
    }
    if (source.dates !== entry.dates) out.push(`dates "${entry.dates}"`);
    for (const bullet of entry.bullets) if (!source.bullets.includes(bullet)) out.push(`bullet "${bullet}"`);
  }
  for (const entry of r.education) {
    if (!c.candidate.education.some((e) => e.institution === entry.institution && e.credential === entry.credential && e.dates === entry.dates)) out.push(`education "${entry.credential}"`);
  }
  return out;
}

async function runCase(c: EvalCase): Promise<CaseResult> {
  const text = `${c.candidate.name}. ${c.candidate.summary}`;
  const cv = workspace.createCvDocument(db, {
    name: `${c.candidate.name} CV`,
    kind: 'manual',
    text,
    profile: { title: c.candidate.title, location: c.candidate.location, skills: c.candidate.skills, summary: c.candidate.summary, years: '8', languages: 'English' },
    source: toSource(c.candidate),
    isDefault: false,
  });
  const vacancyKey = `eval-${c.id}`;
  if (c.drafting.letter.mode === 'user') {
    workspace.createLetter(db, {
      title: 'Cover Letter', company: c.company, role: c.role, type: 'cover_letter', tone: 'formal', length: 'standard',
      status: 'final', vacancyKey, cvId: cv.id, body: c.drafting.letter.body,
    });
  }
  const attempt = workspace.createApplicationAttempt(db, {
    vacancyKey, canonicalUrl: `https://jobs.example/apply/${c.id}`, company: c.company, role: c.role, sourceCvId: cv.id,
    sourceCvContentHash: sha(text), jdSnapshot: c.jd, jdSnapshotHash: sha(c.jd), jdComplete: true,
    workflowVersion: pipeline.APPLICATION_PIPELINE_WORKFLOW_VERSION, checkpoint: 'queued',
  });

  // ---- Arm A: the current validated generation, exactly as the pipeline runs it.
  let draftingCalls = 0;
  await pipeline.runApplicationAttempt(
    {
      db,
      storageRoot: join(dir, 'artifacts'),
      queue: { enqueue: async () => undefined, acquireLease: async () => null, release: async () => undefined, entryState: async () => 'active' },
      generateFieldMap: async () => { throw new Error('no form'); },
      generateTailoredResume: async () => {
        draftingCalls += 1;
        return { ok: true, text: JSON.stringify(resumeFor(c.candidate, c.drafting.experience, c.drafting.skills)) };
      },
      generateCoverLetter: async () => {
        draftingCalls += 1;
        return { ok: true, text: JSON.stringify({ factIds: c.drafting.letter.mode === 'generated' ? c.drafting.letter.factIds : [] }) };
      },
      loadProfile: async () => null,
      now: () => new Date(),
    },
    attempt.id,
  );
  const before = store.currentDrafts(db, attempt.id);
  expect(before.map((d) => d.kind).sort()).toEqual(['cover_letter', 'cv']);

  // ---- Arm B: ONE critique pass over that same package.
  let critiqueCalls = 0;
  const deps = {
    db,
    storageRoot: join(dir, 'artifacts'),
    now: () => new Date(),
    generate: async () => {
      critiqueCalls += 1;
      return { ok: true, text: JSON.stringify(c.critic.reply) };
    },
    loadCompanyEvidence: () => [],
    provider: 'claude',
  };
  const run = await service.runCritique(deps, attempt.id);
  if (!run.ok) throw new Error(`critique run failed for ${c.id}: ${run.message}`);
  const review = run.view.review!;

  const targetBySummary = new Map(c.critic.reply.findings.map((f, i) => [String(f.summary), c.critic.findingTargets[i] ?? null] as const));
  const targetFor = (summary: string): string | null => {
    for (const [full, target] of targetBySummary) if (full.startsWith(summary.slice(0, 120)) || summary.startsWith(full.slice(0, 120))) return target;
    return null;
  };
  const shown = review.findings.map((f) => ({ summary: f.summary, kind: f.kind, target: targetFor(f.summary), truePositive: targetFor(f.summary) !== null }));
  const refused = review.refused
    .filter((r) => r.kind !== 'revision')
    .map((r) => ({ summary: r.summary, code: r.code, target: targetFor(r.summary), intendedAsNoise: targetFor(r.summary) === null }));
  const proposals = review.proposals.map((p) => ({
    document: p.document,
    status: p.status,
    reasons: p.reasons,
    inventedElementsAttempted: c.critic.inventedElements.filter((el) => c.critic.reply.revisions && JSON.stringify(c.critic.reply.revisions).includes(el)),
  }));
  // The revision proposed without a justifying finding is reported as a refused revision entry.
  const revisionsDiscarded = review.refused.filter((r) => r.kind === 'revision').length;

  // A person who reads each offered suggestion and agrees with every one the app offered.
  let accepted = 0;
  for (const proposal of review.proposals.filter((p) => p.acceptable)) {
    const result = await service.acceptProposal(deps, { attemptId: attempt.id, runId: review.runId, document: proposal.document, baseContentHash: proposal.baseContentHash });
    if (result.ok) accepted += 1;
  }

  const finalCv = store.currentDrafts(db, attempt.id).find((d) => d.kind === 'cv')!;
  const finalLetter = store.currentDrafts(db, attempt.id).find((d) => d.kind === 'cover_letter')!;
  const finalResume = finalCv.content.type === 'cv' ? finalCv.content.resume : null;
  const finalCvText = finalResume ? renderResumePlainText(finalResume) : '';
  const finalAll = `${finalCvText}\n${finalLetter.content.type === 'letter' ? finalLetter.content.body : ''}`;

  const surfaced = c.labels.filter((l) => shown.some((s) => s.target === l.id)).map((l) => l.id);
  const beforeDraft = before.find((d) => d.kind === 'cv')!.content;
  const beforeCvText = beforeDraft.type === 'cv' ? renderResumePlainText(beforeDraft.resume) : '';
  const corrected = c.labels
    .filter(
      (l) =>
        l.autoCorrectable &&
        ((l.cvContains !== undefined && finalCvText.includes(l.cvContains) && !beforeCvText.includes(l.cvContains)) ||
          (l.cvOmits !== undefined && !finalCvText.includes(l.cvOmits) && beforeCvText.includes(l.cvOmits))),
    )
    .map((l) => l.id);
  const left = c.labels.map((l) => l.id).filter((id) => !corrected.includes(id));
  const violations = finalResume ? factualViolations(c, finalResume as unknown as ResumeLike) : ['no final CV'];
  const survivors = c.critic.inventedElements.filter((el) => finalAll.includes(el));

  // Documented operation-count proxy (NOT time): each shown finding is read once, each applied
  // suggestion costs one decision, each defect still left costs one manual edit. Arm A has no review,
  // so every labelled defect is one manual find-and-fix.
  const armBOps = shown.length + accepted + left.length;
  return {
    id: c.id,
    split: c.split,
    behaviour: c.critic.behaviour,
    labelledDefects: c.labels.length,
    armA: { draftingModelCalls: draftingCalls, documents: before.map((d) => `${d.kind} v${d.version}`), defectsLeftForThePerson: c.labels.length },
    armB: {
      critiqueModelCalls: critiqueCalls,
      tokenUsage: 'unavailable',
      findingsShown: shown,
      findingsRefused: refused,
      proposals,
      proposalsAccepted: accepted,
      defectsSurfaced: surfaced,
      defectsCorrectedByAcceptedProposal: corrected,
      defectsLeftForThePerson: left,
      inventedElementsAttempted: c.critic.inventedElements,
      inventedElementsInFinalPackage: survivors,
      factualViolationsInFinalPackage: violations,
      finalCvVersion: finalCv.version,
      forcedEditsOnCleanPackage: c.labels.length === 0 ? accepted + revisionsDiscarded * 0 : 0,
    },
    operationProxy: { armA: c.labels.length, armB: armBOps },
  };
}

function aggregate(rows: CaseResult[]) {
  const sum = (f: (r: CaseResult) => number) => rows.reduce((total, r) => total + f(r), 0);
  const refusedCodes: Record<string, number> = {};
  for (const r of rows) for (const f of r.armB.findingsRefused) refusedCodes[f.code] = (refusedCodes[f.code] ?? 0) + 1;
  const proposalStatus: Record<string, number> = {};
  for (const r of rows) for (const p of r.armB.proposals) proposalStatus[p.status] = (proposalStatus[p.status] ?? 0) + 1;
  return {
    cases: rows.length,
    cleanCases: rows.filter((r) => r.labelledDefects === 0).length,
    labelledDefects: sum((r) => r.labelledDefects),
    armA: {
      draftingModelCalls: sum((r) => r.armA.draftingModelCalls),
      defectsLeftForThePerson: sum((r) => r.armA.defectsLeftForThePerson),
      acceptedCorrections: 0,
      newFactualErrorsIntroduced: 0,
    },
    armB: {
      critiqueModelCalls: sum((r) => r.armB.critiqueModelCalls),
      tokenUsage: 'unavailable (the hermetic transport reports none)',
      defectsSurfaced: sum((r) => r.armB.defectsSurfaced.length),
      acceptedCorrections: sum((r) => r.armB.defectsCorrectedByAcceptedProposal.length),
      defectsLeftForThePerson: sum((r) => r.armB.defectsLeftForThePerson.length),
      findingsShown: sum((r) => r.armB.findingsShown.length),
      findingsShownThatTargetALabelledDefect: sum((r) => r.armB.findingsShown.filter((f) => f.truePositive).length),
      findingsShownThatAreNoise: sum((r) => r.armB.findingsShown.filter((f) => !f.truePositive).length),
      findingsRefused: sum((r) => r.armB.findingsRefused.length),
      findingsRefusedByCode: refusedCodes,
      refusedFindingsThatWereAimedAtALabelledDefect: sum((r) => r.armB.findingsRefused.filter((f) => !f.intendedAsNoise).length),
      proposalsByStatus: proposalStatus,
      proposalsAccepted: sum((r) => r.armB.proposalsAccepted),
      inventedElementsAttempted: sum((r) => r.armB.inventedElementsAttempted.length),
      inventedElementsInFinalPackages: sum((r) => r.armB.inventedElementsInFinalPackage.length),
      newFactualErrorsIntroducedInFinalPackages: sum((r) => r.armB.factualViolationsInFinalPackage.length),
      forcedEditsOnCleanPackages: sum((r) => r.armB.forcedEditsOnCleanPackage),
      cleanPackagesWithAnyFindingShown: rows.filter((r) => r.labelledDefects === 0 && r.armB.findingsShown.length > 0).length,
    },
    operationProxy: { armA: sum((r) => r.operationProxy.armA), armB: sum((r) => r.operationProxy.armB) },
  };
}

describe('independent critique evaluation (synthetic, hermetic)', () => {
  it('runs every case through the real pipeline and service and holds the safety invariants', async () => {
    const rows: CaseResult[] = [];
    for (const c of EVAL_CASES) rows.push(await runCase(c));

    for (const row of rows) {
      // One critique call per review, drafting untouched, nothing invented in any final package.
      expect(row.armB.critiqueModelCalls, row.id).toBe(1);
      expect(row.armB.inventedElementsInFinalPackage, row.id).toEqual([]);
      expect(row.armB.factualViolationsInFinalPackage, row.id).toEqual([]);
      // A package with no labelled defect never has an edit forced on it.
      if (row.labelledDefects === 0) expect(row.armB.forcedEditsOnCleanPackage, row.id).toBe(0);
    }
    // The scripted silent reviewer produces a truthful "nothing found" with no proposal at all.
    for (const row of rows.filter((r) => r.behaviour === 'silent')) {
      expect(row.armB.findingsShown).toEqual([]);
      expect(row.armB.proposals).toEqual([]);
      expect(row.armB.finalCvVersion).toBe(1);
    }

    const bySplit = {
      construction: aggregate(rows.filter((r) => r.split === 'construction')),
      heldout: aggregate(rows.filter((r) => r.split === 'heldout')),
    };
    const out = process.env.OVR_690_EVAL_OUT;
    if (out) {
      const head = (() => {
        try {
          return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        } catch {
          return 'unknown';
        }
      })();
      writeFileSync(
        out,
        `${JSON.stringify(
          {
            issue: 690,
            kind: 'synthetic hermetic evaluation: current validated generation vs the same package plus ONE critique pass',
            generatedAtCommit: head,
            command: 'OVR_690_EVAL_OUT=<file> pnpm --filter @agent-dock/desktop exec vitest run test/application-critique-evaluation.test.ts',
            method: {
              arms: {
                A: 'The package exactly as the production preparation pipeline produces it (drafting validators, document acceptance). Nothing reviews it, so every labelled defect is left for the person.',
                B: 'The same package plus one critique pass through the production critique service; the person then accepts every suggestion the app offered (the most favourable reading for the critique arm).',
              },
              splits: 'construction = the candidate and wording used while the verification rules were built (same as the unit tests). heldout = different candidates, postings and defect wording, written after the rules were frozen and run once.',
              labels: 'Predeclared in test/application-critique-eval-cases.ts before any run: each case lists its real defects, what each scripted finding is aimed at (null = noise) and which invented facts a scripted revision attempts. Nothing is derived from the output.',
              reviewer: 'A fixed scripted reply per case standing in for a model. Behaviours (faithful, silent, overeager, inventive, vague) describe the reply, not any real model. Results are about what the app does with each kind of reply.',
              acceptedCorrection: 'A labelled, auto-correctable defect is counted corrected only if the final CV text (after the person accepts every offered suggestion) contains the missing reviewed text or omits the unnecessary text, and the original CV did not already satisfy it.',
              newFactualErrors: 'Measured on every final package by an oracle written independently of the validators: plain set membership of skills, employers, dates, bullets, summary, education and contact against the reviewed source, plus a search for each declared invented element.',
              operationProxy: 'Scripted operation COUNT, not time: arm A = one manual find-and-fix per labelled defect; arm B = one read per finding shown + one decision per suggestion applied + one manual edit per defect left. The weights are all 1 and are an assumption, not a measurement.',
            },
            humanEditingTime: {
              status: 'unavailable',
              reason: 'No human participants were run. No human time is estimated or reported anywhere in this file.',
              manualProtocol: [
                'Recruit editors who have not seen the cases; give each the same synthetic package and posting, once without and once with the review panel, order counterbalanced.',
                'Task: produce a package with no unsupported claim, no cross-document contradiction and every posting requirement the reviewed CV can meet covered.',
                'Record wall-clock time to a package the experimenter accepts against the predeclared labels, the number of accepted suggestions, rejected suggestions and manual edits, and any factual error left in the final package.',
                'Report medians with the sample size; do not report a ratio without it. Use only synthetic CVs.',
              ],
            },
            fixtureCorrections: [
              {
                case: 'H8-omission-rewritten',
                what: 'The first run showed the draft already contained the "Cut invoice generation time" bullet that the label said was missing, so the app correctly refused the finding as already_in_draft. The fixture was wrong, not the rule: the draft was changed to omit that bullet (bullets 0 and 2 instead of 0 and 1) and the case was run again. No verification rule, validator or other case was changed after the held-out run. The held-out set was therefore exposed to this one correction.',
              },
            ],
            tokenUsage: 'unavailable: the hermetic transport reports no token counts, so none are recorded or estimated',
            realProviderResults: 'none: no live provider, private data or paid service was used',
            bySplit,
            cases: rows,
            fixtures: EVAL_CASES.map((c) => ({
              id: c.id,
              split: c.split,
              note: c.note,
              company: c.company,
              role: c.role,
              jd: c.jd,
              candidate: c.candidate,
              drafting: c.drafting,
              labels: c.labels,
              critic: c.critic,
            })),
            limits: [
              'Synthetic data and scripted replies: the numbers describe the app’s checks, not how often a real reviewer finds a real defect or invents a fact.',
              'The held-out set is small (9 cases) and its reviewer behaviours were chosen by the author; a real distribution of behaviours would change every ratio.',
              'The held-out cases are not blind: they were written by the same author as the rules, after freezing the rules, and run once, apart from the one fixture correction listed under fixtureCorrections.',
              'The independent oracle is plain string and set membership; it cannot see a claim that is fluent, new and not a copy of anything.',
              'The operation-count proxy weights every operation equally and is not editing time.',
              'Nothing here estimates interview, ATS or hiring outcomes.',
            ],
          },
          null,
          2,
        )}\n`,
      );
    }
    expect(bySplit.heldout.cases).toBeGreaterThan(0);
    expect(bySplit.heldout.armB.newFactualErrorsIntroducedInFinalPackages).toBe(0);
  });
});
