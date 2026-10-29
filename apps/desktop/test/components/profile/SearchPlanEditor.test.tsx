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
    installVacancyRadarBridge({ getSearchPlan: vi.fn().mockResolvedValue({ status: 'ok', plan: PLAN }) });
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
      getSearchPlan: vi.fn().mockResolvedValue({ status: 'ok', plan: EMPTY_SEARCH_PLAN }),
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
    const bridge = installVacancyRadarBridge({ getSearchPlan: vi.fn().mockResolvedValue({ status: 'ok', plan: PLAN }), saveSearchPlan });
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
      getSearchPlan: vi.fn().mockResolvedValue({ status: 'ok', plan: PLAN }),
      dismissSearchPlanSuggestion,
      saveSearchPlan,
    });
    render(<SearchPlanEditor />);

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss suggested title UI engineer' }));
    await waitFor(() => expect(dismissSearchPlanSuggestion).toHaveBeenCalledWith('ui-engineer'));
    expect(saveSearchPlan).not.toHaveBeenCalled();
  });

  it('says plainly when no title is approved yet and that searches then use only what is typed', async () => {
    installVacancyRadarBridge({ getSearchPlan: vi.fn().mockResolvedValue({ status: 'ok', plan: EMPTY_SEARCH_PLAN }) });
    render(<SearchPlanEditor />);
    expect(await screen.findByText(/No titles approved yet. Searches use only what you type/)).toBeInTheDocument();
  });

  it('says markets, the primary function and languages do not filter, so nothing looks applied when it is not', async () => {
    installVacancyRadarBridge({ getSearchPlan: vi.fn().mockResolvedValue({ status: 'ok', plan: PLAN }) });
    render(<SearchPlanEditor />);
    expect(await screen.findByText(/Markets and the primary function are kept with your plan but do not filter searches/)).toBeInTheDocument();
    expect(screen.getByText(/never treated as a requirement/)).toBeInTheDocument();
    expect(screen.getByText('Markets (kept with the plan only)')).toBeInTheDocument();
  });

  it('a newer-version plan is named as such, kept untouched, and replaced only after confirmation with a backup', async () => {
    const resetSearchPlan = vi.fn().mockResolvedValue({
      plan: EMPTY_SEARCH_PLAN,
      backupFileName: 'search-plan-v1.json.unreadable-2026-10-29T10-00-00-000Z.bak',
    });
    const saveSearchPlan = vi.fn();
    installVacancyRadarBridge({
      getSearchPlan: vi.fn().mockResolvedValue({
        status: 'unreadable',
        reason: 'newer_version',
        message: 'Your search plan was saved by a newer version of Open Vacancy Radar (plan format 2). This version cannot read it and will not change it.',
        fileName: 'search-plan-v1.json',
      }),
      resetSearchPlan,
      saveSearchPlan,
    });
    render(<SearchPlanEditor />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your search plan was saved by a newer version of the app');
    expect(alert).toHaveTextContent('plan format 2');
    expect(alert).toHaveTextContent('Updating Open Vacancy Radar lets you use it again.');
    // One explicit step, then a confirmation; nothing is replaced before it.
    fireEvent.click(screen.getByRole('button', { name: 'Start a new plan' }));
    expect(resetSearchPlan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start a new plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep a backup and start a new plan' }));
    await waitFor(() => expect(resetSearchPlan).toHaveBeenCalledWith({ confirm: true }));
    expect(resetSearchPlan).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/kept unchanged as search-plan-v1\.json\.unreadable-2026-10-29T10-00-00-000Z\.bak/)).toBeInTheDocument();
    // The editor is usable again, on an empty plan.
    expect(screen.getByRole('button', { name: 'Add search plan titles' })).toBeInTheDocument();
    expect(saveSearchPlan).not.toHaveBeenCalled();
  });

  it('a damaged plan reads differently from a newer-version plan', async () => {
    installVacancyRadarBridge({
      getSearchPlan: vi.fn().mockResolvedValue({
        status: 'unreadable',
        reason: 'damaged',
        message: 'Your search plan file is damaged: it is not valid JSON.',
        fileName: 'search-plan-v1.json',
      }),
    });
    render(<SearchPlanEditor />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your search plan file is damaged');
    expect(alert).not.toHaveTextContent('newer version');
    expect(screen.getByRole('button', { name: 'Start a new plan' })).toBeInTheDocument();
  });

  it('shows a readable save refusal for an unusable title, not a raw validation error', async () => {
    const saveSearchPlan = vi.fn().mockRejectedValue(
      new Error(
        "Error invoking remote method 'vacancy:save-search-plan': SearchPlanValidationError: Title 1 (\"##\") has no letters or numbers, so no source can search for it. Change it or remove it.",
      ),
    );
    installVacancyRadarBridge({ getSearchPlan: vi.fn().mockResolvedValue({ status: 'ok', plan: EMPTY_SEARCH_PLAN }), saveSearchPlan });
    render(<SearchPlanEditor />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add search plan titles' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a title' }));
    fireEvent.change(screen.getByLabelText('Title 1'), { target: { value: '##' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve search plan' }));
    expect(
      await screen.findByText('Title 1 ("##") has no letters or numbers, so no source can search for it. Change it or remove it.'),
    ).toBeInTheDocument();
  });

  it('offers a retry when the plan could not be loaded at all', async () => {
    const getSearchPlan = vi.fn().mockRejectedValueOnce(new Error('ipc down')).mockResolvedValue({ status: 'ok', plan: EMPTY_SEARCH_PLAN });
    installVacancyRadarBridge({ getSearchPlan });
    render(<SearchPlanEditor />);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/No titles approved yet/)).toBeInTheDocument();
  });
});
