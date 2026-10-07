import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from '../../../src/components/settings/index.js';
import type {
  ApplicationRecord,
  AppSettingsPatch,
  AppSettingsRecord,
  CvDocumentRecord,
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

/** Settings is now tabbed (General/Search/Workspace/Data/Advanced); a field only renders once its tab is active. */
function openTab(name: 'General' | 'Search' | 'Workspace' | 'Data' | 'Advanced') {
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
    source: null,
    textSource: 'text_layer',
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
  it('shows the Finish setup entry only when the shell can open it (#539)', async () => {
    setup();
    const onOpenSetup = vi.fn();
    const { unmount } = render(<SettingsPage onOpenSetup={onOpenSetup} />);
    const button = await screen.findByRole('button', { name: 'Finish setup' });
    fireEvent.click(button);
    expect(onOpenSetup).toHaveBeenCalledTimes(1);
    unmount();

    setup();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText('Start page')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Finish setup' })).not.toBeInTheDocument();
  });

  it('opens on the General tab unless a tab is asked for', async () => {
    setup();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText('Start page')).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'General' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens on the Search tab and focuses the "What you are looking for" section when asked (issue #480)', async () => {
    setup();
    render(<SettingsPage initialTab="search" focusSection="search-profile" />);

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Search' })).toHaveAttribute('aria-selected', 'true'));
    expect(screen.queryByLabelText('Start page')).not.toBeInTheDocument(); // not the General tab's startup toggles
    const heading = screen.getByRole('heading', { name: 'What you are looking for' });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it('opens the Search tab without stealing focus when no section is asked for', async () => {
    setup();
    render(<SettingsPage initialTab="search" />);

    const heading = await screen.findByRole('heading', { name: 'What you are looking for' });
    expect(heading).not.toHaveFocus();
  });

  it('no longer renders the search profile form on the Search tab, and points to the CV page instead (#635)', async () => {
    setup();
    const onOpenCvPage = vi.fn();
    render(<SettingsPage initialTab="search" onOpenCvPage={onOpenCvPage} />);

    await screen.findByRole('heading', { name: 'What you are looking for' });
    for (const label of ['Name', 'Target roles', 'Strongest skills', 'Country', 'Years of experience']) {
      expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
    }
    expect(screen.getByLabelText('Default search location')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open on CV page' }));
    expect(onOpenCvPage).toHaveBeenCalledTimes(1);
  });

  it('loads settings on mount and populates the form without saving anything', async () => {
    const { bridge } = setup({
      getSettings: vi.fn().mockResolvedValue({
        ...DEFAULT_SETTINGS,
        startPage: 'applications',
        theme: 'dark',
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

    // Load must never autosave.
    expect(bridge.updateSettings).not.toHaveBeenCalled();
  });

  it('links the settings panel to the active tab and switches with the arrow keys', async () => {
    setup();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText('Start page')).toBeInTheDocument());

    expect(screen.getByRole('tabpanel', { name: 'General' })).toContainElement(screen.getByLabelText('Start page'));
    fireEvent.keyDown(screen.getByRole('tab', { name: 'General' }), { key: 'ArrowRight' });

    expect(screen.getByRole('tab', { name: 'Search' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Search' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Start page')).not.toBeInTheDocument();
  });

  it('renders exactly these sections across its five tabs, no fake per-source discovery toggles', async () => {
    setup();
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText('Start page')).toBeInTheDocument());

    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['General', 'Search', 'Workspace', 'Data', 'Advanced']);

    const headingsNow = () => screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headingsNow()).toEqual(['Startup', 'Appearance', 'Support']);

    openTab('Search');
    await waitFor(() =>
      expect(headingsNow()).toEqual(['Default search location', 'What you are looking for', 'Company list', 'Company discovery']),
    );

    openTab('Workspace');
    expect(headingsNow()).toEqual(['Documents', 'Applications', 'Saved application answers']);

    openTab('Data');
    expect(headingsNow()).toEqual(['Job cache', 'Your data']);

    openTab('Advanced');
    expect(headingsNow()).toEqual(['AI runtime', 'Connect other AI apps', 'About']);
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

  it('keeps the save error until it is closed, and the close button works from the keyboard', async () => {
    const updateSettings = vi.fn().mockRejectedValue(new Error('database unreachable'));
    setup({ updateSettings });

    render(<SettingsPage />);
    await screen.findByLabelText('Start page');
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));

    const alert = await screen.findByRole('alert');
    const close = within(alert).getByRole('button', { name: /dismiss error/i });
    expect(close.tagName).toBe('BUTTON');
    close.focus();
    expect(close).toHaveFocus();
    fireEvent.click(close);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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
      expect(screen.getByRole('alert')).toHaveTextContent(/would not update the startup entry/i),
    );
    expect(screen.getByText('registry denied')).not.toBeVisible(); // raw text stays under Details
    // The preference row itself did save; the toggle stays on rather than silently reverting.
    expect(bridge.updateSettings).toHaveBeenCalledWith({ launchAtLogin: true });
    expect(screen.getByRole('switch', { name: 'Launch at login' })).toBeChecked();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('saves the default search location immediately on change', async () => {
    const { bridge } = setup();
    render(<SettingsPage />);
    await screen.findByLabelText('Start page');
    openTab('Search');
    const select = await screen.findByLabelText('Default search location');

    fireEvent.change(select, { target: { value: 'Germany' } });
    await waitFor(() => expect(bridge.updateSettings).toHaveBeenCalledWith({ defaultLocation: 'Germany' }));

    fireEvent.change(select, { target: { value: 'Netherlands' } });
    await waitFor(() => expect(bridge.updateSettings).toHaveBeenCalledWith({ defaultLocation: 'Netherlands' }));

    // Back to no preference.
    fireEvent.change(select, { target: { value: 'all' } });
    await waitFor(() => expect(bridge.updateSettings).toHaveBeenCalledWith({ defaultLocation: '' }));
  });

  it('lists the CV library in the default-CV select and sets the library default (#554)', async () => {
    const cv1 = makeCv('cv-1', 'Frontend CV');
    const cv2 = makeCv('cv-2', 'Angular CV');
    const setDefaultCvDocument = vi.fn().mockResolvedValue([cv1, { ...cv2, isDefault: true }]);
    const { bridge } = setup({
      listCvDocuments: vi.fn().mockResolvedValue([cv1, cv2]),
      setDefaultCvDocument,
    });

    render(<SettingsPage />);
    await screen.findByLabelText('Start page');
    openTab('Workspace');
    const select = await screen.findByLabelText('Default CV');
    await waitFor(() => expect(within(select).getAllByRole('option')).toHaveLength(3));

    fireEvent.change(select, { target: { value: 'cv-2' } });

    await waitFor(() => expect(setDefaultCvDocument).toHaveBeenCalledWith('cv-2'));
    await waitFor(() => expect(select).toHaveValue('cv-2'));
    expect(within(select).queryByRole('option', { name: 'No default' })).not.toBeInTheDocument();
    expect(bridge.updateSettings).not.toHaveBeenCalledWith({ defaultCvId: 'cv-2' });
  });

  it('shows the CV the library marks as default, the same one the CV page shows (#554)', async () => {
    setup({
      listCvDocuments: vi.fn().mockResolvedValue([makeCv('cv-1', 'Frontend CV'), { ...makeCv('cv-2', 'Angular CV'), isDefault: true }]),
    });

    render(<SettingsPage />);
    await screen.findByLabelText('Start page');
    openTab('Workspace');
    const select = await screen.findByLabelText('Default CV');
    await waitFor(() => expect(select).toHaveValue('cv-2'));
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

    openTab('Data');
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

  it('delete my data needs the word DELETE typed, then uses the main-process reset and applies returned defaults', async () => {
    const { bridge } = setup({
      resetApplicationData: vi.fn().mockResolvedValue({
        settings: DEFAULT_SETTINGS,
        deleted: {
          savedJobs: 1,
          applications: 2,
          cvDocuments: 1,
          letters: 1,
          applicationAttempts: 1,
          applicationArtifacts: 2,
          submissionReceipts: 1,
          automationGrants: 1,
        },
      }),
    });

    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText('Start page')).toBeInTheDocument());

    openTab('Data');
    expect(screen.queryByRole('button', { name: 'Reset application data' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete my data' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/there is no backup/i)).toBeInTheDocument();
    for (const record of [/saved jobs/i, /applications and application history/i, /cvs/i, /letters/i]) {
      expect(within(dialog).getAllByText(record).length).toBeGreaterThan(0);
    }

    const confirm = within(dialog).getByRole('button', { name: 'Delete my data' });
    // A click on the button alone cannot confirm.
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(bridge.resetApplicationData).not.toHaveBeenCalled();

    // Wrong text, and the Enter key on it, do nothing either.
    const input = within(dialog).getByLabelText(/type delete to confirm/i);
    fireEvent.change(input, { target: { value: 'delete' } });
    expect(confirm).toBeDisabled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(bridge.resetApplicationData).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: 'DELETE' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(screen.getByText('Application data reset')).toBeInTheDocument());
    expect(bridge.resetApplicationData).toHaveBeenCalledTimes(1);
    expect(bridge.updateSettings).not.toHaveBeenCalled();
  });

  it('a failed deletion reports the failure and leaves the settings screen usable', async () => {
    const { bridge } = setup({ resetApplicationData: vi.fn().mockRejectedValue(new Error('database is locked')) });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText('Start page')).toBeInTheDocument());

    openTab('Data');
    fireEvent.click(screen.getByRole('button', { name: 'Delete my data' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.change(within(dialog).getByLabelText(/type delete to confirm/i), { target: { value: 'DELETE' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete my data' }));

    expect(await screen.findByText('Could not delete your data.')).toBeInTheDocument();
    expect(bridge.resetApplicationData).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Delete my data' })).toBeEnabled();
  });

  it('cancelling a reset confirmation deletes nothing and saves nothing', async () => {
    const { bridge } = setup({
      listApplications: vi.fn().mockResolvedValue([{ id: 'app-1' } as ApplicationRecord]),
    });

    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText('Start page')).toBeInTheDocument());

    openTab('Data');
    fireEvent.click(screen.getByRole('button', { name: 'Delete my data' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(bridge.resetApplicationData).not.toHaveBeenCalled();
    expect(bridge.updateSettings).not.toHaveBeenCalled();
  });

  it('rebuild job cache is a separate action that never touches workspace records', async () => {
    const { bridge } = setup();
    const vacancy = installVacancyRadarBridge({
      rebuildCache: vi.fn().mockResolvedValue({ ok: true, retainedFileName: 'vacancy-engine.db.damaged-1', sponsorRefresh: 'ok' }),
    });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText('Start page')).toBeInTheDocument());

    openTab('Data');
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild job cache' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/your cvs, applications and letters are kept/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rebuild job cache' }));

    expect(await screen.findByText('Job cache rebuilt')).toBeInTheDocument();
    expect(vacancy.rebuildCache).toHaveBeenCalledTimes(1);
    expect(bridge.resetApplicationData).not.toHaveBeenCalled();
    expect(bridge.updateSettings).not.toHaveBeenCalled();
  });

  it('a failed cache rebuild says so and does not report success', async () => {
    setup();
    installVacancyRadarBridge({
      rebuildCache: vi.fn().mockResolvedValue({ ok: false, reason: 'rebuild_failed', detail: 'could not build a fresh job cache: disk full' }),
    });
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText('Start page')).toBeInTheDocument());

    openTab('Data');
    fireEvent.click(screen.getByRole('button', { name: 'Rebuild job cache' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Rebuild job cache' }));

    expect(await screen.findByText('Could not rebuild the job cache.')).toBeInTheDocument();
    expect(screen.queryByText('Job cache rebuilt')).not.toBeInTheDocument();
  });

  it('surfaces a settings load failure without crashing', async () => {
    setup({ getSettings: vi.fn().mockRejectedValue(new Error('database unreachable')) });
    render(<SettingsPage />);

    await waitFor(() => expect(screen.getByText(/database unreachable/i)).toBeInTheDocument());
    expect(screen.queryByLabelText('Start page')).not.toBeInTheDocument();
  });
});
