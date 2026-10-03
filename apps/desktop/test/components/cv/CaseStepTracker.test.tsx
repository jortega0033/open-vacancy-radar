import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_CV_SOURCE, type CvSourceDocument } from '../../../electron/workspace/cv-source-schema.js';
import { CaseStepTracker } from '../../../src/components/cv/CaseStepTracker.js';
import type { VacancyLead } from '../../../src/components/cv/types.js';
import { caseKeyFor } from '../../../src/components/cv/vacancy-key.js';
import type { CvEvidenceOverlayRecord } from '../../../src/window.js';
import { FIXTURE_JD, FIXTURE_REVISION_ID, makeRequirement, makeRevision } from '../../fixtures/cv-evidence.js';
import { installWorkspaceBridge } from '../../workspace-bridge.js';

const VACANCY: VacancyLead = {
  title: 'Platform Engineer',
  company: 'Northwind',
  location: '',
  url: 'https://jobs.example.invalid/1',
  description: FIXTURE_JD,
  requirements: null,
};
const SOURCE: CvSourceDocument = { ...EMPTY_CV_SOURCE, reviewedAt: '2026-09-30T00:00:00.000Z', summary: 'S.' };

function overlay(partial: Partial<CvEvidenceOverlayRecord> = {}): CvEvidenceOverlayRecord {
  return {
    id: 'o-1',
    cvId: 'cv-1',
    vacancyKey: caseKeyFor(VACANCY),
    caseTitle: '',
    caseCompany: '',
    sourceCvContentHash: 'h',
    jdSnapshot: FIXTURE_JD,
    jdSnapshotHash: 'b'.repeat(64),
    jdComplete: true,
    jdIncompleteReasons: [],
    jdWarning: '',
    jdConfirmedComplete: false,
    jdRevisions: [makeRevision()],
    listingStatus: 'unknown',
    state: 'draft',
    requirements: [makeRequirement({ reviewed: false }), makeRequirement({ requirementId: 'r-2', reviewed: false })],
    requirementCoverage: { status: 'complete', revisionId: FIXTURE_REVISION_ID, batches: 1 },
    facts: [],
    wordingVariants: [],
    origin: 'manual',
    caseRevision: '1',
    approvedResumeSnapshot: null,
    projectSelection: null,
    sourceBaseline: null,
    artifacts: [],
    legacyUnverifiedExport: false,
    capturedAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
    ...partial,
  } as CvEvidenceOverlayRecord;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CaseStepTracker (#446)', () => {
  it('shows all seven steps with a state word each, and one Next line, without scrolling anywhere', async () => {
    installWorkspaceBridge({
      getCvEvidenceOverlay: vi.fn().mockResolvedValue(overlay()),
      previewCvEvidenceRebase: vi.fn().mockResolvedValue({ inputsChanged: false }),
    });
    render(<CaseStepTracker cvId="cv-1" vacancy={VACANCY} sourceCv={SOURCE} />);

    const nav = await screen.findByRole('navigation', { name: 'Tailoring steps' });
    const items = within(nav).getAllByRole('listitem');
    expect(items).toHaveLength(7);
    expect(items[0]).toHaveTextContent('1 Job descriptionDone');
    expect(items[1]).toHaveTextContent('2 RequirementsNeeds you');
    expect(items[2]).toHaveTextContent('3 Your answersBlocked');
    expect(within(nav).getByRole('status')).toHaveTextContent('Next: review 2 requirements');
  });

  it('opens a step by scrolling to its card heading and focusing it', async () => {
    installWorkspaceBridge({
      getCvEvidenceOverlay: vi.fn().mockResolvedValue(overlay()),
      previewCvEvidenceRebase: vi.fn().mockResolvedValue({ inputsChanged: false }),
    });
    render(
      <>
        <CaseStepTracker cvId="cv-1" vacancy={VACANCY} sourceCv={SOURCE} />
        <h2 id="cv-step-requirements" tabIndex={-1}>
          Requirement mapping
        </h2>
      </>,
    );
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    fireEvent.click(await screen.findByRole('button', { name: /^step 2: requirements/i }));

    expect(scrollIntoView).toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Requirement mapping' })).toHaveFocus();
  });

  it('falls back to the nearest earlier card when a step\'s own card is not on screen yet', async () => {
    installWorkspaceBridge({
      getCvEvidenceOverlay: vi.fn().mockResolvedValue(overlay()),
      previewCvEvidenceRebase: vi.fn().mockResolvedValue({ inputsChanged: false }),
    });
    render(
      <>
        <CaseStepTracker cvId="cv-1" vacancy={VACANCY} sourceCv={SOURCE} />
        <h2 id="cv-step-approve" tabIndex={-1}>
          Your tailored CV
        </h2>
      </>,
    );
    Element.prototype.scrollIntoView = vi.fn();
    fireEvent.click(await screen.findByRole('button', { name: /^step 7: files/i }));
    expect(screen.getByRole('heading', { name: 'Your tailored CV' })).toHaveFocus();
  });

  it('re-reads the stored case, so a step finished in a card below turns Done on its own', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const getCvEvidenceOverlay = vi
        .fn()
        .mockResolvedValueOnce(overlay())
        .mockResolvedValue(overlay({ requirements: [makeRequirement()] }));
      installWorkspaceBridge({ getCvEvidenceOverlay, previewCvEvidenceRebase: vi.fn().mockResolvedValue({ inputsChanged: false }) });
      render(<CaseStepTracker cvId="cv-1" vacancy={VACANCY} sourceCv={SOURCE} />);
      expect(await screen.findByText(/next: review 2 requirements/i)).toBeInTheDocument();

      await vi.advanceTimersByTimeAsync(3100);

      await waitFor(() => expect(screen.getByRole('status')).not.toHaveTextContent('review 2 requirements'));
      expect(screen.getByRole('button', { name: /^step 2: requirements\. done/i })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders nothing without a vacancy', () => {
    installWorkspaceBridge();
    const { container } = render(<CaseStepTracker cvId="cv-1" vacancy={null} sourceCv={SOURCE} />);
    expect(container).toBeEmptyDOMElement();
  });
});
