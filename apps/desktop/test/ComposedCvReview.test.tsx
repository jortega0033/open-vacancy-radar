import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CV_RENDER_CONTRACT_VERSION } from '../electron/workspace/cv-evidence-schema.js';
import { EMPTY_CV_SOURCE, stableCvSourceJson } from '../electron/workspace/cv-source-schema.js';
import { ComposedCvReview } from '../src/components/cv/ComposedCvReview.js';
import type { VacancyLead } from '../src/components/cv/types.js';
import type { CvEvidenceFact, CvEvidenceOverlayRecord, CvEvidenceOverlayPatch, CvSourceDocument } from '../src/window.js';
import { installWorkspaceBridge } from './workspace-bridge.js';
import { FIXTURE_REVISION_ID, makeFact, makeRequirement, makeRevision, makeVariant } from './fixtures/cv-evidence.js';
import { FULL_JD } from './fixtures/job-description.js';

const VACANCY: VacancyLead = {
  title: 'Senior Frontend Engineer',
  company: 'Redwood Software',
  location: 'Amsterdam, Netherlands',
  url: 'https://example.invalid/jobs/1',
};

const SOURCE: CvSourceDocument = {
  ...EMPTY_CV_SOURCE,
  reviewedAt: '2026-09-30T00:00:00.000Z',
  summary: 'Original summary.',
  experience: [
    { id: 'experience-1', company: 'Redwood Software', title: 'Frontend Engineer', dates: '2021 - Present', engagement: 'employment', client: '', bullets: ['Built things.'] },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

function installOverlayBridge(overlay: CvEvidenceOverlayRecord) {
  let current = overlay;
  return installWorkspaceBridge({
    getCvEvidenceOverlay: vi.fn().mockImplementation(async () => current),
    updateCvEvidenceOverlay: vi.fn().mockImplementation(async (_id: string, patch: CvEvidenceOverlayPatch) => {
      current = { ...current, ...patch } as CvEvidenceOverlayRecord;
      return current;
    }),
    // Mirrors `approveCvEvidenceOverlay`'s real server-side behavior (#421) closely enough for a
    // component test: approves no wording itself and rejects a stale `expectedCaseRevision` the
    // same way the real service does.
    approveCvEvidenceOverlay: vi.fn().mockImplementation(async (_id: string, expectedCaseRevision: string) => {
      if (expectedCaseRevision !== current.caseRevision) {
        throw new Error(`case has changed since it was last read (current revision: ${current.caseRevision})`);
      }
      current = {
        ...current,
        state: 'candidate_approved',
        caseRevision: String(Number(current.caseRevision) + 1),
      };
      return current;
    }),
    exportCvEvidenceOverlay: vi.fn().mockImplementation(async () => {
      const snapshot = current.approvedResumeSnapshot;
      const artifact = {
        artifactId: 'artifact-1',
        format: 'pdf' as const,
        contentHash: 'f'.repeat(64),
        exportedAt: '2026-10-01T11:00:00.000Z',
        snapshotDigest: snapshot?.digest ?? '',
        snapshotApprovedAt: snapshot?.approvedAt ?? '',
        renderContractVersion: CV_RENDER_CONTRACT_VERSION,
        validation: { ok: true, reasons: [], pageCount: 1 },
        savedPath: 'C:\\fake\\approved-cv.pdf',
        reviewOpenedAt: '',
        confirmedAt: '',
      };
      current = { ...current, artifacts: [artifact] };
      return { saved: true, path: artifact.savedPath, artifact, overlay: current };
    }),
  });
}

const EMPTY_RESUME = { contact: { name: 'Sam Doe', title: '', location: '', email: '', phone: '', links: [] }, summary: '', experience: [], projects: [], skills: [], education: [] };

function snapshotAt(renderContractVersion: number) {
  return { renderContractVersion, resume: EMPTY_RESUME, digest: 'd'.repeat(64), approvedAt: '2026-10-01T10:00:00.000Z', caseRevision: '1' };
}

function baseOverlay(partial: Partial<CvEvidenceOverlayRecord> = {}): CvEvidenceOverlayRecord {
  return {
    id: 'overlay-1',
    cvId: 'cv-1',
    vacancyKey: `url:${VACANCY.url}`,
    caseTitle: '',
    caseCompany: '',
    sourceCvContentHash: '', // filled by the test to match the real hash of SOURCE
    jdSnapshot: FULL_JD,
    jdSnapshotHash: 'b'.repeat(64),
    jdComplete: true,
    jdIncompleteReasons: [],
    jdWarning: '',
    jdConfirmedComplete: false,
    jdRevisions: [makeRevision({ text: FULL_JD })],
    listingStatus: 'unknown',
    state: 'draft',
    requirements: [],
    requirementCoverage: { status: 'complete', revisionId: FIXTURE_REVISION_ID, batches: 1 },
    facts: [],
    wordingVariants: [],
    origin: 'vacancy',
    caseRevision: '1',
    approvedResumeSnapshot: null,
    projectSelection: null,
    sourceBaseline: null,
    artifacts: [],
    legacyUnverifiedExport: false,
    capturedAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
    ...partial,
  };
}

async function hashOf(source: CvSourceDocument): Promise<string> {
  // Matches `content-hash.ts`'s `sha256HexOfSource` exactly (stable, sorted-key serialization --
  // see `stable-cv-source-json.test.ts` for why a plain `JSON.stringify` would disagree with it).
  const bytes = new TextEncoder().encode(stableCvSourceJson(source));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fact(partial: Partial<CvEvidenceFact> = {}): CvEvidenceFact {
  return makeFact({
    activity: 'Designed the GraphQL schema',
    mechanism: 'Apollo Server, schema-first',
    result: 'cut client-side overfetching',
    ownership: 'unknown',
    ...partial,
  });
}

/** The button is disabled until the case has loaded, so a click before then would do nothing. */
async function clickPreview() {
  const button = await screen.findByRole('button', { name: /preview approved cv/i });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

const FACT_WORDING = 'Designed the GraphQL schema, using Apollo Server, schema-first, cut client-side overfetching';

describe('ComposedCvReview (#419, step 5-6)', () => {
  it('renders nothing without a saved CV or a selected vacancy', () => {
    installWorkspaceBridge();
    const { container } = render(<ComposedCvReview cvId={null} vacancy={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('previews and approves a clean composition, never touching the free-form draft', async () => {
    const hash = await hashOf(SOURCE);
    installOverlayBridge(baseOverlay({ sourceCvContentHash: hash }));
    render(<ComposedCvReview cvId="cv-1" vacancy={VACANCY} sourceCv={SOURCE} />);

    await clickPreview();

    const preview = await screen.findByLabelText('Composed CV preview');
    expect(preview).toHaveTextContent('Original summary.');
    expect(preview).toHaveTextContent('Built things.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    const approve = screen.getByRole('button', { name: /^approve cv$/i });
    expect(approve).toBeEnabled();
    fireEvent.click(approve);

    await screen.findByText(/^approved\. this is the version ready for export\.$/i);
  });

  it('exports the approved composition via the overlay id, and shows the saved path', async () => {
    const hash = await hashOf(SOURCE);
    const workspace = installOverlayBridge(
      baseOverlay({ sourceCvContentHash: hash, state: 'candidate_approved', approvedResumeSnapshot: snapshotAt(CV_RENDER_CONTRACT_VERSION) }),
    );
    render(<ComposedCvReview cvId="cv-1" vacancy={VACANCY} sourceCv={SOURCE} />);

    const pdfButton = await screen.findByRole('button', { name: /export as pdf/i });
    fireEvent.click(pdfButton);

    await waitFor(() => expect(workspace.exportCvEvidenceOverlay).toHaveBeenCalledWith('overlay-1', 'pdf'));
    expect((await screen.findAllByText(/saved to c:\\fake\\approved-cv\.pdf/i)).length).toBeGreaterThan(0);
    // A saved file is waiting for the candidate's own review, not accepted.
    expect(within(screen.getByLabelText('PDF file')).getByRole('status')).toHaveTextContent('Exported, waiting for your review');
  });

  it('a case approved under an older document format asks to be approved again before it can be exported', async () => {
    const hash = await hashOf(SOURCE);
    installOverlayBridge(
      baseOverlay({ sourceCvContentHash: hash, state: 'candidate_approved', approvedResumeSnapshot: snapshotAt(CV_RENDER_CONTRACT_VERSION - 1) }),
    );
    render(<ComposedCvReview cvId="cv-1" vacancy={VACANCY} sourceCv={SOURCE} />);
    expect(await screen.findByText(/approved before the current document format/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /export as pdf/i })).not.toBeInTheDocument();
    await clickPreview();
    expect(await screen.findByRole('button', { name: /^approve again$/i })).toBeEnabled();
  });

  it('says why approval is blocked when the source CV is unreviewed, and points to the CV Library', async () => {
    const unreviewed: CvSourceDocument = { ...SOURCE, reviewedAt: '' };
    const hash = await hashOf(unreviewed);
    installOverlayBridge(baseOverlay({ sourceCvContentHash: hash }));
    render(<ComposedCvReview cvId="cv-1" vacancy={VACANCY} sourceCv={unreviewed} />);

    const notice = await screen.findByLabelText('Source CV not ready');
    expect(notice).toHaveTextContent('has not been reviewed and confirmed');
    expect(notice).toHaveTextContent('CV Library');
    await clickPreview();
    await screen.findByLabelText('Composed CV preview');
    expect(screen.getByRole('button', { name: /^approve cv$/i })).toBeDisabled();
  });

  it('names a truncated source and blocks export of an already approved case', async () => {
    const truncated: CvSourceDocument = { ...SOURCE, complete: false, incompleteReason: 'the last two pages were never read' };
    const hash = await hashOf(truncated);
    const workspace = installOverlayBridge(
      baseOverlay({ sourceCvContentHash: hash, state: 'candidate_approved', approvedResumeSnapshot: snapshotAt(CV_RENDER_CONTRACT_VERSION) }),
    );
    render(<ComposedCvReview cvId="cv-1" vacancy={VACANCY} sourceCv={truncated} />);

    const blocked = await screen.findByLabelText('Export blocked by the source CV');
    expect(blocked).toHaveTextContent('the last two pages were never read');
    expect(screen.getByRole('button', { name: /export as pdf/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /export as word/i })).toBeDisabled();
    expect(workspace.exportCvEvidenceOverlay).not.toHaveBeenCalled();
  });

  it('offers no export action before the CV has been approved', async () => {
    const hash = await hashOf(SOURCE);
    installOverlayBridge(baseOverlay({ sourceCvContentHash: hash }));
    render(<ComposedCvReview cvId="cv-1" vacancy={VACANCY} sourceCv={SOURCE} />);
    await screen.findByRole('button', { name: /preview approved cv/i });
    expect(screen.queryByRole('button', { name: /export as pdf/i })).not.toBeInTheDocument();
  });

  it('disables approval and explains why when the overlay still has gaps', async () => {
    const hash = await hashOf(SOURCE);
    installOverlayBridge(
      baseOverlay({
        sourceCvContentHash: hash,
        requirements: [makeRequirement({ evidenceClass: 'needs_verification', anchorParentId: '' })],
      }),
    );
    render(<ComposedCvReview cvId="cv-1" vacancy={VACANCY} sourceCv={SOURCE} />);

    await clickPreview();

    expect(await screen.findByRole('alert')).toHaveTextContent(/still need verification/i);
    expect(screen.getByRole('button', { name: /^approve cv$/i })).toBeDisabled();
  });

  it('says there is nothing to compose from before requirement mapping has started', () => {
    installWorkspaceBridge({ getCvEvidenceOverlay: vi.fn().mockResolvedValue(null) });
    render(<ComposedCvReview cvId="cv-1" vacancy={VACANCY} sourceCv={SOURCE} />);
    expect(screen.getByText(/map this vacancy/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /preview approved cv/i })).toBeDisabled();
  });

  it('shows only wording the candidate approved: a fact alone, or a draft of it, adds nothing (#419, step 7)', async () => {
    const hash = await hashOf(SOURCE);
    const draft = makeVariant({
      targetField: 'experience_bullet',
      parentId: 'experience-1',
      text: FACT_WORDING,
      status: 'draft',
      approvedAt: '',
      sourceRevision: '',
    });
    installOverlayBridge(baseOverlay({ sourceCvContentHash: hash, facts: [fact()], wordingVariants: [draft] }));
    render(<ComposedCvReview cvId="cv-1" vacancy={VACANCY} sourceCv={SOURCE} />);

    await clickPreview();

    const preview = await screen.findByLabelText('Composed CV preview');
    expect(preview).toHaveTextContent('Built things.');
    expect(preview).not.toHaveTextContent(/Designed the GraphQL schema/);
  });

  it('shows approved wording in the preview, and approving sends only the id and revision (#419, step 7)', async () => {
    const hash = await hashOf(SOURCE);
    const approvedVariant = makeVariant({
      targetField: 'experience_bullet',
      parentId: 'experience-1',
      text: FACT_WORDING,
      sourceRevision: hash,
    });
    const workspace = installOverlayBridge(
      baseOverlay({ sourceCvContentHash: hash, facts: [fact()], wordingVariants: [approvedVariant] }),
    );
    render(<ComposedCvReview cvId="cv-1" vacancy={VACANCY} sourceCv={SOURCE} />);

    await clickPreview();

    const preview = await screen.findByLabelText('Composed CV preview');
    expect(preview).toHaveTextContent('Built things.');
    expect(preview).toHaveTextContent(FACT_WORDING);

    fireEvent.click(screen.getByRole('button', { name: /^approve cv$/i }));
    await screen.findByText(/^approved\. this is the version ready for export\.$/i);

    // The approve call sends only the overlay id and the revision last read (#421).
    expect(workspace.approveCvEvidenceOverlay).toHaveBeenCalledWith('overlay-1', '1');
  });

  it('re-fetches the overlay fresh on every preview, so a sibling panel edits are never shown stale', async () => {
    const hash = await hashOf(SOURCE);
    let current = baseOverlay({
      sourceCvContentHash: hash,
      requirements: [makeRequirement({ evidenceClass: 'needs_verification', anchorParentId: '', reviewed: false })],
    });
    const getCvEvidenceOverlay = vi.fn().mockImplementation(async () => current);
    installWorkspaceBridge({
      getCvEvidenceOverlay,
      updateCvEvidenceOverlay: vi.fn(),
      exportCvEvidenceOverlay: vi.fn(),
    });
    render(<ComposedCvReview cvId="cv-1" vacancy={VACANCY} sourceCv={SOURCE} />);

    // Mount fetch sees the requirement unreviewed.
    await waitFor(() => expect(screen.getByRole('button', { name: /preview approved cv/i })).toBeEnabled());
    expect(getCvEvidenceOverlay).toHaveBeenCalledTimes(1);

    // RequirementMapping (a sibling component, not this one) resolves it -- simulated here by
    // mutating what the next fetch returns, the way a second IPC round trip would.
    current = { ...current, requirements: [{ ...current.requirements[0]!, reviewed: true, evidenceClass: 'direct' }] };

    fireEvent.click(screen.getByRole('button', { name: /preview approved cv/i }));

    await screen.findByLabelText('Composed CV preview');
    expect(getCvEvidenceOverlay).toHaveBeenCalledTimes(2); // preview re-fetched, not reused from mount
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); // no longer reports the stale gap
  });

  it('shows the complete assembled CV: contact, roles with dates, projects, education and skills', async () => {
    const full: CvSourceDocument = {
      ...SOURCE,
      contact: { name: 'Sam Example', title: 'Engineer', location: 'Utrecht', email: 'sam@example.invalid', phone: '', links: [] },
      education: [{ institution: 'State University', credential: 'BSc Computing', dates: '2015 - 2018' }],
      projects: [{ id: 'project-1', name: 'Toolkit', role: 'Author', dates: '2022', organization: '', description: 'Plugin toolkit.', technologies: [], links: [], pinned: false }],
    };
    installOverlayBridge(baseOverlay({ sourceCvContentHash: await hashOf(full), projectSelection: { projectIds: ['project-1'], maxProjects: 0, approvedAt: '2026-10-01T00:00:00.000Z' } }));
    render(<ComposedCvReview cvId="cv-1" vacancy={VACANCY} sourceCv={full} profile={{ title: '', years: '', location: '', languages: '', skills: ['TypeScript'], summary: '', auth: '' }} />);
    await clickPreview();
    const preview = await screen.findByLabelText('Composed CV preview');
    for (const text of ['Sam Example', 'Utrecht', 'Frontend Engineer at Redwood Software', '2021 - Present', 'Toolkit', 'Plugin toolkit.', 'BSc Computing', 'TypeScript']) {
      expect(preview).toHaveTextContent(text);
    }
  });

  describe('project selection and source changes (#419 step 8)', () => {
    const WITH_PROJECTS: CvSourceDocument = {
      ...SOURCE,
      maxProjects: 1,
      projects: [
        { id: 'project-1', name: 'Toolkit', role: '', dates: '', organization: '', description: 'A.', technologies: [], links: [], pinned: true },
        { id: 'project-2', name: 'Dashboard', role: '', dates: '', organization: '', description: 'B.', technologies: [], links: [], pinned: false },
      ],
    };

    function bridge(initial: CvEvidenceOverlayRecord, plan: Partial<import('../src/window.js').CvRebasePlan> = {}) {
      let current = initial;
      let currentPlan = { baselineKnown: true, inputsChanged: false, changes: [], keptVariantIds: [], droppedVariants: [], orphanedFactIds: [], requirementIdsToReview: [], ...plan };
      const workspace = installWorkspaceBridge({
        getCvEvidenceOverlay: vi.fn().mockImplementation(async () => current),
        previewCvEvidenceRebase: vi.fn().mockImplementation(async () => currentPlan),
        approveCvProjectSelection: vi.fn().mockImplementation(async () => {
          current = {
            ...current,
            projectSelection: { projectIds: ['project-1'], maxProjects: 1, approvedAt: '2026-10-01T00:00:00.000Z' },
            caseRevision: String(Number(current.caseRevision) + 1),
          };
          return current;
        }),
        rebaseCvEvidenceOverlay: vi.fn().mockImplementation(async () => {
          currentPlan = { ...currentPlan, inputsChanged: false, changes: [] };
          current = { ...current, caseRevision: String(Number(current.caseRevision) + 1) };
          return current;
        }),
        approveCvEvidenceOverlay: vi.fn().mockImplementation(async () => {
          current = { ...current, state: 'candidate_approved', caseRevision: String(Number(current.caseRevision) + 1) };
          return current;
        }),
      });
      return workspace;
    }

    it('lists the selected projects with their pins and blocks approval until the selection is approved', async () => {
      const hash = await hashOf(WITH_PROJECTS);
      const workspace = bridge(baseOverlay({ sourceCvContentHash: hash }));
      render(<ComposedCvReview cvId="cv-1" vacancy={VACANCY} sourceCv={WITH_PROJECTS} />);

      const selection = await screen.findByLabelText('Project selection');
      expect(selection).toHaveTextContent('Toolkit (pinned)');
      expect(selection).not.toHaveTextContent('Dashboard');

      await clickPreview();
      expect(await screen.findByRole('alert')).toHaveTextContent(/projects for this CV have not been approved/i);
      expect(screen.getByRole('button', { name: /^approve cv$/i })).toBeDisabled();

      fireEvent.click(screen.getByRole('button', { name: /approve these projects/i }));
      await waitFor(() => expect(workspace.approveCvProjectSelection).toHaveBeenCalledWith('overlay-1', '1'));
      expect(await screen.findByRole('button', { name: /projects approved/i })).toBeDisabled();
      await waitFor(() => expect(screen.getByRole('button', { name: /^approve cv$/i })).toBeEnabled());
    });

    it('says when the selection changed after it was approved', async () => {
      const hash = await hashOf(WITH_PROJECTS);
      bridge(baseOverlay({ sourceCvContentHash: hash, projectSelection: { projectIds: ['project-2'], maxProjects: 0, approvedAt: '2026-10-01T00:00:00.000Z' } }));
      render(<ComposedCvReview cvId="cv-1" vacancy={VACANCY} sourceCv={WITH_PROJECTS} />);
      expect(await screen.findByText(/projects changed since you approved them/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /approve these projects/i })).toBeEnabled();
    });

    it('shows what changed in the CV and holds approval until the candidate rebases explicitly', async () => {
      const hash = await hashOf(WITH_PROJECTS);
      const workspace = bridge(
        baseOverlay({ sourceCvContentHash: hash, projectSelection: { projectIds: ['project-1'], maxProjects: 1, approvedAt: '2026-10-01T00:00:00.000Z' } }),
        {
          inputsChanged: true,
          changes: [{ area: 'Skills', detail: 'Added: Terraform.' }],
          droppedVariants: [{ variantId: 'v-old', text: 'Old wording for a removed role', reason: 'its role is no longer in your CV' }],
        },
      );
      render(<ComposedCvReview cvId="cv-1" vacancy={VACANCY} sourceCv={WITH_PROJECTS} />);

      const panel = await screen.findByLabelText('Changes since this case was started');
      expect(panel).toHaveTextContent('Skills: Added: Terraform.');
      expect(panel).toHaveTextContent('Old wording for a removed role');

      await clickPreview();
      await screen.findByLabelText('Composed CV preview');
      expect(screen.getByRole('button', { name: /^approve cv$/i })).toBeDisabled();
      expect(workspace.rebaseCvEvidenceOverlay).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: /use my current cv for this case/i }));
      await waitFor(() => expect(workspace.rebaseCvEvidenceOverlay).toHaveBeenCalledWith('overlay-1', '1'));
      await waitFor(() => expect(screen.queryByLabelText('Changes since this case was started')).not.toBeInTheDocument());
    });
  });
});
