import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CvLibraryPage } from '../src/components/cv-library/CvLibraryPage.js';
import { describeNextStep, describeTailoringCase, vacancyFromCase } from '../src/components/cv-library/tailoring-cases.js';
import { CV_RENDER_CONTRACT_VERSION } from '../electron/workspace/cv-evidence-schema.js';
import type { CvArtifactRecord, CvDocumentRecord, CvEvidenceOverlayRecord } from '../src/window.js';
import { installBridges } from './cv-bridges.js';
import { FIXTURE_REVISION_ID, makeFact, makeRequirement } from './fixtures/cv-evidence.js';
import { FULL_JD } from './fixtures/job-description.js';
import { installWorkspaceBridge } from './workspace-bridge.js';

/** Reopening existing tailoring cases from the CV Library (#419). */

const CV: CvDocumentRecord = {
  id: 'cv-1',
  name: 'Frontend CV.pdf',
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

const STORED_JD = `${FULL_JD}\nAlso: you will own the GraphQL gateway.`;

function makeCase(partial: Partial<CvEvidenceOverlayRecord> = {}): CvEvidenceOverlayRecord {
  return {
    id: 'overlay-manual',
    cvId: 'cv-1',
    vacancyKey: 'manual:abc-123',
    caseTitle: 'Platform Engineer',
    caseCompany: 'Northwind Freight',
    sourceCvContentHash: 'a'.repeat(64),
    jdSnapshot: STORED_JD,
    jdSnapshotHash: 'b'.repeat(64),
    jdComplete: true,
    jdIncompleteReasons: [],
    jdWarning: '',
    jdConfirmedComplete: false,
    jdRevisions: [
      {
        revisionId: 'rev-1',
        text: STORED_JD,
        textHash: 'c'.repeat(64),
        complete: true,
        capturedAt: '2026-10-01T09:00:00.000Z',
        origin: 'manual',
        url: 'https://jobs.example.invalid/platform',
        requisition: 'REQ-12',
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
    origin: 'manual',
    caseRevision: '4',
    approvedResumeSnapshot: null,
    projectSelection: null,
    sourceBaseline: null,
    artifacts: [],
    legacyUnverifiedExport: false,
    capturedAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-02T09:00:00.000Z',
    ...partial,
  };
}

function pdfArtifact(snapshotDigest: string, snapshotApprovedAt: string): CvArtifactRecord {
  return {
    artifactId: 'artifact-1',
    format: 'pdf',
    contentHash: 'e'.repeat(64),
    exportedAt: '2026-10-02T08:00:00.000Z',
    snapshotDigest,
    snapshotApprovedAt,
    renderContractVersion: CV_RENDER_CONTRACT_VERSION,
    validation: { ok: true, reasons: [], pageCount: 1 },
    savedPath: 'C:\\fake\\cv.pdf',
    reviewOpenedAt: '',
    pagesViewedAt: '',
    confirmedAt: '',
  };
}

/** The library page is heavy to load, so a loaded machine needs more than testing-library's default second. */
const SLOW = { timeout: 8000 };
vi.setConfig({ testTimeout: 20_000 });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('describeTailoringCase and vacancyFromCase', () => {
  it('labels a case by its stored role and company, and falls back to its key', () => {
    expect(describeTailoringCase(makeCase())).toBe('Platform Engineer at Northwind Freight');
    expect(describeTailoringCase(makeCase({ caseTitle: '', caseCompany: '', vacancyKey: 'fields:data engineer|acme|' }))).toBe(
      'data engineer at acme',
    );
    expect(
      describeTailoringCase(makeCase({ caseTitle: '', caseCompany: '', vacancyKey: 'url:https://jobs.example.invalid/9' })),
    ).toBe('https://jobs.example.invalid/9');
  });

  it('builds the vacancy from what the case stored, under the case key it was saved with', () => {
    expect(vacancyFromCase(makeCase())).toMatchObject({
      title: 'Platform Engineer',
      company: 'Northwind Freight',
      url: 'https://jobs.example.invalid/platform',
      description: STORED_JD,
      caseKey: 'manual:abc-123',
      jdOrigin: 'manual',
      jdRequisition: 'REQ-12',
    });
  });
});

describe('reopening tailoring cases from the CV Library', () => {
  it('lists each case with its origin, state, per-format file status and opens a manual case on its stored job description', async () => {
    installBridges();
    const approved = makeCase({
      id: 'overlay-found',
      vacancyKey: 'url:https://jobs.example.invalid/found',
      caseTitle: 'Data Engineer',
      caseCompany: 'Acme',
      origin: 'vacancy',
      state: 'candidate_approved',
      approvedResumeSnapshot: {
        renderContractVersion: CV_RENDER_CONTRACT_VERSION,
        resume: {
          contact: { name: 'Sam Doe', title: '', location: '', email: '', phone: '', links: [] },
          summary: '',
          experience: [],
          projects: [],
          skills: [],
          education: [],
        },
        digest: 'd'.repeat(64),
        approvedAt: '2026-10-01T10:00:00.000Z',
        caseRevision: '5',
      },
      artifacts: [pdfArtifact('d'.repeat(64), '2026-10-01T10:00:00.000Z')],
    });
    const manual = makeCase();
    const getCvEvidenceOverlay = vi
      .fn()
      .mockImplementation(async (_cvId: string, key: string) => (key === manual.vacancyKey ? manual : approved));
    installWorkspaceBridge({
      listCvDocuments: vi.fn().mockResolvedValue([CV]),
      listCvEvidenceOverlays: vi.fn().mockResolvedValue([manual, approved]),
      getCvEvidenceOverlay,
    });

    render(<CvLibraryPage />);

    const table = await screen.findByRole('table', { name: 'Tailoring cases for Frontend CV.pdf' }, SLOW);
    const rows = within(table).getAllByRole('row');
    const manualRow = rows.find((row) => within(row).queryByText('Platform Engineer at Northwind Freight'));
    const foundRow = rows.find((row) => within(row).queryByText('Data Engineer at Acme'));
    expect(manualRow).toBeDefined();
    expect(foundRow).toBeDefined();
    expect(manualRow).toHaveTextContent('Job you entered');
    expect(manualRow).toHaveTextContent('In progress');
    expect(manualRow).toHaveTextContent('not exported');
    expect(manualRow).toHaveTextContent('Map the requirements');
    expect(foundRow).toHaveTextContent('Found vacancy');
    expect(foundRow).toHaveTextContent('CV approved');
    expect(foundRow).toHaveTextContent('waiting for your review');
    expect(foundRow).toHaveTextContent('Review PDF');

    fireEvent.click(screen.getByRole('button', { name: 'Open Platform Engineer at Northwind Freight' }));

    await waitFor(() => expect(getCvEvidenceOverlay).toHaveBeenCalledWith('cv-1', 'manual:abc-123'));
    expect(await screen.findByLabelText('Full job description text', undefined, SLOW)).toHaveTextContent('you will own the GraphQL gateway');
    expect(screen.getByText('Platform Engineer')).toBeInTheDocument();
    expect(screen.getByText(/^Saved on /)).toBeInTheDocument();
  });

  it('reopens a found-vacancy case on its stored text and its own CV, without saving anything', async () => {
    installBridges();
    const found = makeCase({
      id: 'overlay-found',
      cvId: 'cv-2',
      vacancyKey: 'url:https://jobs.example.invalid/found',
      origin: 'vacancy',
      jdRevisions: [
        {
          revisionId: 'rev-1',
          text: 'Original posting.',
          textHash: 'c'.repeat(64),
          complete: true,
          capturedAt: '2026-10-01T09:00:00.000Z',
          origin: 'found',
          url: 'https://jobs.example.invalid/found',
          requisition: '',
          incompleteReasons: [],
          warning: '',
        },
        {
          revisionId: 'rev-2',
          text: STORED_JD,
          textHash: 'd'.repeat(64),
          complete: true,
          capturedAt: '2026-10-02T09:00:00.000Z',
          origin: 'pasted',
          url: 'https://jobs.example.invalid/found',
          requisition: '',
          incompleteReasons: [],
          warning: '',
        },
      ],
    });
    const updateCvEvidenceOverlay = vi.fn();
    const createCvEvidenceOverlay = vi.fn();
    const other: CvDocumentRecord = { ...CV, id: 'cv-2', name: 'Backend CV.pdf', isDefault: false };
    installWorkspaceBridge({
      listCvDocuments: vi.fn().mockResolvedValue([CV, other]),
      listCvEvidenceOverlays: vi.fn().mockImplementation(async (cvId: string) => (cvId === 'cv-2' ? [found] : [])),
      getCvEvidenceOverlay: vi.fn().mockResolvedValue(found),
      updateCvEvidenceOverlay,
      createCvEvidenceOverlay,
    });

    render(<CvLibraryPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Open Platform Engineer at Northwind Freight$/ }, SLOW));

    expect(await screen.findByLabelText('Full job description text', undefined, SLOW)).toHaveTextContent('you will own the GraphQL gateway');
    expect(screen.getByRole('combobox', { name: /use saved cv/i })).toHaveValue('cv-2');
    expect(screen.getByText(/Text you pasted/)).toBeInTheDocument();
    expect(screen.getByText(/^Saved on /)).toBeInTheDocument();
    expect(updateCvEvidenceOverlay).not.toHaveBeenCalled();
    expect(createCvEvidenceOverlay).not.toHaveBeenCalled();
  });

  it('says where cases come from when there are none, instead of rendering nothing', async () => {
    installBridges();
    installWorkspaceBridge({
      listCvDocuments: vi.fn().mockResolvedValue([CV]),
      listCvEvidenceOverlays: vi.fn().mockResolvedValue([]),
    });
    render(<CvLibraryPage />);
    await screen.findByText('Frontend CV.pdf');
    expect(await screen.findByRole('heading', { name: 'Tailoring cases' }, SLOW)).toBeInTheDocument();
    expect(await screen.findByText('Cases you start with Tailor for a job, or from a vacancy, appear here.', undefined, SLOW)).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: /tailoring cases for/i })).not.toBeInTheDocument();
  });
});

