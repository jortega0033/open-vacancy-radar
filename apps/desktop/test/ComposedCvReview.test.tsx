import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_CV_SOURCE } from '../electron/workspace/cv-source-schema.js';
import { ComposedCvReview } from '../src/components/cv/ComposedCvReview.js';
import type { VacancyLead } from '../src/components/cv/types.js';
import type { CvEvidenceOverlayRecord, CvEvidenceOverlayPatch, CvSourceDocument } from '../src/window.js';
import { installWorkspaceBridge } from './workspace-bridge.js';

const VACANCY: VacancyLead = {
  title: 'Senior Frontend Engineer',
  company: 'Redwood Software',
  location: 'Amsterdam, Netherlands',
  url: 'https://example.invalid/jobs/1',
};

const SOURCE: CvSourceDocument = {
  ...EMPTY_CV_SOURCE,
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
      current = { ...current, ...patch };
      return current;
    }),
    exportCvEvidenceOverlay: vi.fn().mockResolvedValue({ saved: true, path: 'C:\\fake\\approved-cv.pdf' }),
  });
}

function baseOverlay(partial: Partial<CvEvidenceOverlayRecord> = {}): CvEvidenceOverlayRecord {
  return {
    id: 'overlay-1',
    cvId: 'cv-1',
    vacancyKey: `url:${VACANCY.url}`,
    sourceCvContentHash: '', // filled by the test to match the real hash of SOURCE
    jdSnapshot: '',
    jdSnapshotHash: 'b'.repeat(64),
    jdComplete: true,
    listingStatus: 'unknown',
    state: 'draft',
    requirements: [],
    facts: [],
    wordingVariants: [],
    capturedAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
    ...partial,
  };
}

async function hashOf(source: CvSourceDocument): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(source));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

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

    fireEvent.click(await screen.findByRole('button', { name: /preview approved cv/i }));

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
    const workspace = installOverlayBridge(baseOverlay({ sourceCvContentHash: hash, state: 'candidate_approved' }));
    render(<ComposedCvReview cvId="cv-1" vacancy={VACANCY} sourceCv={SOURCE} />);

    const pdfButton = await screen.findByRole('button', { name: /export as pdf/i });
    fireEvent.click(pdfButton);

    await waitFor(() => expect(workspace.exportCvEvidenceOverlay).toHaveBeenCalledWith('overlay-1', 'pdf'));
    expect(await screen.findByText(/saved to c:\\fake\\approved-cv\.pdf/i)).toBeInTheDocument();
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
        requirements: [
          { requirementId: 'r-1', text: 'React', jdAnchor: '', classification: 'required', evidenceClass: 'needs_verification', anchorParentId: '', candidateAdded: false, reviewed: true },
        ],
      }),
    );
    render(<ComposedCvReview cvId="cv-1" vacancy={VACANCY} sourceCv={SOURCE} />);

    fireEvent.click(await screen.findByRole('button', { name: /preview approved cv/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/still need verification/i);
    expect(screen.getByRole('button', { name: /^approve cv$/i })).toBeDisabled();
  });

  it('says there is nothing to compose from before requirement mapping has started', () => {
    installWorkspaceBridge({ getCvEvidenceOverlay: vi.fn().mockResolvedValue(null) });
    render(<ComposedCvReview cvId="cv-1" vacancy={VACANCY} sourceCv={SOURCE} />);
    expect(screen.getByText(/map this vacancy/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /preview approved cv/i })).toBeDisabled();
  });
});
