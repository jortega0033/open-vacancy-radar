import { useId, useState, type FormEvent } from 'react';
import type { CandidateProfile } from '@open-vacancy-radar/vacancy-engine';
import { textToSkills } from '../cv-library/cv-profile.js';

export interface RoleQuickInputProps {
  /** One thin line, for the Search page's toolbar area. */
  compact?: boolean;
  onSaved: (profile: CandidateProfile) => void;
}

/**
 * The single question shown when nothing is set: "What role are you looking for?". It saves the
 * answer as the target role through the same `saveSearchProfile` call as the full form, marked as
 * added by the user. Nothing is pre-filled.
 */
export function RoleQuickInput({ compact = false, onSaved }: RoleQuickInputProps) {
  const inputId = useId();
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const roles = textToSkills(value);
    if (roles.length === 0 || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      onSaved(await window.vacancyRadar.saveSearchProfile({ targetRoles: roles, fieldSources: { targetRoles: 'user' } }));
      setValue('');
    } catch {
      setError('Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  }

  const size = compact ? 'input-xs' : 'input-sm';
  const buttonSize = compact ? 'btn-xs' : 'btn-sm';
  return (
    <form onSubmit={(event) => void submit(event)} className={compact ? 'flex flex-wrap items-center gap-2 text-xs' : 'flex flex-col gap-2 text-sm'}>
      <label id={`${inputId}-label`} htmlFor={inputId} className={compact ? 'text-base-content/70' : 'font-medium'}>
        What role are you looking for?
      </label>
      <div className="flex items-center gap-2">
        <input
          id={inputId}
          aria-labelledby={`${inputId}-label`}
          type="text"
          className={`input ${size} w-64`}
          value={value}
          disabled={saving}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
        <button type="submit" className={`btn btn-primary ${buttonSize}`} disabled={saving || textToSkills(value).length === 0}>
          Save
        </button>
      </div>
      {error && (
        <p role="alert" className="text-error">
          {error}
        </p>
      )}
    </form>
  );
}
