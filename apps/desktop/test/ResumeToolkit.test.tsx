import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResumeToolkit } from '../src/components/cv/ResumeToolkit.js';
import type { CvDocument } from '../src/components/cv/types.js';
import { installBridges } from './cv-bridges.js';

const CV: CvDocument = { fileName: 'cv.pdf', text: 'Angular architect. 8 years of frontend work.' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ResumeToolkit', () => {
  it('offers all CV-only modes without requiring a vacancy', () => {
    installBridges();
    render(<ResumeToolkit cv={CV} />);

    expect(screen.getByRole('tab', { name: 'Resume audit' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Improve achievements' })).toBeEnabled();
    expect(screen.getByRole('tab', { name: 'Best-fit roles' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Run resume audit' })).toBeEnabled();
  });

  it('runs only the selected grounded prompt and keeps the result review-only', async () => {
    const bridges = installBridges();
    render(<ResumeToolkit cv={CV} model="sonnet" />);

    fireEvent.click(screen.getByRole('tab', { name: 'Improve achievements' }));
    fireEvent.click(screen.getByRole('button', { name: 'Find achievement rewrites' }));

    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));
    const input = vi.mocked(bridges.agentDock.createSession).mock.calls[0]?.[0];
    expect(input?.model).toBe('sonnet');
    expect(input?.prompt).toContain('**Supported rewrite:**');
    expect(input?.prompt).toContain('**Missing evidence:**');
    expect(input?.prompt).toContain('Do not use any tools');
    expect(input?.prompt).not.toContain('=== VACANCY ===');

    bridges.emit('sess-cv-1', { type: 'assistant.message', text: 'Grounded rewrite.' });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    expect(
      await screen.findByRole('log', { name: /achievement rewrite result/i }),
    ).toHaveTextContent('Grounded rewrite.');
    expect(screen.getByRole('button', { name: /copy to clipboard/i })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });

  it('clears the previous mode output before starting a different review', async () => {
    const bridges = installBridges();
    render(<ResumeToolkit cv={CV} />);

    fireEvent.click(screen.getByRole('button', { name: 'Run resume audit' }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));
    bridges.emit('sess-cv-1', { type: 'assistant.message', text: 'Audit result.' });
    bridges.emit('sess-cv-1', { type: 'session.completed' });
    expect(await screen.findByText('Audit result.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Best-fit roles' }));
    expect(screen.queryByText('Audit result.')).not.toBeInTheDocument();
    expect(screen.getByText('No best-fit roles yet.')).toBeInTheDocument();
  });
});
