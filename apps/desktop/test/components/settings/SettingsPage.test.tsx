import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from '../../../src/components/settings/index.js';
import type {
  ApplicationRecord,
  AppSettingsPatch,
  AppSettingsRecord,
  CvDocumentRecord,
  LetterRecord,
  SavedJobRecord,
} from '../../../src/window.js';
import {
  DEFAULT_SETTINGS,
  installSystemBridge,
  installVacancyRadarBridge,
  installWorkspaceBridge,
} from '../../workspace-bridge.js';

/**
 * `updateSettings` here answers like the real repository: the stored record with the patch
 * merged in. The shared bridge default (always `DEFAULT_SETTINGS`) would make the page appear to
 * revert every change, because SettingsPage adopts the resolved record as truth.
 */
function mergingUpdateSettings(base: AppSettingsRecord = DEFAULT_SETTINGS) {
  return vi.fn(async (patch: AppSettingsPatch): Promise<AppSettingsRecord> => ({ ...base, ...patch }));
}

function setup(overrides: Parameters<typeof installWorkspaceBridge>[0] = {}) {
  const system = installSystemBridge();
  const bridge = installWorkspaceBridge({ updateSettings: mergingUpdateSettings(), ...overrides });
  installVacancyRadarBridge();
  return { bridge, system };
}

/** Settings is now tabbed (General/Search/Workspace/Advanced); a field only renders once its tab is active. */
function openTab(name: 'General' | 'Search' | 'Workspace' | 'Advanced') {
  fireEvent.click(screen.getByRole('tab', { name }));
}

function makeCv(id: string, name: string): CvDocumentRecord {
  return {
    id,
    name,
    kind: 'uploaded',
    targetRole: '',
    text: '',
    profile: { title: '', years: '', location: '', languages: '', skills: [], summary: '', auth: '' },
    isDefault: false,
    uploadedAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-density');
});

