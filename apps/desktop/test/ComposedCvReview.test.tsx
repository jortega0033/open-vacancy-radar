import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    exportCvEvidenceOverlay: vi.fn().mockResolvedValue({ saved: true, path: 'C:\\fake\\approved-cv.pdf' }),
  });
}

function baseOverlay(partial: Partial<CvEvidenceOverlayRecord> = {}): CvEvidenceOverlayRecord {
  return {
    id: 'overlay-1',
    cvId: 'cv-1',
    vacancyKey: `url:${VACANCY.url}`,
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
        requirements: [makeRequirement({ evidenceClass: 'needs_verification', anchorParentId: '' })],
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

    fireEvent.click(await screen.findByRole('button', { name: /preview approved cv/i }));

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

    fireEvent.click(await screen.findByRole('button', { name: /preview approved cv/i }));

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
    await screen.findByRole('button', { name: /preview approved cv/i });
    expect(getCvEvidenceOverlay).toHaveBeenCalledTimes(1);

    // RequirementMapping (a sibling component, not this one) resolves it -- simulated here by
    // mutating what the next fetch returns, the way a second IPC round trip would.
    current = { ...current, requirements: [{ ...current.requirements[0]!, reviewed: true, evidenceClass: 'direct' }] };

    fireEvent.click(screen.getByRole('button', { name: /preview approved cv/i }));

    await screen.findByLabelText('Composed CV preview');
    expect(getCvEvidenceOverlay).toHaveBeenCalledTimes(2); // preview re-fetched, not reused from mount
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); // no longer reports the stale gap
  });
});
