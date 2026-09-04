import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CvAssistant } from '../src/components/cv/CvAssistant.js';
import { installBridges, TEST_VACANCY } from './cv-bridges.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CvAssistant', () => {
  it('uploads the CV once and enables all three AI features from that single upload', async () => {
    installBridges({
      cv: { selectAndRead: vi.fn().mockResolvedValue({ fileName: 'jake.pdf', text: 'Angular architect.' }) },
    });

    render(<CvAssistant vacancy={TEST_VACANCY} />);

    expect(screen.getByRole('button', { name: /analyse gaps/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /draft cover letter/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /draft tailored cv/i })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /choose cv file/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /analyse gaps/i })).toBeEnabled());
    expect(screen.getByRole('button', { name: /draft cover letter/i })).toBeEnabled();
    // The third card reads the same single upload as the other two, rather than asking again.
    expect(screen.getByRole('button', { name: /draft tailored cv/i })).toBeEnabled();
    expect(screen.getByText(/jake\.pdf/)).toBeInTheDocument();
    // The vacancy under consideration is named, so the user knows what these buttons act on.
    expect(screen.getByText('Senior Frontend Engineer')).toBeInTheDocument();
  });

  it('runs each card as its own session, so one draft never lands in another card', async () => {
    const bridges = installBridges({
      cv: { selectAndRead: vi.fn().mockResolvedValue({ fileName: 'jake.pdf', text: 'Angular architect.' }) },
    });

    render(<CvAssistant vacancy={TEST_VACANCY} />);
    fireEvent.click(screen.getByRole('button', { name: /choose cv file/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /analyse gaps/i })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: /draft tailored cv/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));

    const prompt = vi.mocked(bridges.agentDock.createSession).mock.calls[0]?.[0].prompt ?? '';
    expect(prompt).toContain('reordering and re-emphasis task');
    expect(prompt).not.toContain('motivation letter');
    expect(prompt).not.toContain('## Overall fit');

    bridges.emit('sess-cv-1', { type: 'assistant.message', text: 'Tailored CV body.' });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    const tailored = await screen.findByRole('log', { name: /tailored cv draft/i });
    expect(tailored).toHaveTextContent('Tailored CV body.');
    // The other two cards share the process-wide event stream but filter by session id, so they
    // render no output panel at all rather than mirroring the tailoring run's text.
    expect(screen.queryByRole('log', { name: /cover letter draft/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('log', { name: /gap analysis result/i })).not.toBeInTheDocument();
  });

  it('warns, without crashing, when Claude Code is not installed', async () => {
    installBridges({
      agentDock: {
        listProviders: vi.fn().mockResolvedValue([
          {
            id: 'claude',
            name: 'Claude Code',
            installed: false,
            authenticated: 'unknown',
            capabilities: { resume: true, cancellation: true, tools: true, usage: true, thinking: true },
          },
        ]),
      },
    });

    render(<CvAssistant vacancy={TEST_VACANCY} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/claude code is not installed/i);
  });

  it('offers the provider model picker and passes the chosen model into the session', async () => {
    const bridges = installBridges({
      cv: { selectAndRead: vi.fn().mockResolvedValue({ fileName: 'jake.pdf', text: 'Angular architect.' }) },
    });

    render(<CvAssistant vacancy={TEST_VACANCY} />);
    const picker = await screen.findByRole('combobox', { name: /model/i });
    fireEvent.change(picker, { target: { value: 'opus' } });

    fireEvent.click(screen.getByRole('button', { name: /choose cv file/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /analyse gaps/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /analyse gaps/i }));

    await waitFor(() =>
      expect(vi.mocked(bridges.agentDock.createSession).mock.calls[0]?.[0].model).toBe('opus'),
    );
  });
});
