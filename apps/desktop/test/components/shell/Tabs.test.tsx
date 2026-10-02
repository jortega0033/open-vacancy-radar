import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { TabPanel, Tabs } from '../../../src/components/shell/index.js';

const TABS = [
  { id: 'one', label: 'One' },
  { id: 'two', label: 'Two' },
  { id: 'three', label: 'Three', disabled: true },
  { id: 'four', label: 'Four' },
] as const;

function Harness() {
  const [value, setValue] = useState<(typeof TABS)[number]['id']>('one');
  return (
    <div>
      <Tabs label="Demo views" idPrefix="demo" tabs={TABS} value={value} onChange={setValue} />
      <TabPanel idPrefix="demo" id={value}>
        Content for {value}
      </TabPanel>
    </div>
  );
}

const tab = (name: string) => screen.getByRole('tab', { name });

describe('Tabs', () => {
  it('puts only the selected tab in the Tab order', () => {
    render(<Harness />);
    expect(tab('One')).toHaveAttribute('tabindex', '0');
    expect(tab('Two')).toHaveAttribute('tabindex', '-1');
    expect(tab('Four')).toHaveAttribute('tabindex', '-1');
    expect(screen.getByRole('tablist', { name: 'Demo views' })).toBeInTheDocument();
  });

  it('moves selection and focus with ArrowRight and ArrowLeft, wrapping and skipping disabled tabs', () => {
    render(<Harness />);
    fireEvent.keyDown(tab('One'), { key: 'ArrowRight' });
    expect(tab('Two')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Two')).toHaveFocus();
    expect(tab('Two')).toHaveAttribute('tabindex', '0');
    expect(tab('One')).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(tab('Two'), { key: 'ArrowRight' });
    expect(tab('Four')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Four')).toHaveFocus();

    fireEvent.keyDown(tab('Four'), { key: 'ArrowRight' });
    expect(tab('One')).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(tab('One'), { key: 'ArrowLeft' });
    expect(tab('Four')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Four')).toHaveFocus();
  });

  it('jumps to the first and last enabled tab with Home and End', () => {
    render(<Harness />);
    fireEvent.keyDown(tab('One'), { key: 'End' });
    expect(tab('Four')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Four')).toHaveFocus();
    fireEvent.keyDown(tab('Four'), { key: 'Home' });
    expect(tab('One')).toHaveAttribute('aria-selected', 'true');
    expect(tab('One')).toHaveFocus();
  });

  it('ignores other keys', () => {
    render(<Harness />);
    fireEvent.keyDown(tab('One'), { key: 'a' });
    expect(tab('One')).toHaveAttribute('aria-selected', 'true');
  });

  it('links each tab to a labelled tabpanel', () => {
    render(<Harness />);
    const panel = screen.getByRole('tabpanel');
    expect(tab('One')).toHaveAttribute('aria-controls', panel.id);
    expect(panel).toHaveAttribute('aria-labelledby', tab('One').id);
    expect(screen.getByRole('tabpanel', { name: 'One' })).toHaveTextContent('Content for one');

    fireEvent.click(tab('Two'));
    expect(screen.getByRole('tabpanel', { name: 'Two' })).toHaveTextContent('Content for two');
  });
});
