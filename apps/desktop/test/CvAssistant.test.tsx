import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CvAssistant } from '../src/components/cv/CvAssistant.js';
import type { CvDocumentRecord } from '../src/window.js';
import { installBridges, TEST_VACANCY } from './cv-bridges.js';
import { installWorkspaceBridge } from './workspace-bridge.js';

function makeCv(overrides: Partial<CvDocumentRecord> = {}): CvDocumentRecord {
  return {
    id: 'cv-1',
    name: 'Frontend CV.pdf',
    kind: 'uploaded',
    targetRole: '',
    text: 'Angular architect.',
    profile: {
      title: '',
      years: '',
      location: '',
      languages: '',
      skills: [],
      summary: '',
      auth: '',
    },
    source: null,
    isDefault: false,
    uploadedAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CvAssistant', () => {
  it('defaults to the library default CV and marks it clearly', async () => {
    installBridges();
    installWorkspaceBridge({
      listCvDocuments: vi.fn().mockResolvedValue([
        makeCv({ id: 'cv-1', name: 'Old CV.pdf', text: 'Old profile.' }),
        makeCv({
          id: 'cv-2',
          name: 'Default Product CV.pdf',
          text: 'Product engineer.',
          isDefault: true,
        }),
      ]),
    });

    render(<CvAssistant vacancy={TEST_VACANCY} />);

    const picker = await screen.findByRole('combobox', { name: /use saved cv/i });
    expect(picker).toHaveValue('cv-2');
    expect(screen.getByText(/Default Product CV\.pdf \(Default\)/)).toBeInTheDocument();
    expect(screen.getByText(/CV loaded:/)).toHaveTextContent('Default Product CV.pdf');
    expect(screen.getByRole('button', { name: /check ats fit/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /run resume audit/i })).toBeEnabled();
  });

  it('switches library CVs and still allows a one-off upload fallback', async () => {
    installBridges({
      cv: {
        selectAndRead: vi.fn().mockResolvedValue({ fileName: 'one-off.pdf', text: 'One off CV.' }),
      },
    });
    installWorkspaceBridge({
      listCvDocuments: vi
        .fn()
        .mockResolvedValue([
          makeCv({ id: 'cv-1', name: 'Frontend CV.pdf', text: 'Frontend.' }),
          makeCv({ id: 'cv-2', name: 'Backend CV.pdf', text: 'Backend.' }),
        ]),
    });

    render(<CvAssistant vacancy={TEST_VACANCY} />);

    const picker = await screen.findByRole('combobox', { name: /use saved cv/i });
    expect(screen.getByText(/CV loaded:/)).toHaveTextContent('Frontend CV.pdf');

    fireEvent.change(picker, { target: { value: 'cv-2' } });
    expect(screen.getByText(/CV loaded:/)).toHaveTextContent('Backend CV.pdf');

    fireEvent.click(screen.getByRole('button', { name: /replace cv/i }));
    await waitFor(() => expect(screen.getByText(/CV loaded:/)).toHaveTextContent('one-off.pdf'));
  });

  it('explains library CVs that cannot be used because no text was extracted', async () => {
    installBridges();
    installWorkspaceBridge({
      listCvDocuments: vi.fn().mockResolvedValue([makeCv({ text: '' })]),
    });

    render(<CvAssistant vacancy={TEST_VACANCY} />);

    expect(await screen.findByText(/no saved cv with extracted text/i)).toBeInTheDocument();
    expect(screen.getByText(/1 saved CV is unavailable/i)).toBeInTheDocument();
  });

  it('uploads the CV once and enables all three AI features from that single upload', async () => {
    installBridges({
      cv: {
        selectAndRead: vi
          .fn()
          .mockResolvedValue({ fileName: 'jake.pdf', text: 'Angular architect.' }),
      },
    });

    render(<CvAssistant vacancy={TEST_VACANCY} />);

    expect(screen.getByRole('button', { name: /check ats fit/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /draft cover letter/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /draft tailored cv/i })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /choose cv file/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /check ats fit/i })).toBeEnabled(),
    );
    expect(screen.getByRole('button', { name: /draft cover letter/i })).toBeEnabled();
    // The third card reads the same single upload as the other two, rather than asking again.
    expect(screen.getByRole('button', { name: /draft tailored cv/i })).toBeEnabled();
    expect(screen.getByText(/jake\.pdf/)).toBeInTheDocument();
    // The vacancy under consideration is named, so the user knows what these buttons act on.
    expect(screen.getByText('Senior Frontend Engineer')).toBeInTheDocument();
  });

  it('runs each card as its own session, so one draft never lands in another card', async () => {
    const bridges = installBridges({
      cv: {
        selectAndRead: vi
          .fn()
          .mockResolvedValue({ fileName: 'jake.pdf', text: 'Angular architect.' }),
      },
    });

    render(<CvAssistant vacancy={TEST_VACANCY} />);
    fireEvent.click(screen.getByRole('button', { name: /choose cv file/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /check ats fit/i })).toBeEnabled(),
    );

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
    expect(screen.queryByRole('log', { name: /ats fit result/i })).not.toBeInTheDocument();
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
            capabilities: {
              resume: true,
              cancellation: true,
              tools: true,
              usage: true,
              thinking: true,
            },
          },
        ]),
      },
    });

    render(<CvAssistant vacancy={TEST_VACANCY} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/claude code is not installed/i);
  });

  it('offers the provider model picker and passes the chosen model into the session', async () => {
    const bridges = installBridges({
      cv: {
        selectAndRead: vi
          .fn()
          .mockResolvedValue({ fileName: 'jake.pdf', text: 'Angular architect.' }),
      },
    });

    render(<CvAssistant vacancy={TEST_VACANCY} />);
    const picker = await screen.findByRole('combobox', { name: /model/i });
    fireEvent.change(picker, { target: { value: 'opus' } });

    fireEvent.click(screen.getByRole('button', { name: /choose cv file/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /check ats fit/i })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: /check ats fit/i }));

    await waitFor(() =>
      expect(vi.mocked(bridges.agentDock.createSession).mock.calls[0]?.[0].model).toBe('opus'),
    );
  });
});
