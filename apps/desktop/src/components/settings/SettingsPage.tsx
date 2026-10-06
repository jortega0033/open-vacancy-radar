import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AppSettingsPatch,
  AppSettingsRecord,
  CvDocumentRecord,
} from '../../window.js';
import { PROVIDER_LABEL } from '../../provider-labels.js';
import { applyDensity, applyTheme } from '../../theme.js';
import { ConfirmDialog, ErrorBanner, PageLoading, TabPanel, Tabs } from '../shell/index.js';
import { AboutSection } from './AboutSection.js';
import type { NavPage } from '../shell/nav.js';
import { AtsRosterSection } from './AtsRosterSection.js';
import { SegmentedControl, SettingsRow, SettingsSection, ToggleSwitch } from './controls.js';
import { DataManagement } from './DataManagement.js';
import { McpEndpointSection } from './McpEndpointSection.js';
import { SavedAnswersSection } from './SavedAnswersSection.js';
import { SourceScoutSection } from './SourceScoutSection.js';
import { SearchProfileSection } from './SearchProfileSection.js';
import { SupportSection } from './SupportSection.js';
import { ALL_COUNTRIES } from '../search/countries.js';
import {
  SEARCH_PROFILE_FILLED_STATUS,
  tryFillSearchProfileFromCv,
  type SearchProfileFillOutcome,
} from '../cv-library/fill-search-profile-from-cv.js';

/**
 * Top-level "Settings" screen. Every control autosaves its own field through
 * `window.workspace.updateSettings({ [field]: value })` the moment it changes (there is no page
 * "Save" button), and the "Saved" flash only appears after the IPC call actually resolves, never
 * optimistically. Theme and density additionally take effect immediately via `applyTheme` /
 * `applyDensity` (the same calls App.tsx makes on initial hydration).
 *
 * Deliberately not wired into `App.tsx` here: exported standalone (see `index.ts`) so the
 * shell's router can pick it up in a separate integration pass.
 *
 * What is intentionally NOT on this page:
 *  - Per-source discovery toggles. The main process exposes no per-source configuration IPC, so
 *    rendering toggles for them would be decoration that silently does nothing.
 *  - `sidebarCollapsed` / `lastOpenedPage`. Those are shell bookkeeping written by App.tsx as the
 *    user navigates, not preferences a person sets; `sidebarStart` is the user-facing knob.
 */

/** Mirrors the column defaults in electron/workspace/schema.ts: used by both reset actions. */
const SETTINGS_DEFAULTS: AppSettingsPatch = {
  launchAtLogin: false,
  startPage: 'search',
  theme: 'system',
  density: 'comfortable',
  sidebarStart: 'remember_last',
  sidebarCollapsed: false,
  lastOpenedPage: 'search',
  minimizeToTrayOnClose: false,
  autoScanEnabled: false,
  autoSourceScoutEnabled: false,
  autoRosterDownloadEnabled: true,
  defaultLocation: '',
  defaultCvId: null,
  defaultLetterType: 'motivation_letter',
  defaultLetterTone: 'natural',
  defaultLetterLength: 'standard',
  defaultApplicationStatus: 'preparing',
  confirmApplicationDelete: true,
  autoArchiveRejected: false,
  defaultProvider: 'claude',
  mcpEndpointEnabled: false,
};

const START_PAGE_OPTIONS = [
  { value: 'search', label: 'Search' },
  { value: 'saved', label: 'Saved jobs' },
  { value: 'applications', label: 'Applications' },
  { value: 'last_opened', label: 'Last opened page' },
] as const;

const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const;

const DENSITY_OPTIONS = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
] as const;

const SIDEBAR_START_OPTIONS = [
  { value: 'expanded', label: 'Expanded' },
  { value: 'collapsed', label: 'Collapsed' },
  { value: 'remember_last', label: 'Remember last state' },
] as const;

/** The country a new search's Country filter starts pre-set to -- mirrors SearchPage.tsx's own
 * Country selector exactly. "All countries" applies no filter. */
const DEFAULT_LOCATION_OPTIONS = [
  { value: 'all', label: 'All countries' },
  ...ALL_COUNTRIES.map((country) => ({ value: country, label: country })),
];

const LETTER_TYPE_OPTIONS = [
  { value: 'motivation_letter', label: 'Motivation letter' },
  { value: 'cover_letter', label: 'Cover letter' },
  { value: 'recruiter_message', label: 'Recruiter message' },
  { value: 'short_application_message', label: 'Short application message' },
] as const;

