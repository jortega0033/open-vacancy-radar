import { useState, type FormEvent } from 'react';
import type { VacancyLead } from '../cv/index.js';
import { mintManualCaseKey } from '../cv/vacancy-key.js';
import { ErrorBanner } from '../shell/index.js';

export interface ManualCaseFormProps {
  /** Receives a vacancy with no search result behind it. Its `caseKey` is minted here, once, so the
   * tailoring case it opens is its own record rather than a lookalike of a found vacancy. */
  onSubmit(vacancy: VacancyLead): void;
  onCancel(): void;
}

/**
 * "Tailor for a job" entry point (#419, step 2): role, company and the pasted job description are
 * required, the link is optional and is never fetched. Submitting creates no Saved Job and writes
 * nothing to Saved Job notes. The JD only reaches the database when the candidate saves it from the
 * workspace this form opens.
 */
export function ManualCaseForm({ onSubmit, onCancel }: ManualCaseFormProps) {
  const [role, setRole] = useState('');
  const [company, setCompany] = useState('');
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string>();

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmedRole = role.trim();
    const trimmedCompany = company.trim();
    const trimmedDescription = description.trim();
    if (!trimmedRole || !trimmedCompany || !trimmedDescription) {
      setError('Role, company and the job description are all required.');
      return;
    }
    onSubmit({
      title: trimmedRole,
      company: trimmedCompany,
      location: '',
      url: url.trim(),
      description: trimmedDescription,
      requirements: null,
      caseKey: mintManualCaseKey(),
      jdOrigin: 'manual',
    });
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={handleSubmit} aria-label="Tailor for a job">
      <p className="text-sm text-base-content/60">
        Paste the full job description for a role you are considering. It stays with this tailoring
        case and is not added to your Saved Jobs. The link is optional and is not opened.
      </p>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Role</span>
        <input className="input w-full" value={role} onChange={(event) => setRole(event.currentTarget.value)} />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Company</span>
        <input className="input w-full" value={company} onChange={(event) => setCompany(event.currentTarget.value)} />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Link to the posting (optional)</span>
        <input className="input w-full" value={url} onChange={(event) => setUrl(event.currentTarget.value)} />
      </label>
      <label className="block">
        <span className="mb-1 block text-sm font-medium">Job description</span>
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
        <button type="submit" className="btn btn-primary btn-sm">
          Open tailoring workspace
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
