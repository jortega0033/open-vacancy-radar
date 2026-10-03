import { useState, type FormEvent } from 'react';
import { describeCvSourceGaps } from '../../../electron/workspace/cv-source-schema.js';
import type { CvDocumentRecord } from '../../window.js';
import { sha256Hex, sha256HexOfSource } from '../cv/content-hash.js';
import type { VacancyLead } from '../cv/index.js';
import { describeError } from '../cv/useAgentRun.js';
import { mintManualCaseKey } from '../cv/vacancy-key.js';
import { ErrorBanner } from '../shell/index.js';

export interface ManualCaseFormProps {
  /** The CVs the case can be started on, each shown with whether its source is ready for approval. */
  documents: readonly CvDocumentRecord[];
  /** Receives a vacancy with no search result behind it, and the CV the case was stored on (`null`
   * when the library has none, so nothing was stored). Its `caseKey` is minted here, once, so the
   * tailoring case it opens is its own record rather than a lookalike of a found vacancy. */
  onSubmit(vacancy: VacancyLead, cvId: string | null): void;
  onCancel(): void;
}

/** What the candidate is told about a CV before choosing it, from the same source checks that block approval. */
function describeReadiness(doc: CvDocumentRecord): string {
  if (!doc.source) return 'no source record yet';
  return describeCvSourceGaps(doc.source).length > 0 ? 'needs your review' : 'ready';
}

/**
 * "Tailor for a job" entry point (#419, step 2): role, company and the pasted job description are
 * required, the link is optional and is never fetched. Submitting creates no Saved Job and writes
 * nothing to Saved Job notes. It does store the case with its job description as the first revision,
 * on the chosen CV, so leaving the workspace straight away still lists it under Tailoring cases.
 */
export function ManualCaseForm({ documents, onSubmit, onCancel }: ManualCaseFormProps) {
  const [role, setRole] = useState('');
  const [company, setCompany] = useState('');
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string>();
  const [chosenCvId, setChosenCvId] = useState('');
  const [saving, setSaving] = useState(false);

  // The default CV unless the candidate picked another, whatever order the library loaded in.
  const cv = documents.find((doc) => doc.id === chosenCvId) ?? documents.find((doc) => doc.isDefault) ?? documents[0];

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmedRole = role.trim();
    const trimmedCompany = company.trim();
    const trimmedDescription = description.trim();
    if (!trimmedRole || !trimmedCompany || !trimmedDescription) {
      setError('Role, company and the job description are all required.');
      return;
    }
    const caseKey = mintManualCaseKey();
    const vacancy: VacancyLead = {
      title: trimmedRole,
      company: trimmedCompany,
      location: '',
      url: url.trim(),
      description: trimmedDescription,
      requirements: null,
      caseKey,
      jdOrigin: 'manual',
    };
    if (!cv) {
      onSubmit(vacancy, null);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      // The case and its first job description revision are written in one call. A failure keeps
      // the form and everything pasted into it, and pressing the button again retries.
      await window.workspace.createCvEvidenceOverlay({
        cvId: cv.id,
        vacancyKey: caseKey,
        caseTitle: vacancy.title,
        caseCompany: vacancy.company,
        sourceCvContentHash: await sha256HexOfSource(cv.source),
        jdSnapshot: trimmedDescription,
        jdSnapshotHash: await sha256Hex(trimmedDescription),
        origin: 'manual',
        jdOrigin: 'manual',
        jdUrl: vacancy.url,
      });
      onSubmit(vacancy, cv.id);
    } catch (err) {
      setError(describeError(err, 'could not save this tailoring case'));
      setSaving(false);
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => void handleSubmit(event)} aria-label="Tailor for a job">
      <p className="text-sm text-base-content/60">
        Paste the full job description. It is not added to your saved jobs. The link is optional.
      </p>
      <div className="block">
        <label htmlFor="manual-case-cv" className="mb-1 block text-sm font-medium">
          CV to tailor
        </label>
        {documents.length > 0 ? (
          <select
            id="manual-case-cv"
            className="select w-full"
            value={cv?.id ?? ''}
            onChange={(event) => setChosenCvId(event.currentTarget.value)}
            disabled={saving}
          >
            {documents.map((doc) => (
              <option key={doc.id} value={doc.id}>
                {doc.name} ({describeReadiness(doc)})
              </option>
            ))}
          </select>
        ) : (
          <p className="text-sm text-base-content/60">
            No CV in your library yet. The workspace opens without one, and the case is stored once you choose a CV there.
          </p>
        )}
        {cv && describeReadiness(cv) !== 'ready' && (
          <span className="mt-1 block text-xs text-base-content/60">
            This CV cannot be approved until its source is reviewed. You can start the case now and review the source later.
          </span>
        )}
      </div>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Role (required)</span>
        <input className="input w-full" value={role} onChange={(event) => setRole(event.currentTarget.value)} />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Company (required)</span>
        <input className="input w-full" value={company} onChange={(event) => setCompany(event.currentTarget.value)} />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Link to the posting (optional)</span>
        <input className="input w-full" value={url} onChange={(event) => setUrl(event.currentTarget.value)} />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Job description (required)</span>
        <textarea
          className="textarea min-h-48 w-full"
          value={description}
          onChange={(event) => setDescription(event.currentTarget.value)}
        />
      </label>
      {error && (
        <ErrorBanner>
          {error}
        </ErrorBanner>
      )}
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
          {saving && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
          Open tailoring workspace
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
