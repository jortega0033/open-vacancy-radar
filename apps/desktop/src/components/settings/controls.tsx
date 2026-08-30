import type { ReactNode } from 'react';

/**
 * The three layout/control primitives of the settings page, matching the prototype's suggested
 * SettingsSection / SettingsRow / ToggleSwitch breakdown. Purely presentational — every save
 * decision stays in SettingsPage, so a row never knows (or lies about) whether a change landed.
 */

export interface SettingsSectionProps {
  title: string;
  children: ReactNode;
}

export function SettingsSection({ title, children }: SettingsSectionProps) {
  return (
    <section className="mt-8 first:mt-0">
      <h2 className="border-b border-base-300 pb-2 text-xs font-semibold uppercase tracking-wide text-base-content/60">
        {title}
      </h2>
      {children}
    </section>
  );
}

export interface SettingsRowProps {
  label: string;
  /** Secondary line under the label — what the setting actually affects. */
  description?: ReactNode;
  /** Id of the row's form control; when present the label is a real <label> for it. */
  htmlFor?: string;
  children?: ReactNode;
}

export function SettingsRow({ label, description, htmlFor, children }: SettingsRowProps) {
  return (
    <div className="ovr-row flex items-center justify-between gap-4 border-b border-base-300">
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="block text-sm font-medium">
            {label}
          </label>
        ) : (
          <div className="text-sm font-medium">{label}</div>
        )}
        {description && <div className="mt-0.5 text-xs text-base-content/60">{description}</div>}
      </div>
      {children && <div className="flex-none">{children}</div>}
    </div>
  );
}

export interface ToggleSwitchProps {
  /** Accessible name — the row label repeats it visually, this carries it for the control. */
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}

export function ToggleSwitch({ label, checked, disabled, onChange }: ToggleSwitchProps) {
  return (
    <input
      type="checkbox"
      role="switch"
      className="toggle"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.currentTarget.checked)}
    />
  );
}
