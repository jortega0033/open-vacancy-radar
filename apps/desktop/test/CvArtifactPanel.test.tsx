import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderResumePlainText } from '../electron/resume-text.js';
import { CV_RENDER_CONTRACT_VERSION } from '../electron/workspace/cv-evidence-schema.js';
import { CvArtifactPanel } from '../src/components/cv/CvArtifactPanel.js';
import type { CvArtifactRecord, CvEvidenceOverlayRecord } from '../src/window.js';
import { installWorkspaceBridge } from './workspace-bridge.js';
import { FIXTURE_REVISION_ID, makeRevision } from './fixtures/cv-evidence.js';
import { FULL_JD } from './fixtures/job-description.js';

const RESUME = {
  contact: { name: 'Jamie Rivera', title: '', location: '', email: 'jamie.rivera@example.invalid', phone: '', links: [] },
  summary: 'Frontend engineer.',
  experience: [
    { company: 'Redwood Software', title: 'Frontend Engineer', dates: '2021 - Present', engagement: 'employment' as const, client: '', bullets: ['Built the booking screens, using Angular'] },
  ],
  projects: [],
  skills: ['TypeScript'],
  education: [],
};

const SNAPSHOT = {
  renderContractVersion: CV_RENDER_CONTRACT_VERSION,
  resume: RESUME,
  digest: 'd'.repeat(64),
  approvedAt: '2026-10-01T10:00:00.000Z',
  caseRevision: '5',
};

function artifact(partial: Partial<CvArtifactRecord> = {}): CvArtifactRecord {
  return {
    artifactId: 'artifact-1',
    format: 'pdf',
    contentHash: 'abcdef0123456789'.repeat(4),
    exportedAt: '2026-10-01T11:00:00.000Z',
    snapshotDigest: SNAPSHOT.digest,
    snapshotApprovedAt: SNAPSHOT.approvedAt,
    renderContractVersion: CV_RENDER_CONTRACT_VERSION,
    validation: { ok: true, reasons: [], pageCount: 2 },
    savedPath: 'C:\\fake\\cv.pdf',
    reviewOpenedAt: '',
    confirmedAt: '',
    ...partial,
  };
}

