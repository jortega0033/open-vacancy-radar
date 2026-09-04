import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';
import type { CandidateProfilePatch } from '../../../electron/vacancy-profile-validate.js';
import type { CvDocumentRecord } from '../../../src/window.js';
import {
  FillProfileFromCv,
  FillProfileFromCvDrawer,
} from '../../../src/components/settings/FillProfileFromCv.js';
import {
  SearchProfileSection,
  type SearchProfileSectionProps,
} from '../../../src/components/settings/SearchProfileSection.js';
import { installBridges } from '../../cv-bridges.js';
import {
  DEFAULT_CANDIDATE_PROFILE,
  installVacancyRadarBridge,
  installWorkspaceBridge,
} from '../../workspace-bridge.js';

const CV: CvDocumentRecord = {
  id: 'cv-1',
  name: 'Frontend CV',
  kind: 'uploaded',
  targetRole: '',
  text: 'Senior Frontend Engineer at Redwood. Angular, TypeScript, RxJS. Eight years.',
  profile: { title: '', years: '', location: '', languages: '', skills: [], summary: '', auth: '' },
  isDefault: true,
  uploadedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

/**
 * A profile where every field this feature must NOT touch already holds a value the user typed.
 * Any test that saves and finds one of these missing from the patch has caught the exact regression
 * issue #137's risk note is about.
 */
const USER_SET_PROFILE: CandidateProfile = {
  ...DEFAULT_CANDIDATE_PROFILE,
  candidateName: 'Jane Doe',
  currentRole: 'Frontend Engineer',
  location: 'Utrecht',
  experienceYears: 5,
  targetRoles: ['Staff Engineer'],
  consideredRoles: ['Tech Lead'],
  excludedRoleFamilies: ['Sales'],
  strongestSkills: ['React'],
  additionalSkills: ['Jest'],
  constraints: {
    professionalLanguage: 'Dutch',
    dutchRequired: true,
    primaryCountry: 'Netherlands',
    allowRemoteEuSupportingNetherlands: false,
    minimumMonthlyBaseEur: 6000,
  },
};

const GOOD_RESPONSE = JSON.stringify({
  currentRole: 'Senior Frontend Engineer',
  experienceYears: 8,
  location: 'Amsterdam, Netherlands',
  professionalLanguage: 'English',
  strongestSkills: ['Angular', 'TypeScript'],
  additionalSkills: ['RxJS'],
});

function dialog() {
  return within(screen.getByRole('dialog', { name: 'Fill search profile from CV' }));
}

/** Drives one full run of the drawer's agent session to completion with `raw` as the answer. */
async function runExtraction(bridges: ReturnType<typeof installBridges>, raw: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Read CV' }));
  await waitFor(() => expect(bridges.agentDock.createSession).toHaveBeenCalled());
  bridges.emit('sess-cv-1', { type: 'assistant.message', text: raw });
  bridges.emit('sess-cv-1', { type: 'session.completed' });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FillProfileFromCvDrawer', () => {
  it('lists only CVs with extracted text, preselecting the default one', async () => {
    installBridges();
    installWorkspaceBridge({
      listCvDocuments: vi.fn().mockResolvedValue([
        { ...CV, id: 'cv-empty', name: 'Scanned CV', text: '   ', isDefault: false },
        { ...CV, id: 'cv-1', name: 'Frontend CV', isDefault: true },
      ]),
    });

    render(<FillProfileFromCvDrawer profile={USER_SET_PROFILE} onApply={vi.fn()} onClose={vi.fn()} />);

    const select = (await screen.findByLabelText('CV')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('cv-1'));
    expect(within(select).getByRole('option', { name: 'Frontend CV' })).toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: 'Scanned CV' })).not.toBeInTheDocument();
  });

  it('says so plainly when no CV in the library has any text to read', async () => {
    installBridges();
    installWorkspaceBridge({ listCvDocuments: vi.fn().mockResolvedValue([]) });

    render(<FillProfileFromCvDrawer profile={USER_SET_PROFILE} onApply={vi.fn()} onClose={vi.fn()} />);

    expect(await screen.findByText(/No CV in your library has any extracted text yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Read CV' })).not.toBeInTheDocument();
  });

  it('sends the CV text in the prompt and shows the six extracted fields for review', async () => {
    const bridges = installBridges();
    installWorkspaceBridge({ listCvDocuments: vi.fn().mockResolvedValue([CV]) });

    render(<FillProfileFromCvDrawer profile={USER_SET_PROFILE} onApply={vi.fn()} onClose={vi.fn()} />);
    await runExtraction(bridges, GOOD_RESPONSE);

    const prompt = vi.mocked(bridges.agentDock.createSession).mock.calls[0]?.[0]?.prompt ?? '';
    expect(prompt).toContain('Senior Frontend Engineer at Redwood');
    expect(prompt).toContain('"strongestSkills"');
    expect(prompt).toContain('"targetRoles"'); // named only to tell the model not to answer it

    const panel = await waitFor(() => {
      const found = dialog();
      expect(found.getByText(/review and edit before saving/i)).toBeInTheDocument();
      return found;
    });

    expect(panel.getByLabelText('Current role')).toHaveValue('Senior Frontend Engineer');
    expect(panel.getByLabelText('Years of experience')).toHaveValue(8);
    expect(panel.getByLabelText('Location')).toHaveValue('Amsterdam, Netherlands');
    expect(panel.getByLabelText('Professional language')).toHaveValue('English');
    expect(panel.getByLabelText('Strongest skills')).toHaveValue('Angular, TypeScript');
    expect(panel.getByLabelText('Additional skills')).toHaveValue('RxJS');
  });

  it('never renders an input for a field a CV cannot honestly state', async () => {
    const bridges = installBridges();
    installWorkspaceBridge({ listCvDocuments: vi.fn().mockResolvedValue([CV]) });

    render(<FillProfileFromCvDrawer profile={USER_SET_PROFILE} onApply={vi.fn()} onClose={vi.fn()} />);
    await runExtraction(bridges, GOOD_RESPONSE);
    await waitFor(() => expect(dialog().getByLabelText('Current role')).toBeInTheDocument());

    const panel = dialog();
    for (const label of ['Target roles', 'Considered roles', 'Excluded role families', 'Minimum monthly base (EUR)']) {
      expect(panel.queryByLabelText(label)).not.toBeInTheDocument();
    }
  });

  it('falls back to the profile, not to blanks, for anything the CV did not state', async () => {
    const bridges = installBridges();
    installWorkspaceBridge({ listCvDocuments: vi.fn().mockResolvedValue([CV]) });

    render(<FillProfileFromCvDrawer profile={USER_SET_PROFILE} onApply={vi.fn()} onClose={vi.fn()} />);
    await runExtraction(bridges, JSON.stringify({ currentRole: 'Senior Frontend Engineer', experienceYears: 0 }));

    await waitFor(() => expect(dialog().getByLabelText('Current role')).toHaveValue('Senior Frontend Engineer'));
    const panel = dialog();
    expect(panel.getByLabelText('Years of experience')).toHaveValue(5);
    expect(panel.getByLabelText('Location')).toHaveValue('Utrecht');
    expect(panel.getByLabelText('Professional language')).toHaveValue('Dutch');
    expect(panel.getByLabelText('Strongest skills')).toHaveValue('React');
  });

  it('saves only the six reviewed fields, including edits the user made to them', async () => {
    const bridges = installBridges();
    installWorkspaceBridge({ listCvDocuments: vi.fn().mockResolvedValue([CV]) });
    const onApply = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(<FillProfileFromCvDrawer profile={USER_SET_PROFILE} onApply={onApply} onClose={onClose} />);
    await runExtraction(bridges, GOOD_RESPONSE);
    await waitFor(() => expect(dialog().getByLabelText('Current role')).toBeInTheDocument());

    fireEvent.change(dialog().getByLabelText('Current role'), { target: { value: 'Lead Frontend Engineer' } });
    fireEvent.click(dialog().getByRole('button', { name: 'Save to profile' }));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply).toHaveBeenCalledWith({
      currentRole: 'Lead Frontend Engineer',
      experienceYears: 8,
      location: 'Amsterdam, Netherlands',
      strongestSkills: ['Angular', 'TypeScript'],
      additionalSkills: ['RxJS'],
      constraints: { professionalLanguage: 'English' },
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('drops every excluded field a malformed response tries to smuggle through the whole UI path', async () => {
    const bridges = installBridges();
    installWorkspaceBridge({ listCvDocuments: vi.fn().mockResolvedValue([CV]) });
    const onApply = vi.fn().mockResolvedValue(undefined);

    render(<FillProfileFromCvDrawer profile={USER_SET_PROFILE} onApply={onApply} onClose={vi.fn()} />);
    await runExtraction(
      bridges,
      JSON.stringify({
        currentRole: 'Senior Frontend Engineer',
        targetRoles: ['Engineering Manager'],
        consideredRoles: ['VP Engineering'],
        excludedRoleFamilies: ['Support'],
        primaryCountry: 'Germany',
        minimumMonthlyBaseEur: 12000,
        constraints: { primaryCountry: 'Germany', minimumMonthlyBaseEur: 12000 },
      }),
    );
    await waitFor(() => expect(dialog().getByLabelText('Current role')).toBeInTheDocument());
    fireEvent.click(dialog().getByRole('button', { name: 'Save to profile' }));

    await waitFor(() => expect(onApply).toHaveBeenCalled());
    const patch = onApply.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(patch).sort()).toEqual([
      'additionalSkills',
      'constraints',
      'currentRole',
      'experienceYears',
      'location',
      'strongestSkills',
    ]);
    expect(Object.keys(patch.constraints as object)).toEqual(['professionalLanguage']);
    // The user's own forward-looking answers were never even offered to the save.
    expect(patch.targetRoles).toBeUndefined();
    expect(patch.consideredRoles).toBeUndefined();
    expect(patch.excludedRoleFamilies).toBeUndefined();
  });

  it('keeps the drawer open and shows the failure inline when the save is rejected', async () => {
    const bridges = installBridges();
    installWorkspaceBridge({ listCvDocuments: vi.fn().mockResolvedValue([CV]) });
    const onClose = vi.fn();

    render(
      <FillProfileFromCvDrawer
        profile={USER_SET_PROFILE}
        onApply={vi.fn().mockRejectedValue(new Error('disk write failed'))}
        onClose={onClose}
      />,
    );
    await runExtraction(bridges, GOOD_RESPONSE);
    await waitFor(() => expect(dialog().getByLabelText('Current role')).toBeInTheDocument());
    fireEvent.click(dialog().getByRole('button', { name: 'Save to profile' }));

    await waitFor(() => expect(dialog().getByRole('alert')).toHaveTextContent('disk write failed'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows an unreadable response as an error and offers nothing to save', async () => {
    const bridges = installBridges();
    installWorkspaceBridge({ listCvDocuments: vi.fn().mockResolvedValue([CV]) });

    render(<FillProfileFromCvDrawer profile={USER_SET_PROFILE} onApply={vi.fn()} onClose={vi.fn()} />);
    await runExtraction(bridges, 'I could not read that CV.');

    await waitFor(() => expect(dialog().getByRole('alert')).toHaveTextContent(/not valid JSON/));
    expect(dialog().getByRole('button', { name: 'Save to profile' })).toBeDisabled();
  });
});

describe('FillProfileFromCv (the Settings entry point)', () => {
  it('touches no bridge until the drawer is actually opened', () => {
    // Rendered with `window.workspace`/`window.agentDock` deliberately absent: the button must be
    // inert enough that a Settings page which never opens it needs neither bridge. This is what
    // keeps every existing SearchProfileSection test (which installs only the vacancy bridge)
    // passing unchanged.
    render(<FillProfileFromCv profile={USER_SET_PROFILE} onApply={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Fill from CV' })).toBeEnabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the drawer on click', async () => {
    installBridges();
    installWorkspaceBridge({ listCvDocuments: vi.fn().mockResolvedValue([CV]) });

    render(<FillProfileFromCv profile={USER_SET_PROFILE} onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Fill from CV' }));

    expect(await screen.findByRole('dialog', { name: 'Fill search profile from CV' })).toBeInTheDocument();
  });
});

describe('SearchProfileSection: filling from a CV merges into the profile', () => {
  function baseProps(overrides: Partial<SearchProfileSectionProps> = {}): SearchProfileSectionProps {
    return {
      onSaved: vi.fn(),
      onSaveError: vi.fn(),
      ...overrides,
    };
  }

  it("sends a six-field patch, leaving the user's target roles, country and salary floor untouched", async () => {
    const bridges = installBridges();
    installWorkspaceBridge({ listCvDocuments: vi.fn().mockResolvedValue([CV]) });
    // The IPC merges the patch onto what is on disk (main.ts's `vacancy:save-search-profile`), so
    // the stub does the same: what comes back is what the user would actually be left with.
    const saveSearchProfile = vi.fn().mockImplementation(async (patch: CandidateProfilePatch) => ({
      ...USER_SET_PROFILE,
      ...patch,
      constraints: { ...USER_SET_PROFILE.constraints, ...patch.constraints },
    }));
    installVacancyRadarBridge({
      getSearchProfile: vi.fn().mockResolvedValue(USER_SET_PROFILE),
      saveSearchProfile,
    });
    const onSaved = vi.fn();

    render(<SearchProfileSection {...baseProps({ onSaved })} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Fill from CV' }));
    await runExtraction(bridges, GOOD_RESPONSE);
    await waitFor(() => expect(dialog().getByLabelText('Current role')).toBeInTheDocument());
    fireEvent.click(dialog().getByRole('button', { name: 'Save to profile' }));

    await waitFor(() => expect(saveSearchProfile).toHaveBeenCalledTimes(1));
    expect(saveSearchProfile).toHaveBeenCalledWith({
      currentRole: 'Senior Frontend Engineer',
      experienceYears: 8,
      location: 'Amsterdam, Netherlands',
      strongestSkills: ['Angular', 'TypeScript'],
      additionalSkills: ['RxJS'],
      constraints: { professionalLanguage: 'English' },
    });

    // The section re-renders from what the merge returned: the six bridged fields changed, and
    // every field the user had set themselves survived.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Current role')).toHaveValue('Senior Frontend Engineer');
    expect(screen.getByLabelText('Strongest skills')).toHaveValue('Angular, TypeScript');
    expect(screen.getByLabelText('Target roles')).toHaveValue('Staff Engineer');
    expect(screen.getByLabelText('Considered roles')).toHaveValue('Tech Lead');
    expect(screen.getByLabelText('Excluded role families')).toHaveValue('Sales');
    expect(screen.getByLabelText('Name')).toHaveValue('Jane Doe');
    expect(onSaved).toHaveBeenCalled();
  });
});
