import { useId, useState } from 'react';
import type {
  InterviewContextResult,
  InterviewContextView,
  InterviewPackageView,
} from '../../../electron/interview-context-types.js';
import { ErrorBanner, WarningBanner } from '../shell/index.js';
import {
  documentLabel,
  evidenceText,
  fingerprint,
  integrityNotes,
  kindText,
  packageTitle,
  provenanceBadge,
  provenanceText,
} from './interview-context-labels.js';

type Slot = 'cv' | 'letter';
type Choice = '' | 'prepared_file' | 'linked_document' | 'supplied_text' | 'unknown';

export interface SubmittedDocumentsPanelProps {
  applicationId: string;
  view: InterviewContextView;
  selectedId: string | null;
  onSelect(packageId: string): void;
  /** Called with the new view after the person saved what they sent. */
  onView(view: InterviewContextView): void;
  /** Whether the application links a CV / letter in the library right now. */
  linked: { cv: boolean; letter: boolean };
  /** True while something else in the drawer is busy (a run, another save). */
  disabled: boolean;
  onBusyChange(busy: boolean): void;
}

/**
 * #691: which documents went with this application, and the person's own statement about them. Shows
 * the recorded basis exactly (version, fingerprint, how it is known) and never upgrades it: a prepared
 * file stays "Prepared only" until the person says otherwise, and a file this app sent itself keeps
 * that record.
 */
export function SubmittedDocumentsPanel({
  applicationId,
  view,
  selectedId,
  onSelect,
  onView,
  linked,
  disabled,
  onBusyChange,
}: SubmittedDocumentsPanelProps) {
  const groupId = useId();
  const selected = view.packages.find((pkg) => pkg.id === selectedId) ?? null;

  return (
    <section aria-label="Documents you sent" className="rounded-box border border-base-300 p-3 text-sm">
      <h3 className="text-sm font-semibold">Documents you sent</h3>
      {view.packages.length === 0 && (
        <p className="mt-1 text-xs text-base-content/70">
          No documents for this application are on file. The prep pack uses your current CV and letter and says
          they may differ from what you sent.
        </p>
      )}

      {view.packages.length > 1 && (
        <fieldset className="mt-2">
          <legend className="text-xs text-base-content/70">Prepare from the documents of</legend>
          {view.packages.map((pkg) => (
            <label key={pkg.id} className="mt-1 flex items-start gap-2 text-xs">
              <input
                type="radio"
                aria-label={packageTitle(pkg)}
                className="radio radio-xs mt-0.5"
                name={`${groupId}-package`}
                checked={selectedId === pkg.id}
                disabled={disabled}
                onChange={() => onSelect(pkg.id)}
              />
              <span>{packageTitle(pkg)}</span>
            </label>
          ))}
        </fieldset>
      )}

      {view.selection === 'choose' && !selected && (
        <WarningBanner>
          More than one set of documents belongs to this application. Choose the one you are preparing for.
        </WarningBanner>
      )}

      {selected && (
        <PackageDetails
          key={selected.id}
          applicationId={applicationId}
          pkg={selected}
          onView={onView}
          linked={linked}
          disabled={disabled}
          onBusyChange={onBusyChange}
        />
      )}
    </section>
  );
}

