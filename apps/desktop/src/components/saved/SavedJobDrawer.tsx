import { useState, type FormEvent } from 'react';
import type { Market, SavedJobInput, SavedJobRecord, SavedJobStatus } from '../../window.js';
import { SAVED_JOB_STATUSES, SAVED_JOB_STATUS_LABEL } from './saved-job-status.js';

export interface SavedJobDrawerProps {
  /** Present in edit mode, `undefined` for "add a new saved job". */
  job?: SavedJobRecord;
  onSave: (input: SavedJobInput) => void;
  onClose: () => void;
  /** True while the parent's create/update call against `window.workspace` is in flight. */
  saving?: boolean;
  /** Surfaces a bridge-level failure (e.g. the IPC call rejected) below the form actions. */
  error?: string;
}

interface FormState {
  role: string;
  company: string;
  market: Market;
  location: string;
  salary: string;
  arrangement: string;
  sourceUrl: string;
  verification: string;
  status: SavedJobStatus;
  notes: string;
}

function toFormState(job: SavedJobRecord | undefined): FormState {
  return {
    role: job?.role ?? '',
    company: job?.company ?? '',
    market: job?.market ?? 'worldwide',
    location: job?.location ?? '',
    salary: job?.salary ?? '',
    arrangement: job?.arrangement ?? '',
    sourceUrl: job?.sourceUrl ?? '',
    verification: job?.verification ?? '',
    status: job?.status ?? 'considering',
    notes: job?.notes ?? '',
  };
}

/** Empty string on an optional free-text field means "not set": send `null`, not `''`. */
function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Right-side add/edit drawer for a saved job, per the prototype's `EntityEditorDrawer`
 * (`export-src.html` Saved Jobs row "Edit" action / "Add job manually" button). A plain fixed
 * panel with a Tailwind slide-in transition. No drawer library is needed for one form.
 *
 * Mounted only while a drawer is open (see `SavedJobsPage`), keyed by the job id so switching
 * between "add" and "edit" (or between two different rows) always starts from a fresh form
 * instead of carrying over stale field values.
 */
export function SavedJobDrawer({ job, onSave, onClose, saving, error }: SavedJobDrawerProps) {
  const [form, setForm] = useState<FormState>(() => toFormState(job));
  const [validationError, setValidationError] = useState<string>();

  const isEdit = job != null;

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (form.role.trim() === '' || form.company.trim() === '') {
      setValidationError('Role and company are required');
      return;
    }
    setValidationError(undefined);
    onSave({
      role: form.role.trim(),
      company: form.company.trim(),
      market: form.market,
      location: form.location.trim(),
      salary: blankToNull(form.salary),
      arrangement: blankToNull(form.arrangement),
      sourceUrl: blankToNull(form.sourceUrl),
      verification: blankToNull(form.verification),
      status: form.status,
      notes: form.notes,
    });
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="presentation">
      <button
        type="button"
        className="absolute inset-0 bg-black/40"
        aria-label="Close drawer"
        onClick={onClose}
      />
      <div
        className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-base-300 bg-base-100 p-5 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? 'Edit saved job' : 'Add saved job'}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">{isEdit ? 'Edit saved job' : 'Add job manually'}</h2>
          <button className="btn btn-ghost btn-sm" type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <form className="mt-4 flex flex-1 flex-col gap-3" onSubmit={handleSubmit}>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Role</span>
            <input
              className="input w-full"
              type="text"
              value={form.role}
              onChange={(e) => set('role', e.target.value)}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Company</span>
            <input
              className="input w-full"
              type="text"
              value={form.company}
              onChange={(e) => set('company', e.target.value)}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Market</span>
            <select
              className="select w-full"
              value={form.market}
              onChange={(e) => set('market', e.target.value as Market)}
            >
              <option value="netherlands">Netherlands</option>
              <option value="worldwide">Worldwide</option>
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Location</span>
            <input
              className="input w-full"
              type="text"
              value={form.location}
              onChange={(e) => set('location', e.target.value)}
              placeholder="e.g. Amsterdam, Remote"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Salary</span>
            <input
              className="input w-full"
              type="text"
              value={form.salary}
              onChange={(e) => set('salary', e.target.value)}
              placeholder="e.g. EUR 6,500/month"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Arrangement</span>
            <input
              className="input w-full"
              type="text"
              value={form.arrangement}
              onChange={(e) => set('arrangement', e.target.value)}
              placeholder="e.g. Remote, Hybrid, On-site"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Source URL</span>
            <input
              className="input w-full"
              type="url"
              value={form.sourceUrl}
              onChange={(e) => set('sourceUrl', e.target.value)}
              placeholder="https://…"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Verification</span>
            <input
              className="input w-full"
              type="text"
              value={form.verification}
              onChange={(e) => set('verification', e.target.value)}
              placeholder="e.g. Recognised sponsor"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Status</span>
            <select
              className="select w-full"
              value={form.status}
              onChange={(e) => set('status', e.target.value as SavedJobStatus)}
            >
              {SAVED_JOB_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {SAVED_JOB_STATUS_LABEL[status]}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Notes</span>
            <textarea
              className="textarea w-full"
              rows={4}
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
            />
          </label>

          {validationError && (
            <p className="text-sm text-error" role="alert">
              {validationError}
            </p>
          )}
          {error && (
            <p className="text-sm text-error" role="alert">
              {error}
            </p>
          )}

          <div className="mt-auto flex justify-end gap-2 pt-4">
            <button className="btn btn-sm" type="button" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button className="btn btn-primary btn-sm" type="submit" disabled={saving}>
              {saving && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