describe('a CV change that puts cases on hold (#449)', () => {
  it('labels a draft case "CV changed, review needed" only when the CV changed, and keeps "In progress" otherwise', async () => {
    installBridges();
    const held = makeCase({ id: 'overlay-held', vacancyKey: 'manual:held', caseTitle: 'Held Role', caseCompany: 'Held Co' });
    const plain = makeCase({ id: 'overlay-plain', vacancyKey: 'manual:plain', caseTitle: 'Plain Role', caseCompany: 'Plain Co' });
    const rebasePlan = (inputsChanged: boolean) => ({
      baselineKnown: true,
      inputsChanged,
      changes: [],
      keptVariantIds: [],
      droppedVariants: [],
      orphanedFactIds: [],
      staleFacts: [],
      requirementIdsToReview: [],
    });
    installWorkspaceBridge({
      listCvDocuments: vi.fn().mockResolvedValue([CV]),
      listCvEvidenceOverlays: vi.fn().mockResolvedValue([held, plain]),
      previewCvEvidenceRebase: vi.fn().mockImplementation(async (id: string) => rebasePlan(id === 'overlay-held')),
    });

    render(<CvLibraryPage />);

    const table = await screen.findByRole('table', { name: 'Tailoring cases for Frontend CV.pdf' }, SLOW);
    const rows = within(table).getAllByRole('row');
    const heldRow = rows.find((row) => within(row).queryByText('Held Role at Held Co'));
    const plainRow = rows.find((row) => within(row).queryByText('Plain Role at Plain Co'));
    expect(heldRow).toHaveTextContent('CV changed, review needed');
    expect(heldRow).not.toHaveTextContent('In progress');
    expect(plainRow).toHaveTextContent('In progress');
    expect(plainRow).not.toHaveTextContent('CV changed');
  });

  it('does not ask what changed for a case that is not a draft', async () => {
    installBridges();
    const previewCvEvidenceRebase = vi.fn();
    installWorkspaceBridge({
      listCvDocuments: vi.fn().mockResolvedValue([CV]),
      listCvEvidenceOverlays: vi.fn().mockResolvedValue([makeCase({ state: 'needs_input' })]),
      previewCvEvidenceRebase,
    });
    render(<CvLibraryPage />);
    await screen.findByRole('table', { name: 'Tailoring cases for Frontend CV.pdf' }, SLOW);
    expect(previewCvEvidenceRebase).not.toHaveBeenCalled();
  });

  it('tells the drawer how many tailoring cases use the CV before saving', async () => {
    installBridges();
    const cases = [makeCase(), makeCase({ id: 'overlay-2', vacancyKey: 'manual:two' })];
    installWorkspaceBridge({
      listCvDocuments: vi.fn().mockResolvedValue([CV]),
      listCvEvidenceOverlays: vi.fn().mockResolvedValue(cases),
    });
    render(<CvLibraryPage />);
    await screen.findByText('Frontend CV.pdf', undefined, SLOW);

    fireEvent.click(screen.getByRole('button', { name: /^edit /i }));
    const dialog = await screen.findByRole('dialog', { name: /edit cv/i });

    expect(await within(dialog).findByText(/2 tailoring cases use this CV./)).toHaveTextContent(
      '2 tailoring cases use this CV. Saving changes puts them on hold until you review what changed. Files you already exported stay on disk.',
    );
  });

  it('uses the singular for one case, and shows no notice when the CV has none or in the add drawer', async () => {
    installBridges();
    const listCvEvidenceOverlays = vi.fn().mockResolvedValue([makeCase()]);
    installWorkspaceBridge({ listCvDocuments: vi.fn().mockResolvedValue([CV]), listCvEvidenceOverlays });
    const { unmount } = render(<CvLibraryPage />);
    await screen.findByText('Frontend CV.pdf', undefined, SLOW);
    fireEvent.click(screen.getByRole('button', { name: /^edit /i }));
    const dialog = await screen.findByRole('dialog', { name: /edit cv/i });
    expect(await within(dialog).findByText(/1 tailoring case uses this CV./)).toHaveTextContent(
      'Saving changes puts it on hold',
    );
    unmount();

    installWorkspaceBridge({
      listCvDocuments: vi.fn().mockResolvedValue([CV]),
      listCvEvidenceOverlays: vi.fn().mockResolvedValue([]),
    });
    render(<CvLibraryPage />);
    await screen.findByText('Frontend CV.pdf', undefined, SLOW);
    fireEvent.click(screen.getByRole('button', { name: /^edit /i }));
    const emptyDialog = await screen.findByRole('dialog', { name: /edit cv/i });
    await waitFor(() => expect(within(emptyDialog).getByRole('button', { name: /save changes/i })).toBeEnabled());
    expect(within(emptyDialog).queryByText(/tailoring cases? uses? this CV/)).not.toBeInTheDocument();
  });
});

