import { SettingsRow, SettingsSection } from './controls.js';

export interface DataManagementProps {
  /** True while a reset is running: every entry point disables so they cannot overlap. */
  busy: boolean;
  onRequestRebuildCache: () => void;
  onRequestResetSettings: () => void;
  onRequestResetData: () => void;
}

/**
 * The Data tab: the job cache first, then settings, then the one deletion that has no way back.
 * The cache and the personal data are separate sections on purpose (#442): somebody troubleshooting
 * a broken scan reaches the harmless action first and never has to pass the destructive one.
 *
 * Export and import are not shown until they work, since they need native save/open dialogs the
 * bridge does not expose, which is also why the deletion row says there is no backup.
 */
export function DataManagement({ busy, onRequestRebuildCache, onRequestResetSettings, onRequestResetData }: DataManagementProps) {
  return (
    <>
      <SettingsSection title="Job cache">
        <p className="ovr-row border-b border-base-300 text-sm text-base-content/70">
          Your data stays on this computer. Sponsor checks use the public IND register.
        </p>
        <SettingsRow
          label="Rebuild job cache"
          description="Sets aside the current downloaded job cache and builds a fresh one. Your CVs, applications and letters are kept. Downloaded vacancies and sponsor data are fetched again."
        >
          <button type="button" className="btn btn-sm btn-outline" disabled={busy} onClick={onRequestRebuildCache}>
            Rebuild job cache
          </button>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Your data">
        <SettingsRow
          label="Reset settings"
          description="Puts every setting back to its default. Your saved jobs, applications, CVs and letters stay."
        >
          <button type="button" className="btn btn-sm btn-outline" disabled={busy} onClick={onRequestResetSettings}>
            Reset settings
          </button>
        </SettingsRow>

        <SettingsRow
          label="Delete my data"
          description="Permanently deletes your saved jobs, applications, CVs, letters, generated files, saved answers and search profile. There is no backup. Deleted CVs, applications and letters cannot be recovered."
        >
          <button type="button" className="btn btn-sm btn-outline btn-error" disabled={busy} onClick={onRequestResetData}>
            Delete my data
          </button>
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
