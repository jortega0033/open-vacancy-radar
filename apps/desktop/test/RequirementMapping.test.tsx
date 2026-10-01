import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_CV_SOURCE } from '../electron/workspace/cv-source-schema.js';
import type { CvEvidenceOverlayRecord, CvEvidenceOverlayPatch, CvSourceDocument } from '../src/window.js';
import { RequirementMapping } from '../src/components/cv/RequirementMapping.js';
import type { CvDocument } from '../src/components/cv/types.js';
import { installBridges, TEST_VACANCY } from './cv-bridges.js';
import { installWorkspaceBridge } from './workspace-bridge.js';

const CV: CvDocument = { fileName: 'cv.pdf', text: 'Angular architect. 8 years of frontend work.' };

/** The JD text `TEST_VACANCY` produces (`jobDescriptionBody`): every quote below is a passage of it. */
const QUOTE_ANGULAR = 'Build Angular applications';
const QUOTE_YEARS = 'Five years of frontend experience required';

const SOURCE: CvSourceDocument = {
  ...EMPTY_CV_SOURCE,
  experience: [
    { id: 'experience-1', company: 'Redwood Software', title: 'Frontend Engineer', dates: '2021 - Present', engagement: 'employment', client: '', bullets: [] },
  ],
};

/** A minimal stateful overlay store, so create/update/get behave consistently across calls the
 * way the real IPC bridge does, without standing up a real SQLite file for a renderer test. */
