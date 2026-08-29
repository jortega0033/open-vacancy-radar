import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoverLetter } from '../src/components/cv/CoverLetter.js';
import type { CvDocument } from '../src/components/cv/types.js';
import { installBridges, TEST_VACANCY } from './cv-bridges.js';

const CV: CvDocument = { fileName: 'cv.pdf', text: 'Angular architect. 8 years of frontend work.' };

/** jsdom has no clipboard implementation, so install one we can assert against. */
function stubClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true });
  return writeText;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CoverLetter', () => {
  it('generates a draft from the CV and vacancy and streams it in', async () => {
    const bridges = installBridges();
    stubClipboard();
    render(<CoverLetter cv={CV} vacancy={TEST_VACANCY} />);

    fireEvent.click(screen.getByRole('button', { name: /draft cover letter/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));

    const prompt = vi.mocked(bridges.agentDock.createSession).mock.calls[0]?.[0].prompt ?? '';
    expect(prompt).toContain('motivation letter');
    expect(prompt).toContain('Redwood Software');
    expect(prompt).toContain('Angular architect. 8 years of frontend work.');
    // Guardrails that keep the draft usable and honest.
    expect(prompt).toContain('Do not invent a hiring manager');
    expect(prompt).toContain('[Your Name]');

    bridges.emit('sess-cv-1', { type: 'assistant.message', text: 'Dear hiring team,' });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    const draft = await screen.findByRole('log', { name: /cover letter draft/i });
    expect(draft).toHaveTextContent('Dear hiring team,');
    expect(screen.getByRole('button', { name: /regenerate/i })).toBeEnabled();
  });

  it('copies the generated letter to the clipboard and confirms it', async () => {
    const bridges = installBridges();
    const writeText = stubClipboard();
    render(<CoverLetter cv={CV} vacancy={TEST_VACANCY} />);

    fireEvent.click(screen.getByRole('button', { name: /draft cover letter/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());

    expect(screen.getByRole('button', { name: /copy to clipboard/i })).toBeDisabled(); // nothing to copy yet

    bridges.emit('sess-cv-1', { type: 'assistant.message', text: 'Dear hiring team, I am writing about the role.' });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    const copyButton = await screen.findByRole('button', { name: /copy to clipboard/i });
    await waitFor(() => expect(copyButton).toBeEnabled());
    fireEvent.click(copyButton);

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('Dear hiring team, I am writing about the role.'),
    );
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('reports a clipboard failure instead of silently claiming success', async () => {
    const bridges = installBridges();
    stubClipboard(vi.fn().mockRejectedValue(new Error('Write permission denied.')));
    render(<CoverLetter cv={CV} vacancy={TEST_VACANCY} />);

    fireEvent.click(screen.getByRole('button', { name: /draft cover letter/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());
    bridges.emit('sess-cv-1', { type: 'assistant.message', text: 'Dear hiring team,' });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    fireEvent.click(await screen.findByRole('button', { name: /copy to clipboard/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Write permission denied.');
    expect(screen.queryByText('Copied')).not.toBeInTheDocument();
  });

  it('regenerating starts a fresh session and discards the previous draft', async () => {
    const bridges = installBridges();
    stubClipboard();
    render(<CoverLetter cv={CV} vacancy={TEST_VACANCY} />);

    fireEvent.click(screen.getByRole('button', { name: /draft cover letter/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));
    bridges.emit('sess-cv-1', { type: 'assistant.message', text: 'First draft.' });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    fireEvent.click(await screen.findByRole('button', { name: /regenerate/i }));

    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('First draft.')).not.toBeInTheDocument());
  });

  it('surfaces a failed generation without crashing', async () => {
    const bridges = installBridges();
    stubClipboard();
    render(<CoverLetter cv={CV} vacancy={TEST_VACANCY} />);
    fireEvent.click(screen.getByRole('button', { name: /draft cover letter/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());

    bridges.emit('sess-cv-1', { type: 'session.failed', message: 'provider CLI is not authenticated' });

    expect(await screen.findByRole('alert')).toHaveTextContent('provider CLI is not authenticated');
  });
});
