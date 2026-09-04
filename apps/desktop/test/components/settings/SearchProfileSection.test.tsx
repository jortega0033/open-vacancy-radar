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

function baseProps(overrides: Partial<SearchProfileSectionProps> = {}): SearchProfileSectionProps {
  return {
    onSaved: vi.fn(),
    onSaveError: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SearchProfileSection', () => {
  it('shows the search profile form', async () => {
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(configuredProfile()),
    });

    render(<SearchProfileSection {...baseProps()} />);

    await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());
    expect(screen.getByRole('heading', { name: 'Search profile' })).toBeInTheDocument();
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

  it('shows a load error instead of the form when the profile fails to load', async () => {
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockRejectedValue(new Error('disk read failed')),
    });

    render(<SearchProfileSection {...baseProps()} />);

    await waitFor(() => expect(screen.getByText('disk read failed')).toBeInTheDocument());
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });

  it('groups the candidate-profile fields under Identity / Role matching subheadings', async () => {
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(configuredProfile()),
    });

    render(<SearchProfileSection {...baseProps()} />);

    await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());
    expect(screen.getByRole('heading', { level: 3, name: 'Identity' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Role matching' })).toBeInTheDocument();
  });
});