function installStatefulOverlayBridge() {
  let overlay: CvEvidenceOverlayRecord | null = null;
  let nextId = 1;

  const workspace = installWorkspaceBridge({
    getCvEvidenceOverlay: vi.fn().mockImplementation(async () => overlay),
    createCvEvidenceOverlay: vi.fn().mockImplementation(async (input) => {
      if (overlay) return overlay;
      overlay = {
        id: `overlay-${nextId++}`,
        cvId: input.cvId,
        vacancyKey: input.vacancyKey,
        sourceCvContentHash: input.sourceCvContentHash,
        jdSnapshot: input.jdSnapshot ?? '',
        jdSnapshotHash: input.jdSnapshotHash,
        jdComplete: input.jdComplete ?? true,
        jdIncompleteReasons: [],
        jdWarning: '',
        jdConfirmedComplete: false,
        jdRevisions: [],
        listingStatus: input.listingStatus ?? 'unknown',
        state: 'needs_input',
        requirements: [],
        requirementCoverage: { status: 'not_run', revisionId: '', batches: 0 },
        facts: [],
        wordingVariants: [],
        origin: input.origin ?? 'vacancy',
        caseRevision: '1',
        approvedResumeSnapshot: null,
        projectSelection: null,
        sourceBaseline: null,
        capturedAt: '2026-09-30T00:00:00.000Z',
        updatedAt: '2026-09-30T00:00:00.000Z',
      };
      return overlay;
    }),
    updateCvEvidenceOverlay: vi.fn().mockImplementation(async (id: string, patch: CvEvidenceOverlayPatch) => {
      if (!overlay || overlay.id !== id) throw new Error('no such overlay');
      // The real repository stamps the JD revision onto coverage, and a case with no JD revisions
      // has the empty revision id.
      const { requirementCoverage, ...rest } = patch;
      overlay = {
        ...overlay,
        ...rest,
        ...(requirementCoverage ? { requirementCoverage: { ...requirementCoverage, revisionId: '' } } : {}),
        updatedAt: '2026-09-30T00:01:00.000Z',
      } as CvEvidenceOverlayRecord;
      return overlay;
    }),
  });
  return workspace;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function emitAnswer(bridges: ReturnType<typeof installBridges>, payload: unknown) {
  bridges.emit('sess-cv-1', { type: 'assistant.message', text: JSON.stringify(payload) });
  bridges.emit('sess-cv-1', { type: 'session.completed' });
}

describe('RequirementMapping (#419)', () => {
  it('shows a hint and disables the run button until a saved CV and a vacancy are both present', () => {
    installBridges();
    const { rerender } = render(<RequirementMapping cvId={null} cv={null} vacancy={null} />);
    expect(screen.getByText(/select a saved cv/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /map requirements/i })).toBeDisabled();

    rerender(<RequirementMapping cvId="cv-1" cv={CV} vacancy={null} />);
    expect(screen.getByText(/select a vacancy/i)).toBeInTheDocument();
  });

  it('maps requirements, keeping the evidence class structurally separate from ATS fit', async () => {
    const bridges = installBridges();
    const workspace = installStatefulOverlayBridge();
    render(<RequirementMapping cvId="cv-1" cv={CV} vacancy={TEST_VACANCY} />);

    fireEvent.click(screen.getByRole('button', { name: /map requirements/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));

    const prompt = vi.mocked(bridges.agentDock.createSession).mock.calls[0]?.[0].prompt ?? '';
    expect(prompt).toContain('never how the posting is worded');

    emitAnswer(bridges, {
      requirements: [
        { text: 'Angular experience', jdAnchor: QUOTE_ANGULAR, classification: 'required', evidenceClass: 'needs_verification', anchorParentId: '' },
      ],
    });

    await screen.findByText('Angular experience');
    expect(workspace.createCvEvidenceOverlay).toHaveBeenCalledTimes(1);
    expect(workspace.updateCvEvidenceOverlay).toHaveBeenCalled();
    expect(screen.getByText(/1 requirement\(s\) have not been reviewed/i)).toBeInTheDocument();
  });

  it('turns away a proposal whose quote is not in the job description, and shows that it did', async () => {
    const bridges = installBridges();
    installStatefulOverlayBridge();
    render(<RequirementMapping cvId="cv-1" cv={CV} vacancy={TEST_VACANCY} />);

    fireEvent.click(screen.getByRole('button', { name: /map requirements/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());
    emitAnswer(bridges, {
      requirements: [
        { text: 'Kubernetes experience', jdAnchor: 'Must run Kubernetes clusters' },
        { text: 'Angular experience', jdAnchor: QUOTE_ANGULAR },
      ],
    });

    await screen.findByText('Angular experience');
    expect(screen.queryByText('Kubernetes experience', { selector: '.font-medium' })).not.toBeInTheDocument();
    expect(screen.getByText(/1 proposed requirement\(s\) were not added/i)).toBeInTheDocument();
  });

  it('keeps reading further batches when the model reports more, and carries the earlier ones forward', async () => {
    const bridges = installBridges();
    installStatefulOverlayBridge();
    render(<RequirementMapping cvId="cv-1" cv={CV} vacancy={TEST_VACANCY} />);

    fireEvent.click(screen.getByRole('button', { name: /map requirements/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));
    emitAnswer(bridges, { requirements: [{ text: 'Angular experience', jdAnchor: QUOTE_ANGULAR }], hasMore: true });

    // The follow-up batch is requested on its own and names what is already listed.
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(2));
    const second = vi.mocked(bridges.agentDock.createSession).mock.calls[1]?.[0].prompt ?? '';
    expect(second).toContain('already listed');
    expect(second).toContain('- Angular experience');

    emitAnswer(bridges, { requirements: [{ text: 'Frontend years', jdAnchor: QUOTE_YEARS }], hasMore: false });
    await screen.findByText('Frontend years');
    expect(screen.getByText('Angular experience')).toBeInTheDocument();
    // Extraction is finished, but nothing is reviewed yet, so the list still cannot back approval.
    expect(screen.queryByText(/requirement list is partial/i)).not.toBeInTheDocument();
    expect(screen.getByText(/2 requirement\(s\) have not been reviewed/i)).toBeInTheDocument();
  });

  it('never claims the list is complete while batches remain unread', async () => {
    const bridges = installBridges();
    const workspace = installStatefulOverlayBridge();
    render(<RequirementMapping cvId="cv-1" cv={CV} vacancy={TEST_VACANCY} />);

    fireEvent.click(screen.getByRole('button', { name: /map requirements/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));
    // A follow-up batch that adds nothing new stops the loop with coverage left partial.
    emitAnswer(bridges, { requirements: [{ text: 'Angular experience', jdAnchor: QUOTE_ANGULAR }], hasMore: true });
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(2));
    emitAnswer(bridges, { requirements: [{ text: 'Angular experience', jdAnchor: QUOTE_ANGULAR }], hasMore: true });

    await screen.findByText(/requirement list is partial/i);
    expect(screen.getByRole('button', { name: /read the rest of the job description/i })).toBeEnabled();
    const lastPatch = vi.mocked(workspace.updateCvEvidenceOverlay).mock.calls.at(-1)?.[1];
    expect(lastPatch?.requirementCoverage?.status).toBe('partial');
  });

  it('lets the candidate confirm the list covers the job description', async () => {
    const bridges = installBridges();
    const workspace = installStatefulOverlayBridge();
    render(<RequirementMapping cvId="cv-1" cv={CV} vacancy={TEST_VACANCY} />);

    fireEvent.click(screen.getByRole('button', { name: /map requirements/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());
    emitAnswer(bridges, { requirements: [{ text: 'Angular experience', jdAnchor: QUOTE_ANGULAR }], hasMore: true });
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(2));
    emitAnswer(bridges, { requirements: [], hasMore: true });
    // Both batches are saved before the candidate confirms.
    await waitFor(() => expect(vi.mocked(workspace.updateCvEvidenceOverlay)).toHaveBeenCalledTimes(2));
    await screen.findByText(/requirement list is partial/i);

    fireEvent.click(screen.getByRole('button', { name: /i read the whole job description/i }));

    await waitFor(() =>
      expect(vi.mocked(workspace.updateCvEvidenceOverlay).mock.calls.at(-1)?.[1].requirementCoverage?.status).toBe('complete'),
    );
    await waitFor(() => expect(screen.queryByText(/requirement list is partial/i)).not.toBeInTheDocument());
  });

  it('marking a row reviewed persists the change', async () => {
    const bridges = installBridges();
    installStatefulOverlayBridge();
    render(<RequirementMapping cvId="cv-1" cv={CV} vacancy={TEST_VACANCY} />);

    fireEvent.click(screen.getByRole('button', { name: /map requirements/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());
    emitAnswer(bridges, { requirements: [{ text: 'Angular experience', jdAnchor: QUOTE_ANGULAR }] });

    const checkbox = await screen.findByRole('checkbox', { name: /reviewed/i });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);

    await waitFor(() => expect(checkbox).toBeChecked());
    await waitFor(() => expect(screen.queryByText(/have not been reviewed/i)).not.toBeInTheDocument());
  });

  it('marks a requirement as not a requirement with a reason, keeps it visible, and persists it', async () => {
    const bridges = installBridges();
    const workspace = installStatefulOverlayBridge();
    render(<RequirementMapping cvId="cv-1" cv={CV} vacancy={TEST_VACANCY} />);

    fireEvent.click(screen.getByRole('button', { name: /map requirements/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());
    emitAnswer(bridges, { requirements: [{ text: 'Frontend years', jdAnchor: QUOTE_YEARS }] });
    await screen.findByText('Frontend years');

    fireEvent.click(screen.getByRole('button', { name: /^not a requirement$/i }));
    const confirm = screen.getByRole('button', { name: /mark as not a requirement/i });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/reason this is not a requirement/i), { target: { value: 'Describes the team, not the role' } });
    fireEvent.click(confirm);

    await screen.findByText(/reason: describes the team, not the role/i);
    // Still listed, labelled, and out of the review count.
    expect(screen.getByText('Frontend years')).toBeInTheDocument();
    expect(screen.getByText(/\(not a requirement\)/i)).toBeInTheDocument();
    expect(screen.queryByText(/have not been reviewed/i)).not.toBeInTheDocument();
    const lastPatch = vi.mocked(workspace.updateCvEvidenceOverlay).mock.calls.at(-1)?.[1];
    expect(lastPatch?.requirements?.[0]).toMatchObject({ excluded: true, exclusionReason: 'Describes the team, not the role' });
  });

  it('lets the candidate add a requirement with an exact quote, already marked reviewed', async () => {
    installBridges();
    const workspace = installStatefulOverlayBridge();
    render(<RequirementMapping cvId="cv-1" cv={CV} vacancy={TEST_VACANCY} />);

    fireEvent.change(screen.getByLabelText(/new requirement text/i), { target: { value: 'Five years of frontend work' } });
    fireEvent.change(screen.getByLabelText(/exact quote from the job description/i), { target: { value: QUOTE_YEARS } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await screen.findByText('Five years of frontend work');
    expect(screen.getByText(/added by you/i)).toBeInTheDocument();
    expect(screen.queryByText(/have not been reviewed/i)).not.toBeInTheDocument();
    expect(workspace.createCvEvidenceOverlay).toHaveBeenCalledTimes(1);
  });

  it('refuses a candidate-added requirement whose quote is not in the job description', async () => {
    installBridges();
    const workspace = installStatefulOverlayBridge();
    render(<RequirementMapping cvId="cv-1" cv={CV} vacancy={TEST_VACANCY} />);

    fireEvent.change(screen.getByLabelText(/new requirement text/i), { target: { value: 'Onsite 2 days a week' } });
    fireEvent.change(screen.getByLabelText(/exact quote from the job description/i), { target: { value: 'Onsite twice a week' } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/copied exactly from the job description/i);
    expect(screen.queryByText('Onsite 2 days a week')).not.toBeInTheDocument();
    expect(workspace.updateCvEvidenceOverlay).not.toHaveBeenCalled();
  });

  it('reuses an already-started overlay instead of creating a second one for the same vacancy', async () => {
    installBridges();
    const workspace = installStatefulOverlayBridge();
    await workspace.createCvEvidenceOverlay({
      cvId: 'cv-1',
      vacancyKey: `url:${TEST_VACANCY.url}`,
      sourceCvContentHash: 'a'.repeat(64),
      jdSnapshotHash: 'b'.repeat(64),
    });
    vi.mocked(workspace.createCvEvidenceOverlay).mockClear();

    render(<RequirementMapping cvId="cv-1" cv={CV} vacancy={TEST_VACANCY} />);
    await screen.findByRole('button', { name: /re-map requirements|map requirements/i });

    fireEvent.change(screen.getByLabelText(/new requirement text/i), { target: { value: 'A manual one' } });
    fireEvent.change(screen.getByLabelText(/exact quote from the job description/i), { target: { value: QUOTE_ANGULAR } });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await screen.findByText('A manual one');
    expect(workspace.createCvEvidenceOverlay).not.toHaveBeenCalled();
  });

  describe('clarification flow (#419, step 6)', () => {
    async function seedOneNeedsVerificationRequirement() {
      const bridges = installBridges();
      const workspace = installStatefulOverlayBridge();
      render(<RequirementMapping cvId="cv-1" cv={CV} vacancy={TEST_VACANCY} sourceCv={SOURCE} />);

      fireEvent.click(screen.getByRole('button', { name: /map requirements/i }));
      await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());
      emitAnswer(bridges, {
        requirements: [
          { text: 'GraphQL schema design', jdAnchor: QUOTE_ANGULAR, classification: 'required', evidenceClass: 'needs_verification', anchorParentId: '' },
        ],
      });
      await screen.findByText('GraphQL schema design');
      return workspace;
    }

    it('answering in three separate steps saves a proposed self-reported fact and flips the requirement to direct evidence', async () => {
      const workspace = await seedOneNeedsVerificationRequirement();
      fireEvent.click(screen.getByRole('button', { name: /^answer$/i }));

      // Step 1 shows only the first question.
      expect(screen.getByText(/question 1 of 3/i)).toBeInTheDocument();
      expect(screen.queryByLabelText(/how did you do it/i)).not.toBeInTheDocument();
      fireEvent.change(screen.getByLabelText(/role or project/i), { target: { value: 'experience:experience-1' } });
      fireEvent.change(screen.getByLabelText(/what did you personally do/i), {
        target: { value: 'Designed the GraphQL schema for checkout' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^next$/i }));

      expect(screen.getByText(/question 2 of 3/i)).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText(/how did you do it/i), { target: { value: 'Apollo Server, schema-first' } });
      fireEvent.click(screen.getByRole('button', { name: /^next$/i }));

      expect(screen.getByText(/question 3 of 3/i)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /save answer/i }));

      await waitFor(() => expect(screen.queryByRole('button', { name: /^answer$/i })).not.toBeInTheDocument());
      expect(screen.getAllByText(/frontend engineer at redwood software/i).length).toBeGreaterThan(0);
      const lastPatch = vi.mocked(workspace.updateCvEvidenceOverlay).mock.calls.at(-1)?.[1];
      expect(lastPatch?.facts).toHaveLength(1);
      expect(lastPatch?.facts?.[0]).toMatchObject({ verification: 'self_reported', parentId: 'experience-1', approval: 'proposed' });
      expect(lastPatch?.requirements?.[0]).toMatchObject({ evidenceClass: 'direct', factIds: [lastPatch?.facts?.[0]?.factId] });
    });

    it('"not my work" records a confirmed-gap fact and marks the requirement a gap the candidate confirmed', async () => {
      const workspace = await seedOneNeedsVerificationRequirement();
      fireEvent.click(screen.getByRole('button', { name: /^answer$/i }));
      fireEvent.click(screen.getByRole('button', { name: /not my work/i }));

      await waitFor(() => expect(screen.queryByRole('button', { name: /^answer$/i })).not.toBeInTheDocument());
      const lastPatch = vi.mocked(workspace.updateCvEvidenceOverlay).mock.calls.at(-1)?.[1];
      expect(lastPatch?.facts?.[0]).toMatchObject({ verification: 'candidate_confirmed_gap' });
      expect(lastPatch?.requirements?.[0]).toMatchObject({ evidenceClass: 'candidate_confirmed_gap' });
    });

    it('"skip" closes the form and saves nothing', async () => {
      const workspace = await seedOneNeedsVerificationRequirement();
      vi.mocked(workspace.updateCvEvidenceOverlay).mockClear();
      fireEvent.click(screen.getByRole('button', { name: /^answer$/i }));
      fireEvent.click(screen.getByRole('button', { name: /skip for now/i }));

      expect(screen.queryByLabelText(/role or project/i)).not.toBeInTheDocument();
      expect(workspace.updateCvEvidenceOverlay).not.toHaveBeenCalled();
    });
  });
});
