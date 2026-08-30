import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AppSettingsPatch,
  AppSettingsRecord,
  CvDocumentRecord,
} from '../../window.js';
import { PROVIDER_LABEL } from '../../provider-labels.js';
import { applyDensity, applyTheme } from '../../theme.js';
import { ConfirmDialog } from '../shell/index.js';
import { AboutSection } from './AboutSection.js';
import { SegmentedControl, SettingsRow, SettingsSection, ToggleSwitch } from './controls.js';
import { DataManagement } from './DataManagement.js';

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
  defaultMarket: 'netherlands',
  defaultLocation: '',
  sponsorOnlyDefault: true,
  indVerificationEnabled: true,
  defaultCvId: null,
  defaultLetterType: 'motivation_letter',
  defaultLetterTone: 'natural',
  defaultLetterLength: 'standard',
  defaultApplicationStatus: 'preparing',
  confirmApplicationDelete: true,
  autoArchiveRejected: false,
  defaultProvider: 'claude',
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

/** Exactly the two pipelines this app can search. Never a per-country list. */
const MARKET_OPTIONS = [
  { value: 'netherlands', label: 'Netherlands (IND sponsors)' },
  { value: 'worldwide', label: 'Worldwide remote' },
] as const;

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

type SaveStatus = { kind: 'saved'; message: string } | { kind: 'error'; message: string };

type ResetTarget = 'settings' | 'data';

function describeError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
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
  /** Rendered as the "AI runtime" section's "Manage in AI Runtime" button. Optional so the page
   * still works standalone (e.g. in isolation tests) without a real router behind it. */
  onNavigateToRuntime?: () => void;
}

