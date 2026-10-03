import { SettingsRow, SettingsSection } from './controls.js';

export interface DataManagementProps {
  /** True while a reset is running: both entry points disable so they cannot overlap. */
  busy: boolean;
  onRequestResetSettings: () => void;
  onRequestResetData: () => void;
}

/**
 * The data-management section: reset settings and reset application data. Export and import are
 * not shown until they work, since they need native save/open dialogs the bridge does not expose.
 */
export function DataManagement({ busy, onRequestResetSettings, onRequestResetData }: DataManagementProps) {
  return (
    <SettingsSection title="Data management">
      <p className="ovr-row border-b border-base-300 text-sm text-base-content/70">
        Your data stays on this computer. Sponsor checks use the public IND register.
      </p>

      <SettingsRow
        label="Reset settings"
        description="Puts every setting back to its default. Your saved jobs, applications, CVs and letters stay."
      >
        <button
          type="button"
          className="btn btn-sm btn-outline"
          disabled={busy}
          onClick={onRequestResetSettings}
        >
          Reset settings
        </button>
      </SettingsRow>

      <SettingsRow
        label="Reset application data"
        description="Delete your saved jobs, applications, CVs, letters and search profile. Public vacancy data is kept."
      >
        <button
          type="button"
          className="btn btn-sm btn-outline btn-error"
          disabled={busy}
          onClick={onRequestResetData}
        >
          Reset application data
        </button>
      </SettingsRow>
    </SettingsSection>
  );
}