const LETTER_TONE_OPTIONS = [
  { value: 'formal', label: 'Formal' },
  { value: 'natural', label: 'Natural' },
  { value: 'confident', label: 'Confident' },
  { value: 'concise', label: 'Concise' },
] as const;

const LETTER_LENGTH_OPTIONS = [
  { value: 'short', label: 'Short' },
  { value: 'standard', label: 'Standard' },
  { value: 'detailed', label: 'Detailed' },
] as const;

const APPLICATION_STATUS_OPTIONS = [
  { value: 'preparing', label: 'Preparing' },
  { value: 'applied', label: 'Applied' },
  { value: 'recruiter_screen', label: 'Recruiter screen' },
  { value: 'interview', label: 'Interview' },
  { value: 'offer', label: 'Offer' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'withdrawn', label: 'Withdrawn' },
] as const;

type SaveStatus = { kind: 'saved'; message: string } | { kind: 'error'; message: string; details?: string };

type ResetTarget = 'settings' | 'data' | 'cache';

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** An error toast: one plain sentence, with the raw message (when there is one) behind "Details". */
function failure(err: unknown, message: string): SaveStatus {
  return err instanceof Error && err.message ? { kind: 'error', message, details: err.message } : { kind: 'error', message };
}

interface SettingsSelectProps<T extends string> {
  id: string;
  value: T;
  options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  disabled?: boolean;
  onChange: (next: T) => void;
}

function SettingsSelect<T extends string>({ id, value, options, disabled, onChange }: SettingsSelectProps<T>) {
  return (
    <select
      id={id}
      className="select select-sm"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.value as T)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export interface SettingsPageProps {
  /** Rendered as the "AI runtime" section's "Manage in AI runtime" button. Optional so the page
   * still works standalone (e.g. in isolation tests) without a real router behind it. */
  onNavigateToRuntime?: () => void;
  /** Reopens the setup checklist ("Finish setup"). Hidden when not provided. */
  onOpenSetup?: () => void;
  /** The tab to open on. The shell keeps this in its own state, so it survives the page remounting. */
  initialTab?: SettingsTab;
  /** A section to scroll to and focus once its tab is showing. Only the search profile today. */
  focusSection?: SettingsFocusSection;
  /** The shell's active and previous pages, passed on to the About diagnostics report. */
  currentPage?: NavPage;
  previousPage?: NavPage;
}

export type SettingsTab = 'general' | 'search' | 'workspace' | 'data' | 'advanced';
export type SettingsFocusSection = 'search-profile';

const SETTINGS_TABS: ReadonlyArray<{ readonly id: SettingsTab; readonly label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'search', label: 'Search' },
  { id: 'workspace', label: 'Workspace' },
  { id: 'data', label: 'Data' },
  { id: 'advanced', label: 'Advanced' },
];

