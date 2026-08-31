import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';
import {
  SearchProfileSection,
  type SearchProfileSectionProps,
} from '../../../src/components/settings/SearchProfileSection.js';
import { DEFAULT_CANDIDATE_PROFILE, installVacancyRadarBridge } from '../../workspace-bridge.js';

function configuredProfile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    ...DEFAULT_CANDIDATE_PROFILE,
    targetRoles: ['Frontend Engineer'],
    strongestSkills: ['TypeScript', 'React'],
    ...overrides,
  };
}

/** `sponsorOnlyDefault` lives in `app_settings`, owned by `SettingsPage`, not this section's own
 * candidate-profile IPC, so every render here supplies it (and a no-op handler) explicitly. */
function baseProps(overrides: Partial<SearchProfileSectionProps> = {}): SearchProfileSectionProps {
  return {
    sponsorOnlyDefault: true,
    onChangeSponsorOnlyDefault: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SearchProfileSection', () => {
  it('explains the profile only affects the Netherlands pipeline, not worldwide', async () => {
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(configuredProfile()),
    });

    render(<SearchProfileSection {...baseProps()} />);

    await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Netherlands search profile' })).toBeInTheDocument();
    expect(screen.getByText(/worldwide pipeline has no equivalent/)).toBeInTheDocument();
  });

  it('shows the unconfigured warning when there are no target roles or strongest skills', async () => {
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(DEFAULT_CANDIDATE_PROFILE),
    });

    render(<SearchProfileSection {...baseProps()} />);

    await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());
    expect(screen.getByText(/not scored against anything/)).toBeInTheDocument();
  });

  it('hides the unconfigured warning once target roles or strongest skills are set', async () => {
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(configuredProfile()),
    });

    render(<SearchProfileSection {...baseProps()} />);

    await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());
    expect(screen.queryByText(/not scored against anything/)).not.toBeInTheDocument();
  });

  it('saves a text field on blur, sending only that field', async () => {
    const saveSearchProfile = vi.fn().mockResolvedValue(configuredProfile({ candidateName: 'Jane Doe' }));
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(DEFAULT_CANDIDATE_PROFILE),
      saveSearchProfile,
    });

    render(<SearchProfileSection {...baseProps()} />);

    const nameInput = await screen.findByLabelText('Name');
    fireEvent.change(nameInput, { target: { value: 'Jane Doe' } });
    fireEvent.blur(nameInput);

    await waitFor(() => expect(saveSearchProfile).toHaveBeenCalledWith({ candidateName: 'Jane Doe' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved');
  });

  it('does not save on blur when the field is unchanged', async () => {
    const saveSearchProfile = vi.fn();
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(DEFAULT_CANDIDATE_PROFILE),
      saveSearchProfile,
    });

    render(<SearchProfileSection {...baseProps()} />);

    const nameInput = await screen.findByLabelText('Name');
    fireEvent.blur(nameInput);

    expect(saveSearchProfile).not.toHaveBeenCalled();
  });

  it('saves a comma-separated list field as an array', async () => {
    const saveSearchProfile = vi.fn().mockResolvedValue(configuredProfile({ targetRoles: ['Frontend', 'Backend'] }));
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(DEFAULT_CANDIDATE_PROFILE),
      saveSearchProfile,
    });

    render(<SearchProfileSection {...baseProps()} />);

    const targetRoles = await screen.findByLabelText('Target roles');
    fireEvent.change(targetRoles, { target: { value: 'Frontend, Backend' } });
    fireEvent.blur(targetRoles);

    await waitFor(() =>
      expect(saveSearchProfile).toHaveBeenCalledWith({ targetRoles: ['Frontend', 'Backend'] }),
    );
  });

  it('saves a toggle immediately, without waiting for blur', async () => {
    const saveSearchProfile = vi.fn().mockResolvedValue(configuredProfile({ constraints: { ...DEFAULT_CANDIDATE_PROFILE.constraints, dutchRequired: true } }));
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(DEFAULT_CANDIDATE_PROFILE),
      saveSearchProfile,
    });

    render(<SearchProfileSection {...baseProps()} />);

    const toggle = await screen.findByRole('switch', { name: 'I can take Dutch-required roles' });
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(saveSearchProfile).toHaveBeenCalledWith({ constraints: { dutchRequired: true } }),
    );
  });

  it('reverts an optimistically-toggled switch when the save fails', async () => {
    const saveSearchProfile = vi.fn().mockRejectedValue(new Error('disk write failed'));
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(DEFAULT_CANDIDATE_PROFILE),
      saveSearchProfile,
    });

    render(<SearchProfileSection {...baseProps()} />);

    const toggle = await screen.findByRole('switch', { name: 'I can take Dutch-required roles' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);

    expect(toggle).toBeChecked();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('disk write failed'));
    expect(toggle).not.toBeChecked();
  });

  it('shows a load error instead of the form when the profile fails to load', async () => {
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockRejectedValue(new Error('disk read failed')),
    });

    render(<SearchProfileSection {...baseProps()} />);

    await waitFor(() => expect(screen.getByText('disk read failed')).toBeInTheDocument());
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });

  it('shows the sponsor-only-default toggle here (moved from Search defaults, since it is Netherlands-only) even before the profile loads', async () => {
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockRejectedValue(new Error('disk read failed')),
    });

    render(<SearchProfileSection {...baseProps({ sponsorOnlyDefault: false })} />);

    expect(screen.getByRole('switch', { name: 'Recognised sponsors only by default' })).not.toBeChecked();
  });

  it('reports a sponsor-only-default toggle through the callback, not the candidate-profile IPC', async () => {
    const onChangeSponsorOnlyDefault = vi.fn();
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(configuredProfile()),
    });

    render(<SearchProfileSection {...baseProps({ sponsorOnlyDefault: true, onChangeSponsorOnlyDefault })} />);

    // Wait for the profile-loaded render (not just the toggle's own early appearance in the
    // loading branch): the toggle row is present in both, but clicking before the swap can hit a
    // node from the loading branch that React has since replaced.
    await screen.findByLabelText('Name');
    const toggle = screen.getByRole('switch', { name: 'Recognised sponsors only by default' });
    fireEvent.click(toggle);

    expect(onChangeSponsorOnlyDefault).toHaveBeenCalledWith(false);
  });
});
