import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';
import { SearchProfileSection } from '../../../src/components/settings/SearchProfileSection.js';
import { DEFAULT_CANDIDATE_PROFILE, installVacancyRadarBridge } from '../../workspace-bridge.js';

function configuredProfile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    ...DEFAULT_CANDIDATE_PROFILE,
    targetRoles: ['Frontend Engineer'],
    strongestSkills: ['TypeScript', 'React'],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SearchProfileSection', () => {
  it('shows the unconfigured warning when there are no target roles or strongest skills', async () => {
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(DEFAULT_CANDIDATE_PROFILE),
    });

    render(<SearchProfileSection />);

    await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());
    expect(screen.getByText(/not scored against anything/)).toBeInTheDocument();
  });

  it('hides the unconfigured warning once target roles or strongest skills are set', async () => {
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(configuredProfile()),
    });

    render(<SearchProfileSection />);

    await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());
    expect(screen.queryByText(/not scored against anything/)).not.toBeInTheDocument();
  });

  it('saves a text field on blur, sending only that field', async () => {
    const saveSearchProfile = vi.fn().mockResolvedValue(configuredProfile({ candidateName: 'Jane Doe' }));
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(DEFAULT_CANDIDATE_PROFILE),
      saveSearchProfile,
    });

    render(<SearchProfileSection />);

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

    render(<SearchProfileSection />);

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

    render(<SearchProfileSection />);

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

    render(<SearchProfileSection />);

    const toggle = await screen.findByRole('switch', { name: 'Dutch required' });
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(saveSearchProfile).toHaveBeenCalledWith({ constraints: { dutchRequired: true } }),
    );
  });

  it('shows a load error instead of the form when the profile fails to load', async () => {
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockRejectedValue(new Error('disk read failed')),
    });

    render(<SearchProfileSection />);

    await waitFor(() => expect(screen.getByText('disk read failed')).toBeInTheDocument());
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });
});
