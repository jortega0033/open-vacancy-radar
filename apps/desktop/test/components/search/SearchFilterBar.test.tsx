import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SearchFilterBar } from '../../../src/components/search/SearchFilterBar.js';
import { DEFAULT_FILTERS, type SearchFilters } from '../../../src/components/search/results.js';

function renderBar(filters: SearchFilters, onFiltersChange = vi.fn(), onClear = vi.fn()) {
  render(
    <SearchFilterBar
      filters={filters}
      onFiltersChange={onFiltersChange}
      onLocationChange={vi.fn()}
      onSearch={vi.fn()}
      onBrowseAll={vi.fn()}
      onClear={onClear}
      sources={['remotive']}
      employmentTypes={['full_time']}
      busy={false}
      salaryNote=""
      hasReport
      aiWebDiscovery={false}
      onAiWebDiscoveryChange={vi.fn()}
      aiWebDiscoveryAvailable
      onOpenSearchProfile={vi.fn()}
    />,
  );
  return onFiltersChange;
}

/** A bar that actually applies changes, so chips and the count react like in the app. */
function StatefulBar({ initial = DEFAULT_FILTERS }: { initial?: SearchFilters }) {
  const [filters, setFilters] = useState<SearchFilters>({ ...initial, query: 'nurse' });
  return (
    <>
      <SearchFilterBar
        filters={filters}
        onFiltersChange={(patch) => setFilters((current) => ({ ...current, ...patch }))}
        onLocationChange={vi.fn()}
        onSearch={vi.fn()}
        onBrowseAll={vi.fn()}
        onClear={() => setFilters({ ...DEFAULT_FILTERS, query: 'nurse' })}
        sources={['remotive']}
        employmentTypes={['full_time']}
        busy={false}
        salaryNote=""
        hasReport
        aiWebDiscovery={false}
        onAiWebDiscoveryChange={vi.fn()}
        aiWebDiscoveryAvailable
        onOpenSearchProfile={vi.fn()}
      />
      <button type="button">Outside</button>
    </>
  );
}

function filtersButton() {
  return screen.getByRole('button', { name: /^Filters/ });
}