describe('SettingsPage', () => {
  it('loads settings on mount and populates the form without saving anything', async () => {
    const { bridge } = setup({
      getSettings: vi.fn().mockResolvedValue({
        ...DEFAULT_SETTINGS,
        startPage: 'applications',
        theme: 'dark',
        defaultMarket: 'worldwide',
        defaultLocation: 'Germany',
        launchAtLogin: true,
      } satisfies AppSettingsRecord),
    });

    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByLabelText('Start page')).toHaveValue('applications'));
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('switch', { name: 'Launch at login' })).toBeChecked();

    openTab('Search');
    expect(screen.getByLabelText('Default search location')).toHaveValue('Germany');
    // Worldwide default: the Netherlands-only IND toggles would just be clutter for a user whose
    // default search location isn't Netherlands.
    expect(screen.queryByRole('switch', { name: 'Recognised sponsors only by default' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'IND recognised sponsor verification' })).not.toBeInTheDocument();

    // Load must never autosave.
    expect(bridge.updateSettings).not.toHaveBeenCalled();
  });

  it('shows the IND-sponsor toggles only when the default search location is Netherlands', async () => {
    setup({
      getSettings: vi.fn().mockResolvedValue({
        ...DEFAULT_SETTINGS,
        defaultMarket: 'netherlands',
        sponsorOnlyDefault: false,
        indVerificationEnabled: true,
      } satisfies AppSettingsRecord),
    });

    render(<SettingsPage />);
    await screen.findByLabelText('Start page');
    openTab('Search');

    expect(screen.getByLabelText('Default search location')).toHaveValue('Netherlands');
    expect(screen.getByRole('switch', { name: 'Recognised sponsors only by default' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'IND recognised sponsor verification' })).toBeChecked();
  });

  it('renders exactly these sections across its four tabs, no fake per-source discovery toggles', async () => {
    setup();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText('Start page')).toBeInTheDocument());

    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['General', 'Search', 'Workspace', 'Advanced']);

    const headingsNow = () => screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headingsNow()).toEqual(['Settings', 'Startup', 'Appearance']);

    // `setup()`'s default is worldwide, so the Netherlands-only search-profile section (issue: no
    // default country bias) renders nothing at all here -- see the dedicated NL-selected case above.
    openTab('Search');
    expect(headingsNow()).toEqual(['Settings', 'Default search location']);

    openTab('Workspace');
    expect(headingsNow()).toEqual(['Settings', 'Documents', 'Applications']);

    openTab('Advanced');
    expect(headingsNow()).toEqual(['Settings', 'AI runtime', 'Data management', 'About']);
  });

  it('offers "All countries" plus the full country list (Netherlands included) as one unified selector', async () => {
    setup();
    render(<SettingsPage />);
    await screen.findByLabelText('Start page');
    openTab('Search');
    const select = await screen.findByLabelText('Default search location');

    const values = within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    expect(values[0]).toBe('all');
    expect(values).toContain('Netherlands');
    expect(values).toContain('Germany');
    // A real country list, not a two-item market picker in disguise.
    expect(values.length).toBeGreaterThan(50);
  });

  it('autosaves a changed field with a patch containing only that field, and shows "Saved" only after the IPC call resolves', async () => {
    let resolveSave!: (record: AppSettingsRecord) => void;
    const updateSettings = vi.fn().mockImplementation(
      () => new Promise<AppSettingsRecord>((resolve) => { resolveSave = resolve; }),
    );
    setup({ updateSettings });

    render(<SettingsPage />);
    const select = await screen.findByLabelText('Start page');

    fireEvent.change(select, { target: { value: 'saved' } });

    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledWith({ startPage: 'saved' });
    // Not optimistic: no confirmation while the call is still in flight.
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();

    await act(async () => {
      resolveSave({ ...DEFAULT_SETTINGS, startPage: 'saved' });
    });

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.getByText('Saved')).toHaveAttribute('role', 'status');
  });

  it('applies a theme change to the document immediately, before persistence resolves', async () => {
    const updateSettings = vi.fn().mockImplementation(() => new Promise<AppSettingsRecord>(() => {}));
    setup({ updateSettings });

    render(<SettingsPage />);
    await screen.findByLabelText('Start page');

    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));

    // applyTheme ran synchronously with the click, while updateSettings is still pending.
    expect(document.documentElement.getAttribute('data-theme')).toBe('openvacancyradar-dark');
    expect(updateSettings).toHaveBeenCalledWith({ theme: 'dark' });
  });

  it('applies a density change to the document immediately and persists it', async () => {
    const { bridge } = setup();
    render(<SettingsPage />);
    await screen.findByLabelText('Start page');

    fireEvent.click(screen.getByRole('button', { name: 'Compact' }));

    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
    await waitFor(() => expect(bridge.updateSettings).toHaveBeenCalledWith({ density: 'compact' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('reverts the field, theme included, when the save fails', async () => {
    const updateSettings = vi.fn().mockRejectedValue(new Error('database unreachable'));
    setup({ updateSettings });

    render(<SettingsPage />);
    await screen.findByLabelText('Start page');

    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('openvacancyradar-dark');

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/database unreachable/));
    expect(screen.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('persists launch-at-login and mirrors it into the OS via window.system', async () => {
    const { bridge, system } = setup();
    render(<SettingsPage />);
    const toggle = await screen.findByRole('switch', { name: 'Launch at login' });

    fireEvent.click(toggle);

    await waitFor(() => expect(bridge.updateSettings).toHaveBeenCalledWith({ launchAtLogin: true }));
    await waitFor(() => expect(system.setLaunchAtLogin).toHaveBeenCalledWith(true));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('keeps the persisted value but reports honestly when the OS login-item call fails', async () => {
    const { bridge } = setup();
    installSystemBridge({ setLaunchAtLogin: vi.fn().mockRejectedValue(new Error('registry denied')) });

    render(<SettingsPage />);
    const toggle = await screen.findByRole('switch', { name: 'Launch at login' });

    fireEvent.click(toggle);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/login item could not be updated.*registry denied/i),
    );
    // The preference row itself did save; the toggle stays on rather than silently reverting.
    expect(bridge.updateSettings).toHaveBeenCalledWith({ launchAtLogin: true });
    expect(screen.getByRole('switch', { name: 'Launch at login' })).toBeChecked();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('saves the default search location immediately on change, resolving pipeline vs. country filter correctly', async () => {
    const { bridge } = setup();
    render(<SettingsPage />);
    await screen.findByLabelText('Start page');
    openTab('Search');
    const select = await screen.findByLabelText('Default search location');

    // A specific country: worldwide, pre-filtered to it.
    fireEvent.change(select, { target: { value: 'Germany' } });
    await waitFor(() =>
      expect(bridge.updateSettings).toHaveBeenCalledWith({ defaultMarket: 'worldwide', defaultLocation: 'Germany' }),
    );

    // Netherlands: the IND pipeline, not a worldwide search filtered to Dutch locations.
    fireEvent.change(select, { target: { value: 'Netherlands' } });
    await waitFor(() =>
      expect(bridge.updateSettings).toHaveBeenCalledWith({ defaultMarket: 'netherlands', defaultLocation: '' }),
    );

    // Back to no preference: worldwide, unfiltered.
    fireEvent.change(select, { target: { value: 'all' } });
    await waitFor(() =>
      expect(bridge.updateSettings).toHaveBeenCalledWith({ defaultMarket: 'worldwide', defaultLocation: '' }),
    );
  });

  it('lists the CV library in the default-CV select and saves the chosen id', async () => {
    const { bridge } = setup({
      listCvDocuments: vi.fn().mockResolvedValue([makeCv('cv-1', 'Frontend CV'), makeCv('cv-2', 'Angular CV')]),
    });

    render(<SettingsPage />);
    await screen.findByLabelText('Start page');
    openTab('Workspace');
    const select = await screen.findByLabelText('Default CV');
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));

    fireEvent.change(select, { target: { value: 'cv-2' } });

    await waitFor(() => expect(bridge.updateSettings).toHaveBeenCalledWith({ defaultCvId: 'cv-2' }));
  });

  it('disables the default-CV select and says so when the library is empty', async () => {
    setup({ listCvDocuments: vi.fn().mockResolvedValue([]) });
    render(<SettingsPage />);

    await screen.findByLabelText('Start page');
    openTab('Workspace');
    const select = await screen.findByLabelText('Default CV');
    expect(select).toBeDisabled();
    expect(screen.getByText(/no cvs in the library yet/i)).toBeInTheDocument();
  });

  it('resets settings to schema defaults after confirmation, re-applying theme and density', async () => {
    const { bridge, system } = setup({
      getSettings: vi.fn().mockResolvedValue({
        ...DEFAULT_SETTINGS,
        theme: 'dark',
        density: 'compact',
        launchAtLogin: true,
      } satisfies AppSettingsRecord),
    });

    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true'),
    );

    openTab('Advanced');
    fireEvent.click(screen.getByRole('button', { name: 'Reset settings' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /reset settings/i }));

    await waitFor(() =>
      expect(bridge.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({
          launchAtLogin: false,
          startPage: 'search',
          theme: 'system',
          density: 'comfortable',
          defaultMarket: 'worldwide',
          defaultCvId: null,
          confirmApplicationDelete: true,
        }),
      ),
    );
    openTab('General');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'System' })).toHaveAttribute('aria-pressed', 'true'),
    );
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
    expect(document.documentElement.getAttribute('data-density')).toBeNull();
    await waitFor(() => expect(system.setLaunchAtLogin).toHaveBeenCalledWith(false));
    expect(await screen.findByText('Settings reset')).toBeInTheDocument();

    // Data is untouched by this reset.
    expect(bridge.deleteSavedJob).not.toHaveBeenCalled();
    expect(bridge.deleteApplication).not.toHaveBeenCalled();
    expect(bridge.deleteCvDocument).not.toHaveBeenCalled();
    expect(bridge.deleteLetter).not.toHaveBeenCalled();
  });

  it('reset application data deletes every row through the existing IPC verbs, then restores defaults', async () => {
    const { bridge } = setup({
      listApplications: vi.fn().mockResolvedValue([{ id: 'app-1' } as ApplicationRecord, { id: 'app-2' } as ApplicationRecord]),
      listSavedJobs: vi.fn().mockResolvedValue([{ id: 'job-1' } as SavedJobRecord]),
      listLetters: vi.fn().mockResolvedValue([{ id: 'letter-1' } as LetterRecord]),
      listCvDocuments: vi.fn().mockResolvedValue([makeCv('cv-1', 'Frontend CV')]),
    });

    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText('Start page')).toBeInTheDocument());

    openTab('Advanced');
    fireEvent.click(screen.getByRole('button', { name: 'Reset application data' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /delete everything/i }));

    await waitFor(() => expect(screen.getByText('Application data reset')).toBeInTheDocument());
    expect(bridge.deleteApplication).toHaveBeenCalledWith('app-1');
    expect(bridge.deleteApplication).toHaveBeenCalledWith('app-2');
    expect(bridge.deleteSavedJob).toHaveBeenCalledWith('job-1');
    expect(bridge.deleteLetter).toHaveBeenCalledWith('letter-1');
    expect(bridge.deleteCvDocument).toHaveBeenCalledWith('cv-1');
    expect(bridge.updateSettings).toHaveBeenCalledWith(expect.objectContaining({ theme: 'system', defaultCvId: null }));
  });

  it('cancelling a reset confirmation deletes nothing and saves nothing', async () => {
    const { bridge } = setup({
      listApplications: vi.fn().mockResolvedValue([{ id: 'app-1' } as ApplicationRecord]),
    });

    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText('Start page')).toBeInTheDocument());

    openTab('Advanced');
    fireEvent.click(screen.getByRole('button', { name: 'Reset application data' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(bridge.deleteApplication).not.toHaveBeenCalled();
    expect(bridge.updateSettings).not.toHaveBeenCalled();
  });

  it('surfaces a settings load failure without crashing', async () => {
    setup({ getSettings: vi.fn().mockRejectedValue(new Error('database unreachable')) });
    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByText(/database unreachable/i)).toBeInTheDocument());
    expect(screen.queryByLabelText('Start page')).not.toBeInTheDocument();
  });
});
