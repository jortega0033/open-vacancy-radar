import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SaveCvToLibrary } from '../src/components/cv/SaveCvToLibrary.js';
import type { CvDocumentRecord } from '../src/window.js';
import { installWorkspaceBridge } from './workspace-bridge.js';

const CV = { fileName: 'jake-ortega-cv.pdf', text: 'Angular. TypeScript. 8 years.' };

const SAVED: CvDocumentRecord = {
  id: 'cv-1',
  name: CV.fileName,
  kind: 'uploaded',
  targetRole: '',
  text: CV.text,
  profile: { title: '', years: '', location: '', languages: '', skills: [], summary: '', auth: '' },
  isDefault: true,
  uploadedAt: '2026-08-29T10:00:00.000Z',
  updatedAt: '2026-08-29T10:00:00.000Z',
};

beforeEach(() => {
  installWorkspaceBridge();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SaveCvToLibrary', () => {
  it('persists the extracted text and file name, and nothing else about the file', async () => {
    // Notably absent: any path. The renderer never learns one, so it cannot leak one here.
    const bridge = installWorkspaceBridge({ createCvDocument: vi.fn().mockResolvedValue(SAVED) });
    render(<SaveCvToLibrary cv={CV} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save to CV library' }));

    await waitFor(() =>
      expect(bridge.createCvDocument).toHaveBeenCalledWith({
        name: 'jake-ortega-cv.pdf',
        kind: 'uploaded',
        text: 'Angular. TypeScript. 8 years.',
      }),
    );
  });

  it('confirms the save and does not offer to save the same document twice', async () => {
    const bridge = installWorkspaceBridge({ createCvDocument: vi.fn().mockResolvedValue(SAVED) });
    render(<SaveCvToLibrary cv={CV} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save to CV library' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Saved to library' })).toBeDisabled());
    expect(screen.getByRole('status')).toHaveTextContent('Added to your CV library.');
    expect(bridge.createCvDocument).toHaveBeenCalledTimes(1);
  });

  it('reports the new row id so a caller can select it', async () => {
    installWorkspaceBridge({ createCvDocument: vi.fn().mockResolvedValue(SAVED) });
    const onSaved = vi.fn();
    render(<SaveCvToLibrary cv={CV} onSaved={onSaved} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save to CV library' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('cv-1'));
  });

  it('surfaces a rejected save and stays retryable rather than pretending it worked', async () => {
    installWorkspaceBridge({
      createCvDocument: vi.fn().mockRejectedValue(new Error('"name" is required')),
    });
    render(<SaveCvToLibrary cv={CV} />);

    fireEvent.click(screen.getByRole('button', { name: 'Save to CV library' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('"name" is required'));
    expect(screen.getByRole('button', { name: 'Save to CV library' })).toBeEnabled();
  });
});
