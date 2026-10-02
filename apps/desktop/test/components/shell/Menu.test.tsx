import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Menu } from '../../../src/components/shell/index.js';

function setup(onSelect: () => void | Promise<unknown> = vi.fn()) {
  render(
    <div>
      <Menu
        trigger="Export"
        items={[
          { key: 'a', label: 'Alpha', onSelect },
          { key: 'b', label: 'Beta', onSelect: vi.fn() },
          { key: 'c', label: 'Gamma', onSelect: vi.fn() },
        ]}
      />
      <button type="button">Elsewhere</button>
    </div>,
  );
  return { onSelect, trigger: screen.getByRole('button', { name: 'Export' }) };
}

describe('Menu', () => {
  it('declares itself a menu button and stays closed until opened', () => {
    const { trigger } = setup();
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens on click with the first item focused, a labelled menu and no tabIndex on the list', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu', { name: 'Export' });
    expect(menu).not.toHaveAttribute('tabindex');
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toHaveFocus();
    expect(screen.getByRole('menuitem', { name: 'Beta' })).toHaveAttribute('tabindex', '-1');
  });

  it('opens with ArrowDown on the first item and ArrowUp on the last', () => {
    const { trigger } = setup();
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    expect(screen.getByRole('menuitem', { name: 'Gamma' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toHaveFocus();
  });

  it('moves between items with the arrow keys, wrapping, and with Home and End', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Beta' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'End' });
    expect(screen.getByRole('menuitem', { name: 'Gamma' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(screen.getByRole('menuitem', { name: 'Gamma' })).toHaveFocus();
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(screen.getByRole('menuitem', { name: 'Alpha' })).toHaveFocus();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('closes on an outside pointer press and on Tab', () => {
    const { trigger } = setup();
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Tab' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('runs the chosen item, closes, and returns focus to the trigger', () => {
    const { trigger, onSelect } = setup();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Alpha' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('keeps the chosen item focused until a pending action settles', async () => {
    let finish: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const onSelect = vi.fn(() => pending);
    const { trigger } = setup(onSelect);
    fireEvent.click(trigger);
    const alpha = screen.getByRole('menuitem', { name: 'Alpha' });
    fireEvent.click(alpha);

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(alpha).toHaveFocus();
    expect(alpha).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(alpha);
    expect(onSelect).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish();
      await pending;
    });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
