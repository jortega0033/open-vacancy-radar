import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TailorCv } from '../src/components/cv/TailorCv.js';
import type { CvDocument } from '../src/components/cv/types.js';
import { installBridges, TEST_VACANCY } from './cv-bridges.js';
import { installWorkspaceBridge } from './workspace-bridge.js';

const CV: CvDocument = { fileName: 'cv.pdf', text: 'Angular architect. 8 years of frontend work.' };

/** jsdom has no clipboard implementation, so install one we can assert against. */
function stubClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true });
  return writeText;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TailorCv', () => {
  it('generates a tailored draft from the CV and vacancy and streams it in', async () => {
    const bridges = installBridges();
    stubClipboard();
    render(<TailorCv cv={CV} vacancy={TEST_VACANCY} />);

    fireEvent.click(screen.getByRole('button', { name: /draft tailored cv/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));

    const prompt = vi.mocked(bridges.agentDock.createSession).mock.calls[0]?.[0].prompt ?? '';
    expect(prompt).toContain('reordering and re-emphasis task');
    expect(prompt).toContain('Redwood Software');
    expect(prompt).toContain('Angular architect. 8 years of frontend work.');
    // Guardrails that keep the draft honest.
    expect(prompt).toContain('Do not add a single fact, skill, tool, employer, title, date or metric');

    bridges.emit('sess-cv-1', { type: 'assistant.message', text: 'Angular architect, tailored.' });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    const draft = await screen.findByRole('log', { name: /tailored cv draft/i });
    expect(draft).toHaveTextContent('Angular architect, tailored.');
    expect(screen.getByRole('button', { name: /regenerate/i })).toBeEnabled();
  });

  it('copies the tailored draft to the clipboard and confirms it', async () => {
    const bridges = installBridges();
    const writeText = stubClipboard();
    render(<TailorCv cv={CV} vacancy={TEST_VACANCY} />);

    fireEvent.click(screen.getByRole('button', { name: /draft tailored cv/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());

    expect(screen.getByRole('button', { name: /copy to clipboard/i })).toBeDisabled(); // nothing to copy yet

    bridges.emit('sess-cv-1', { type: 'assistant.message', text: 'Angular architect, tailored draft.' });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    const copyButton = await screen.findByRole('button', { name: /copy to clipboard/i });
    await waitFor(() => expect(copyButton).toBeEnabled());
    fireEvent.click(copyButton);

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Angular architect, tailored draft.'));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('reports a clipboard failure instead of silently claiming success', async () => {
    const bridges = installBridges();
    stubClipboard(vi.fn().mockRejectedValue(new Error('Write permission denied.')));
    render(<TailorCv cv={CV} vacancy={TEST_VACANCY} />);

    fireEvent.click(screen.getByRole('button', { name: /draft tailored cv/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());
    bridges.emit('sess-cv-1', { type: 'assistant.message', text: 'Angular architect, tailored.' });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    fireEvent.click(await screen.findByRole('button', { name: /copy to clipboard/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Write permission denied.');
    expect(screen.queryByText('Copied')).not.toBeInTheDocument();
  });

  it('regenerating starts a fresh session and discards the previous draft', async () => {
    const bridges = installBridges();
    stubClipboard();
    render(<TailorCv cv={CV} vacancy={TEST_VACANCY} />);

    fireEvent.click(screen.getByRole('button', { name: /draft tailored cv/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));
    bridges.emit('sess-cv-1', { type: 'assistant.message', text: 'First draft.' });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    fireEvent.click(await screen.findByRole('button', { name: /regenerate/i }));

    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('First draft.')).not.toBeInTheDocument());
  });

  it('cancels a running draft through the session it started, and only while one is running', async () => {
    const bridges = installBridges();
    stubClipboard();
    render(<TailorCv cv={CV} vacancy={TEST_VACANCY} />);

    const cancel = screen.getByRole('button', { name: /cancel/i });
    expect(cancel).toBeDisabled(); // nothing to cancel before a run starts

    fireEvent.click(screen.getByRole('button', { name: /draft tailored cv/i }));
    await waitFor(() => expect(cancel).toBeEnabled());
    fireEvent.click(cancel);

    await waitFor(() => expect(bridges.agentDock.cancelSession).toHaveBeenCalledWith('sess-cv-1'));

    bridges.emit('sess-cv-1', { type: 'session.cancelled' });
    await waitFor(() => expect(cancel).toBeDisabled());
  });

  it('surfaces a failed generation without crashing', async () => {
    const bridges = installBridges();
    stubClipboard();
    render(<TailorCv cv={CV} vacancy={TEST_VACANCY} />);
    fireEvent.click(screen.getByRole('button', { name: /draft tailored cv/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());

    bridges.emit('sess-cv-1', { type: 'session.failed', message: 'provider CLI is not authenticated' });

    expect(await screen.findByRole('alert')).toHaveTextContent('provider CLI is not authenticated');
  });

  // Deliberate non-goal: a tailored draft is output the user reads and takes away, exactly like a
  // cover letter. It must not quietly become a second CV in the library, or overwrite the one that
  // produced it. There is no "save" affordance here, and this asserts the absence stays absent.
  it('writes nothing to the workspace: the draft never touches the stored CV or the library', async () => {
    const bridges = installBridges();
    const workspace = installWorkspaceBridge();
    stubClipboard();
    render(<TailorCv cv={CV} vacancy={TEST_VACANCY} />);

    fireEvent.click(screen.getByRole('button', { name: /draft tailored cv/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());
    bridges.emit('sess-cv-1', { type: 'assistant.message', text: 'Angular architect, tailored.' });
    bridges.emit('sess-cv-1', { type: 'session.completed' });
    await screen.findByRole('button', { name: /regenerate/i });

    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    for (const write of [
      workspace.createCvDocument,
      workspace.updateCvDocument,
      workspace.createLetter,
      workspace.updateLetter,
      workspace.createSavedJob,
      workspace.updateSavedJob,
    ]) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it('disables the draft button and shows a hint until a CV and vacancy are both present', () => {
    installBridges();
    stubClipboard();
    const { rerender } = render(<TailorCv cv={null} vacancy={null} />);

    expect(screen.getByText(/load a cv above/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /draft tailored cv/i })).toBeDisabled();

    rerender(<TailorCv cv={CV} vacancy={null} />);
    expect(screen.getByText(/select a vacancy to tailor your cv for/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /draft tailored cv/i })).toBeDisabled();
  });
});
