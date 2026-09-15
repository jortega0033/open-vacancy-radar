import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoverLetter } from '../src/components/cv/CoverLetter.js';
import type { CvDocument } from '../src/components/cv/types.js';
import type { CvProfile, CvSourceDocument } from '../src/window.js';
import { installBridges, TEST_VACANCY } from './cv-bridges.js';

const CV: CvDocument = { fileName: 'cv.pdf', text: 'Angular architect. 8 years of frontend work.' };

/**
 * A reviewed source CV, which is now the precondition for drafting at all: the card assembles the
 * letter from facts a person confirmed rather than from prose a model wrote (F-J).
 *
 * Synthetic throughout: an invented candidate, an invented employer, an `example.invalid` address.
 */
const SOURCE_CV: CvSourceDocument = {
  contact: {
    name: 'Robin Vega',
    title: 'Senior Frontend Engineer',
    location: 'Amsterdam',
    email: 'robin.vega@example.invalid',
    phone: '',
    links: [],
  },
  summary: 'Frontend engineer working on design systems.',
  experience: [
    {
      company: 'Northwind Digital',
      title: 'Senior Frontend Engineer',
      dates: '2021 - present',
      engagement: 'employment',
      client: '',
      bullets: ['Rebuilt the component library.'],
    },
  ],
  education: [{ institution: 'Utrecht Polytechnic', credential: 'BSc Computer Science', dates: '2013 - 2017' }],
  projects: [],
  maxProjects: 0,
  complete: true,
  incompleteReason: '',
  coveredChars: 4_000,
  sourceChars: 4_000,
  reviewedAt: '2026-08-01T09:00:00.000Z',
};

const PROFILE: CvProfile = {
  title: 'Senior Frontend Engineer',
  years: '8 years',
  location: 'Amsterdam',
  languages: 'English, Dutch',
  skills: ['Angular', 'TypeScript'],
  summary: 'Frontend engineer.',
  auth: 'EU citizen',
};

/** One well-formed reply: two ids that exist on the reviewed source above. */
const FACT_SELECTION = '{"factIds":["experience-1","skill-1"]}';

/** jsdom has no clipboard implementation, so install one we can assert against. */
function stubClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true });
  return writeText;
}

function renderCard() {
  return render(<CoverLetter cv={CV} vacancy={TEST_VACANCY} sourceCv={SOURCE_CV} profile={PROFILE} />);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CoverLetter', () => {
  it('asks for a fact selection over the reviewed CV, then assembles the letter from it', async () => {
    const bridges = installBridges();
    stubClipboard();
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /draft cover letter/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));

    const prompt = vi.mocked(bridges.agentDock.createSession).mock.calls[0]?.[0].prompt ?? '';
    expect(prompt).toContain('motivation letter');
    expect(prompt).toContain('Redwood Software');
    expect(prompt).toContain('Angular architect. 8 years of frontend work.');
    // The selection contract: ids out of an enumerated list, never a document.
    expect(prompt).toContain('{"factIds": [string]}');
    expect(prompt).toContain('You do not write this document.');
    expect(prompt).toContain('experience-1');
    expect(prompt).toContain('Never invent an employer, job title, date');

    bridges.emit('sess-cv-1', { type: 'assistant.message', text: FACT_SELECTION });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    const draft = await screen.findByRole('log', { name: /cover letter draft/i });
    expect(draft).toHaveTextContent('Hello Redwood Software hiring team,');
    expect(draft).toHaveTextContent(
      'My reviewed CV lists Senior Frontend Engineer at Northwind Digital (2021 - present).',
    );
    expect(draft).toHaveTextContent('My reviewed CV lists Angular as a skill.');
    expect(draft).toHaveTextContent('Best regards,');
    expect(draft).toHaveTextContent('Robin Vega');
    expect(screen.getByRole('button', { name: /regenerate/i })).toBeEnabled();
  });

  it('rejects a free-prose reply rather than showing it as a draft', async () => {
    const bridges = installBridges();
    stubClipboard();
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /draft cover letter/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());

    bridges.emit('sess-cv-1', {
      type: 'assistant.message',
      text: 'Dear hiring team, I hold a CISSP and have led teams of forty.',
    });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    expect(await screen.findByRole('alert')).toHaveTextContent('returned invalid JSON');
    expect(screen.queryByRole('log', { name: /cover letter draft/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/CISSP/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy to clipboard/i })).toBeDisabled();
  });

  it('rejects a selection naming a fact the reviewed CV does not carry', async () => {
    const bridges = installBridges();
    stubClipboard();
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /draft cover letter/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());

    bridges.emit('sess-cv-1', { type: 'assistant.message', text: '{"factIds":["employer-fabrikam"]}' });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    expect(await screen.findByRole('alert')).toHaveTextContent('unsupported source facts: employer-fabrikam');
    expect(screen.queryByRole('log', { name: /cover letter draft/i })).not.toBeInTheDocument();
  });

  it('cannot draft from a CV with no reviewed source, and says what would fix it', () => {
    installBridges();
    stubClipboard();
    render(<CoverLetter cv={CV} vacancy={TEST_VACANCY} />);

    expect(screen.getByRole('button', { name: /draft cover letter/i })).toBeDisabled();
    expect(screen.getByText(/no reviewed source record yet/i)).toBeInTheDocument();
  });

  it('copies the assembled letter to the clipboard and confirms it', async () => {
    const bridges = installBridges();
    const writeText = stubClipboard();
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /draft cover letter/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());

    expect(screen.getByRole('button', { name: /copy to clipboard/i })).toBeDisabled(); // nothing to copy yet

    bridges.emit('sess-cv-1', { type: 'assistant.message', text: FACT_SELECTION });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    const copyButton = await screen.findByRole('button', { name: /copy to clipboard/i });
    await waitFor(() => expect(copyButton).toBeEnabled());
    fireEvent.click(copyButton);

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Hello Redwood Software hiring team,')),
    );
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });

  it('reports a clipboard failure instead of silently claiming success', async () => {
    const bridges = installBridges();
    stubClipboard(vi.fn().mockRejectedValue(new Error('Write permission denied.')));
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /draft cover letter/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());
    bridges.emit('sess-cv-1', { type: 'assistant.message', text: FACT_SELECTION });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    fireEvent.click(await screen.findByRole('button', { name: /copy to clipboard/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Write permission denied.');
    expect(screen.queryByText('Copied')).not.toBeInTheDocument();
  });

  it('regenerating starts a fresh session and discards the previous draft', async () => {
    const bridges = installBridges();
    stubClipboard();
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: /draft cover letter/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(1));
    bridges.emit('sess-cv-1', { type: 'assistant.message', text: '{"factIds":["education-1"]}' });
    bridges.emit('sess-cv-1', { type: 'session.completed' });

    await screen.findByText(/BSc Computer Science/);
    fireEvent.click(await screen.findByRole('button', { name: /regenerate/i }));

    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/BSc Computer Science/)).not.toBeInTheDocument());
  });

  it('surfaces a failed generation without crashing', async () => {
    const bridges = installBridges();
    stubClipboard();
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: /draft cover letter/i }));
    await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());

    bridges.emit('sess-cv-1', { type: 'session.failed', message: 'provider CLI is not authenticated' });

    expect(await screen.findByRole('alert')).toHaveTextContent('provider CLI is not authenticated');
  });
});
