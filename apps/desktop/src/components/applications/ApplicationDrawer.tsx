import { useState } from 'react';
import type {
  ApplicationInput,
  ApplicationRecord,
  ApplicationStatus,
  CvDocumentRecord,
  LetterRecord,
  SavedJobRecord,
} from '../../window.js';
import { APPLICATION_STATUS_LABEL, APPLICATION_STATUS_ORDER, toDateInputValue } from './application-status.js';

interface DraftState {
  savedJobId: string;
  role: string;
  company: string;
  location: string;
  status: ApplicationStatus;
  appliedAt: string;
  nextStep: string;
  contact: string;
  cvId: string;
  letterId: string;
  notes: string;
}

function draftFromRecord(record: ApplicationRecord | null): DraftState {
  if (!record) {
    return {
      savedJobId: '',
      role: '',
      company: '',
      location: '',
      status: 'preparing',
      appliedAt: '',
      nextStep: '',
      contact: '',
      cvId: '',
      letterId: '',
      notes: '',
    };
  }
  return {
    savedJobId: record.savedJobId ?? '',
    role: record.role,
    company: record.company,
    location: record.location,
    status: record.status,
    appliedAt: toDateInputValue(record.appliedAt),
    nextStep: record.nextStep,
    contact: record.contact,
    cvId: record.cvId ?? '',
    letterId: record.letterId ?? '',
    notes: record.notes,
  };
}

export interface ApplicationDrawerProps {
  mode: 'create' | 'edit';
  record: ApplicationRecord | null;
  savedJobs: readonly SavedJobRecord[];
  cvDocuments: readonly CvDocumentRecord[];
  letters: readonly LetterRecord[];
  onCancel: () => void;
  /** Rejecting shows the thrown error's message inline; resolving closes the drawer. */
  onSubmit: (input: ApplicationInput) => Promise<void>;
}

/**
 * Add/edit drawer for an application, docked to the right edge: daisyUI's `modal-end` variant
 * gives us that layout plus a themed scrim for free, so nothing here hardcodes an overlay color.
 * Field set mirrors the design reference's `drawerApp` block exactly (see
 * design-reference/export-src.html lines ~815-834): everything except the linked-record dropdowns,
 * which pull their options from the lists the parent already fetched via the workspace bridge.
 */
export function ApplicationDrawer({
  mode,
  record,
  savedJobs,
  cvDocuments,
  letters,
  onCancel,
  onSubmit,
}: ApplicationDrawerProps) {
  const [draft, setDraft] = useState<DraftState>(() => draftFromRecord(record));
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  function update<K extends keyof DraftState>(key: K, value: DraftState[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    const role = draft.role.trim();
    const company = draft.company.trim();
    if (!role || !company) {
      setError('Role and company are required.');
      return;
    }

    const input: ApplicationInput = {
      role,
      company,
      location: draft.location,
      savedJobId: draft.savedJobId === '' ? null : draft.savedJobId,
      status: draft.status,
      appliedAt: draft.appliedAt === '' ? null : draft.appliedAt,
      nextStep: draft.nextStep,
      contact: draft.contact,
      cvId: draft.cvId === '' ? null : draft.cvId,
      letterId: draft.letterId === '' ? null : draft.letterId,
      notes: draft.notes,
    };

    setSubmitting(true);
    setError(undefined);
    try {
      await onSubmit(input);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to save application');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal modal-open modal-end" role="dialog" aria-modal="true">
      <div className="modal-box flex max-w-md flex-col rounded-none p-0">
        <div className="flex items-center justify-between border-b border-base-300 px-5 py-3.5">
          <h2 className="text-sm font-semibold">{mode === 'create' ? 'New application' : 'Edit application'}</h2>
          <button
            type="button"
            aria-label="Close"
            className="btn btn-ghost btn-sm btn-circle"
            onClick={onCancel}
            disabled={submitting}
          >
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
              Link saved job
            </span>
            <select
              className="select w-full"
              value={draft.savedJobId}
              onChange={(e) => update('savedJobId', e.target.value)}
            >
              <option value="">None (manual entry)</option>
              {savedJobs.map((job) => (
                <option key={job.id} value={job.id}>
                  {job.role}, {job.company}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
              Role *
            </span>
            <input
              className="input w-full"
              value={draft.role}
              onChange={(e) => update('role', e.target.value)}
              disabled={submitting}
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
              Company *
            </span>
            <input
              className="input w-full"
              value={draft.company}
              onChange={(e) => update('company', e.target.value)}
              disabled={submitting}
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
              Location
            </span>
            <input
              className="input w-full"
              value={draft.location}
              onChange={(e) => update('location', e.target.value)}
              disabled={submitting}
            />
          </label>

          <div className="grid grid-cols-2 gap-2.5">
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
                Status
              </span>
              <select
                className="select w-full"
                value={draft.status}
                onChange={(e) => update('status', e.target.value as ApplicationStatus)}
                disabled={submitting}
              >
                {APPLICATION_STATUS_ORDER.map((status) => (
                  <option key={status} value={status}>
                    {APPLICATION_STATUS_LABEL[status]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
                Applied date
              </span>
              <input
                className="input w-full"
                type="date"
                value={draft.appliedAt}
                onChange={(e) => update('appliedAt', e.target.value)}
                disabled={submitting}
              />
            </label>
          </div>

          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
              Next step
            </span>
            <input
              className="input w-full"
              value={draft.nextStep}
              onChange={(e) => update('nextStep', e.target.value)}
              placeholder="e.g. Technical interview · 2 Sep"
              disabled={submitting}
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
              Contact person
            </span>
            <input
              className="input w-full"
              value={draft.contact}
              onChange={(e) => update('contact', e.target.value)}
              disabled={submitting}
            />
          </label>

          <div className="grid grid-cols-2 gap-2.5">
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
                CV
              </span>
              <select className="select w-full" value={draft.cvId} onChange={(e) => update('cvId', e.target.value)}>
                <option value="">None</option>
                {cvDocuments.map((cv) => (
                  <option key={cv.id} value={cv.id}>
                    {cv.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
                Letter
              </span>
              <select
                className="select w-full"
                value={draft.letterId}
                onChange={(e) => update('letterId', e.target.value)}
              >
                <option value="">None</option>
                {letters.map((letter) => (
                  <option key={letter.id} value={letter.id}>
                    {letter.title}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-base-content/60">
              Notes
            </span>
            <textarea
              className="textarea w-full"
              rows={3}
              value={draft.notes}
              onChange={(e) => update('notes', e.target.value)}
              disabled={submitting}
            />
          </label>

          {error && <p className="text-sm text-error">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-base-300 px-5 py-3.5">
          <button type="button" className="btn btn-outline" onClick={onCancel} disabled={submitting}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={submitting}>
            {mode === 'create' ? 'Create application' : 'Save changes'}
          </button>
        </div>
      </div>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={onCancel} disabled={submitting} />
    </div>
  );
}