function PackageDetails({
  applicationId,
  pkg,
  onView,
  linked,
  disabled,
  onBusyChange,
}: {
  applicationId: string;
  pkg: InterviewPackageView;
  onView(view: InterviewContextView): void;
  linked: { cv: boolean; letter: boolean };
  disabled: boolean;
  onBusyChange(busy: boolean): void;
}) {
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [choices, setChoices] = useState<Record<Slot, Choice>>({ cv: '', letter: '' });
  const [texts, setTexts] = useState<Record<Slot, string>>({ cv: '', letter: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const note = kindText(pkg);

  const lockedSlot = (slot: Slot): boolean => pkg.documents.some((doc) => doc.slot === slot && doc.provenance === 'receipt_backed');
  const pending = (['cv', 'letter'] as const).filter((slot) => choices[slot] !== '');
  const canSave =
    !disabled &&
    !saving &&
    pending.length > 0 &&
    pending.every((slot) => choices[slot] !== 'supplied_text' || texts[slot].trim().length > 0);

  async function save(): Promise<void> {
    if (!canSave) return;
    setSaving(true);
    onBusyChange(true);
    setError(undefined);
    setSaved(false);
    let result: InterviewContextResult;
    try {
      result = await window.interviewContext.stateDocuments({
        applicationId,
        packageId: pkg.id,
        expectedVersion: pkg.version,
        statements: pending.map((slot) => ({
          slot,
          choice: choices[slot] as Exclude<Choice, ''>,
          ...(choices[slot] === 'supplied_text' ? { text: texts[slot] } : {}),
        })),
      });
    } catch {
      result = { ok: false, code: 'failed', message: 'Something went wrong. Nothing was changed.', view: null };
    }
    setSaving(false);
    onBusyChange(false);
    if (result.ok) {
      setSaved(true);
      setOpen(false);
      setChoices({ cv: '', letter: '' });
      setTexts({ cv: '', letter: '' });
      onView(result.view);
      return;
    }
    setError(result.message);
    if (result.view) onView(result.view);
  }

  return (
    <div className="mt-2 space-y-2">
      <p className="text-xs" data-testid="submission-evidence">
        {evidenceText(pkg)}
      </p>
      {note && <p className="text-xs text-base-content/70">{note}</p>}
      {pkg.posting.matches === false && (
        <p className="text-xs text-base-content/70">
          The saved job description changed after it was recorded, so it is left out of the prep pack.
        </p>
      )}

      {pkg.documents.length === 0 ? (
        <p className="text-xs text-base-content/70">No documents are listed for this application yet.</p>
      ) : (
        <ul className="space-y-2">
          {pkg.documents.map((doc) => {
            const label = documentLabel(doc);
            const print = fingerprint(doc.contentHash ?? doc.artifactHash);
            return (
              <li key={doc.slot} className="rounded-box border border-base-300 p-2" data-testid={`sent-${doc.slot}`} data-provenance={doc.provenance}>
                <p className="flex flex-wrap items-center gap-1 text-xs">
                  <span className="font-medium">
                    {label.charAt(0).toUpperCase() + label.slice(1)}
                    {doc.version ? `, version ${doc.version}` : ''}
                  </span>
                  <span className="badge badge-sm badge-outline">{provenanceBadge(doc)}</span>
                </p>
                <p className="mt-1 text-xs">{provenanceText(doc)}</p>
                {print && <p className="mt-1 break-all text-xs text-base-content/70">Fingerprint {print}</p>}
                {integrityNotes(doc).map((line) => (
                  <p key={line} className="mt-1 text-xs text-base-content/70">
                    {line}
                  </p>
                ))}
              </li>
            );
          })}
        </ul>
      )}

      {saved && (
        <p role="status" className="text-xs font-medium">
          Saved. The earlier record is kept.
        </p>
      )}
      {error && <ErrorBanner>{error}</ErrorBanner>}

      {!open ? (
        <button type="button" className="btn btn-outline btn-xs" disabled={disabled} onClick={() => setOpen(true)}>
          Tell the app what you sent
        </button>
      ) : (
        <form
          aria-label="What you sent"
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {(['cv', 'letter'] as const).map((slot) => {
            const name = slot === 'cv' ? 'CV' : 'letter';
            const selectId = `${formId}-${slot}`;
            return (
              <div key={slot} className="space-y-1">
                <label htmlFor={selectId} className="text-xs font-medium">
                  {slot === 'cv' ? 'CV you sent' : 'Letter you sent'}
                </label>
                {lockedSlot(slot) ? (
                  <p className="text-xs text-base-content/70">This app sent this file itself, so its record stays as it is.</p>
                ) : (
                  <select
                    id={selectId}
                    className="select select-bordered select-xs w-full"
                    value={choices[slot]}
                    disabled={saving}
                    onChange={(event) => setChoices((current) => ({ ...current, [slot]: event.target.value as Choice }))}
                  >
                    <option value="">No change</option>
                    {pkg.heldSlots.includes(slot) && <option value="prepared_file">The {name} this app prepared</option>}
                    {linked[slot] && <option value="linked_document">My linked {name} as it reads now</option>}
                    <option value="supplied_text">I will paste the text I sent</option>
                    <option value="unknown">I do not know which version I sent</option>
                  </select>
                )}
                {choices[slot] === 'supplied_text' && (
                  <>
                    <label htmlFor={`${selectId}-text`} className="sr-only">
                      {slot === 'cv' ? 'Text of the CV you sent' : 'Text of the letter you sent'}
                    </label>
                    <textarea
                      id={`${selectId}-text`}
                      aria-label={slot === 'cv' ? 'Text of the CV you sent' : 'Text of the letter you sent'}
                      className="textarea textarea-bordered textarea-xs w-full"
                      rows={4}
                      maxLength={60_000}
                      value={texts[slot]}
                      disabled={saving}
                      onChange={(event) => setTexts((current) => ({ ...current, [slot]: event.target.value }))}
                    />
                  </>
                )}
              </div>
            );
          })}
          <p className="text-xs text-base-content/70">
            Saving adds a new record. The earlier one is kept, and nothing about your CV or your library changes.
          </p>
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary btn-xs" disabled={!canSave}>
              Save what you sent
            </button>
            <button type="button" className="btn btn-ghost btn-xs" disabled={saving} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
