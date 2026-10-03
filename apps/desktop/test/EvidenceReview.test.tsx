import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_CV_SOURCE } from '../electron/workspace/cv-source-schema.js';
import { EvidenceReview } from '../src/components/cv/EvidenceReview.js';
import type { CvEvidenceOverlayPatch, CvEvidenceOverlayRecord, CvSourceDocument } from '../src/window.js';
import { TEST_VACANCY } from './cv-bridges.js';
import { FIXTURE_REVISION_ID, makeFact, makeRevision, makeVariant } from './fixtures/cv-evidence.js';
import { installWorkspaceBridge } from './workspace-bridge.js';

const SOURCE: CvSourceDocument = {
  ...EMPTY_CV_SOURCE,
  experience: [
    { id: 'experience-1', company: 'Redwood Software', title: 'Frontend Engineer', dates: '2021 - Present', engagement: 'employment', client: '', bullets: [] },
  ],
};

function overlay(partial: Partial<CvEvidenceOverlayRecord> = {}): CvEvidenceOverlayRecord {
  return {
    id: 'overlay-1',
    cvId: 'cv-1',
    vacancyKey: `url:${TEST_VACANCY.url}`,
    caseTitle: '',
    caseCompany: '',
    sourceCvContentHash: 'a'.repeat(64),
    jdSnapshot: 'A job description.',
    jdSnapshotHash: 'b'.repeat(64),
    jdComplete: true,
    jdIncompleteReasons: [],
    jdWarning: '',
    jdConfirmedComplete: false,
    jdRevisions: [makeRevision()],
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
    capturedAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...partial,
  };
}

function install(initial: CvEvidenceOverlayRecord) {
  let current = initial;
  return installWorkspaceBridge({
    getCvEvidenceOverlay: vi.fn().mockImplementation(async () => current),
    updateCvEvidenceOverlay: vi.fn().mockImplementation(async (_id: string, patch: CvEvidenceOverlayPatch) => {
      current = { ...current, ...patch } as CvEvidenceOverlayRecord;
      return current;
    }),
  });
}

function renderReview() {
  return render(<EvidenceReview cvId="cv-1" vacancy={TEST_VACANCY} sourceCv={SOURCE} />);
}

