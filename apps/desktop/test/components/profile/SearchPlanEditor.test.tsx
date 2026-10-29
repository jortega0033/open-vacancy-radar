import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_SEARCH_PLAN, type SearchPlan } from '@open-vacancy-radar/vacancy-engine';
import { SearchPlanEditor } from '../../../src/components/profile/SearchPlanEditor.js';
import { installVacancyRadarBridge } from '../../workspace-bridge.js';

const PLAN: SearchPlan = {
  schemaVersion: 1,
  revision: 3,
  updatedAt: '2026-10-29T10:00:00.000Z',
  primaryFunction: 'Frontend engineering',
  variants: [
    { id: 'react-developer', title: 'React developer', language: '', origin: 'user' },
    { id: 'frontend-ontwikkelaar-dutch', title: 'Frontend ontwikkelaar', language: 'Dutch', origin: 'toolkit' },
  ],
  markets: ['Netherlands'],
  suggestions: [
    { id: 'ui-engineer', title: 'UI engineer', language: '', origin: 'toolkit', suggestedAt: '2026-10-29T10:00:00.000Z' },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SearchPlanEditor (#686)', () => {
  it('shows the approved titles in order with language and where each came from, apart from suggestions', async () => {
    installVacancyRadarBridge({ getSearchPlan: vi.fn().mockResolvedValue(PLAN) });
    render(<SearchPlanEditor />);

    const list = await screen.findByRole('list', { name: 'Approved titles, in order' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('React developer');
    expect(items[0]).toHaveTextContent('Added by you');
    expect(items[1]).toHaveTextContent('Frontend ontwikkelaar');
    expect(items[1]).toHaveTextContent('Dutch');
    expect(items[1]).toHaveTextContent('From the CV tools, approved by you');
    // A suggestion is listed separately and is not part of the approved list.
    expect(within(list).queryByText('UI engineer')).not.toBeInTheDocument();
    const suggestions = screen.getByRole('list', { name: 'Suggested titles' });
    expect(suggestions).toHaveTextContent('UI engineer');
    expect(screen.getByText(/not part of your searches until you add them/i)).toBeInTheDocument();
  });

  it('lets a person approve a plan by hand, with no AI, in the order and language they chose', async () => {
    const saveSearchPlan = vi.fn().mockResolvedValue({ ...EMPTY_SEARCH_PLAN, revision: 1 });
    const bridge = installVacancyRadarBridge({
      getSearchPlan: vi.fn().mockResolvedValue(EMPTY_SEARCH_PLAN),
      saveSearchPlan,
    });
    render(<SearchPlanEditor />);

    fireEvent.click(await screen.findByRole('button', { name: 'Add search plan titles' }));
    fireEvent.change(screen.getByLabelText('Primary function'), { target: { value: 'Frontend engineering' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a title' }));
    fireEvent.change(screen.getByLabelText('Title 1'), { target: { value: 'React developer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a title' }));
    fireEvent.change(screen.getByLabelText('Title 2'), { target: { value: 'Frontend ontwikkelaar' } });
    fireEvent.change(screen.getByLabelText('Working language for title 2'), { target: { value: 'Dutch' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move title 2 up' }));
    fireEvent.change(screen.getByLabelText(/Markets/), { target: { value: 'Netherlands, Germany' } });
    expect(saveSearchPlan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Approve search plan' }));

    await waitFor(() => expect(saveSearchPlan).toHaveBeenCalledTimes(1));
    expect(saveSearchPlan).toHaveBeenCalledWith({
      primaryFunction: 'Frontend engineering',
      variants: [
        { title: 'Frontend ontwikkelaar', language: 'Dutch', origin: 'user' },
        { title: 'React developer', language: '', origin: 'user' },
      ],
      markets: ['Netherlands', 'Germany'],
    });
    // Approving a plan never touches the candidate profile.
    expect(bridge.saveSearchProfile).not.toHaveBeenCalled();
  });

  it('adds a suggestion only when the person presses Add, keeping its origin', async () => {
    const saveSearchPlan = vi.fn().mockResolvedValue({ ...PLAN, suggestions: [] });
    const bridge = installVacancyRadarBridge({ getSearchPlan: vi.fn().mockResolvedValue(PLAN), saveSearchPlan });
    render(<SearchPlanEditor />);

    await screen.findByRole('list', { name: 'Suggested titles' });
    expect(saveSearchPlan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Add suggested title UI engineer' }));
    await waitFor(() => expect(saveSearchPlan).toHaveBeenCalledTimes(1));
    expect(saveSearchPlan.mock.calls[0]![0].variants).toEqual([
      { title: 'React developer', language: '', origin: 'user' },
      { title: 'Frontend ontwikkelaar', language: 'Dutch', origin: 'toolkit' },
      { title: 'UI engineer', language: '', origin: 'toolkit' },
    ]);
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Suggested titles' })).not.toBeInTheDocument());
    expect(bridge.saveSearchProfile).not.toHaveBeenCalled();
  });

  it('dismisses a suggestion without approving anything', async () => {
    const dismissSearchPlanSuggestion = vi.fn().mockResolvedValue({ ...PLAN, suggestions: [] });
    const saveSearchPlan = vi.fn();
    installVacancyRadarBridge({
      getSearchPlan: vi.fn().mockResolvedValue(PLAN),
      dismissSearchPlanSuggestion,
      saveSearchPlan,
    });
    render(<SearchPlanEditor />);

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss suggested title UI engineer' }));
    await waitFor(() => expect(dismissSearchPlanSuggestion).toHaveBeenCalledWith('ui-engineer'));
    expect(saveSearchPlan).not.toHaveBeenCalled();
  });

  it('says plainly when no title is approved yet and that searches then use only what is typed', async () => {
    installVacancyRadarBridge({ getSearchPlan: vi.fn().mockResolvedValue(EMPTY_SEARCH_PLAN) });
    render(<SearchPlanEditor />);
    expect(await screen.findByText(/No titles approved yet. Searches use only what you type/)).toBeInTheDocument();
  });
});
