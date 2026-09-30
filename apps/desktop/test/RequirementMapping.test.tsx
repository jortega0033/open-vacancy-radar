import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CvEvidenceOverlayRecord, CvEvidenceOverlayPatch } from '../src/window.js';
import { RequirementMapping } from '../src/components/cv/RequirementMapping.js';
import type { CvDocument } from '../src/components/cv/types.js';
import { installBridges, TEST_VACANCY } from './cv-bridges.js';
import { installWorkspaceBridge } from './workspace-bridge.js';

const CV: CvDocument = { fileName: 'cv.pdf', text: 'Angular architect. 8 years of frontend work.' };

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
        listingStatus: input.listingStatus ?? 'unknown',
        state: 'needs_input',
        requirements: [],
        facts: [],
        wordingVariants: [],
        capturedAt: '2026-09-30T00:00:00.000Z',
        updatedAt: '2026-09-30T00:00:00.000Z',
      };
      return overlay;
    }),
    updateCvEvidenceOverlay: vi.fn().mockImplementation(async (id: string, patch: CvEvidenceOverlayPatch) => {
      if (!overlay || overlay.id !== id) throw new Error('no such overlay');
      overlay = { ...overlay, ...patch, updatedAt: '2026-09-30T00:01:00.000Z' };
      return overlay;
    }),
  });
  return workspace;
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

    bridges.emit('sess-cv-1', {
      type: 'assistant.message',
      text: JSON.stringify({
        requirements: [
          { text: 'Angular experience', jdAnchor: 'Angular applications', classification: 'required', evidenceClass: 'needs_verification', anchorParentId: '' },
        ],
      }),
    });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    await screen.findByText('Angular experience');
    expect(workspace.createCvEvidenceOverlay).toHaveBeenCalledTimes(1);
    expect(workspace.updateCvEvidenceOverlay).toHaveBeenCalled();
    expect(screen.getByText(/1 of 1 requirement\(s\) not yet reviewed/i)).toBeInTheDocument();
  });

  it('marking a row reviewed persists the change', async () => {
    const bridges = installBridges();
    installStatefulOverlayBridge();
    render(<RequirementMapping cvId="cv-1" cv={CV} vacancy={TEST_VACANCY} />);

    fireEvent.click(screen.getByRole('button', { name: /map requirements/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());
    bridges.emit('sess-cv-1', {
      type: 'assistant.message',
      text: JSON.stringify({ requirements: [{ text: 'Angular experience' }] }),
    });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    const checkbox = await screen.findByRole('checkbox', { name: /reviewed/i });
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);

    await waitFor(() => expect(checkbox).toBeChecked());
    await waitFor(() => expect(screen.queryByText(/not yet reviewed/i)).not.toBeInTheDocument());
  });

  it('lets the candidate add a requirement the extraction missed, already marked reviewed', async () => {
    installBridges();
    const workspace = installStatefulOverlayBridge();
    render(<RequirementMapping cvId="cv-1" cv={CV} vacancy={TEST_VACANCY} />);

    fireEvent.change(screen.getByLabelText(/new requirement text/i), {
      target: { value: 'Onsite 2 days a week' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await screen.findByText('Onsite 2 days a week');
    expect(screen.getByText(/added by you/i)).toBeInTheDocument();
    expect(screen.queryByText(/not yet reviewed/i)).not.toBeInTheDocument();
    expect(workspace.createCvEvidenceOverlay).toHaveBeenCalledTimes(1);
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
    fireEvent.click(screen.getByRole('button', { name: /^add$/i }));

    await screen.findByText('A manual one');
    expect(workspace.createCvEvidenceOverlay).not.toHaveBeenCalled();
  });
});
