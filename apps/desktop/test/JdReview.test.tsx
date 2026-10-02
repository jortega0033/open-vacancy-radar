import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CvAssistant } from '../src/components/cv/CvAssistant.js';
import { JdReview } from '../src/components/cv/JdReview.js';
import type { VacancyLead } from '../src/components/cv/types.js';
import type { CvDocumentRecord, CvEvidenceOverlayRecord } from '../src/window.js';
import { installBridges } from './cv-bridges.js';
import { FULL_JD } from './fixtures/job-description.js';
import { installWorkspaceBridge } from './workspace-bridge.js';

const FOUND: VacancyLead = {
  title: 'Logistics Platform Engineer',
  company: 'Northwind Freight',
  location: 'Rotterdam',
  url: 'https://jobs.example.invalid/logistics',
  description: FULL_JD,
  requirements: null,
  jdOrigin: 'found',
};

const SHORT_FOUND: VacancyLead = { ...FOUND, description: 'We need an engineer who must know TypeScript.' };
const ABSENT: VacancyLead = { ...FOUND, description: null };

function overlay(partial: Partial<CvEvidenceOverlayRecord> = {}): CvEvidenceOverlayRecord {
  return {
    id: 'overlay-1',
    cvId: 'cv-1',
    vacancyKey: `url:${FOUND.url}`,
    caseTitle: '',
    caseCompany: '',
    sourceCvContentHash: 'a'.repeat(64),
    jdSnapshot: FULL_JD,
    jdSnapshotHash: 'b'.repeat(64),
    jdComplete: true,
    jdIncompleteReasons: [],
    jdWarning: '',
    jdConfirmedComplete: false,
    jdRevisions: [
      {
        revisionId: 'rev-1',
        text: FULL_JD,
        textHash: 'c'.repeat(64),
        complete: true,
        capturedAt: '2026-10-01T09:00:00.000Z',
        origin: 'found',
        url: FOUND.url,
        requisition: '',
        incompleteReasons: [],
        warning: '',
      },
    ],
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
    capturedAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    ...partial,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('JdReview (#419, step 4)', () => {
  it('shows the full posting text a found vacancy carries, with its origin', () => {
    installWorkspaceBridge();
    render(<JdReview cvId="cv-1" vacancy={FOUND} onReplaceText={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.getByLabelText('Full job description text')).toHaveTextContent('Northwind Freight is hiring a Logistics Platform Engineer');
    expect(screen.getByText(/Posting text from the search result/)).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: /completeness/i })).not.toBeInTheDocument();
  });

  it('says plainly that no posting text arrived, and fetches nothing', () => {
    installWorkspaceBridge();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<JdReview cvId="cv-1" vacancy={ABSENT} onReplaceText={vi.fn()} onSaved={vi.fn()} />);

    expect(screen.getByText(/No posting text came with this vacancy/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Full job description text')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /paste job description/i })).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows the completeness warning for a short posting', () => {
    installWorkspaceBridge();
    render(<JdReview cvId="cv-1" vacancy={SHORT_FOUND} onReplaceText={vi.fn()} onSaved={vi.fn()} />);

    const warning = screen.getByRole('status', { name: /completeness/i });
    expect(warning).toHaveTextContent(/characters of posting text were captured/);
  });

  it('saves the found text as the case JD with its origin and URL', async () => {
    const createCvEvidenceOverlay = vi.fn().mockResolvedValue(overlay());
    installWorkspaceBridge({ createCvEvidenceOverlay });
    const onSaved = vi.fn();
    render(<JdReview cvId="cv-1" vacancy={FOUND} onReplaceText={vi.fn()} onSaved={onSaved} />);

    fireEvent.click(screen.getByRole('button', { name: /save job description/i }));

    await waitFor(() => expect(createCvEvidenceOverlay).toHaveBeenCalled());
    expect(createCvEvidenceOverlay).toHaveBeenCalledWith(
      expect.objectContaining({
        cvId: 'cv-1',
        vacancyKey: `url:${FOUND.url}`,
        jdSnapshot: FULL_JD,
        origin: 'vacancy',
        jdOrigin: 'found',
        jdUrl: FOUND.url,
      }),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(await screen.findByText(/Saved as revision 1/)).toHaveTextContent('Text check cccccccccccc');
  });

  it('pasting a replacement hands the new text up and saves it as a new pasted revision', async () => {
    const updateCvEvidenceOverlay = vi.fn().mockResolvedValue(overlay({ jdSnapshot: 'Pasted text.' }));
    installWorkspaceBridge({ getCvEvidenceOverlay: vi.fn().mockResolvedValue(overlay()), updateCvEvidenceOverlay });
    const onReplaceText = vi.fn();
    render(<JdReview cvId="cv-1" vacancy={FOUND} onReplaceText={onReplaceText} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /replace job description/i }));
    fireEvent.change(screen.getByLabelText('Job description text'), { target: { value: '  Pasted text.  ' } });
    fireEvent.change(screen.getByLabelText(/requisition/i), { target: { value: 'REQ-9' } });
    fireEvent.click(screen.getByRole('button', { name: /use this text/i }));

    expect(onReplaceText).toHaveBeenCalledWith('Pasted text.', 'REQ-9');
    await waitFor(() => expect(updateCvEvidenceOverlay).toHaveBeenCalled());
    expect(updateCvEvidenceOverlay).toHaveBeenCalledWith(
      'overlay-1',
      expect.objectContaining({ jdSnapshot: 'Pasted text.', jdOrigin: 'pasted', jdRequisition: 'REQ-9' }),
    );
  });

  it('offers the confirmation for a short saved JD, and records it', async () => {
    const saved = overlay({
      jdSnapshot: SHORT_FOUND.description as string,
      jdComplete: false,
      jdIncompleteReasons: ['posting_text_too_thin'],
      jdWarning: 'short',
    });
    const updateCvEvidenceOverlay = vi.fn().mockResolvedValue({ ...saved, jdConfirmedComplete: true });
    installWorkspaceBridge({ getCvEvidenceOverlay: vi.fn().mockResolvedValue(saved), updateCvEvidenceOverlay });
    render(<JdReview cvId="cv-1" vacancy={SHORT_FOUND} onReplaceText={vi.fn()} onSaved={vi.fn()} />);

    const checkbox = await screen.findByRole('checkbox', { name: /read the whole job description/i });
    fireEvent.click(checkbox);

    await waitFor(() => expect(updateCvEvidenceOverlay).toHaveBeenCalledWith('overlay-1', { jdConfirmedComplete: true }));
  });

  it('never offers the confirmation for a cut-off JD', async () => {
    const saved = overlay({ jdComplete: false, jdIncompleteReasons: ['truncated_at_source'], jdWarning: 'cut off' });
    installWorkspaceBridge({ getCvEvidenceOverlay: vi.fn().mockResolvedValue(saved) });
    render(<JdReview cvId="cv-1" vacancy={FOUND} onReplaceText={vi.fn()} onSaved={vi.fn()} />);

    await screen.findByText(/Saved as revision 1/);
    expect(screen.queryByRole('checkbox', { name: /read the whole job description/i })).not.toBeInTheDocument();
  });

  it('keeps the save disabled until a CV is selected', () => {
    installWorkspaceBridge();
    render(<JdReview cvId={null} vacancy={FOUND} onReplaceText={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByRole('button', { name: /save job description/i })).toBeDisabled();
  });
});

describe('CvAssistant job description handoff (#419, steps 1 and 4)', () => {
  function makeCv(): CvDocumentRecord {
    return {
      id: 'cv-1',
      name: 'Frontend CV',
      kind: 'uploaded',
      targetRole: '',
      text: 'Angular architect.',
      profile: { title: '', years: '', location: '', languages: '', skills: [], summary: '', auth: '' },
      source: null,
      textSource: 'text_layer',
      isDefault: true,
      uploadedAt: '2026-08-01T09:00:00.000Z',
      updatedAt: '2026-08-01T09:00:00.000Z',
    };
  }

  it('passes the real posting text of a found vacancy into the workspace', async () => {
    installBridges();
    installWorkspaceBridge({ listCvDocuments: vi.fn().mockResolvedValue([makeCv()]) });
    render(<CvAssistant vacancy={FOUND} />);

    expect(await screen.findByLabelText('Full job description text')).toHaveTextContent('Requirements:');
    expect(screen.getByLabelText('Full job description text')).toHaveTextContent('Fluent English is essential');
  });

  it('lets the candidate paste a JD over a vacancy that arrived with none', async () => {
    installBridges();
    const createCvEvidenceOverlay = vi.fn().mockResolvedValue(overlay({ jdSnapshot: 'My pasted posting text.' }));
    installWorkspaceBridge({ listCvDocuments: vi.fn().mockResolvedValue([makeCv()]), createCvEvidenceOverlay });
    render(<CvAssistant vacancy={ABSENT} />);

    expect(await screen.findByText(/No posting text came with this vacancy/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /paste job description/i }));
    fireEvent.change(screen.getByLabelText('Job description text'), { target: { value: 'My pasted posting text.' } });
    fireEvent.click(screen.getByRole('button', { name: /use this text/i }));

    expect(await screen.findByLabelText('Full job description text')).toHaveTextContent('My pasted posting text.');
    await waitFor(() =>
      expect(createCvEvidenceOverlay).toHaveBeenCalledWith(
        expect.objectContaining({ jdSnapshot: 'My pasted posting text.', jdOrigin: 'pasted' }),
      ),
    );
  });

  it('shows the stored pasted text after a remount, and creates no revision of its own', async () => {
    installBridges();
    const pasted = overlay({
      jdSnapshot: 'My earlier pasted posting text.',
      jdRevisions: [
        ...overlay().jdRevisions,
        {
          revisionId: 'rev-2',
          text: 'My earlier pasted posting text.',
          textHash: 'd'.repeat(64),
          complete: true,
          capturedAt: '2026-10-01T10:00:00.000Z',
          origin: 'pasted',
          url: FOUND.url,
          requisition: 'REQ-7',
          incompleteReasons: [],
          warning: '',
        },
      ],
    });
    const updateCvEvidenceOverlay = vi.fn();
    const createCvEvidenceOverlay = vi.fn();
    installWorkspaceBridge({
      listCvDocuments: vi.fn().mockResolvedValue([makeCv()]),
      getCvEvidenceOverlay: vi.fn().mockResolvedValue(pasted),
      updateCvEvidenceOverlay,
      createCvEvidenceOverlay,
    });
    // The vacancy still carries its original posting text, as it does every time the screen opens.
    render(<CvAssistant vacancy={FOUND} />);

    await waitFor(() => expect(screen.getByLabelText('Full job description text')).toHaveTextContent('My earlier pasted posting text.'));
    expect(screen.getByLabelText('Full job description text')).not.toHaveTextContent('Fluent English is essential');
    expect(screen.getByText(/Text you pasted/)).toHaveTextContent('requisition REQ-7');
    expect(updateCvEvidenceOverlay).not.toHaveBeenCalled();
    expect(createCvEvidenceOverlay).not.toHaveBeenCalled();
  });

  it('JdReview itself prefers the stored latest revision over the text the vacancy carries', async () => {
    installWorkspaceBridge({
      getCvEvidenceOverlay: vi.fn().mockResolvedValue(overlay({ jdSnapshot: 'Stored replacement text.' })),
    });
    render(<JdReview cvId="cv-1" vacancy={FOUND} onReplaceText={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('Full job description text')).toHaveTextContent('Stored replacement text.'));
    expect(screen.getByRole('button', { name: /save as new revision/i })).toBeDisabled();
  });

  it('replacing the text writes exactly one update and no create', async () => {
    const updateCvEvidenceOverlay = vi.fn().mockResolvedValue(overlay({ jdSnapshot: 'Pasted text.' }));
    const createCvEvidenceOverlay = vi.fn();
    installWorkspaceBridge({ getCvEvidenceOverlay: vi.fn().mockResolvedValue(overlay()), updateCvEvidenceOverlay, createCvEvidenceOverlay });
    render(<JdReview cvId="cv-1" vacancy={FOUND} onReplaceText={vi.fn()} onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /replace job description/i }));
    fireEvent.change(screen.getByLabelText('Job description text'), { target: { value: 'Pasted text.' } });
    fireEvent.click(screen.getByRole('button', { name: /use this text/i }));

    await waitFor(() => expect(updateCvEvidenceOverlay).toHaveBeenCalledTimes(1));
    expect(createCvEvidenceOverlay).not.toHaveBeenCalled();
  });

  it('uses the minted case key of a manual vacancy rather than one derived from its fields', async () => {
    installBridges();
    const getCvEvidenceOverlay = vi.fn().mockResolvedValue(null);
    installWorkspaceBridge({ listCvDocuments: vi.fn().mockResolvedValue([makeCv()]), getCvEvidenceOverlay });
    render(<CvAssistant vacancy={{ ...FOUND, url: '', caseKey: 'manual:test-key', jdOrigin: 'manual' }} />);

    await waitFor(() => expect(getCvEvidenceOverlay).toHaveBeenCalledWith('cv-1', 'manual:test-key'));
    expect(getCvEvidenceOverlay).not.toHaveBeenCalledWith('cv-1', expect.stringMatching(/^(url|fields):/));
  });

  it('explains when the selected CV has no reviewed structured source', async () => {
    installBridges();
    installWorkspaceBridge({ listCvDocuments: vi.fn().mockResolvedValue([makeCv()]) });
    render(<CvAssistant vacancy={FOUND} />);

    expect(await screen.findByText(/no reviewed structured source yet/i)).toBeInTheDocument();
  });
});