export function SettingsPage({
  onNavigateToRuntime,
  onOpenSetup,
  initialTab,
  focusSection,
  currentPage,
  previousPage,
}: SettingsPageProps = {}) {
  const [settings, setSettings] = useState<AppSettingsRecord | null>(null);
  const [loadError, setLoadError] = useState<string>();

  // Plain local state, not persisted: like LettersPage's own tabs, nothing here needs to survive a
  // restart. A plain "open Settings" lands on General; a caller that wants somewhere specific says so.
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'general');

  const [cvDocuments, setCvDocuments] = useState<CvDocumentRecord[]>([]);
  const [cvListError, setCvListError] = useState<string>();

  const [status, setStatus] = useState<SaveStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<ResetTarget | null>(null);

  // Guards against a slow earlier save overwriting the state a later save already produced.
  const saveSeq = useRef(0);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await window.workspace.getSettings();
        if (cancelled) return;
        setSettings(loaded);
      } catch (err) {
        if (!cancelled) setLoadError(describeError(err, 'unknown error'));
      }
    })();
    void (async () => {
      try {
        const docs = await window.workspace.listCvDocuments();
        if (!cancelled) setCvDocuments(docs);
      } catch (err) {
        if (!cancelled) setCvListError(describeError(err, 'unknown error'));
      }
    })();
    return () => {
      cancelled = true;
      if (flashTimer.current !== undefined) clearTimeout(flashTimer.current);
    };
  }, []);

  const flash = useCallback((next: SaveStatus) => {
    setStatus(next);
    if (flashTimer.current !== undefined) clearTimeout(flashTimer.current);
    if (next.kind === 'saved') {
      flashTimer.current = setTimeout(() => setStatus(null), 2000);
    }
  }, []);

  /**
   * The single autosave path: reflect the choice in local state immediately (so the control shows
   * what the user picked), persist just that field, and only report "Saved" once the IPC call has
   * resolved. On failure the previous record (and any theme/density it implied) is restored.
   */
  const changeField = useCallback(
    (patch: AppSettingsPatch) => {
      const previous = settings;
      if (!previous) return;
      setSettings({ ...previous, ...patch });
      if (patch.theme !== undefined) applyTheme(patch.theme);
      if (patch.density !== undefined) applyDensity(patch.density);

      const seq = ++saveSeq.current;
      void (async () => {
        try {
          const updated = await window.workspace.updateSettings(patch);
          if (seq !== saveSeq.current) return;
          setSettings(updated);
          flash({ kind: 'saved', message: 'Saved' });
        } catch (err) {
          if (seq !== saveSeq.current) return;
          setSettings(previous);
          applyTheme(previous.theme);
          applyDensity(previous.density);
          flash(failure(err, 'Could not save this setting.'));
        }
      })();
    },
    [settings, flash],
  );

  /**
   * Launch at login persists like any other field, then additionally mirrors into the OS
   * login-item registration via the narrow `system:set-login-item` IPC. A failure of the OS half
   * keeps the persisted value but says so, instead of pretending the whole change landed.
   */
  const changeLaunchAtLogin = useCallback(
    (next: boolean) => {
      const previous = settings;
      if (!previous) return;
      setSettings({ ...previous, launchAtLogin: next });

      const seq = ++saveSeq.current;
      void (async () => {
        let updated: AppSettingsRecord;
        try {
          updated = await window.workspace.updateSettings({ launchAtLogin: next });
        } catch (err) {
          if (seq !== saveSeq.current) return;
          setSettings(previous);
          flash(failure(err, 'Could not save this setting.'));
          return;
        }
        if (seq === saveSeq.current) setSettings(updated);
        try {
          await window.system.setLaunchAtLogin(updated.launchAtLogin);
          if (seq === saveSeq.current) flash({ kind: 'saved', message: 'Saved' });
        } catch (err) {
          if (seq === saveSeq.current) {
            flash(failure(err, 'Saved, but your computer would not update the startup entry.'));
          }
        }
      })();
    },
    [settings, flash],
  );

  /** Restore every preference to its schema default. Personal application data stays. */
  const resetSettings = useCallback(async (): Promise<AppSettingsRecord> => {
    const updated = await window.workspace.updateSettings(SETTINGS_DEFAULTS);
    saveSeq.current += 1; // invalidate any in-flight per-field save
    setSettings(updated);
    applyTheme(updated.theme);
    applyDensity(updated.density);
    try {
      await window.system.setLaunchAtLogin(updated.launchAtLogin);
    } catch {
      // The preference row is already reset; the OS entry (if any) is cleaned up on next toggle.
    }
    return updated;
  }, []);

  /** Reset personal records and generated files through one main-process-owned operation. */
  const runReset = useCallback(
    (target: ResetTarget) => {
      setConfirmTarget(null);
      setBusy(true);
      void (async () => {
        try {
          if (target === 'cache') {
            // Touches only the downloaded vacancy cache: no workspace record is read or written.
            const result = await window.vacancyRadar.rebuildCache();
            if (!result.ok) {
              flash(failure(new Error(result.detail), 'Could not rebuild the job cache.'));
              return;
            }
            flash({
              kind: 'saved',
              message:
                result.sponsorRefresh === 'ok'
                  ? 'Job cache rebuilt'
                  : 'Job cache rebuilt. The sponsor register could not be refreshed yet.',
            });
            return;
          }
          if (target === 'data') {
            const result = await window.workspace.resetApplicationData();
            saveSeq.current += 1;
            setSettings(result.settings);
            applyTheme(result.settings.theme);
            applyDensity(result.settings.density);
            await window.system.setLaunchAtLogin(result.settings.launchAtLogin).catch(() => {});
            setCvDocuments([]);
          } else {
            await resetSettings();
          }
          flash({
            kind: 'saved',
            message: target === 'data' ? 'Application data reset' : 'Settings reset',
          });
        } catch (err) {
          flash(failure(err, target === 'data' ? 'Could not delete your data.' : 'Could not reset your settings.'));
        } finally {
          setBusy(false);
        }
      })();
    },
    [resetSettings, flash],
  );

  if (loadError) {
    return (
      <div>
        <ErrorBanner className="mt-4" details={loadError}>
          Could not load your settings.
        </ErrorBanner>
      </div>
    );
  }

  if (!settings) {
    return (
      <div>
        <PageLoading label="Loading settings…" />
      </div>
    );
  }

  const disabled = busy;

  return (
    <div className="max-w-3xl">
      <Tabs
        label="Settings sections"
        idPrefix="settings"
        className="tabs tabs-box w-fit"
        value={activeTab}
        onChange={setActiveTab}
        tabs={SETTINGS_TABS}
      />

      <TabPanel idPrefix="settings" id={activeTab}>
      {activeTab === 'general' && (
        <>
          {onOpenSetup && (
            <SettingsSection title="Setup">
              <SettingsRow label="Finish setup" description="CV, AI tool and company list.">
                <button type="button" className="btn btn-outline btn-sm" onClick={onOpenSetup}>
                  Finish setup
                </button>
              </SettingsRow>
            </SettingsSection>
          )}
          <SettingsSection title="Startup">
            <SettingsRow
              label="Launch at login"
              description="Starts the app when you sign in to this computer."
            >
              <ToggleSwitch
                label="Launch at login"
                checked={settings.launchAtLogin}
                disabled={disabled}
                onChange={changeLaunchAtLogin}
              />
            </SettingsRow>
            <SettingsRow
              label="Keep running in the background when closed"
              description="Closing the window keeps the app running in the tray."
            >
              <ToggleSwitch
                label="Keep running in the background when closed"
                checked={settings.minimizeToTrayOnClose}
                disabled={disabled}
                onChange={(minimizeToTrayOnClose) => changeField({ minimizeToTrayOnClose })}
              />
            </SettingsRow>
            <SettingsRow
              label="Automatically check for new vacancies while running in the background"
              description="Looks for new jobs while the app is in the tray. Needs the setting above."
            >
              <ToggleSwitch
                label="Automatically check for new vacancies while running in the background"
                checked={settings.autoScanEnabled}
                disabled={!settings.minimizeToTrayOnClose || disabled}
                onChange={(autoScanEnabled) => changeField({ autoScanEnabled })}
              />
            </SettingsRow>
            <SettingsRow label="Start page" description="The page shown when the app opens." htmlFor="setting-start-page">
              <SettingsSelect
                id="setting-start-page"
                value={settings.startPage}
                options={START_PAGE_OPTIONS}
                disabled={disabled}
                onChange={(startPage) => changeField({ startPage })}
              />
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="Appearance">
            <SettingsRow label="Theme" description="System matches your computer's light or dark mode.">
              <SegmentedControl
                label="Theme"
                value={settings.theme}
                options={THEME_OPTIONS}
                disabled={disabled}
                onChange={(theme) => changeField({ theme })}
              />
            </SettingsRow>
            <SettingsRow label="Density" description="Compact tightens list and table rows to fit more on screen.">
              <SegmentedControl
                label="Density"
                value={settings.density}
                options={DENSITY_OPTIONS}
                disabled={disabled}
                onChange={(density) => changeField({ density })}
              />
            </SettingsRow>
            <SettingsRow
              label="Sidebar on launch"
              description="Whether the sidebar starts expanded, collapsed, or however you last left it."
              htmlFor="setting-sidebar-start"
            >
              <SettingsSelect
                id="setting-sidebar-start"
                value={settings.sidebarStart}
                options={SIDEBAR_START_OPTIONS}
                disabled={disabled}
                onChange={(sidebarStart) => changeField({ sidebarStart })}
              />
            </SettingsRow>
          </SettingsSection>

          <SupportSection />
        </>
      )}

      {activeTab === 'search' && (
        <>
          <SettingsSection title="Default search location">
            <SettingsRow
              label="Default search location"
              description="Which country a new search's Country filter starts pre-set to."
              htmlFor="setting-default-location"
            >
              <SettingsSelect
                id="setting-default-location"
                value={settings.defaultLocation || 'all'}
                options={DEFAULT_LOCATION_OPTIONS}
                disabled={disabled}
                onChange={(value) => changeField({ defaultLocation: value === 'all' ? '' : value })}
              />
            </SettingsRow>
          </SettingsSection>

          <SearchProfileSection
            disabled={disabled}
            focusOnOpen={focusSection === 'search-profile'}
            onSaved={() => flash({ kind: 'saved', message: 'Saved' })}
            onSaveError={(message, details) => flash({ kind: 'error', message, ...(details ? { details } : {}) })}
          />

          <AtsRosterSection
            disabled={disabled}
            autoDownload={settings.autoRosterDownloadEnabled}
            onAutoDownloadChange={(autoRosterDownloadEnabled) => changeField({ autoRosterDownloadEnabled })}
            onRefreshed={(result) =>
              flash({ kind: 'saved', message: `Company list updated (${result.totalEntries.toLocaleString()} companies)` })
            }
            onRefreshError={(message, details) => flash({ kind: 'error', message, ...(details ? { details } : {}) })}
          />

          <SourceScoutSection
            enabled={settings.autoSourceScoutEnabled}
            disabled={disabled}
            onEnabledChange={(autoSourceScoutEnabled) => changeField({ autoSourceScoutEnabled })}
          />
        </>
      )}

      {activeTab === 'workspace' && (
        <>
          <SettingsSection title="Documents">
            <SettingsRow
              label="Default CV"
              description={
                cvListError
                  ? 'Could not load your CVs.'
                  : cvDocuments.length === 0
                    ? 'No CVs in the library yet. Add one on the CV page first.'
                    : 'Pre-selected CV for gap analysis and letter generation.'
              }
              htmlFor="setting-default-cv"
            >
              <SettingsSelect
                id="setting-default-cv"
                // The same default the CV page and Search use: the library's own flag (#554).
                value={cvDocuments.find((cv) => cv.isDefault)?.id ?? ''}
                options={[
                  ...(cvDocuments.some((cv) => cv.isDefault) ? [] : [{ value: '', label: 'No default' }]),
                  ...cvDocuments.map((cv) => ({ value: cv.id, label: cv.name })),
                ]}
                disabled={disabled || Boolean(cvListError) || cvDocuments.length === 0}
                onChange={(next) => {
                  if (next === '') return;
                  void window.workspace
                    .setDefaultCvDocument(next)
                    .then((refreshed) => {
                      setCvDocuments(refreshed);
                      const promoted = refreshed.find((cv) => cv.id === next);
                      return promoted ? tryFillSearchProfileFromCv(promoted) : ({ filled: false } as SearchProfileFillOutcome);
                    })
                    .then((outcome) => {
                      if (outcome.error) {
                        flash({ kind: 'error', message: `Default CV saved, but the search profile was not filled: ${outcome.error}` });
                      } else {
                        flash({ kind: 'saved', message: outcome.filled ? SEARCH_PROFILE_FILLED_STATUS : 'Default CV saved' });
                      }
                    })
                    .catch((err: unknown) => flash({ kind: 'error', message: describeError(err, 'could not set the default CV') }));
                }}
              />
            </SettingsRow>
            <SettingsRow label="Default letter type" htmlFor="setting-letter-type">
              <SettingsSelect
                id="setting-letter-type"
                value={settings.defaultLetterType}
                options={LETTER_TYPE_OPTIONS}
                disabled={disabled}
                onChange={(defaultLetterType) => changeField({ defaultLetterType })}
              />
            </SettingsRow>
            <SettingsRow label="Default letter tone" htmlFor="setting-letter-tone">
              <SettingsSelect
                id="setting-letter-tone"
                value={settings.defaultLetterTone}
                options={LETTER_TONE_OPTIONS}
                disabled={disabled}
                onChange={(defaultLetterTone) => changeField({ defaultLetterTone })}
              />
            </SettingsRow>
            <SettingsRow label="Default letter length" htmlFor="setting-letter-length">
              <SettingsSelect
                id="setting-letter-length"
                value={settings.defaultLetterLength}
                options={LETTER_LENGTH_OPTIONS}
                disabled={disabled}
                onChange={(defaultLetterLength) => changeField({ defaultLetterLength })}
              />
            </SettingsRow>
          </SettingsSection>

          <SettingsSection title="Applications">
            <SettingsRow
              label="Default status for new applications"
              htmlFor="setting-application-status"
            >
              <SettingsSelect
                id="setting-application-status"
                value={settings.defaultApplicationStatus}
                options={APPLICATION_STATUS_OPTIONS}
                disabled={disabled}
                onChange={(defaultApplicationStatus) => changeField({ defaultApplicationStatus })}
              />
            </SettingsRow>
            <SettingsRow
              label="Confirm before deleting"
              description="Ask for confirmation before permanently deleting an application."
            >
              <ToggleSwitch
                label="Confirm before deleting"
                checked={settings.confirmApplicationDelete}
                disabled={disabled}
                onChange={(confirmApplicationDelete) => changeField({ confirmApplicationDelete })}
              />
            </SettingsRow>
            <SettingsRow
              label="Auto-archive rejected applications"
              description="Move applications to the archive automatically when their status becomes Rejected."
            >
              <ToggleSwitch
                label="Auto-archive rejected applications"
                checked={settings.autoArchiveRejected}
                disabled={disabled}
                onChange={(autoArchiveRejected) => changeField({ autoArchiveRejected })}
              />
            </SettingsRow>
          </SettingsSection>

          <SavedAnswersSection />
        </>
      )}

      {activeTab === 'advanced' && (
        <>
          <SettingsSection title="AI runtime">
            <SettingsRow label="AI tool" description={PROVIDER_LABEL[settings.defaultProvider]}>
              <button type="button" className="btn btn-sm btn-outline" onClick={onNavigateToRuntime}>
                Manage
              </button>
            </SettingsRow>
          </SettingsSection>

          <McpEndpointSection
            settings={settings}
            cvDocuments={cvDocuments}
            disabled={disabled}
            onToggled={changeField}
          />

          <AboutSection
            {...(currentPage ? { currentPage } : {})}
            {...(previousPage ? { previousPage } : {})}
          />
        </>
      )}

      {activeTab === 'data' && (
        <DataManagement
          busy={busy}
          onRequestRebuildCache={() => setConfirmTarget('cache')}
          onRequestResetSettings={() => setConfirmTarget('settings')}
          onRequestResetData={() => setConfirmTarget('data')}
        />
      )}
      </TabPanel>

      {confirmTarget === 'settings' && (
        <ConfirmDialog
          title="Reset settings?"
          message="Every setting returns to its default. Your saved jobs, applications, CVs and letters stay."
          confirmLabel="Reset settings"
          onConfirm={() => runReset('settings')}
          onCancel={() => setConfirmTarget(null)}
        />
      )}
      {confirmTarget === 'cache' && (
        <ConfirmDialog
          title="Rebuild the job cache?"
          message="The current downloaded job cache is set aside and a fresh one is built, so downloaded vacancies and sponsor data are fetched again. Your CVs, applications and letters are kept."
          confirmLabel="Rebuild job cache"
          onConfirm={() => runReset('cache')}
          onCancel={() => setConfirmTarget(null)}
        />
      )}
      {confirmTarget === 'data' && (
        <ConfirmDialog
          title="Delete my data?"
          message={
            <>
              <p>This permanently deletes:</p>
              <ul className="mt-1 list-disc pl-5">
                <li>your saved jobs</li>
                <li>your applications and application history</li>
                <li>your CVs and tailoring cases</li>
                <li>your letters</li>
                <li>generated application files</li>
                <li>your saved answers and search profile</li>
              </ul>
              <p className="mt-2">Settings go back to their defaults. Your downloaded job cache is kept.</p>
              <p className="mt-2 font-medium">There is no backup. Deleted CVs, applications and letters cannot be recovered.</p>
            </>
          }
          confirmLabel="Delete my data"
          requireText="DELETE"
          onConfirm={() => runReset('data')}
          onCancel={() => setConfirmTarget(null)}
        />
      )}

      {status && (
        <div className="toast toast-end z-50">
          {status.kind === 'saved' ? (
            <div role="status" className="alert alert-success alert-soft py-2 text-sm">
              {status.message}
            </div>
          ) : (
            <div role="alert" className="alert alert-error py-2 text-sm">
              <div className="min-w-0">
                <span>{status.message}</span>
                {status.details && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs font-medium">Details</summary>
                    <pre className="mt-1 max-h-40 max-w-xs overflow-auto text-xs break-words whitespace-pre-wrap">{status.details}</pre>
                  </details>
                )}
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                aria-label="Dismiss error"
                onClick={() => setStatus(null)}
              >
                Close
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