describe('SearchFilterBar primary controls', () => {
  it('shows only role, country, the AI toggle and Search until Filters is opened', () => {
    renderBar({ ...DEFAULT_FILTERS, query: 'nurse' });
    expect(screen.getByRole('searchbox', { name: 'Role or keywords' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Country' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Also search the web with AI' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument();
    for (const name of ['Posted within', 'Job source', 'Employment type']) {
      expect(screen.queryByRole('combobox', { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('checkbox', { name: 'Hide on-site and hybrid' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Minimum annual salary' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it('keeps Browse all vacancies reachable while no role is typed', () => {
    renderBar({ ...DEFAULT_FILTERS });
    expect(screen.getByRole('button', { name: 'Browse all vacancies' })).toBeEnabled();
  });
});

describe('SearchFilterBar Filters popover', () => {
  it('wires aria-expanded and aria-controls and gives every control a name', () => {
    renderBar({ ...DEFAULT_FILTERS, query: 'nurse' });
    const button = filtersButton();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const panel = screen.getByRole('group', { name: 'Filters' });
    expect(button.getAttribute('aria-controls')).toBe(panel.id);
    const inPanel = within(panel);
    expect(inPanel.getByRole('combobox', { name: 'Posted within' })).toBeInTheDocument();
    expect(inPanel.getByRole('combobox', { name: 'Job source' })).toBeInTheDocument();
    expect(inPanel.getByRole('combobox', { name: 'Employment type' })).toBeInTheDocument();
    expect(inPanel.getByRole('textbox', { name: 'Minimum annual salary' })).toBeInTheDocument();
    expect(inPanel.getByRole('combobox', { name: 'Salary currency' })).toBeInTheDocument();
    expect(inPanel.getByRole('checkbox', { name: 'Include jobs with no salary' })).toBeInTheDocument();
    expect(inPanel.getByRole('checkbox', { name: 'Hide on-site and hybrid' })).toBeInTheDocument();
    expect(inPanel.getByRole('button', { name: 'Clear filters' })).toBeInTheDocument();
  });

  it('opens from the keyboard, and Escape closes it and returns focus to the button', () => {
    render(<StatefulBar />);
    const button = filtersButton();
    button.focus();
    // A native button turns Enter/Space into a click; jsdom does not, so click stands in for it.
    fireEvent.click(button);
    const select = screen.getByRole('combobox', { name: 'Posted within' });
    select.focus();
    expect(select).toHaveFocus();
    fireEvent.keyDown(select, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Filters' })).not.toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();
  });

  it('closes on an outside press', () => {
    render(<StatefulBar />);
    fireEvent.click(filtersButton());
    expect(screen.getByRole('group', { name: 'Filters' })).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('group', { name: 'Filters' })).not.toBeInTheDocument();
  });

  it('stays open when pressing inside the panel', () => {
    render(<StatefulBar />);
    fireEvent.click(filtersButton());
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Job source' }));
    expect(screen.getByRole('group', { name: 'Filters' })).toBeInTheDocument();
  });
});

describe('SearchFilterBar active filters', () => {
  it('has no count and no chips by default', () => {
    render(<StatefulBar />);
    expect(filtersButton()).toHaveAccessibleName('Filters');
    expect(screen.queryByRole('list', { name: 'Active filters' })).not.toBeInTheDocument();
  });

  it('counts active filters and shows a removable chip for each', () => {
    render(<StatefulBar />);
    fireEvent.click(filtersButton());
    fireEvent.change(screen.getByRole('combobox', { name: 'Posted within' }), { target: { value: '7' } });
    expect(filtersButton()).toHaveAccessibleName('Filters 1 active');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hide on-site and hybrid' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Job source' }), { target: { value: 'remotive' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Minimum annual salary' }), { target: { value: '60000' } });
    expect(filtersButton()).toHaveAccessibleName('Filters 4 active');

    const chips = within(screen.getByRole('list', { name: 'Active filters' }));
    expect(chips.getByText('Last 7 days')).toBeInTheDocument();
    expect(chips.getByText('No on-site or hybrid')).toBeInTheDocument();
    expect(chips.getByText('Salary 60,000 or more')).toBeInTheDocument();
    expect(chips.getAllByRole('button').map((chip) => chip.getAttribute('aria-label'))).toEqual([
      'Remove filter: Last 7 days',
      'Remove filter: Remotive',
      'Remove filter: Salary 60,000 or more',
      'Remove filter: No on-site or hybrid',
    ]);
  });

  it('removing a chip resets that filter, updates the count and keeps focus on the button', () => {
    render(<StatefulBar initial={{ ...DEFAULT_FILTERS, postedWithin: '30', hideOnsiteHybrid: true }} />);
    expect(filtersButton()).toHaveAccessibleName('Filters 2 active');
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: Last 30 days' }));
    expect(filtersButton()).toHaveAccessibleName('Filters 1 active');
    expect(screen.queryByText('Last 30 days')).not.toBeInTheDocument();
    expect(screen.getByText('No on-site or hybrid')).toBeInTheDocument();
    expect(filtersButton()).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Remove filter: No on-site or hybrid' }));
    expect(filtersButton()).toHaveAccessibleName('Filters');
    expect(screen.queryByRole('list', { name: 'Active filters' })).not.toBeInTheDocument();
  });

  it('Clear filters inside the popover calls onClear', () => {
    const onClear = vi.fn();
    renderBar({ ...DEFAULT_FILTERS, query: 'nurse', postedWithin: '7' }, vi.fn(), onClear);
    fireEvent.click(filtersButton());
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe('SearchFilterBar hide on-site and hybrid (#565a)', () => {
  it('is off by default and reports a change when toggled', () => {
    const onChange = renderBar({ ...DEFAULT_FILTERS });
    fireEvent.click(filtersButton());
    const box = screen.getByRole('checkbox', { name: 'Hide on-site and hybrid' });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith({ hideOnsiteHybrid: true });
  });

  it('shows the on state', () => {
    renderBar({ ...DEFAULT_FILTERS, hideOnsiteHybrid: true });
    fireEvent.click(filtersButton());
    expect(screen.getByRole('checkbox', { name: 'Hide on-site and hybrid' })).toBeChecked();
  });
});

describe('SearchFilterBar AI web discovery (#641)', () => {
  it('shows a visible explanation when AI web discovery is not available', () => {
    render(
      <SearchFilterBar
        filters={{ ...DEFAULT_FILTERS, query: 'nurse' }}
        onFiltersChange={vi.fn()}
        onLocationChange={vi.fn()}
        onSearch={vi.fn()}
        onBrowseAll={vi.fn()}
        onClear={vi.fn()}
        sources={['remotive']}
        employmentTypes={['full_time']}
        busy={false}
        salaryNote=""
        hasReport
        aiWebDiscovery={false}
        onAiWebDiscoveryChange={vi.fn()}
        aiWebDiscoveryAvailable={false}
        onOpenSearchProfile={vi.fn()}
      />,
    );
    const checkbox = screen.getByRole('checkbox', { name: 'Also search the web with AI' });
    expect(checkbox).toBeDisabled();
    const helpText = screen.getByText(/Add a role or skill under What you are looking for/);
    expect(helpText).toBeInTheDocument();
    expect(checkbox).toHaveAttribute('aria-describedby', helpText.id);
  });

  it('includes a link to open the search profile when the callback is provided', () => {
    const onOpenSearchProfile = vi.fn();
    render(
      <SearchFilterBar
        filters={{ ...DEFAULT_FILTERS, query: 'nurse' }}
        onFiltersChange={vi.fn()}
        onLocationChange={vi.fn()}
        onSearch={vi.fn()}
        onBrowseAll={vi.fn()}
        onClear={vi.fn()}
        sources={['remotive']}
        employmentTypes={['full_time']}
        busy={false}
        salaryNote=""
        hasReport
        aiWebDiscovery={false}
        onAiWebDiscoveryChange={vi.fn()}
        aiWebDiscoveryAvailable={false}
        onOpenSearchProfile={onOpenSearchProfile}
      />,
    );
    const link = screen.getByRole('button', { name: 'What you are looking for' });
    fireEvent.click(link);
    expect(onOpenSearchProfile).toHaveBeenCalledTimes(1);
  });

  it('hides the explanation when AI web discovery is available', () => {
    render(
      <SearchFilterBar
        filters={{ ...DEFAULT_FILTERS, query: 'nurse' }}
        onFiltersChange={vi.fn()}
        onLocationChange={vi.fn()}
        onSearch={vi.fn()}
        onBrowseAll={vi.fn()}
        onClear={vi.fn()}
        sources={['remotive']}
        employmentTypes={['full_time']}
        busy={false}
        salaryNote=""
        hasReport
        aiWebDiscovery={false}
        onAiWebDiscoveryChange={vi.fn()}
        aiWebDiscoveryAvailable
        onOpenSearchProfile={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Add a role or skill under What you are looking for/)).not.toBeInTheDocument();
    const checkbox = screen.getByRole('checkbox', { name: 'Also search the web with AI' });
    expect(checkbox).toBeEnabled();
    expect(checkbox).not.toHaveAttribute('aria-describedby');
  });
});
