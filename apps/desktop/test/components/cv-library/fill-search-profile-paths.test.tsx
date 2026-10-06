import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentDockBridge, CvBridge, CvDocumentRecord } from '../../../src/window.js';
import { CvLibraryPage } from '../../../src/components/cv-library/index.js';
import { SaveCvToLibrary } from '../../../src/components/cv/SaveCvToLibrary.js';
import { SettingsPage } from '../../../src/components/settings/index.js';
import {
  DEFAULT_CANDIDATE_PROFILE,
  installSystemBridge,
  installVacancyRadarBridge,
  installWorkspaceBridge,
} from '../../workspace-bridge.js';

function makeCv(overrides: Partial<CvDocumentRecord> = {}): CvDocumentRecord {
  return {
    id: 'cv-1',
    name: 'Frontend CV',
    kind: 'manual',
    targetRole: 'Product Engineer',
    text: '',
    profile: {
      title: 'Frontend Engineer',
      years: '8',
      location: 'Amsterdam',
      languages: 'English',
      skills: ['React', 'TypeScript'],
      summary: '',
      auth: '',
    },
    source: null,
    textSource: 'text_layer',
    isDefault: true,
    uploadedAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    ...overrides,
  };
}

const FILLED_PROFILE = {
  ...DEFAULT_CANDIDATE_PROFILE,
  currentRole: 'Backend Engineer',
  location: 'Berlin',
  experienceYears: 5,
  strongestSkills: ['Go'],
  targetRoles: ['Platform Engineer'],
  constraints: { ...DEFAULT_CANDIDATE_PROFILE.constraints, professionalLanguage: 'German' },
};

const EXPECTED_PATCH = {
  currentRole: 'Frontend Engineer',
  location: 'Amsterdam',
  experienceYears: 8,
  constraints: { professionalLanguage: 'English' },
  strongestSkills: ['React', 'TypeScript'],
  targetRoles: ['Product Engineer'],
};

const EMPTY_PROFILE = {
  ...DEFAULT_CANDIDATE_PROFILE,
  constraints: { ...DEFAULT_CANDIDATE_PROFILE.constraints, professionalLanguage: '' },
};

function installProfile(profile = EMPTY_PROFILE) {
  const saveSearchProfile = vi.fn().mockResolvedValue(profile);
  installVacancyRadarBridge({ getSearchProfile: vi.fn().mockResolvedValue(profile), saveSearchProfile });
  return saveSearchProfile;
}

function installCvAndAgentBridges(selectAndRead: CvBridge['selectAndRead'] = vi.fn().mockResolvedValue(null)) {
  (window as unknown as { cv: CvBridge }).cv = { selectAndRead, getWorkspaceDir: vi.fn().mockResolvedValue('/ws') };
  (window as unknown as { agentDock: AgentDockBridge }).agentDock = {
    getDaemonStatus: vi.fn().mockResolvedValue({ state: 'ready' }),
    restartDaemon: vi.fn().mockResolvedValue({ state: 'ready' }),
    onDaemonStatus: vi.fn().mockReturnValue(() => {}),
    listProviders: vi.fn().mockResolvedValue([]),
    createSession: vi.fn(),
    cancelSession: vi.fn().mockResolvedValue(undefined),
    onSessionEvent: vi.fn().mockReturnValue(() => {}),
    selectDirectory: vi.fn(),
  };
}

