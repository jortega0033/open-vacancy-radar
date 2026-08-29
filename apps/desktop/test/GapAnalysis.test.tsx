import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GapAnalysis } from '../src/components/cv/GapAnalysis.js';
import type { CvDocument } from '../src/components/cv/types.js';
import { installBridges, TEST_VACANCY } from './cv-bridges.js';

const CV: CvDocument = { fileName: 'cv.pdf', text: 'Angular architect. 8 years of frontend work.' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GapAnalysis', () => {
  it('keeps the run button disabled until both a CV and a vacancy are present', () => {
    installBridges();
    const { rerender } = render(<GapAnalysis cv={null} vacancy={null} />);
    expect(screen.getByRole('button', { name: /analyse gaps/i })).toBeDisabled();
    expect(screen.getByText(/load a cv above/i)).toBeInTheDocument();

    rerender(<GapAnalysis cv={CV} vacancy={null} />);
    expect(screen.getByRole('button', { name: /analyse gaps/i })).toBeDisabled();
    expect(screen.getByText(/select a vacancy/i)).toBeInTheDocument();

    rerender(<GapAnalysis cv={CV} vacancy={TEST_VACANCY} />);
    expect(screen.getByRole('button', { name: /analyse gaps/i })).toBeEnabled();
  });

  it('streams the analysis: shows a working state, accumulates chunks, then settles on completion', async () => {
    const bridges = installBridges();
    render(<GapAnalysis cv={CV} vacancy={TEST_VACANCY} model="sonnet" />);

    fireEvent.click(screen.getByRole('button', { name: /analyse gaps/i }));

    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));

    const input = vi.mocked(bridges.agentDock.createSession).mock.calls[0]?.[0];
    expect(input?.provider).toBe('claude');
    expect(input?.cwd).toBe('/userData/ai-workspace'); // from window.cv.getWorkspaceDir(), not guessed
    expect(input?.model).toBe('sonnet');
    expect(input?.prompt).toContain('## Gaps');
    expect(input?.prompt).toContain('Senior Frontend Engineer');
    expect(input?.prompt).toContain('Angular architect. 8 years of frontend work.');

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/starting claude code|analysing/i));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();

    bridges.emit('sess-cv-1', { type: 'assistant.message', text: '## Strengths' });
    bridges.emit('sess-cv-1', { type: 'assistant.message', text: 'Eight years of Angular.' });

    await waitFor(() => expect(screen.getByRole('log', { name: /gap analysis/i })).toHaveTextContent('## Strengths'));
    expect(screen.getByRole('log', { name: /gap analysis/i })).toHaveTextContent('Eight years of Angular.');

    bridges.emit('sess-cv-1', { type: 'session.completed' });

    await waitFor(() => expect(screen.getByRole('button', { name: /re-run analysis/i })).toBeEnabled());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });

  it('ignores events belonging to another session', async () => {
    const bridges = installBridges();
    render(<GapAnalysis cv={CV} vacancy={TEST_VACANCY} />);
    fireEvent.click(screen.getByRole('button', { name: /analyse gaps/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());

    bridges.emit('some-other-session', { type: 'assistant.message', text: 'should not appear' });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText('should not appear')).not.toBeInTheDocument();
  });

  it('surfaces session.failed as an error state without crashing', async () => {
    const bridges = installBridges();
    render(<GapAnalysis cv={CV} vacancy={TEST_VACANCY} />);
    fireEvent.click(screen.getByRole('button', { name: /analyse gaps/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());

    bridges.emit('sess-cv-1', { type: 'session.failed', message: 'claude exited with code 1' });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('claude exited with code 1');
    expect(screen.getByRole('button', { name: /re-run analysis/i })).toBeEnabled();
  });

  it('surfaces a rejected createSession as an error state instead of an endless spinner', async () => {
    installBridges({ agentDock: { createSession: vi.fn().mockRejectedValue(new Error('daemon is not ready yet')) } });
    render(<GapAnalysis cv={CV} vacancy={TEST_VACANCY} />);
    fireEvent.click(screen.getByRole('button', { name: /analyse gaps/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('daemon is not ready yet');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('treats a completed run that produced no text as a failure, not an empty success', async () => {
    const bridges = installBridges();
    render(<GapAnalysis cv={CV} vacancy={TEST_VACANCY} />);
    fireEvent.click(screen.getByRole('button', { name: /analyse gaps/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());

    bridges.emit('sess-cv-1', { type: 'session.completed' });

    expect(await screen.findByRole('alert')).toHaveTextContent(/without returning any text/i);
  });

  it('cancels the running session through the bridge', async () => {
    const bridges = installBridges();
    render(<GapAnalysis cv={CV} vacancy={TEST_VACANCY} />);
    fireEvent.click(screen.getByRole('button', { name: /analyse gaps/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(bridges.agentDock.cancelSession).toHaveBeenCalledWith('sess-cv-1'));

    bridges.emit('sess-cv-1', { type: 'session.cancelled' });
    expect(await screen.findByText(/^Cancelled\.$/)).toBeInTheDocument();
  });
});
