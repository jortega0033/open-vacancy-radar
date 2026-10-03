// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorkspaceDb, type WorkspaceDb } from '../electron/workspace/client.js';
import { CV_RENDER_CONTRACT_VERSION } from '../electron/workspace/cv-evidence-schema.js';
import { EMPTY_CV_SOURCE, stableCvSourceJson, type CvSourceDocument } from '../electron/workspace/cv-source-schema.js';
import * as workspace from '../electron/workspace/repository.js';
import { cvEvidenceOverlays } from '../electron/workspace/schema.js';
import { makeFact, makeVariant } from './fixtures/cv-evidence.js';
import { FULL_JD } from './fixtures/job-description.js';

/**
 * Composition and approval (#419 step 8) against a real migrated database: the project selection
 * approval, what a change to the CV does to an approved case, the explicit rebase, and how a case
 * saved before these fields existed behaves.
 */
let dir: string;
let db: WorkspaceDb;
let close: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ovr-composition-'));
  ({ db, close } = createWorkspaceDb(dir));
});

afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

const SOURCE: CvSourceDocument = {
  ...EMPTY_CV_SOURCE,
  summary: 'Original summary.',
  experience: [
    { id: 'experience-1', company: 'Redwood Software', title: 'Frontend Engineer', dates: '2021 - Present', engagement: 'employment', client: '', bullets: ['Built things.'] },
    { id: 'experience-2', company: 'Redwood Software', title: 'Frontend Engineer', dates: '2018 - 2021', engagement: 'employment', client: '', bullets: ['Built older things.'] },
  ],
  projects: [
    { id: 'project-1', name: 'Toolkit', role: '', dates: '', organization: '', description: 'Toolkit text.', technologies: [], links: [], pinned: true },
    { id: 'project-2', name: 'Dashboard', role: '', dates: '', organization: '', description: 'Dashboard text.', technologies: [], links: [], pinned: false },
    { id: 'project-3', name: 'Parser', role: '', dates: '', organization: '', description: 'Parser text.', technologies: [], links: [], pinned: false },
  ],
  maxProjects: 2,
};

const COVERED = { requirementCoverage: { status: 'complete' as const, batches: 1 } };
const hashOf = (source: CvSourceDocument) => createHash('sha256').update(stableCvSourceJson(source)).digest('hex');

function newCase(source: CvSourceDocument = SOURCE) {
  const cv = workspace.createCvDocument(db, {
    name: 'Resume',
    kind: 'manual',
    profile: { title: '', years: '', location: '', languages: '', skills: ['TypeScript'], summary: '', auth: '' },
    source,
  });
  const overlay = workspace.createCvEvidenceOverlay(db, {
    cvId: cv.id,
    vacancyKey: 'url:https://jobs.example.invalid/1',
    sourceCvContentHash: hashOf(cv.source!),
    jdSnapshot: FULL_JD,
    jdSnapshotHash: 'b'.repeat(64),
  });
  return { cv, overlay };
}

const read = (id: string) => workspace.getCvEvidenceOverlayById(db, id);
const update = (id: string, patch: Parameters<typeof workspace.updateCvEvidenceOverlay>[2]) => workspace.updateCvEvidenceOverlay(db, id, patch);
const approveSelection = (id: string) => workspace.approveCvProjectSelection(db, id, read(id).caseRevision);
const approve = (id: string) => workspace.approveCvEvidenceOverlay(db, id, read(id).caseRevision);
const rebase = (id: string) => workspace.rebaseCvEvidenceOverlay(db, id, read(id).caseRevision);