function overlayWith(partial: Partial<CvEvidenceOverlayRecord> = {}): CvEvidenceOverlayRecord {
  return {
    id: 'overlay-1',
    cvId: 'cv-1',
    vacancyKey: 'url:https://example.invalid/jobs/1',
    sourceCvContentHash: 'a'.repeat(64),
    jdSnapshot: FULL_JD,
    jdSnapshotHash: 'b'.repeat(64),
    jdComplete: true,
    jdIncompleteReasons: [],
    jdWarning: '',
    jdConfirmedComplete: false,
    jdRevisions: [makeRevision({ text: FULL_JD })],
    listingStatus: 'unknown',
    state: 'candidate_approved',
    requirements: [],
    requirementCoverage: { status: 'complete', revisionId: FIXTURE_REVISION_ID, batches: 1 },
    facts: [],
    wordingVariants: [],
    origin: 'vacancy',
    caseRevision: '5',
    approvedResumeSnapshot: SNAPSHOT,
    projectSelection: null,
    sourceBaseline: null,
    artifacts: [],
    legacyUnverifiedExport: false,
    capturedAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...partial,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function pdfRow() {
  return screen.getByLabelText('PDF file');
}
function wordRow() {
  return screen.getByLabelText('Word file');
}

describe('CvArtifactPanel (#419 step 9)', () => {
  it('shows each format as not exported before anything was saved', () => {
    installWorkspaceBridge();
    render(<CvArtifactPanel overlay={overlayWith()} onOverlayChange={vi.fn()} />);
    expect(within(pdfRow()).getByRole('status')).toHaveTextContent('Not exported');
    expect(within(wordRow()).getByRole('status')).toHaveTextContent('Not exported');
  });

  it('exports by case id and format only, and shows the saved file waiting for review', async () => {
    const saved = overlayWith({ artifacts: [artifact({ format: 'docx', savedPath: 'C:\\fake\\cv.docx', validation: { ok: true, reasons: [] } })] });
    const workspace = installWorkspaceBridge({
      exportCvEvidenceOverlay: vi.fn().mockResolvedValue({ saved: true, path: 'C:\\fake\\cv.docx', artifact: saved.artifacts[0], overlay: saved }),
    });
    const onChange = vi.fn();
    const { rerender } = render(<CvArtifactPanel overlay={overlayWith()} onOverlayChange={onChange} />);

    fireEvent.click(within(wordRow()).getByRole('button', { name: /export as word/i }));

    await waitFor(() => expect(workspace.exportCvEvidenceOverlay).toHaveBeenCalledWith('overlay-1', 'docx'));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(saved));
    expect(await screen.findByText(/saved to c:\\fake\\cv\.docx/i)).toBeInTheDocument();
    rerender(<CvArtifactPanel overlay={saved} onOverlayChange={onChange} />);
    expect(within(wordRow()).getByRole('status')).toHaveTextContent('Exported, waiting for your review');
    expect(within(pdfRow()).getByRole('status')).toHaveTextContent('Not exported');
  });

  it('a cancelled save dialog changes nothing and shows no message', async () => {
    const base = overlayWith();
    installWorkspaceBridge({ exportCvEvidenceOverlay: vi.fn().mockResolvedValue({ saved: false, artifact: null, overlay: base }) });
    render(<CvArtifactPanel overlay={base} onOverlayChange={vi.fn()} />);
    fireEvent.click(within(pdfRow()).getByRole('button', { name: /export as pdf/i }));
    await waitFor(() => expect(within(pdfRow()).getByRole('button', { name: /export as pdf/i })).toBeEnabled());
    expect(screen.queryByText(/saved to/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(within(pdfRow()).getByRole('status')).toHaveTextContent('Not exported');
  });

  it('lists why a file failed its checks, with no way to accept it, and offers to export again', () => {
    const failed = overlayWith({
      artifacts: [artifact({ validation: { ok: false, reasons: ['page 2: text is clipped at the page edge'], pageCount: 2 }, savedPath: '' })],
    });
    installWorkspaceBridge();
    render(<CvArtifactPanel overlay={failed} onOverlayChange={vi.fn()} />);
    expect(within(pdfRow()).getByRole('status')).toHaveTextContent('Failed its checks');
    expect(within(pdfRow()).getByLabelText('PDF problems')).toHaveTextContent('page 2: text is clipped at the page edge');
    expect(within(pdfRow()).queryByRole('button', { name: /read every page/i })).not.toBeInTheDocument();
    expect(within(pdfRow()).getByRole('button', { name: /export pdf again/i })).toBeEnabled();
    // The other format is untouched by this failure.
    expect(within(wordRow()).getByRole('status')).toHaveTextContent('Not exported');
  });

  it('a PDF can be confirmed only after it was opened, and the page count is shown', async () => {
    const waiting = overlayWith({ artifacts: [artifact()] });
    const opened = overlayWith({ artifacts: [artifact({ reviewOpenedAt: '2026-10-01T11:05:00.000Z' })] });
    const accepted = overlayWith({ artifacts: [artifact({ reviewOpenedAt: '2026-10-01T11:05:00.000Z', confirmedAt: '2026-10-01T11:06:00.000Z' })] });
    const workspace = installWorkspaceBridge({
      openCvArtifact: vi.fn().mockResolvedValue(opened),
      confirmCvArtifact: vi.fn().mockResolvedValue(accepted),
    });
    let current = waiting;
    const onChange = vi.fn((next: CvEvidenceOverlayRecord) => {
      current = next;
      rerender(<CvArtifactPanel overlay={current} onOverlayChange={onChange} />);
    });
    const { rerender } = render(<CvArtifactPanel overlay={current} onOverlayChange={onChange} />);

    expect(within(pdfRow()).getByText(/2 page\(s\)/)).toBeInTheDocument();
    const confirm = within(pdfRow()).getByRole('button', { name: /i read every page and it looks right/i });
    expect(confirm).toBeDisabled();

    fireEvent.click(within(pdfRow()).getByRole('button', { name: /open the pdf to read every page/i }));
    await waitFor(() => expect(workspace.openCvArtifact).toHaveBeenCalledWith('overlay-1', 'artifact-1'));
    await waitFor(() => expect(within(pdfRow()).getByRole('button', { name: /i read every page/i })).toBeEnabled());

    fireEvent.click(within(pdfRow()).getByRole('button', { name: /i read every page/i }));
    await waitFor(() => expect(workspace.confirmCvArtifact).toHaveBeenCalledWith('overlay-1', 'artifact-1'));
    await waitFor(() => expect(within(pdfRow()).getByRole('status')).toHaveTextContent('Accepted'));
    expect(within(pdfRow()).queryByRole('button', { name: /i read every page/i })).not.toBeInTheDocument();
  });

  it('a Word file gets its own confirmation, worded as a review in the candidate editor, with no page fit claim', async () => {
    const waiting = overlayWith({ artifacts: [artifact({ artifactId: 'artifact-2', format: 'docx', savedPath: 'C:\\fake\\cv.docx', validation: { ok: true, reasons: [] } })] });
    const accepted = overlayWith({ artifacts: [{ ...waiting.artifacts[0]!, confirmedAt: '2026-10-01T11:06:00.000Z' }] });
    const workspace = installWorkspaceBridge({ confirmCvArtifact: vi.fn().mockResolvedValue(accepted) });
    const onChange = vi.fn();
    render(<CvArtifactPanel overlay={waiting} onOverlayChange={onChange} />);

    expect(within(wordRow()).getByText(/nothing about page layout/i)).toBeInTheDocument();
    expect(within(wordRow()).queryByText(/page\(s\)/i)).not.toBeInTheDocument();
    fireEvent.click(within(wordRow()).getByRole('button', { name: /i reviewed this in my editor/i }));
    await waitFor(() => expect(workspace.confirmCvArtifact).toHaveBeenCalledWith('overlay-1', 'artifact-2'));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(accepted));
    // The PDF is a separate format with its own state.
    expect(within(pdfRow()).getByRole('status')).toHaveTextContent('Not exported');
  });

  it('shows an accepted file as accepted and says the record covers only the bytes saved at export', () => {
    const accepted = overlayWith({ artifacts: [artifact({ reviewOpenedAt: 'x', confirmedAt: '2026-10-01T11:06:00.000Z' })] });
    installWorkspaceBridge();
    render(<CvArtifactPanel overlay={accepted} onOverlayChange={vi.fn()} />);
    expect(within(pdfRow()).getByRole('status')).toHaveTextContent('Accepted');
    expect(within(pdfRow()).getByText(/not checked again/i)).toBeInTheDocument();
    expect(within(pdfRow()).getByText(/hash abcdef012345/i)).toBeInTheDocument();
  });

  it('marks a file out of date once the approved version moved on, keeping its hash and offering no confirmation', () => {
    const old = artifact({ reviewOpenedAt: 'x', confirmedAt: '2026-10-01T11:06:00.000Z', snapshotDigest: 'e'.repeat(64) });
    installWorkspaceBridge();
    render(<CvArtifactPanel overlay={overlayWith({ artifacts: [old] })} onOverlayChange={vi.fn()} />);
    expect(within(pdfRow()).getByRole('status')).toHaveTextContent('Out of date');
    expect(within(pdfRow()).getByText(/hash abcdef012345/i)).toBeInTheDocument();
    expect(within(pdfRow()).queryByRole('button', { name: /i read every page/i })).not.toBeInTheDocument();
    expect(within(pdfRow()).getByRole('button', { name: /export pdf again/i })).toBeEnabled();
    expect(screen.getByText(/earlier files \(1\)/i)).toBeInTheDocument();
  });

  it('a renderer contract change makes a file out of date without touching approval', () => {
    const old = artifact({ renderContractVersion: CV_RENDER_CONTRACT_VERSION - 1, confirmedAt: 'x', reviewOpenedAt: 'x' });
    installWorkspaceBridge();
    render(<CvArtifactPanel overlay={overlayWith({ artifacts: [old] })} onOverlayChange={vi.fn()} />);
    expect(within(pdfRow()).getByRole('status')).toHaveTextContent('Out of date');
  });

  it('shows a case an earlier version marked exported as not verified', () => {
    installWorkspaceBridge();
    render(<CvArtifactPanel overlay={overlayWith({ legacyUnverifiedExport: true })} onOverlayChange={vi.fn()} />);
    expect(within(pdfRow()).getByRole('status')).toHaveTextContent('Exported by an earlier version, not verified');
    expect(within(wordRow()).getByRole('status')).toHaveTextContent('not verified');
  });

  it('copies the plain text of the approved snapshot', async () => {
    installWorkspaceBridge();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<CvArtifactPanel overlay={overlayWith()} onOverlayChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /copy as plain text/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(renderResumePlainText(RESUME)));
    expect(writeText.mock.calls[0]?.[0]).toContain('Built the booking screens, using Angular');
  });

  it('never says the vacancy is ready to apply, in any state', () => {
    installWorkspaceBridge();
    const accepted = overlayWith({
      artifacts: [
        artifact({ reviewOpenedAt: 'x', confirmedAt: 'y' }),
        artifact({ artifactId: 'artifact-2', format: 'docx', validation: { ok: true, reasons: [] }, confirmedAt: 'y' }),
      ],
    });
    const { container } = render(<CvArtifactPanel overlay={accepted} onOverlayChange={vi.fn()} />);
    expect(container.textContent ?? '').not.toMatch(/ready to apply|ready for application|good to apply/i);
    expect(container.textContent ?? '').not.toContain('\u2014');
  });

  it('keeps every action reachable at the minimum desktop width: rows wrap and nothing has a fixed width', () => {
    installWorkspaceBridge();
    const waiting = overlayWith({ artifacts: [artifact({ reviewOpenedAt: 'x' })] });
    const { container } = render(
      <div style={{ width: '360px' }}>
        <CvArtifactPanel overlay={waiting} onOverlayChange={vi.fn()} />
      </div>,
    );
    for (const name of [/export pdf again/i, /open the pdf to read every page/i, /i read every page/i, /export as word/i, /copy as plain text/i]) {
      expect(screen.getByRole('button', { name })).toBeVisible();
    }
    for (const row of container.querySelectorAll('button')) {
      expect(row.parentElement?.className).toMatch(/flex-wrap/);
      expect(row.className).not.toMatch(/\bw-\d|\bmin-w-/);
    }
  });
});