export function SettingsPage({ onNavigateToRuntime }: SettingsPageProps = {}) {
  const [settings, setSettings] = useState<AppSettingsRecord | null>(null);
  const [loadError, setLoadError] = useState<string>();

  const [cvDocuments, setCvDocuments] = useState<CvDocumentRecord[]>([]);
  const [cvListError, setCvListError] = useState<string>();

  const [locationDraft, setLocationDraft] = useState('');

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
        setLocationDraft(loaded.defaultLocation);
      } catch (err) {
        if (!cancelled) setLoadError(describeError(err, 'could not load settings'));
      }
    })();
    void (async () => {
      try {
        const docs = await window.workspace.listCvDocuments();
        if (!cancelled) setCvDocuments(docs);
      } catch (err) {
        if (!cancelled) setCvListError(describeError(err, 'could not load the CV library'));
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
          setLocationDraft(updated.defaultLocation);
          flash({ kind: 'saved', message: 'Saved' });
        } catch (err) {
          if (seq !== saveSeq.current) return;
          setSettings(previous);
          setLocationDraft(previous.defaultLocation);
          applyTheme(previous.theme);
          applyDensity(previous.density);
          flash({ kind: 'error', message: describeError(err, 'could not save this setting') });
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
          flash({ kind: 'error', message: describeError(err, 'could not save this setting') });
          return;
        }
        if (seq === saveSeq.current) setSettings(updated);
        try {
          await window.system.setLaunchAtLogin(updated.launchAtLogin);
          if (seq === saveSeq.current) flash({ kind: 'saved', message: 'Saved' });
        } catch (err) {
          if (seq === saveSeq.current) {
            flash({
              kind: 'error',
              message: `Preference saved, but the system login item could not be updated: ${describeError(err, 'unknown error')}`,
            });
          }
        }
      })();
    },
    [settings, flash],
  );

  const commitLocation = useCallback(() => {
    if (!settings) return;
    const next = locationDraft.trim();
    if (next === settings.defaultLocation) {
      setLocationDraft(next);
      return;
    }
    changeField({ defaultLocation: next });
  }, [settings, locationDraft, changeField]);

  /** Restore every preference to its schema default. Data (jobs, applications, CVs, letters) stays. */
  const resetSettings = useCallback(async (): Promise<AppSettingsRecord> => {
    const updated = await window.workspace.updateSettings(SETTINGS_DEFAULTS);
    saveSeq.current += 1; // invalidate any in-flight per-field save
    setSettings(updated);
    setLocationDraft(updated.defaultLocation);
    applyTheme(updated.theme);
    applyDensity(updated.density);
    try {
      await window.system.setLaunchAtLogin(updated.launchAtLogin);
    } catch {
      // The preference row is already reset; the OS entry (if any) is cleaned up on next toggle.
    }
    return updated;
  }, []);

  /**
   * "Reset application data" runs entirely over the existing workspace IPC: list + delete each
   * entity, then restore default settings. Applications go first because they reference saved
   * jobs, CVs and letters. No bespoke "drop everything" channel exists, and none is needed.
   */
  const runReset = useCallback(
    (target: ResetTarget) => {
      setConfirmTarget(null);
      setBusy(true);
      void (async () => {
        try {
          if (target === 'data') {
            const applications = await window.workspace.listApplications('all');
            for (const application of applications) {
              await window.workspace.deleteApplication(application.id);
            }
            const savedJobs = await window.workspace.listSavedJobs();
            for (const job of savedJobs) {
              await window.workspace.deleteSavedJob(job.id);
            }
            const letters = await window.workspace.listLetters();
            for (const letter of letters) {
              await window.workspace.deleteLetter(letter.id);
            }
            const cvs = await window.workspace.listCvDocuments();
            for (const cv of cvs) {
              await window.workspace.deleteCvDocument(cv.id);
            }
            setCvDocuments([]);
          }
          await resetSettings();
          flash({
            kind: 'saved',
            message: target === 'data' ? 'Application data reset' : 'Settings reset',
          });
        } catch (err) {
          flash({
            kind: 'error',
            message: describeError(
              err,
              target === 'data' ? 'could not reset application data' : 'could not reset settings',
            ),
          });
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
        <h2 className="text-lg font-semibold">Settings</h2>
        <div className="alert alert-error mt-4">{loadError}</div>
      </div>
    );
  }

  if (!settings) {
    return (
      <div>
        <h2 className="text-lg font-semibold">Settings</h2>
        <div className="alert alert-info mt-4">Loading settings…</div>
      </div>
    );
  }

  const disabled = busy;

  return (
    <div className="max-w-3xl">
      <h2 className="text-lg font-semibold">Settings</h2>
      <p className="mt-1 text-sm text-base-content/60">
        Changes are saved automatically as you make them.
      </p>

      <SettingsSection title="General">
        <SettingsRow
          label="Launch at login"
          description="Start Open Vacancy Radar automatically when you sign in to this computer. The system entry is registered by installed builds; in development only the preference is stored."
        >
          <ToggleSwitch
            label="Launch at login"
            checked={settings.launchAtLogin}
            disabled={disabled}
            onChange={changeLaunchAtLogin}
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
        <SettingsRow label="Theme" description="System follows the operating system's light/dark preference, live.">
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

      <SettingsSection title="Search defaults">
        <SettingsRow
          label="Default market"
          description="Which of the two search pipelines a new search starts on."
          htmlFor="setting-default-market"
        >
          <SettingsSelect
            id="setting-default-market"
            value={settings.defaultMarket}
            options={MARKET_OPTIONS}
            disabled={disabled}
            onChange={(defaultMarket) => changeField({ defaultMarket })}
          />
        </SettingsRow>
        <SettingsRow
          label="Default location"
          description="Pre-filled location filter for new searches. Leave empty for no filter."
          htmlFor="setting-default-location"
        >
          <input
            id="setting-default-location"
            type="text"
            className="input input-sm w-56"
            placeholder="e.g. Amsterdam"
            value={locationDraft}
            disabled={disabled}
            onChange={(event) => setLocationDraft(event.currentTarget.value)}
            onBlur={commitLocation}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitLocation();
            }}
          />
        </SettingsRow>
        <SettingsRow
          label="Recognised sponsors only by default"
          description="Netherlands searches start with the IND recognised-sponsor filter switched on."
        >
          <ToggleSwitch
            label="Recognised sponsors only by default"
            checked={settings.sponsorOnlyDefault}
            disabled={disabled}
            onChange={(sponsorOnlyDefault) => changeField({ sponsorOnlyDefault })}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Market integrations">
        <SettingsRow
          label="Netherlands: IND recognised sponsor verification"
          description="Source: IND Public Register · checks employers of Netherlands vacancies."
        >
          <ToggleSwitch
            label="IND recognised sponsor verification"
            checked={settings.indVerificationEnabled}
            disabled={disabled}
            onChange={(indVerificationEnabled) => changeField({ indVerificationEnabled })}
          />
        </SettingsRow>
        <SettingsRow
          label="Netherlands job sources"
          description="Recruitee, Greenhouse, Teamtailor, SmartRecruiters, Lever and mapped company career sites."
        >
          <span className="badge badge-outline badge-sm">Configured</span>
        </SettingsRow>
        <p className="ovr-row border-b border-base-300 text-xs text-base-content/60">
          No market-specific employer verification is configured for Germany, Belgium, France, the
          United Kingdom or the United States. Vacancy search, CV matching, letters and application
          tracking still work for those markets.
        </p>
      </SettingsSection>

      <SettingsSection title="Documents">
        <SettingsRow
          label="Default CV"
          description={
            cvListError
              ? `The CV library could not be loaded: ${cvListError}`
              : cvDocuments.length === 0
                ? 'No CVs in the library yet. Add one on the CV page first.'
                : 'Pre-selected CV for gap analysis and letter generation.'
          }
          htmlFor="setting-default-cv"
        >
          <SettingsSelect
            id="setting-default-cv"
            value={settings.defaultCvId ?? ''}
            options={[
              { value: '', label: 'No default' },
              ...cvDocuments.map((cv) => ({ value: cv.id, label: cv.name })),
            ]}
            disabled={disabled || Boolean(cvListError) || cvDocuments.length === 0}
            onChange={(next) => changeField({ defaultCvId: next === '' ? null : next })}
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

      <SettingsSection title="AI runtime">
        <SettingsRow
          label="Runtime provider"
          description={`${PROVIDER_LABEL[settings.defaultProvider]} · CLI default model · AgentDock local runtime`}
        >
          <button type="button" className="btn btn-sm btn-outline" onClick={onNavigateToRuntime}>
            Manage in AI Runtime
          </button>
        </SettingsRow>
      </SettingsSection>

      <DataManagement
        busy={busy}
        onRequestResetSettings={() => setConfirmTarget('settings')}
        onRequestResetData={() => setConfirmTarget('data')}
      />

      <AboutSection />

      {confirmTarget === 'settings' && (
        <ConfirmDialog
          title="Reset settings?"
          message="Every preference on this page returns to its default. Saved jobs, applications, CVs and letters are not touched."
          confirmLabel="Reset settings"
          onConfirm={() => runReset('settings')}
          onCancel={() => setConfirmTarget(null)}
        />
      )}
      {confirmTarget === 'data' && (
        <ConfirmDialog
          title="Reset application data?"
          message="This permanently deletes every saved job, application, CV and letter, and restores default settings. This cannot be undone."
          confirmLabel="Delete everything"
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
              {status.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
