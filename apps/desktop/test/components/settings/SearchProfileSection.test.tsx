import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';
import {
  SearchProfileSection,
  type SearchProfileSectionProps,
} from '../../../src/components/settings/SearchProfileSection.js';
import {
  DEFAULT_CANDIDATE_PROFILE,
  installVacancyRadarBridge,
} from '../../workspace-bridge.js';

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
  });

  it('puts target roles and country first and keeps everything else under a collapsed More options (#635)', async () => {
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(configuredProfile()),
    });

    const { container } = render(<SearchProfileSection {...baseProps()} />);

    const targetRoles = await screen.findByLabelText('Target roles');
    const country = screen.getByLabelText('Country');
    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByText('More options')).toBeInTheDocument();
    // Required fields sit outside the collapsed block; every other field sits inside it.
    expect(details!.contains(targetRoles)).toBe(false);
    expect(details!.contains(country)).toBe(false);
    for (const label of ['Name', 'Current role', 'Location', 'Years of experience', 'Professional language', 'Strongest skills', 'Additional skills', 'Considered roles', 'Excluded role families']) {
      expect(details!.contains(screen.getByLabelText(label))).toBe(true);
    }
    expect(targetRoles.compareDocumentPosition(country) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(country.compareDocumentPosition(details!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the unconfigured warning when there are no target roles or strongest skills', async () => {
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(DEFAULT_CANDIDATE_PROFILE),
    });

    render(<SearchProfileSection {...baseProps()} />);

    await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());
    expect(screen.getByText(/Add a target role or a skill to see ranked matches/)).toBeInTheDocument();
  });

  it('hides the unconfigured warning once target roles or strongest skills are set', async () => {
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(configuredProfile()),
    });

    render(<SearchProfileSection {...baseProps()} />);

    await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());
    expect(screen.queryByText(/Add a target role or a skill to see ranked matches/)).not.toBeInTheDocument();
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

    await waitFor(() => expect(saveSearchProfile).toHaveBeenCalledWith({ candidateName: 'Jane Doe', fieldSources: { candidateName: 'user' } }));
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
      expect(saveSearchProfile).toHaveBeenCalledWith({
        targetRoles: ['Frontend', 'Backend'],
        fieldSources: { targetRoles: 'user' },
      }),
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

  it('records a country edit as added by the user, nested under constraints', async () => {
    const saveSearchProfile = vi.fn().mockResolvedValue(configuredProfile());
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(DEFAULT_CANDIDATE_PROFILE),
      saveSearchProfile,
    });

    render(<SearchProfileSection {...baseProps()} />);

    const country = await screen.findByLabelText('Country');
    fireEvent.change(country, { target: { value: 'Portugal' } });
    fireEvent.blur(country);

    await waitFor(() =>
      expect(saveSearchProfile).toHaveBeenCalledWith({
        constraints: { primaryCountry: 'Portugal' },
        fieldSources: { primaryCountry: 'user' },
      }),
    );
  });

  it('groups the optional fields under Role matching / About you subheadings', async () => {
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(configuredProfile()),
    });

    render(<SearchProfileSection {...baseProps()} />);

    await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());
    expect(screen.getByRole('heading', { level: 3, name: 'About you' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Role matching' })).toBeInTheDocument();
  });

  it('no longer shows the default CV line: that lives on the CV page', async () => {
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(configuredProfile({ candidateName: 'Jane Doe' })),
    });

    render(<SearchProfileSection {...baseProps()} />);

    await waitFor(() => expect(screen.getByLabelText('Name')).toBeInTheDocument());
    expect(screen.queryByLabelText('Profile status')).not.toBeInTheDocument();
    expect(screen.queryByText(/Default CV/)).not.toBeInTheDocument();
  });
});