async function submitManualCv(name: string) {
  fireEvent.click(screen.getAllByRole('button', { name: /add manual profile/i })[0]!);
  const dialog = await screen.findByRole('dialog', { name: /add manual cv profile/i });
  fireEvent.change(within(dialog).getByLabelText(/^name/i), { target: { value: name } });
  fireEvent.click(within(dialog).getByRole('button', { name: /add cv/i }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CV paths that fill the empty search profile (#628)', () => {
  it('fills it when a CV created in the drawer becomes the default', async () => {
    installWorkspaceBridge({
      listCvDocuments: vi.fn().mockResolvedValue([]),
      createCvDocument: vi.fn().mockResolvedValue(makeCv()),
    });
    const save = installProfile();
    installCvAndAgentBridges();

    render(<CvLibraryPage />);
    await waitFor(() => expect(screen.getByText(/no cv on file/i)).toBeInTheDocument());
    await submitManualCv('Frontend CV');

    await waitFor(() => expect(save).toHaveBeenCalledWith(EXPECTED_PATCH));
    expect(await screen.findByText('Search profile filled from the default CV')).toBeInTheDocument();
  });

  it('leaves a filled profile alone when a new default CV is created', async () => {
    installWorkspaceBridge({
      listCvDocuments: vi.fn().mockResolvedValue([]),
      createCvDocument: vi.fn().mockResolvedValue(makeCv()),
    });
    const save = installProfile(FILLED_PROFILE);
    installCvAndAgentBridges();

    render(<CvLibraryPage />);
    await waitFor(() => expect(screen.getByText(/no cv on file/i)).toBeInTheDocument());
    await submitManualCv('Frontend CV');

    await waitFor(() => expect(screen.getByText('Frontend CV')).toBeInTheDocument());
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByText(/search profile filled/i)).not.toBeInTheDocument();
  });

  it('does not touch the profile when the created CV is not the default', async () => {
    installWorkspaceBridge({
      listCvDocuments: vi.fn().mockResolvedValue([makeCv({ id: 'a', name: 'Existing CV' })]),
      createCvDocument: vi.fn().mockResolvedValue(makeCv({ id: 'b', isDefault: false })),
    });
    const save = installProfile();
    installCvAndAgentBridges();

    render(<CvLibraryPage />);
    await waitFor(() => expect(screen.getByText('Existing CV')).toBeInTheDocument());
    await submitManualCv('Second CV');

    await waitFor(() => expect(screen.getByText('Frontend CV')).toBeInTheDocument());
    expect(save).not.toHaveBeenCalled();
  });

  it('fills it when the default CV is edited', async () => {
    const record = makeCv();
    installWorkspaceBridge({
      listCvDocuments: vi.fn().mockResolvedValue([record]),
      updateCvDocument: vi.fn().mockResolvedValue(record),
    });
    const save = installProfile();
    installCvAndAgentBridges();

    render(<CvLibraryPage />);
    await waitFor(() => expect(screen.getByText('Frontend CV')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^edit product engineer/i }));
    const dialog = await screen.findByRole('dialog', { name: /edit cv/i });
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(save).toHaveBeenCalledWith(EXPECTED_PATCH));
  });

  it('does not touch the profile when a non-default CV is edited', async () => {
    const record = makeCv({ isDefault: false });
    installWorkspaceBridge({
      listCvDocuments: vi.fn().mockResolvedValue([record]),
      updateCvDocument: vi.fn().mockResolvedValue(record),
    });
    const save = installProfile();
    installCvAndAgentBridges();

    render(<CvLibraryPage />);
    await waitFor(() => expect(screen.getByText('Frontend CV')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^edit product engineer/i }));
    const dialog = await screen.findByRole('dialog', { name: /edit cv/i });
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: /edit cv/i })).not.toBeInTheDocument());
    expect(save).not.toHaveBeenCalled();
  });

  it('fills it after an upload from the library page when the upload is the default', async () => {
    const created = makeCv({ id: 'up', name: 'resume.pdf', kind: 'uploaded' });
    installWorkspaceBridge({
      listCvDocuments: vi.fn().mockResolvedValue([]),
      createCvDocument: vi.fn().mockResolvedValue(created),
    });
    const save = installProfile();
    installCvAndAgentBridges(vi.fn().mockResolvedValue({ status: 'ok', fileName: 'resume.pdf', text: 'Text.' }));

    render(<CvLibraryPage />);
    await waitFor(() => expect(screen.getByText(/no cv on file/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /^upload cv$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /save to cv library/i }));

    await waitFor(() => expect(save).toHaveBeenCalledWith(EXPECTED_PATCH));
    expect(await screen.findByText('Search profile filled from the default CV')).toBeInTheDocument();
  });

  it('SaveCvToLibrary fills on its own and says so', async () => {
    installWorkspaceBridge({ createCvDocument: vi.fn().mockResolvedValue(makeCv()) });
    const save = installProfile();

    render(<SaveCvToLibrary cv={{ fileName: 'resume.pdf', text: 'Text.' }} />);
    fireEvent.click(screen.getByRole('button', { name: /save to cv library/i }));

    await waitFor(() => expect(save).toHaveBeenCalledWith(EXPECTED_PATCH));
    expect(await screen.findByText(/search profile filled from the default cv/i)).toBeInTheDocument();
  });

  it('SaveCvToLibrary never overwrites filled fields', async () => {
    installWorkspaceBridge({ createCvDocument: vi.fn().mockResolvedValue(makeCv()) });
    const save = installProfile(FILLED_PROFILE);

    render(<SaveCvToLibrary cv={{ fileName: 'resume.pdf', text: 'Text.' }} />);
    fireEvent.click(screen.getByRole('button', { name: /save to cv library/i }));

    await waitFor(() => expect(screen.getByText('Saved to library')).toBeInTheDocument());
    expect(save).not.toHaveBeenCalled();
  });

  it('SaveCvToLibrary skips a CV that is not the default', async () => {
    installWorkspaceBridge({ createCvDocument: vi.fn().mockResolvedValue(makeCv({ isDefault: false })) });
    const save = installProfile();

    render(<SaveCvToLibrary cv={{ fileName: 'resume.pdf', text: 'Text.' }} />);
    fireEvent.click(screen.getByRole('button', { name: /save to cv library/i }));

    await waitFor(() => expect(screen.getByText('Saved to library')).toBeInTheDocument());
    expect(save).not.toHaveBeenCalled();
  });

  it('SaveCvToLibrary leaves the profile to the caller when fillSearchProfile is false (welcome flow)', async () => {
    installWorkspaceBridge({ createCvDocument: vi.fn().mockResolvedValue(makeCv()) });
    const save = installProfile();

    render(<SaveCvToLibrary cv={{ fileName: 'resume.pdf', text: 'Text.' }} fillSearchProfile={false} />);
    fireEvent.click(screen.getByRole('button', { name: /save to cv library/i }));

    await waitFor(() => expect(screen.getByText('Saved to library')).toBeInTheDocument());
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps the save visible and says so when filling the profile fails', async () => {
    installWorkspaceBridge({ createCvDocument: vi.fn().mockResolvedValue(makeCv()) });
    installVacancyRadarBridge({ getSearchProfile: vi.fn().mockRejectedValue(new Error('profile locked')) });

    render(<SaveCvToLibrary cv={{ fileName: 'resume.pdf', text: 'Text.' }} />);
    fireEvent.click(screen.getByRole('button', { name: /save to cv library/i }));

    expect(await screen.findByText(/search profile was not filled: profile locked/i)).toBeInTheDocument();
    expect(screen.getByText('Saved to library')).toBeInTheDocument();
  });

  it('fills it when the default CV is chosen in Settings, without overwriting filled fields', async () => {
    const cv1 = makeCv({ id: 'cv-1', name: 'Old CV', isDefault: true, targetRole: '' });
    const cv2 = makeCv({ id: 'cv-2', name: 'Angular CV', isDefault: false });
    installSystemBridge();
    installWorkspaceBridge({
      listCvDocuments: vi.fn().mockResolvedValue([cv1, cv2]),
      setDefaultCvDocument: vi.fn().mockResolvedValue([{ ...cv1, isDefault: false }, { ...cv2, isDefault: true }]),
    });
    const save = installProfile({ ...EMPTY_PROFILE, location: 'Berlin' });

    render(<SettingsPage />);
    await screen.findByLabelText('Start page');
    fireEvent.click(screen.getByRole('tab', { name: 'Workspace' }));
    const select = await screen.findByLabelText('Default CV');
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(2));
    fireEvent.change(select, { target: { value: 'cv-2' } });

    const { location: _kept, ...patchWithoutLocation } = EXPECTED_PATCH;
    await waitFor(() => expect(save).toHaveBeenCalledWith(patchWithoutLocation));
    expect(await screen.findByText('Search profile filled from the default CV')).toBeInTheDocument();
  });
});
