import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SearchFilterBar } from '../../../src/components/search/SearchFilterBar.js';
import { DEFAULT_FILTERS, type SearchFilters } from '../../../src/components/search/results.js';

function renderBar(filters: SearchFilters, onFiltersChange = vi.fn()) {
  render(
    <SearchFilterBar
      filters={filters}
      onFiltersChange={onFiltersChange}
      onLocationChange={vi.fn()}
      onSearch={vi.fn()}
      onBrowseAll={vi.fn()}
      onClear={vi.fn()}
      sources={[]}
      employmentTypes={[]}
      busy={false}
      salaryNote=""
      hasReport
      aiWebDiscovery={false}
      onAiWebDiscoveryChange={vi.fn()}
      aiWebDiscoveryAvailable
    />,
  );
  return onFiltersChange;
}

describe('SearchFilterBar hide on-site and hybrid (#565a)', () => {
  it('is off by default and reports a change when toggled', () => {
    const onChange = renderBar({ ...DEFAULT_FILTERS });
    const box = screen.getByRole('checkbox', { name: 'Hide on-site and hybrid' });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(onChange).toHaveBeenCalledWith({ hideOnsiteHybrid: true });
  });

  it('shows the on state', () => {
    renderBar({ ...DEFAULT_FILTERS, hideOnsiteHybrid: true });
    expect(screen.getByRole('checkbox', { name: 'Hide on-site and hybrid' })).toBeChecked();
  });
});
