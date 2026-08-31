import type { ReactNode } from 'react';

/**
 * The three layout/control primitives of the settings page, matching the prototype's suggested
 * SettingsSection / SettingsRow / ToggleSwitch breakdown. Purely presentational: every save
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
  /** Secondary line under the label: what the setting actually affects. */
  description?: ReactNode;
  /** Id of the row's form control; when present the label is a real <label> for it. */
  htmlFor?: string;
  children?: ReactNode;
}

export function SettingsRow({ label, description, htmlFor, children }: SettingsRowProps) {
  return (
    <div className="ovr-row flex items-start justify-between gap-4 border-b border-base-300">
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
      {/* `items-start` above keeps the control aligned to the label line rather than centered
          against the whole label+description block, which floats it too low once a description
          wraps to 2-3 lines; the top padding here re-centers it on that one line specifically. */}
      {children && <div className="flex-none pt-0.5">{children}</div>}
    </div>
  );
}

/** A lightweight heading for clustering related rows within one `SettingsSection`, one step
 * quieter than the section's own `<h2>` (no border, no ovr-row spacing) — reuses the same
 * caption style as `ProviderCard`'s "Capabilities" label and `RuntimePage`'s "Default runtime"
 * caption, so the visual language for "small uppercase group label" stays consistent app-wide. */
export function SettingsSubheading({ children }: { children: ReactNode }) {
  return (
    <h3 className="mt-5 mb-1 text-[11px] font-semibold tracking-wide text-base-content/60 uppercase">
      {children}
    </h3>
  );
}

export interface SegmentedControlProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  disabled?: boolean;
  onChange: (next: T) => void;
}

/** The prototype's button-group style for Theme/Density: a small, closed set of mutually
 * exclusive choices reads better as segmented buttons than as a dropdown. */
export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: SegmentedControlProps<T>) {
  return (
    <div className="join" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`btn btn-sm join-item ${option.value === value ? 'btn-active' : ''}`}
          aria-pressed={option.value === value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export interface ToggleSwitchProps {
  /** Accessible name: the row label repeats it visually, this carries it for the control. */
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
