import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_CV_SOURCE } from '../electron/workspace/cv-source-schema.js';
import { TailoringProposalsPanel } from '../src/components/cv/TailoringProposalsPanel.js';
import type { CvEvidenceOverlayRecord, CvSourceDocument, CvTailoringProposalRecord } from '../src/window.js';
import { TEST_VACANCY } from './cv-bridges.js';
import { installWorkspaceBridge } from './workspace-bridge.js';

const SOURCE: CvSourceDocument = {
  ...EMPTY_CV_SOURCE,
  experience: [
    { id: 'experience-1', company: 'Redwood Software', title: 'Frontend Engineer', dates: '', engagement: 'employment', client: '', bullets: [] },
  ],
};

function overlay(partial: Partial<CvEvidenceOverlayRecord> = {}): CvEvidenceOverlayRecord {
  return {
    id: 'overlay-1',
    cvId: 'cv-1',
    vacancyKey: `url:${TEST_VACANCY.url}`,
    sourceCvContentHash: '',
    jdSnapshot: '',
    jdSnapshotHash: 'b'.repeat(64),
    jdComplete: true,
    jdIncompleteReasons: [],
    jdWarning: '',
    jdConfirmedComplete: false,
    jdRevisions: [],
    listingStatus: 'unknown',
    state: 'draft',
    requirements: [],
    requirementCoverage: { status: 'not_run', revisionId: '', batches: 0 },
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

function proposal(partial: Partial<CvTailoringProposalRecord> = {}): CvTailoringProposalRecord {
  return {
    id: 'proposal-1',
    caseId: 'overlay-1',
    grantId: 'grant-1',
    status: 'pending',
    payload: { kind: 'requirement', data: { text: 'Node.js experience', jdAnchor: '', classification: 'required', evidenceClass: 'needs_verification', anchorParentId: '' } },
    caseRevisionAtProposal: '1',
    createdAt: '2026-10-01T00:00:00.000Z',
    decidedAt: '',
    ...partial,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TailoringProposalsPanel (#421)', () => {
  it('renders nothing when there is no case yet', async () => {
    installWorkspaceBridge({ getCvEvidenceOverlay: vi.fn().mockResolvedValue(null) });
    const { container } = render(<TailoringProposalsPanel cvId="cv-1" vacancy={TEST_VACANCY} sourceCv={SOURCE} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('renders nothing when the case has no pending proposals', async () => {
    installWorkspaceBridge({
      getCvEvidenceOverlay: vi.fn().mockResolvedValue(overlay()),
      listCvTailoringProposals: vi.fn().mockResolvedValue([]),
    });
    const { container } = render(<TailoringProposalsPanel cvId="cv-1" vacancy={TEST_VACANCY} sourceCv={SOURCE} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('describes a requirement proposal in plain language and accepts it', async () => {
    const acceptCvTailoringProposal = vi.fn().mockResolvedValue({ proposal: proposal({ status: 'accepted' }), overlay: overlay() });
    installWorkspaceBridge({
      getCvEvidenceOverlay: vi.fn().mockResolvedValue(overlay()),
      listCvTailoringProposals: vi.fn().mockResolvedValue([proposal()]),
      acceptCvTailoringProposal,
    });
    render(<TailoringProposalsPanel cvId="cv-1" vacancy={TEST_VACANCY} sourceCv={SOURCE} />);

    expect(await screen.findByText(/new requirement: "node\.js experience"/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^accept$/i }));
    await waitFor(() => expect(acceptCvTailoringProposal).toHaveBeenCalledWith('proposal-1'));
    await waitFor(() => expect(screen.queryByText(/new requirement/i)).not.toBeInTheDocument());
  });

  it('describes a fact proposal naming the real role it is anchored to', async () => {
    const factProposal = proposal({
      id: 'proposal-2',
      payload: { kind: 'fact', data: { parentId: 'experience-1', parentType: 'experience', client: '', activity: 'Rebuilt the checkout flow', mechanism: 'React', result: 'fewer drop-offs', ownership: 'sole', sourceReference: '', metricValue: '', metricUnit: '', metricBasis: '' } },
    });
    installWorkspaceBridge({
      getCvEvidenceOverlay: vi.fn().mockResolvedValue(overlay()),
      listCvTailoringProposals: vi.fn().mockResolvedValue([factProposal]),
    });
    render(<TailoringProposalsPanel cvId="cv-1" vacancy={TEST_VACANCY} sourceCv={SOURCE} />);
    expect(await screen.findByText(/rebuilt the checkout flow.*frontend engineer at redwood software/i)).toBeInTheDocument();
  });

  it('rejects a proposal and removes it from the list', async () => {
    const rejectCvTailoringProposal = vi.fn().mockResolvedValue(proposal({ status: 'rejected' }));
    installWorkspaceBridge({
      getCvEvidenceOverlay: vi.fn().mockResolvedValue(overlay()),
      listCvTailoringProposals: vi.fn().mockResolvedValue([proposal()]),
      rejectCvTailoringProposal,
    });
    render(<TailoringProposalsPanel cvId="cv-1" vacancy={TEST_VACANCY} sourceCv={SOURCE} />);
    await screen.findByText(/new requirement/i);
    fireEvent.click(screen.getByRole('button', { name: /^reject$/i }));
    await waitFor(() => expect(rejectCvTailoringProposal).toHaveBeenCalledWith('proposal-1'));
    await waitFor(() => expect(screen.queryByText(/new requirement/i)).not.toBeInTheDocument());
  });

  it('shows an error and keeps the proposal listed when accepting fails', async () => {
    installWorkspaceBridge({
      getCvEvidenceOverlay: vi.fn().mockResolvedValue(overlay()),
      listCvTailoringProposals: vi.fn().mockResolvedValue([proposal()]),
      acceptCvTailoringProposal: vi.fn().mockRejectedValue(new Error('case has changed since it was last read')),
    });
    render(<TailoringProposalsPanel cvId="cv-1" vacancy={TEST_VACANCY} sourceCv={SOURCE} />);
    await screen.findByText(/new requirement/i);
    fireEvent.click(screen.getByRole('button', { name: /^accept$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/case has changed/i);
    expect(screen.getByText(/new requirement/i)).toBeInTheDocument();
  });
});