describe('the Tailoring cases list shows state and next step (#499)', () => {
  const revisionId = FIXTURE_REVISION_ID;
  const complete = { status: 'complete' as const, revisionId, batches: 1 };
  const snapshotFor = (digest: string, approvedAt: string) => ({
    renderContractVersion: CV_RENDER_CONTRACT_VERSION,
    resume: {
      contact: { name: 'Sam Doe', title: '', location: '', email: '', phone: '', links: [] },
      summary: '',
      experience: [],
      projects: [],
      skills: [],
      education: [],
    },
    digest,
    approvedAt,
    caseRevision: '5',
  });
  const approvedAt = '2026-10-01T10:00:00.000Z';
  const approved = (partial: Partial<CvEvidenceOverlayRecord> = {}) =>
    makeCase({ state: 'candidate_approved', approvedResumeSnapshot: snapshotFor('d'.repeat(64), approvedAt), ...partial });
  const withFile = (confirmedAt: string, reviewOpenedAt = '') => [
    { ...pdfArtifact('d'.repeat(64), approvedAt), confirmedAt, reviewOpenedAt },
  ];

  it('derives the first action the candidate can take, in the order the workspace asks for it', () => {
    expect(describeNextStep(makeCase({ jdSnapshot: '' }), false)).toBe('Add the job description');
    expect(describeNextStep(makeCase(), false)).toBe('Map the requirements');
    expect(describeNextStep(makeCase({ requirementCoverage: { ...complete, status: 'partial' } }), false)).toBe(
      'Map the rest of the requirements',
    );
    expect(
      describeNextStep(
        makeCase({
          requirementCoverage: complete,
          requirements: [makeRequirement({ requirementId: 'r-1', reviewed: false }), makeRequirement({ requirementId: 'r-2', reviewed: false })],
        }),
        false,
      ),
    ).toBe('Review 2 requirements');
    expect(
      describeNextStep(
        makeCase({ requirementCoverage: complete, requirements: [makeRequirement({ reviewed: false })] }),
        false,
      ),
    ).toBe('Review 1 requirement');
    expect(
      describeNextStep(
        makeCase({
          requirementCoverage: complete,
          requirements: [
            makeRequirement({ requirementId: 'r-1', evidenceClass: 'needs_verification' }),
            makeRequirement({ requirementId: 'r-2', evidenceClass: 'needs_verification' }),
            makeRequirement({ requirementId: 'r-3', evidenceClass: 'direct' }),
          ],
        }),
        false,
      ),
    ).toBe('Answer 2 questions');
    expect(
      describeNextStep(
        makeCase({ requirementCoverage: complete, requirements: [makeRequirement()], facts: [makeFact({ approval: 'proposed' })] }),
        false,
      ),
    ).toBe('Review 1 fact');
    expect(describeNextStep(makeCase({ requirementCoverage: complete, requirements: [makeRequirement()], facts: [makeFact()] }), false)).toBe(
      'Approve the CV',
    );
    expect(describeNextStep(makeCase({ state: 'conflict' }), false)).toBe('Resolve conflicting facts');
    expect(describeNextStep(makeCase({ state: 'qa_failed' }), false)).toBe('Fix the failed checks');
  });

  it('puts a changed CV first, ahead of every other step', () => {
    expect(describeNextStep(makeCase(), true)).toBe('Review what changed in your CV');
  });

  it('reads the file states of an approved case', () => {
    expect(describeNextStep(approved(), false)).toBe('Export your files');
    expect(describeNextStep(approved({ artifacts: withFile('') }), false)).toBe('Review PDF');
    expect(describeNextStep(approved({ artifacts: withFile('2026-10-02T09:00:00.000Z', '2026-10-02T08:30:00.000Z') }), false)).toBe('Done');
    expect(
      describeNextStep(approved({ artifacts: [{ ...pdfArtifact('d'.repeat(64), approvedAt), validation: { ok: false, reasons: ['too long'], pageCount: 3 } }] }), false),
    ).toBe('Export again');
    expect(
      describeNextStep(approved({ artifacts: [pdfArtifact('0'.repeat(64), '2026-09-01T10:00:00.000Z')] }), false),
    ).toBe('Export your files again');
    expect(
      describeNextStep(
        approved({ approvedResumeSnapshot: { ...snapshotFor('d'.repeat(64), approvedAt), renderContractVersion: CV_RENDER_CONTRACT_VERSION - 1 } }),
        false,
      ),
    ).toBe('Approve the CV again');
  });

  it('shows every row a next step and tells the two approved states apart', async () => {
    installBridges();
    const rows = [
      makeCase({ id: 'c-1', vacancyKey: 'manual:1', caseTitle: 'Role One', caseCompany: 'Co One', state: 'needs_input' }),
      approved({ id: 'c-2', vacancyKey: 'manual:2', caseTitle: 'Role Two', caseCompany: 'Co Two', artifacts: withFile('') }),
      makeCase({ id: 'c-3', vacancyKey: 'manual:3', caseTitle: 'Role Three', caseCompany: 'Co Three', state: 'artifact_approved' }),
      approved({
        id: 'c-4',
        vacancyKey: 'manual:4',
        caseTitle: 'Role Four',
        caseCompany: 'Co Four',
        artifacts: withFile('2026-10-02T09:00:00.000Z', '2026-10-02T08:30:00.000Z'),
      }),
    ];
    installWorkspaceBridge({
      listCvDocuments: vi.fn().mockResolvedValue([CV]),
      listCvEvidenceOverlays: vi.fn().mockResolvedValue(rows),
    });
    render(<CvLibraryPage />);

    const table = await screen.findByRole('table', { name: 'Tailoring cases for Frontend CV.pdf' }, SLOW);
    expect(within(table).getByRole('columnheader', { name: 'Next step' })).toBeInTheDocument();
    const bodyRows = within(table).getAllByRole('row').slice(1);
    expect(bodyRows).toHaveLength(4);
    for (const row of bodyRows) {
      const cells = within(row).getAllByRole('cell');
      expect(cells[5]?.textContent?.trim().length).toBeGreaterThan(0);
    }
    const byLabel = (label: string) => bodyRows.find((row) => within(row).queryByText(label)) as HTMLElement;
    expect(within(byLabel('Role One at Co One')).getAllByRole('cell')[2]).toHaveTextContent('Needs your input');
    expect(within(byLabel('Role Two at Co Two')).getAllByRole('cell')[2]).toHaveTextContent('CV approved');
    expect(within(byLabel('Role Two at Co Two')).getAllByRole('cell')[5]).toHaveTextContent('Review PDF');
    expect(within(byLabel('Role Three at Co Three')).getAllByRole('cell')[2]).toHaveTextContent('Files accepted');
    expect(within(byLabel('Role Four at Co Four')).getAllByRole('cell')[5]).toHaveTextContent('Done');
  });

  it('shows a loading line, not an empty or finished list, while the cases load', async () => {
    installBridges();
    let release: (cases: CvEvidenceOverlayRecord[]) => void = () => undefined;
    installWorkspaceBridge({
      listCvDocuments: vi.fn().mockResolvedValue([CV]),
      listCvEvidenceOverlays: vi.fn().mockImplementation(() => new Promise<CvEvidenceOverlayRecord[]>((resolve) => (release = resolve))),
    });
    render(<CvLibraryPage />);

    expect(await screen.findByText('Loading your tailoring cases…', undefined, SLOW)).toBeInTheDocument();
    expect(screen.queryByText(/appear here/)).not.toBeInTheDocument();
    expect(screen.queryByText('Done')).not.toBeInTheDocument();

    release([makeCase()]);
    expect(await screen.findByRole('table', { name: 'Tailoring cases for Frontend CV.pdf' }, SLOW)).toBeInTheDocument();
    expect(screen.queryByText('Loading your tailoring cases…')).not.toBeInTheDocument();
  });

  it('shows the error rather than an empty list when the cases cannot be loaded', async () => {
    installBridges();
    installWorkspaceBridge({
      listCvDocuments: vi.fn().mockResolvedValue([CV]),
      listCvEvidenceOverlays: vi.fn().mockRejectedValue(new Error('cases database unreachable')),
    });
    render(<CvLibraryPage />);

    expect(await screen.findByText('cases database unreachable', undefined, SLOW)).toBeInTheDocument();
    expect(screen.queryByText(/appear here/)).not.toBeInTheDocument();
  });
});
