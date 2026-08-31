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

/** `sponsorOnlyDefault` and `indVerificationEnabled` live in `app_settings`, owned by
 * `SettingsPage`, not this section's own candidate-profile IPC; `onSaved`/`onSaveError` likewise
 * belong to `SettingsPage`'s one shared toast now, not a toast this section renders itself. Every
 * render here supplies all of them (with no-op handlers) explicitly. */
function baseProps(overrides: Partial<SearchProfileSectionProps> = {}): SearchProfileSectionProps {
  return {
    sponsorOnlyDefault: true,
    onChangeSponsorOnlyDefault: vi.fn(),
    indVerificationEnabled: true,
    onChangeIndVerificationEnabled: vi.fn(),
    showIndOptions: true,
    onSaved: vi.fn(),
    onSaveError: vi.fn(),
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

  it('saves a text field on blur, sending only that field, and reports success through the shared toast callback', async () => {
    const saveSearchProfile = vi.fn().mockResolvedValue(configuredProfile({ candidateName: 'Jane Doe' }));
    const onSaved = vi.fn();
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(DEFAULT_CANDIDATE_PROFILE),
      saveSearchProfile,
    });

    render(<SearchProfileSection {...baseProps({ onSaved })} />);

    const nameInput = await screen.findByLabelText('Name');
    fireEvent.change(nameInput, { target: { value: 'Jane Doe' } });
    fireEvent.blur(nameInput);

    await waitFor(() => expect(saveSearchProfile).toHaveBeenCalledWith({ candidateName: 'Jane Doe' }));
    // No toast of its own any more: SettingsPage's one shared toast instance renders it instead,
    // so two autosaving forms on the same tab can never pop overlapping toasts in the same corner.
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
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

  it('reverts an optimistically-toggled switch when the save fails, reporting the error upward', async () => {
    const saveSearchProfile = vi.fn().mockRejectedValue(new Error('disk write failed'));
    const onSaveError = vi.fn();
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(DEFAULT_CANDIDATE_PROFILE),
      saveSearchProfile,
    });

    render(<SearchProfileSection {...baseProps({ onSaveError })} />);

    const toggle = await screen.findByRole('switch', { name: 'I can take Dutch-required roles' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);

    expect(toggle).toBeChecked();
    await waitFor(() => expect(onSaveError).toHaveBeenCalledWith('disk write failed'));
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

  it('shows the IND verification toggle here too (moved from the old Market integrations section) and reports it through its own callback', async () => {
    const onChangeIndVerificationEnabled = vi.fn();
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockRejectedValue(new Error('disk read failed')),
    });

    render(<SearchProfileSection {...baseProps({ indVerificationEnabled: true, onChangeIndVerificationEnabled })} />);

    const toggle = screen.getByRole('switch', { name: 'IND recognised sponsor verification' });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);

    expect(onChangeIndVerificationEnabled).toHaveBeenCalledWith(false);
  });

  it('hides the Search behavior toggles entirely when the default search location is not Netherlands', async () => {
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(configuredProfile()),
    });

    render(<SearchProfileSection {...baseProps({ showIndOptions: false })} />);

    await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());
    expect(screen.queryByRole('switch', { name: 'Recognised sponsors only by default' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'IND recognised sponsor verification' })).not.toBeInTheDocument();
    expect(screen.queryByText('Search behavior')).not.toBeInTheDocument();
  });

  it('groups the candidate-profile fields under Identity / Role matching / Constraints subheadings', async () => {
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(configuredProfile()),
    });

    render(<SearchProfileSection {...baseProps()} />);

    await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());
    expect(screen.getByRole('heading', { level: 3, name: 'Identity' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Role matching' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Constraints' })).toBeInTheDocument();
  });
});
