import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupportPromptState } from '../../../electron/workspace/support-prompt.js';
import { SettingsPage } from '../../../src/components/settings/index.js';
import {
  DEFAULT_SETTINGS,
  installSystemBridge,
  installVacancyRadarBridge,
  installWorkspaceBridge,
} from '../../workspace-bridge.js';

/** #503: the permanent Support section on the General tab. */

let stored: SupportPromptState;

function setup(initial: SupportPromptState) {
  stored = initial;
  installSystemBridge();
  installVacancyRadarBridge();
  return installWorkspaceBridge({
    getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, supportPrompt: stored })),
    updateSettings: vi.fn(async (patch: { supportPrompt?: SupportPromptState }) => {
      if (patch.supportPrompt) stored = patch.supportPrompt;
      return { ...DEFAULT_SETTINGS, supportPrompt: stored };
    }),
  });
}

const stopNavigation = (event: Event) => event.preventDefault();

beforeEach(() => {
  document.addEventListener('click', stopNavigation);
});

afterEach(() => {
  document.removeEventListener('click', stopNavigation);
  vi.restoreAllMocks();
});

describe('Settings Support section (#503)', () => {
  it('shows the sentence and both links on the General tab, reachable by keyboard', async () => {
    setup({ answered: false, asks: 0, successesSinceDismissal: 0 });
    render(<SettingsPage />);

    expect(await screen.findByRole('heading', { name: 'Support' })).toBeInTheDocument();
    expect(screen.getByText('OVR is free and open source.')).toBeInTheDocument();

    const star = screen.getByRole('link', { name: 'Star on GitHub' });
    const coffee = screen.getByRole('link', { name: 'Buy me a coffee' });
    expect(star).toHaveAttribute('href', 'https://github.com/jortega0033/open-vacancy-radar');
    expect(coffee).toHaveAttribute('href', 'https://buymeacoffee.com/jortega0033');
    for (const link of [star, coffee]) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link).not.toHaveAttribute('tabindex', '-1');
      link.focus();
      expect(link).toHaveFocus();
    }
  });

  it('sets answered when a link is clicked and leaves the other counters alone', async () => {
    const workspace = setup({ answered: false, asks: 1, successesSinceDismissal: 3 });
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('link', { name: 'Star on GitHub' }));

    await waitFor(() => expect(stored).toEqual({ answered: true, asks: 1, successesSinceDismissal: 3 }));
    expect(workspace.updateSettings).toHaveBeenCalledWith({
      supportPrompt: { answered: true, asks: 1, successesSinceDismissal: 3 },
    });
  });

  it('does not write anything when the ask was already answered, and never writes for other settings', async () => {
    const workspace = setup({ answered: true, asks: 0, successesSinceDismissal: 0 });
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('link', { name: 'Buy me a coffee' }));

    await waitFor(() => expect(workspace.getSettings).toHaveBeenCalledTimes(2));
    expect(workspace.updateSettings).not.toHaveBeenCalled();
  });
});
