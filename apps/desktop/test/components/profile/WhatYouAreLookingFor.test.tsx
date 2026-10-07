import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';
import { WhatYouAreLookingFor } from '../../../src/components/profile/WhatYouAreLookingFor.js';
import { RankingSummary } from '../../../src/components/profile/RankingSummary.js';
import { rankingText, summarizeProfile } from '../../../src/components/profile/profile-summary.js';
import { DEFAULT_CANDIDATE_PROFILE, installVacancyRadarBridge } from '../../workspace-bridge.js';

const EMPTY: CandidateProfile = {
  ...DEFAULT_CANDIDATE_PROFILE,
  constraints: { ...DEFAULT_CANDIDATE_PROFILE.constraints, professionalLanguage: '' },
};

function profile(overrides: Partial<CandidateProfile> = {}, country = ''): CandidateProfile {
  return { ...EMPTY, ...overrides, constraints: { ...EMPTY.constraints, primaryCountry: country } };
}

const FROM_CV = profile(
  {
    targetRoles: ['Data analyst'],
    strongestSkills: ['SQL', 'Python', 'Tableau'],
    fieldSources: { targetRoles: 'cv', strongestSkills: 'cv' },
  },
  'Netherlands',
);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('profile summary helpers', () => {
  it('labels only what has a recorded source', () => {
    const { rows } = summarizeProfile(
      profile({ targetRoles: ['A'], strongestSkills: ['B'], fieldSources: { targetRoles: 'cv', primaryCountry: 'user' } }, 'Spain'),
    );
    expect(rows.map((row) => [row.key, row.source])).toEqual([
      ['targetRoles', 'From your CV'],
      ['primaryCountry', 'Added by you'],
      ['strongestSkills', null],
    ]);
  });

  it('never labels an empty field, even when a source is on record', () => {
    const { rows } = summarizeProfile(profile({ fieldSources: { targetRoles: 'cv', primaryCountry: 'user' } }));
    expect(rows.every((row) => row.source === null)).toBe(true);
  });

  it('is empty only when there is neither a role nor a skill', () => {
    expect(summarizeProfile(EMPTY).isEmpty).toBe(true);
    expect(summarizeProfile(profile({}, 'Spain')).isEmpty).toBe(true);
    expect(summarizeProfile(profile({ strongestSkills: ['SQL'] })).isEmpty).toBe(false);
  });

  it('limits the skills it names and builds the ranking phrase from roles and country', () => {
    const many = profile({ strongestSkills: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
    expect(summarizeProfile(many).rows[2]?.text).toBe('a, b, c, d, e');
    expect(rankingText(FROM_CV)).toBe('Data analyst, Netherlands');
    expect(rankingText(profile({ strongestSkills: ['SQL'] }))).toBe('SQL');
    expect(rankingText(EMPTY)).toBe('');
  });
});

describe('WhatYouAreLookingFor', () => {
  it('asks one question with a single input when nothing is set, and saves the answer as added by the user', async () => {
    const saved = profile({ targetRoles: ['Nurse'], fieldSources: { targetRoles: 'user' } });
    const saveSearchProfile = vi.fn().mockResolvedValue(saved);
    installVacancyRadarBridge({ getSearchProfile: vi.fn().mockResolvedValue(EMPTY), saveSearchProfile });

    render(<WhatYouAreLookingFor />);

    const input = await screen.findByLabelText('What role are you looking for?');
    expect(input).toHaveValue('');
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    fireEvent.change(input, { target: { value: 'Nurse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(saveSearchProfile).toHaveBeenCalledWith({ targetRoles: ['Nurse'], fieldSources: { targetRoles: 'user' } }),
    );
    expect(await screen.findByText('Nurse')).toBeInTheDocument();
    expect(screen.getByText('Added by you')).toBeInTheDocument();
  });

  it('shows role, country and skills marked "From your CV" when a CV filled them', async () => {
    installVacancyRadarBridge({ getSearchProfile: vi.fn().mockResolvedValue(FROM_CV) });

    render(<WhatYouAreLookingFor />);

    const region = await screen.findByRole('region', { name: 'What you are looking for' });
    expect(within(region).getByText('Data analyst')).toBeInTheDocument();
    expect(within(region).getByText('Netherlands')).toBeInTheDocument();
    expect(within(region).getByText('SQL, Python, Tableau')).toBeInTheDocument();
    // Role and skills came from the CV; the country has no record, so it carries no label.
    expect(within(region).getAllByText('From your CV')).toHaveLength(2);
    expect(within(region).queryByText('Added by you')).not.toBeInTheDocument();
  });

  it('shows a mix of sources side by side', async () => {
    installVacancyRadarBridge({
      getSearchProfile: vi
        .fn()
        .mockResolvedValue({ ...FROM_CV, fieldSources: { targetRoles: 'cv', primaryCountry: 'user', strongestSkills: 'user' } }),
    });

    render(<WhatYouAreLookingFor />);

    const region = await screen.findByRole('region', { name: 'What you are looking for' });
    expect(within(region).getAllByText('Added by you')).toHaveLength(2);
    expect(within(region).getAllByText('From your CV')).toHaveLength(1);
  });

  it('shows user-added values with their label and "Not set" for the rest', async () => {
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(profile({ targetRoles: ['Chef'], fieldSources: { targetRoles: 'user' } })),
    });

    render(<WhatYouAreLookingFor />);

    const region = await screen.findByRole('region', { name: 'What you are looking for' });
    expect(within(region).getByText('Chef')).toBeInTheDocument();
    expect(within(region).getByText('Added by you')).toBeInTheDocument();
    expect(within(region).getAllByText('Not set')).toHaveLength(2);
  });

  it('shows no label when no source was recorded, never guessing "From your CV"', async () => {
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(profile({ targetRoles: ['Chef'], strongestSkills: ['Knife skills'] }, 'Italy')),
    });

    render(<WhatYouAreLookingFor />);

    const region = await screen.findByRole('region', { name: 'What you are looking for' });
    expect(within(region).getByText('Chef')).toBeInTheDocument();
    expect(within(region).queryByText('From your CV')).not.toBeInTheDocument();
    expect(within(region).queryByText('Added by you')).not.toBeInTheDocument();
  });

  it('pre-fills no default role, country or salary anywhere', async () => {
    installVacancyRadarBridge({ getSearchProfile: vi.fn().mockResolvedValue(EMPTY) });

    render(<WhatYouAreLookingFor />);

    await screen.findByLabelText('What role are you looking for?');
    expect(screen.queryByText('Not set')).not.toBeInTheDocument();
    expect(screen.getByRole('region').textContent).not.toMatch(/netherlands|remote|€|\$/i);
  });

  it('has one Edit button with its own accessible name, and Edit opens the form with required fields first and More options collapsed', async () => {
    installVacancyRadarBridge({ getSearchProfile: vi.fn().mockResolvedValue(FROM_CV) });

    render(<WhatYouAreLookingFor />);

    const edit = await screen.findByRole('button', { name: 'Edit what you are looking for' });
    expect(screen.getAllByRole('button', { name: /^edit/i })).toHaveLength(1);
    fireEvent.click(edit);

    const dialog = await screen.findByRole('dialog', { name: 'What you are looking for' });
    const targetRoles = await within(dialog).findByLabelText('Target roles');
    const country = within(dialog).getByLabelText('Country');
    const details = dialog.querySelector('details');
    expect(details).not.toHaveAttribute('open');
    expect(details!.contains(targetRoles)).toBe(false);
    expect(details!.contains(country)).toBe(false);
    expect(details!.contains(within(dialog).getByLabelText('Strongest skills'))).toBe(true);
    expect(within(dialog).getByText('More options')).toBeInTheDocument();
    await waitFor(() => expect(targetRoles).toHaveFocus());
  });

  it('refreshes the summary after an edit in the form', async () => {
    const getSearchProfile = vi.fn().mockResolvedValue(FROM_CV);
    const saveSearchProfile = vi.fn().mockResolvedValue({
      ...FROM_CV,
      constraints: { ...FROM_CV.constraints, primaryCountry: 'Belgium' },
      fieldSources: { ...FROM_CV.fieldSources, primaryCountry: 'user' },
    });
    installVacancyRadarBridge({ getSearchProfile, saveSearchProfile });

    render(<WhatYouAreLookingFor />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit what you are looking for' }));
    const dialog = await screen.findByRole('dialog', { name: 'What you are looking for' });
    const country = await within(dialog).findByLabelText('Country');
    fireEvent.change(country, { target: { value: 'Belgium' } });
    fireEvent.blur(country);

    await waitFor(() =>
      expect(saveSearchProfile).toHaveBeenCalledWith({
        constraints: { primaryCountry: 'Belgium' },
        fieldSources: { primaryCountry: 'user' },
      }),
    );
    await waitFor(() => expect(getSearchProfile.mock.calls.length).toBeGreaterThan(2));
  });
});

describe('RankingSummary', () => {
  it('shows one "Ranking for" line with an Edit button when something is set', () => {
    const onEdit = vi.fn();
    render(<RankingSummary profile={FROM_CV} onEdit={onEdit} />);

    expect(screen.getByText('Ranking for: Data analyst, Netherlands')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit what you are looking for' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('renders nothing when nothing is set, so the empty page keeps one role flow', () => {
    const { container } = render(<RankingSummary profile={EMPTY} onEdit={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing until the profile has loaded', () => {
    const { container } = render(<RankingSummary profile={null} onEdit={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
