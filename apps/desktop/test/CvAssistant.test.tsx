import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CvAssistant } from '../src/components/cv/CvAssistant.js';
import { installBridges, TEST_VACANCY } from './cv-bridges.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CvAssistant', () => {
  it('uploads the CV once and enables both AI features from that single upload', async () => {
    installBridges({
      cv: { selectAndRead: vi.fn().mockResolvedValue({ fileName: 'jake.pdf', text: 'Angular architect.' }) },
    });

    render(<CvAssistant vacancy={TEST_VACANCY} />);

    expect(screen.getByRole('button', { name: /analyse gaps/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /draft cover letter/i })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /choose cv file/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /analyse gaps/i })).toBeEnabled());
    expect(screen.getByRole('button', { name: /draft cover letter/i })).toBeEnabled();
    expect(screen.getByText(/jake\.pdf/)).toBeInTheDocument();
    // The vacancy under consideration is named, so the user knows what these buttons act on.
    expect(screen.getByText('Senior Frontend Engineer')).toBeInTheDocument();
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