describe('JdReview confirms before a replacement clears reviews (#450)', () => {
  const REVIEWED = {
    requirementId: 'req-1',
    text: 'Owns the GraphQL gateway',
    jdAnchor: 'GraphQL',
    classification: 'required' as const,
    evidenceClass: 'direct' as const,
    anchorParentId: '',
    candidateAdded: false,
    reviewed: true,
    quoteStart: 0,
    quoteEnd: 7,
    jdRevisionId: 'rev-1',
    excluded: false,
    exclusionReason: '',
    sourceIds: [],
    factIds: [],
  };

  function openPaste(text: string) {
    fireEvent.click(screen.getByRole('button', { name: /replace job description/i }));
    fireEvent.change(screen.getByLabelText('Job description text'), { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: /use this text/i }));
  }

  it('asks first when requirements were reviewed, and writes nothing until the candidate confirms', async () => {
    const reviewed = overlay({ requirements: [REVIEWED] });
    const updateCvEvidenceOverlay = vi.fn().mockResolvedValue(overlay({ jdSnapshot: 'New posting text.' }));
    installWorkspaceBridge({ getCvEvidenceOverlay: vi.fn().mockResolvedValue(reviewed), updateCvEvidenceOverlay });
    const onReplaceText = vi.fn();
    render(<JdReview cvId="cv-1" vacancy={FOUND} onReplaceText={onReplaceText} onSaved={vi.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('Full job description text')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: /replace job description/i })).toBeEnabled());
    await screen.findByText(/Saved as revision 1/);

    openPaste('New posting text.');

    const dialog = await screen.findByRole('alertdialog', { name: 'Replace the job description?' });
    expect(dialog).toHaveTextContent('Logistics Platform Engineer at Northwind Freight');
    expect(dialog).toHaveTextContent(
      'Your requirement reviews and the CV approval for this job are cleared. You will review the requirements again.',
    );
    expect(updateCvEvidenceOverlay).not.toHaveBeenCalled();
    expect(onReplaceText).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Replace and clear reviews' }));

    await waitFor(() => expect(updateCvEvidenceOverlay).toHaveBeenCalledTimes(1));
    expect(updateCvEvidenceOverlay).toHaveBeenCalledWith(
      'overlay-1',
      expect.objectContaining({ jdSnapshot: 'New posting text.', jdOrigin: 'pasted' }),
    );
    expect(onReplaceText).toHaveBeenCalledWith('New posting text.', '');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('asks first for an approved case, and Keep current text leaves the case and the pasted draft alone', async () => {
    const updateCvEvidenceOverlay = vi.fn();
    installWorkspaceBridge({
      getCvEvidenceOverlay: vi.fn().mockResolvedValue(overlay({ state: 'candidate_approved' })),
      updateCvEvidenceOverlay,
    });
    const onReplaceText = vi.fn();
    render(<JdReview cvId="cv-1" vacancy={FOUND} onReplaceText={onReplaceText} onSaved={vi.fn()} />);
    await screen.findByText(/Saved as revision 1/);

    openPaste('Draft I want to keep.');
    await screen.findByRole('alertdialog', { name: 'Replace the job description?' });
    fireEvent.click(screen.getByRole('button', { name: 'Keep current text' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(updateCvEvidenceOverlay).not.toHaveBeenCalled();
    expect(onReplaceText).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Job description text')).toHaveValue('Draft I want to keep.');
    expect(screen.getByLabelText('Full job description text')).toHaveTextContent('Northwind Freight is hiring');
  });

  it('keeps the one-click path when nothing has been reviewed or approved', async () => {
    const updateCvEvidenceOverlay = vi.fn().mockResolvedValue(overlay({ jdSnapshot: 'Pasted text.' }));
    installWorkspaceBridge({
      getCvEvidenceOverlay: vi.fn().mockResolvedValue(overlay({ requirements: [{ ...REVIEWED, reviewed: false }] })),
      updateCvEvidenceOverlay,
    });
    render(<JdReview cvId="cv-1" vacancy={FOUND} onReplaceText={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByText(/Saved as revision 1/);

    openPaste('Pasted text.');

    await waitFor(() => expect(updateCvEvidenceOverlay).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('does not ask when the pasted text is the text already saved', async () => {
    const updateCvEvidenceOverlay = vi.fn().mockResolvedValue(overlay({ requirements: [REVIEWED] }));
    installWorkspaceBridge({
      getCvEvidenceOverlay: vi.fn().mockResolvedValue(overlay({ requirements: [REVIEWED] })),
      updateCvEvidenceOverlay,
    });
    render(<JdReview cvId="cv-1" vacancy={FOUND} onReplaceText={vi.fn()} onSaved={vi.fn()} />);
    await screen.findByText(/Saved as revision 1/);

    openPaste(`  ${FULL_JD}  `);

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => expect(updateCvEvidenceOverlay).toHaveBeenCalledTimes(1));
  });
});