const lastPatch = (workspace: ReturnType<typeof install>) => vi.mocked(workspace.updateCvEvidenceOverlay).mock.calls.at(-1)?.[1];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EvidenceReview (#419, step 7)', () => {
  it('shows the facts card with its empty text before any fact exists', async () => {
    install(overlay());
    renderReview();
    expect(await screen.findByText('Facts and wording')).toBeInTheDocument();
    expect(screen.getByText('Facts appear here after you answer a question about a requirement.')).toBeInTheDocument();
    expect(screen.queryByText(/^history/i)).not.toBeInTheDocument();
  });

  it('shows nothing when there is no case to review', async () => {
    const workspace = install(overlay());
    vi.mocked(workspace.getCvEvidenceOverlay).mockResolvedValue(null);
    const { container } = renderReview();
    await waitFor(() => expect(workspace.getCvEvidenceOverlay).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('restores a rejected fact to not approved yet, with the same details and never as approved', async () => {
    const rejected = makeFact({ approval: 'rejected', mechanism: 'Angular and RxJS' });
    const workspace = install(overlay({ facts: [rejected] }));
    renderReview();
    fireEvent.click(await screen.findByText(/history \(1\)/i));
    expect(screen.queryByRole('button', { name: /^approve this fact$/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /restore this fact/i }));
    await waitFor(() => expect(lastPatch(workspace)?.facts?.[0]).toEqual({ ...rejected, approval: 'proposed' }));
    const facts = await screen.findByRole('list', { name: 'Facts' });
    expect(within(facts).getByText(/not approved yet/i)).toBeInTheDocument();
    expect(within(facts).getByText('Angular and RxJS')).toBeInTheDocument();
    expect(screen.getByText(/restored\. it is not approved yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/^history/i)).not.toBeInTheDocument();
  });

  it('restores a rejected wording as a draft and leaves replaced ones without a restore button', async () => {
    const workspace = install(
      overlay({
        facts: [makeFact({ approval: 'approved' })],
        wordingVariants: [
          makeVariant({ variantId: 'v-rejected', status: 'rejected', rejectedAt: '2026-10-01T00:00:00.000Z', text: 'Rejected sentence.' }),
          makeVariant({ variantId: 'v-old', status: 'superseded', text: 'Old sentence.' }),
        ],
      }),
    );
    renderReview();
    fireEvent.click(await screen.findByText(/history \(2\)/i));
    expect(screen.getAllByRole('button', { name: /restore this wording/i })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /restore this wording/i }));
    await waitFor(() => expect(lastPatch(workspace)?.wordingVariants?.find((variant) => variant.variantId === 'v-rejected')?.status).toBe('draft'));
    const wording = await screen.findByRole('list', { name: 'Wording' });
    expect(within(wording).getByText('Rejected sentence.')).toBeInTheDocument();
    expect(within(wording).getByText(/draft, not approved/i)).toBeInTheDocument();
  });

  it('shows the refusal and no restored notice when a restore fails', async () => {
    const workspace = install(overlay({ facts: [makeFact({ approval: 'rejected' })] }));
    renderReview();
    fireEvent.click(await screen.findByText(/history \(1\)/i));
    vi.mocked(workspace.updateCvEvidenceOverlay).mockRejectedValueOnce(new Error('could not be saved'));
    fireEvent.click(screen.getByRole('button', { name: /restore this fact/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be saved/i);
    expect(screen.queryByText(/restored\./i)).not.toBeInTheDocument();
  });

  it('shows every field the candidate approves a fact on, and labels self-report as such', async () => {
    install(
      overlay({
        facts: [
          makeFact({
            approval: 'proposed',
            client: 'Northwind Freight',
            timePhase: 'first year',
            ownership: 'shared',
            mechanism: 'Angular and RxJS',
            result: 'fewer support calls',
            metricValue: '12',
            metricUnit: 'percent',
            metricBasis: 'a report my manager sent',
          }),
        ],
      }),
    );
    renderReview();
    const facts = await screen.findByRole('list', { name: 'Facts' });
    expect(within(facts).getByText('Frontend Engineer at Redwood Software')).toBeInTheDocument();
    expect(within(facts).getByText('Built the booking screens')).toBeInTheDocument();
    expect(within(facts).getByText('Northwind Freight')).toBeInTheDocument();
    expect(within(facts).getByText('first year')).toBeInTheDocument();
    expect(within(facts).getByText('Shared with a team')).toBeInTheDocument();
    expect(within(facts).getByText('Angular and RxJS')).toBeInTheDocument();
    expect(within(facts).getByText('fewer support calls')).toBeInTheDocument();
    expect(within(facts).getByText('12 percent')).toBeInTheDocument();
    expect(within(facts).getByText('You told us')).toBeInTheDocument();
    expect(within(facts).getByText(/not approved yet/i)).toBeInTheDocument();
  });

  it('says a repository revision was found in the project files', async () => {
    install(overlay({ facts: [makeFact({ sourceKind: 'repository_inspection', verification: 'corroborated' })] }));
    renderReview();
    expect(await screen.findByText('Found in your project files')).toBeInTheDocument();
  });

  it('approves a fact only when the candidate asks, and rejects on request', async () => {
    const workspace = install(overlay({ facts: [makeFact({ approval: 'proposed' })] }));
    renderReview();
    fireEvent.click(await screen.findByRole('button', { name: /approve this fact/i }));
    await waitFor(() => expect(lastPatch(workspace)?.facts?.[0]).toMatchObject({ factId: 'fact-1', approval: 'approved' }));

    await screen.findByText('Approved');
    fireEvent.click(screen.getByRole('button', { name: /^reject$/i }));
    await waitFor(() => expect(lastPatch(workspace)?.facts?.[0]?.approval).toBe('rejected'));
    // A rejected fact leaves the live list and stays in the history.
    await screen.findByText(/history \(1\)/i);
  });

  it('corrects a fact by replacing it: the old one is superseded, the new one proposed, and wording on it withdrawn', async () => {
    const workspace = install(overlay({ facts: [makeFact()], wordingVariants: [makeVariant()] }));
    renderReview();
    fireEvent.click(await screen.findByRole('button', { name: /^correct$/i }));
    fireEvent.change(screen.getByLabelText('What you did'), { target: { value: 'Rebuilt the booking screens' } });
    fireEvent.change(screen.getByLabelText(/^when$/i), { target: { value: 'second year' } });
    fireEvent.click(screen.getByRole('button', { name: /replace this fact/i }));

    await waitFor(() => expect(lastPatch(workspace)?.facts).toHaveLength(2));
    const patch = lastPatch(workspace);
    expect(patch?.facts?.[0]).toMatchObject({ factId: 'fact-1', approval: 'superseded' });
    expect(patch?.facts?.[1]).toMatchObject({ supersedes: 'fact-1', approval: 'proposed', activity: 'Rebuilt the booking screens', timePhase: 'second year' });
    expect(patch?.wordingVariants?.[0]).toMatchObject({ variantId: 'v-1', status: 'superseded' });
  });

  it('shows a contradiction and says none of the pair can be used', async () => {
    install(
      overlay({
        state: 'conflict',
        facts: [
          makeFact({ factId: 'fact-1', ownership: 'sole' }),
          makeFact({ factId: 'fact-2', ownership: 'shared', approval: 'proposed' }),
        ],
      }),
    );
    renderReview();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/contradict each other/i);
    expect(alert).toHaveTextContent(/alone/i);
    expect(screen.getAllByText(/in a contradiction/i).length).toBeGreaterThan(0);
  });

  it('proposes wording as drafts from approved facts, and says so when there is nothing to propose', async () => {
    const workspace = install(overlay({ facts: [makeFact()] }));
    renderReview();
    fireEvent.click(await screen.findByRole('button', { name: /propose wording from approved facts/i }));
    await waitFor(() => expect(lastPatch(workspace)?.wordingVariants).toHaveLength(1));
    expect(lastPatch(workspace)?.wordingVariants?.[0]).toMatchObject({ status: 'draft', factIds: ['fact-1'], approvedAt: '' });

    fireEvent.click(await screen.findByRole('button', { name: /propose wording from approved facts/i }));
    expect(await screen.findByText(/no approved fact left without wording/i)).toBeInTheDocument();
  });

  it('shows the exact wording and approves it only on an explicit click', async () => {
    const workspace = install(
      overlay({ facts: [makeFact()], wordingVariants: [makeVariant({ status: 'draft', approvedAt: '', text: 'Built the booking screens, using Angular and RxJS' })] }),
    );
    renderReview();
    const wording = await screen.findByRole('list', { name: 'Wording' });
    expect(within(wording).getByText('Built the booking screens, using Angular and RxJS')).toBeInTheDocument();
    expect(within(wording).getByText(/draft, not approved/i)).toBeInTheDocument();
    expect(vi.mocked(workspace.updateCvEvidenceOverlay)).not.toHaveBeenCalled();

    fireEvent.click(within(wording).getByRole('button', { name: /approve this wording/i }));
    await waitFor(() => expect(lastPatch(workspace)?.wordingVariants?.[0]?.status).toBe('candidate_approved'));
  });

  it('editing a wording saves a new variant and keeps the old one superseded', async () => {
    const workspace = install(overlay({ facts: [makeFact()], wordingVariants: [makeVariant({ text: 'Original sentence.' })] }));
    renderReview();
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    fireEvent.change(screen.getByLabelText('Edited wording'), { target: { value: 'A better sentence.' } });
    fireEvent.click(screen.getByRole('button', { name: /save as new wording/i }));

    await waitFor(() => expect(lastPatch(workspace)?.wordingVariants).toHaveLength(2));
    const [old, replacement] = lastPatch(workspace)?.wordingVariants ?? [];
    expect(old).toMatchObject({ variantId: 'v-1', status: 'superseded', text: 'Original sentence.' });
    expect(replacement).toMatchObject({ status: 'draft', text: 'A better sentence.', supersedes: 'v-1' });
    // The new text is shown as a draft awaiting approval, and the old one moved to history.
    expect(await screen.findByText('A better sentence.')).toBeInTheDocument();
    expect(screen.getByText(/draft, not approved/i)).toBeInTheDocument();
  });

  it('rejects a wording and records it in the history', async () => {
    const workspace = install(overlay({ facts: [makeFact()], wordingVariants: [makeVariant({ status: 'draft', approvedAt: '', text: 'Rejected sentence.' })] }));
    renderReview();
    const wording = await screen.findByRole('list', { name: 'Wording' });
    fireEvent.click(within(wording).getByRole('button', { name: /^reject$/i }));
    await waitFor(() => expect(lastPatch(workspace)?.wordingVariants?.[0]?.status).toBe('rejected'));
    fireEvent.click(await screen.findByText(/history \(1\)/i));
    expect(screen.getByText(/wording rejected: rejected sentence\./i)).toBeInTheDocument();
  });

  it('shows the server refusal instead of pretending the change worked', async () => {
    install(overlay({ facts: [makeFact({ approval: 'proposed' })] }));
    vi.mocked(window.workspace.updateCvEvidenceOverlay).mockRejectedValueOnce(new Error('a rejected or replaced fact cannot be reused'));
    renderReview();
    fireEvent.click(await screen.findByRole('button', { name: /approve this fact/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot be reused/i);
  });
});