/** A case with facts and approved wording on both roles, ready for selection and whole-CV approval. */
function readyCase() {
  const made = newCase();
  update(made.overlay.id, {
    facts: [
      makeFact({ factId: 'fact-1', parentId: 'experience-1', activity: 'Built the booking screens', mechanism: 'Angular' }),
      makeFact({ factId: 'fact-2', parentId: 'experience-2', activity: 'Built the reporting screens', mechanism: 'React' }),
    ],
    ...COVERED,
  });
  update(made.overlay.id, {
    wordingVariants: [
      makeVariant({ variantId: 'v-1', targetField: 'experience_bullet', parentId: 'experience-1', factIds: ['fact-1'], text: 'Built the booking screens, using Angular', approvedAt: '', sourceRevision: '' }),
      makeVariant({ variantId: 'v-2', targetField: 'experience_bullet', parentId: 'experience-2', factIds: ['fact-2'], text: 'Built the reporting screens, using React', approvedAt: '', sourceRevision: '' }),
      makeVariant({ variantId: 'v-sum', targetField: 'summary', factIds: ['fact-1', 'fact-2'], text: 'Frontend engineer who builds booking and reporting screens.', approvedAt: '', sourceRevision: '' }),
    ],
  });
  return made;
}

describe('project selection approval (#419 step 8)', () => {
  it('stores the pinned projects plus what the limit allows, computed in the main process', () => {
    const { overlay } = newCase();
    const approved = approveSelection(overlay.id);
    expect(approved.projectSelection).toMatchObject({ projectIds: ['project-1', 'project-2'], maxProjects: 2 });
    expect(approved.projectSelection?.approvedAt).not.toBe('');
  });

  it('is required before whole-CV approval when the source has projects', () => {
    const { overlay } = readyCase();
    expect(() => approve(overlay.id)).toThrow(/projects for this CV have not been approved/);
    approveSelection(overlay.id);
    const approved = approve(overlay.id);
    expect(approved.state).toBe('candidate_approved');
    expect(approved.approvedResumeSnapshot?.resume.projects.map((project) => project.name)).toEqual(['Toolkit', 'Dashboard']);
  });

  it('records the render contract version with the approved snapshot', () => {
    const { overlay } = readyCase();
    approveSelection(overlay.id);
    expect(approve(overlay.id).approvedResumeSnapshot?.renderContractVersion).toBe(CV_RENDER_CONTRACT_VERSION);
  });

  it('is not required for a source with no projects', () => {
    const { overlay } = newCase({ ...SOURCE, projects: [] });
    update(overlay.id, COVERED);
    expect(approve(overlay.id).state).toBe('candidate_approved');
  });

  it('a changed pin or limit makes the stored selection stale and moves an approved case back to a draft', () => {
    const { cv, overlay } = readyCase();
    approveSelection(overlay.id);
    expect(approve(overlay.id).state).toBe('candidate_approved');

    workspace.updateCvDocument(db, cv.id, { source: { ...SOURCE, maxProjects: 1 } });
    expect(read(overlay.id).state).toBe('draft');
    // The case must first be rebased onto the changed CV (the limit is part of it).
    expect(() => approve(overlay.id)).toThrow(/rebase the case first/);
    rebase(overlay.id);
    expect(read(overlay.id).projectSelection).toBeNull();
    expect(() => approve(overlay.id)).toThrow(/projects for this CV have not been approved/);
    expect(approveSelection(overlay.id).projectSelection?.projectIds).toEqual(['project-1']);
    expect(approve(overlay.id).approvedResumeSnapshot?.resume.projects.map((project) => project.name)).toEqual(['Toolkit']);
  });

  it('approving a different selection than the stored one invalidates an approved case', () => {
    const { overlay } = readyCase();
    approveSelection(overlay.id);
    approve(overlay.id);
    // Same selection again changes nothing.
    expect(approveSelection(overlay.id).state).toBe('candidate_approved');
    // Force a different stored selection, as a stale one would be, then approve the current one.
    db.update(cvEvidenceOverlays)
      .set({ projectSelection: { projectIds: ['project-3'], maxProjects: 0, approvedAt: '2026-10-01T00:00:00.000Z' } })
      .where(eq(cvEvidenceOverlays.id, overlay.id))
      .run();
    expect(approveSelection(overlay.id).state).toBe('draft');
  });

  it('refuses a stale case revision', () => {
    const { overlay } = newCase();
    expect(() => workspace.approveCvProjectSelection(db, overlay.id, '999')).toThrow(workspace.CvEvidenceOverlayRevisionConflictError);
  });
});

