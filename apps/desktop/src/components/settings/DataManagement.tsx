import { SettingsRow, SettingsSection } from './controls.js';

export interface DataManagementProps {
  /** True while a reset is running. Both entry points are disabled so they cannot overlap. */
  busy: boolean;
  onRequestResetSettings: () => void;
  onRequestResetData: () => void;
}

/**
 * The data-management section. Two of the prototype's actions are available (reset settings,
 * reset application data; both run entirely over the existing workspace IPC); export/import are
 * shown disabled with an explanation, because doing them properly needs native save/open dialogs
 * that the fixed-capability bridge does not expose yet. Per the page's one rule, a control either
 * works or visibly says it does not.
 */
export function DataManagement({ busy, onRequestResetSettings, onRequestResetData }: DataManagementProps) {
  return (
    <SettingsSection title="Data management">
      <p className="ovr-row border-b border-base-300 text-sm text-base-content/70">
        Saved jobs, applications, CVs, letters and settings are stored locally on this computer.
        Sponsor checks query the public IND register. There is no cloud sync and no account.
      </p>

      <SettingsRow
        label="Export / import"
        description={
          <>
            <span className="badge badge-ghost badge-sm mr-1.5 align-middle">Not yet available</span>
            This build cannot choose backup files yet, so export and import are disabled.
          </>
        }
      >
        <div className="flex gap-2">
          <button type="button" className="btn btn-sm btn-outline" disabled>
            Export data (JSON)
          </button>
          <button type="button" className="btn btn-sm btn-outline" disabled>
            Import data
          </button>
        </div>
      </SettingsRow>

      <SettingsRow
        label="Reset settings"
        description="Restore every preference on this page to its default. Saved jobs, applications, CVs and letters are not touched."
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
        description="Permanently delete every saved job, application, CV and letter, and restore default settings."
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
