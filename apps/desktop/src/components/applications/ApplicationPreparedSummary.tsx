import type { ApplicationArtifactSummary, ApplicationAttemptRecord, PreparedApplicationField } from '../../window.js';

export interface ApplicationPreparedSummaryProps {
  attempt: ApplicationAttemptRecord;
  /** The artifacts registered against this exact attempt id. Read through
   * `workspace.listApplicationArtifacts`, which scopes by attempt in SQL. */
  documents: readonly ApplicationArtifactSummary[];
  onOpenArtifact?: (artifactId: string) => void;
}

const DOCUMENT_LABEL: Record<ApplicationArtifactSummary['kind'], string> = {
  cv_pdf: 'CV',
  cover_letter_pdf: 'Cover letter',
  combined_pdf: 'CV and letter',
  other: 'Attachment',
};

const STATUS_LABEL: Record<PreparedApplicationField['status'], string> = {
  committed: 'Filled in',
  awaiting_you: 'You answer this',
  left_blank: 'Left blank',
  pending_upload: 'Needs a file',
};

const STATUS_BADGE: Record<PreparedApplicationField['status'], string> = {
  committed: 'badge badge-neutral badge-soft',
  awaiting_you: 'badge badge-warning badge-soft',
  left_blank: 'badge badge-neutral badge-soft',
  pending_upload: 'badge badge-warning badge-soft',
};

const PROVENANCE_LABEL: Record<NonNullable<PreparedApplicationField['provenance']>, string> = {
  cv: 'from your CV',
  profile: 'from your search profile',
  user_answer: 'from an answer you gave',
  jd: 'from the job description',
};

/**
 * What this app actually put into this application, and what it did not (#272).
 *
 * Two things it is careful about, both of them the reason this is a separate component rather than
 * a couple of lines inside the swipe card:
 *
 *  - **It only ever shows this attempt's own record.** The documents come from a query scoped to
 *    the attempt id, and the committed fields come off the attempt row itself. On top of that, the
 *    record carries the employer and role it was prepared for, and this refuses to render it unless
 *    they still match the attempt being reviewed -- so a record belonging to any other application
 *    cannot be presented as this one's answers.
 *  - **It never implies more than happened.** A field this app filled says so and names where the
 *    value came from; a field it deliberately left alone says that too. There is no "N fields
 *    filled" derived from how many fields the page happens to have, which is exactly the claim
 *    issue #277 flagged. Confirming each value is genuinely committed on the live page is #277's
 *    own work, and this wording does not get ahead of it.
 */
export function ApplicationPreparedSummary({ attempt, documents, onOpenArtifact }: ApplicationPreparedSummaryProps) {
  const prepared = attempt.preparedFields;
  const matchesThisAttempt = prepared != null && prepared.company === attempt.company && prepared.role === attempt.role;

  return (
    <div className="flex flex-col gap-3 border-b border-base-300 px-5 py-3.5">
      {attempt.checkpointDetail && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-base-content/60">Tailoring and preparation</h3>
          <p className="mt-1 text-xs text-base-content/70">{attempt.checkpointDetail}</p>
        </div>
      )}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-base-content/60">Documents for this application</h3>
        {documents.length === 0 ? (
          <p className="mt-1 text-xs text-base-content/60">No documents were prepared for this attempt.</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-0.5">
            {documents.map((document) => (
              <li key={document.id} className="flex items-center justify-between gap-3 text-xs">
                <span>
                  <span className="font-medium">{DOCUMENT_LABEL[document.kind]}</span>{' '}
                  <span className="text-base-content/60">{document.fileName}</span>
                </span>
                {onOpenArtifact ? (
                  <button type="button" className="btn btn-ghost btn-xs" onClick={() => onOpenArtifact(document.id)}>
                    Review
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-base-content/60">
          Answers filled for {attempt.role} at {attempt.company}
        </h3>
        {!matchesThisAttempt ? (
          <p className="mt-1 text-xs text-base-content/60">
            This app has no record of filling this form, so check every field on the page yourself before submitting.
          </p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1">
            {prepared.fields.map((field, index) => (
              <li key={`${field.label}-${index}`} className="flex items-start justify-between gap-3 text-xs">
                <span className="min-w-0">
                  <span className="font-medium">{field.label || 'Unlabelled field'}</span>
                  {field.status === 'committed' && field.value !== undefined ? (
                    <>
                      <span className="text-base-content/40">: </span>
                      <span className="break-words text-base-content/80">{field.value}</span>
                      {field.provenance ? (
                        <span className="text-base-content/50"> ({PROVENANCE_LABEL[field.provenance]})</span>
                      ) : null}
                    </>
                  ) : field.detail ? (
                    <>
                      <span className="text-base-content/40">: </span>
                      <span className="text-base-content/60">{field.detail}</span>
                    </>
                  ) : null}
                </span>
                <span className={`${STATUS_BADGE[field.status]} whitespace-nowrap`}>{STATUS_LABEL[field.status]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