describe('changes to the CV after a case was started (#419)', () => {
  function approvedReadyCase() {
    const made = readyCase();
    approveSelection(made.overlay.id);
    approve(made.overlay.id);
    return made;
  }

  it('captures what the case was started from', () => {
    const { overlay } = newCase();
    expect(overlay.sourceBaseline?.source?.summary).toBe('Original summary.');
    expect(overlay.sourceBaseline?.skills).toEqual(['TypeScript']);
    expect(overlay.sourceBaseline?.inputsDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a change to the profile skills invalidates approval, shows a diff, and blocks approval until rebased', () => {
    const { cv, overlay } = approvedReadyCase();
    expect(workspace.previewCvEvidenceRebase(db, overlay.id).inputsChanged).toBe(false);

    workspace.updateCvDocument(db, cv.id, { profile: { skills: ['TypeScript', 'Terraform'] } });

    expect(read(overlay.id).state).toBe('draft');
    const plan = workspace.previewCvEvidenceRebase(db, overlay.id);
    expect(plan.inputsChanged).toBe(true);
    expect(plan.changes).toEqual([{ area: 'Skills', detail: 'Added: Terraform.' }]);
    expect(() => approve(overlay.id)).toThrow(/rebase the case first/);

    rebase(overlay.id);
    expect(workspace.previewCvEvidenceRebase(db, overlay.id).inputsChanged).toBe(false);
    approveSelection(overlay.id);
    const again = approve(overlay.id);
    expect(again.state).toBe('candidate_approved');
    expect(again.approvedResumeSnapshot?.resume.skills).toEqual(['TypeScript', 'Terraform']);
  });

  it('a change to the profile summary or the CV text also needs a rebase', () => {
    const { cv, overlay } = approvedReadyCase();
    workspace.updateCvDocument(db, cv.id, { text: 'New extracted text.' });
    expect(workspace.previewCvEvidenceRebase(db, overlay.id).changes).toEqual([{ area: 'CV text', detail: 'The extracted CV text changed.' }]);
    expect(read(overlay.id).state).toBe('draft');
  });

  it('a change that does not touch the CV content, such as a rename, leaves the approval alone', () => {
    const { cv, overlay } = approvedReadyCase();
    workspace.updateCvDocument(db, cv.id, { name: 'Renamed resume' });
    expect(read(overlay.id).state).toBe('candidate_approved');
    expect(workspace.previewCvEvidenceRebase(db, overlay.id).inputsChanged).toBe(false);
  });

  it('a rebase keeps facts and still-valid wording and drops wording whose role or source text changed', () => {
    const { cv, overlay } = approvedReadyCase();
    expect(read(overlay.id).wordingVariants.every((variant) => variant.status === 'candidate_approved')).toBe(true);

    // Role 2 is removed, the summary is rewritten, and role 1 only gets another bullet.
    const edited: CvSourceDocument = {
      ...SOURCE,
      summary: 'A rewritten summary.',
      experience: [{ ...SOURCE.experience[0]!, bullets: ['Built things.', 'Added a bullet.'] }],
    };
    workspace.updateCvDocument(db, cv.id, { source: edited });

    const plan = workspace.previewCvEvidenceRebase(db, overlay.id);
    expect(plan.keptVariantIds).toEqual(['v-1']);
    expect(plan.droppedVariants.map((dropped) => [dropped.variantId, dropped.reason])).toEqual([
      ['v-2', 'its role is no longer in your CV'],
      ['v-sum', 'the summary it replaces changed'],
    ]);
    expect(plan.orphanedFactIds).toEqual(['fact-2']);

    const rebased = rebase(overlay.id);
    const byId = new Map(rebased.wordingVariants.map((variant) => [variant.variantId, variant]));
    expect(byId.get('v-1')?.status).toBe('candidate_approved');
    expect(byId.get('v-1')?.sourceRevision).toBe(rebased.sourceCvContentHash);
    expect(byId.get('v-2')?.status).toBe('superseded');
    expect(byId.get('v-sum')?.status).toBe('superseded');
    expect(rebased.facts.map((fact) => fact.factId).sort()).toEqual(['fact-1', 'fact-2']);
    expect(rebased.state).toBe('draft');
    expect(rebased.projectSelection).toBeNull();

    approveSelection(overlay.id);
    const final = approve(overlay.id);
    const resume = final.approvedResumeSnapshot?.resume;
    expect(resume?.experience).toHaveLength(1);
    expect(resume?.experience[0]?.bullets).toEqual(['Built things.', 'Added a bullet.', 'Built the booking screens, using Angular']);
    expect(resume?.summary).toBe('A rewritten summary.');
    expect(JSON.stringify(resume)).not.toContain('reporting screens');
  });

  it('a rebase clears the links of a requirement that pointed at a vanished role and asks for its review again', () => {
    const { cv, overlay } = readyCase();
    update(overlay.id, {
      requirements: [
        {
          requirementId: 'r-1',
          text: 'TypeScript',
          jdAnchor: FULL_JD.slice(0, 20),
          classification: 'required',
          evidenceClass: 'direct',
          anchorParentId: 'experience-2',
          candidateAdded: false,
          reviewed: true,
          quoteStart: 0,
          quoteEnd: 20,
          jdRevisionId: read(overlay.id).jdRevisions[0]!.revisionId,
          excluded: false,
          exclusionReason: '',
          sourceIds: ['experience-2'],
          factIds: [],
        },
      ],
    });
    workspace.updateCvDocument(db, cv.id, { source: { ...SOURCE, experience: [SOURCE.experience[0]!] } });
    expect(workspace.previewCvEvidenceRebase(db, overlay.id).requirementIdsToReview).toEqual(['r-1']);
    const requirement = rebase(overlay.id).requirements[0];
    expect(requirement).toMatchObject({ anchorParentId: '', sourceIds: [], reviewed: false });
  });
});

describe('a case saved before these fields existed (#419)', () => {
  it('stays approved and readable, with no invented selection, baseline or render version', () => {
    const { overlay } = newCase({ ...SOURCE, projects: [] });
    update(overlay.id, COVERED);
    const approved = approve(overlay.id);
    // Rewrite the row as an earlier version would have stored it.
    const legacySnapshot = { ...approved.approvedResumeSnapshot!, renderContractVersion: undefined };
    db.update(cvEvidenceOverlays)
      .set({ projectSelection: null, sourceBaseline: null, approvedResumeSnapshot: legacySnapshot as never })
      .where(eq(cvEvidenceOverlays.id, overlay.id))
      .run();

    const legacy = read(overlay.id);
    expect(legacy.state).toBe('candidate_approved');
    expect(legacy.projectSelection).toBeNull();
    expect(legacy.sourceBaseline).toBeNull();
    expect(legacy.approvedResumeSnapshot?.renderContractVersion).toBe(0);

    const plan = workspace.previewCvEvidenceRebase(db, overlay.id);
    expect(plan).toMatchObject({ baselineKnown: false, inputsChanged: false, changes: [] });
  });

  it('can still be rebased and approved again, and records the current render contract version', () => {
    const { cv, overlay } = newCase({ ...SOURCE, projects: [] });
    update(overlay.id, COVERED);
    db.update(cvEvidenceOverlays).set({ sourceBaseline: null }).where(eq(cvEvidenceOverlays.id, overlay.id)).run();

    workspace.updateCvDocument(db, cv.id, { source: { ...SOURCE, projects: [], summary: 'Changed summary.' } });
    // Without an earlier copy the source hash mismatch is all there is to go on.
    expect(workspace.previewCvEvidenceRebase(db, overlay.id)).toMatchObject({ baselineKnown: false, inputsChanged: true });
    expect(() => approve(overlay.id)).toThrow(/your CV changed/);

    rebase(overlay.id);
    const approved = approve(overlay.id);
    expect(approved.state).toBe('candidate_approved');
    expect(approved.sourceBaseline?.inputsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(approved.approvedResumeSnapshot?.renderContractVersion).toBe(CV_RENDER_CONTRACT_VERSION);
  });
});

describe('fact anchors (#436)', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const factOf = (id: string, factId: string) => read(id).facts.find((fact) => fact.factId === factId)!;

  it('stamps an anchor in the main process: role id, field, exact text and a digest of it', () => {
    const { overlay } = readyCase();
    expect(factOf(overlay.id, 'fact-1').anchor).toEqual({
      parentId: 'experience-1',
      field: 'experience_bullets',
      text: 'Built things.',
      digest: sha('experience_bullets\nBuilt things.'),
      profileSkills: [],
    });
  });

  it('stamps a project fact against the project description', () => {
    const { overlay } = newCase();
    update(overlay.id, { facts: [makeFact({ factId: 'fact-p', parentId: 'project-2', parentType: 'project' })] });
    expect(factOf(overlay.id, 'fact-p').anchor).toMatchObject({ field: 'project_description', text: 'Dashboard text.' });
  });

  it('ignores an anchor the caller supplies', () => {
    const { overlay } = newCase();
    const forged = { parentId: 'experience-1', field: 'experience_bullets' as const, text: 'Something else.', digest: sha('x'), profileSkills: [] };
    update(overlay.id, { facts: [makeFact({ factId: 'fact-1', anchor: forged })] });
    expect(factOf(overlay.id, 'fact-1').anchor?.text).toBe('Built things.');
  });

  it('leaves a fact stored without an anchor unanchored, even after an unrelated write', () => {
    const { cv, overlay } = readyCase();
    const stored = read(overlay.id).facts.map(({ anchor: _anchor, ...fact }) => fact);
    db.update(cvEvidenceOverlays).set({ facts: stored as never }).where(eq(cvEvidenceOverlays.id, overlay.id)).run();
    expect(factOf(overlay.id, 'fact-1').anchor).toBeUndefined();

    update(overlay.id, { listingStatus: 'open' });
    update(overlay.id, { facts: read(overlay.id).facts });
    expect(factOf(overlay.id, 'fact-1').anchor).toBeUndefined();

    // A source change cannot make a legacy fact stale: there is nothing to compare it against.
    workspace.updateCvDocument(db, cv.id, { source: { ...SOURCE, experience: [{ ...SOURCE.experience[0]!, bullets: ['Rewritten.'] }, SOURCE.experience[1]!] } });
    expect(workspace.previewCvEvidenceRebase(db, overlay.id).staleFacts).toEqual([]);
  });

  it('reads a malformed stored anchor as no anchor', () => {
    const { overlay } = readyCase();
    const stored = read(overlay.id).facts.map((fact) => (fact.factId === 'fact-1' ? { ...fact, anchor: { text: 5 } } : fact));
    db.update(cvEvidenceOverlays).set({ facts: stored as never }).where(eq(cvEvidenceOverlays.id, overlay.id)).run();
    expect(factOf(overlay.id, 'fact-1').anchor).toBeUndefined();
  });

  it('a rewritten bullet marks only the facts of its own role stale, and a new bullet marks none', () => {
    const { cv, overlay } = readyCase();
    workspace.updateCvDocument(db, cv.id, {
      source: {
        ...SOURCE,
        experience: [{ ...SOURCE.experience[0]!, bullets: ['Built things.', 'Added a bullet.'] }, { ...SOURCE.experience[1]!, bullets: ['Rewritten older things.'] }],
      },
    });
    const plan = workspace.previewCvEvidenceRebase(db, overlay.id);
    expect(plan.inputsChanged).toBe(true);
    // fact-2 is anchored to the role whose bullets were rewritten; fact-1 is not touched.
    expect(plan.staleFacts.map((stale) => stale.factId)).toEqual(['fact-2']);
  });

  it('an edit to an anchored bullet marks the fact stale; a rebase sends it back to review and withdraws the wording that cites it', () => {
    const { cv, overlay } = readyCase();
    workspace.updateCvDocument(db, cv.id, {
      source: { ...SOURCE, experience: [{ ...SOURCE.experience[0]!, bullets: ['Built different things.'] }, SOURCE.experience[1]!] },
    });
    const plan = workspace.previewCvEvidenceRebase(db, overlay.id);
    expect(plan.staleFacts).toEqual([{ factId: 'fact-1', activity: 'Built the booking screens', reason: 'a role bullet it was reviewed against changed' }]);

    const rebased = rebase(overlay.id);
    expect(rebased.facts.find((fact) => fact.factId === 'fact-1')?.approval).toBe('proposed');
    expect(rebased.facts.find((fact) => fact.factId === 'fact-2')?.approval).toBe('approved');
    const byId = new Map(rebased.wordingVariants.map((variant) => [variant.variantId, variant]));
    expect(byId.get('v-1')?.status).toBe('superseded');
    expect(byId.get('v-sum')?.status).toBe('superseded');
    expect(byId.get('v-2')?.status).toBe('candidate_approved');

    // Approving the fact again is the re-review: it is anchored to the text the candidate now sees.
    const reapproved = update(overlay.id, { facts: rebased.facts.map((fact) => (fact.factId === 'fact-1' ? { ...fact, approval: 'approved' as const } : fact)) });
    expect(reapproved.facts.find((fact) => fact.factId === 'fact-1')?.anchor?.text).toBe('Built different things.');
    expect(workspace.previewCvEvidenceRebase(db, overlay.id).staleFacts).toEqual([]);
  });

  it('a changed project description marks a project fact stale', () => {
    const { cv, overlay } = newCase();
    update(overlay.id, { facts: [makeFact({ factId: 'fact-p', parentId: 'project-1', parentType: 'project' })] });
    workspace.updateCvDocument(db, cv.id, {
      source: { ...SOURCE, projects: SOURCE.projects.map((project) => (project.id === 'project-1' ? { ...project, description: 'New toolkit text.' } : project)) },
    });
    expect(workspace.previewCvEvidenceRebase(db, overlay.id).staleFacts.map((stale) => [stale.factId, stale.reason])).toEqual([
      ['fact-p', 'the project description it was reviewed against changed'],
    ]);
  });

  it('anchors a fact that backs a skill wording to that profile skill, and removing the skill marks it stale', () => {
    const { cv, overlay } = newCase();
    update(overlay.id, {
      facts: [makeFact({ factId: 'fact-1', parentId: 'experience-1', activity: 'Wrote the TypeScript build tooling' })],
    });
    update(overlay.id, {
      wordingVariants: [makeVariant({ variantId: 'v-skill', targetField: 'skill', parentId: '', factIds: ['fact-1'], text: 'TypeScript', approvedAt: '', sourceRevision: '' })],
    });
    expect(factOf(overlay.id, 'fact-1').anchor?.profileSkills).toEqual([{ skill: 'TypeScript', digest: sha('typescript') }]);

    workspace.updateCvDocument(db, cv.id, { profile: { skills: [] } });
    expect(workspace.previewCvEvidenceRebase(db, overlay.id).staleFacts.map((stale) => stale.reason)).toEqual([
      'the profile skill "TypeScript" it backs was removed',
    ]);
  });
});
