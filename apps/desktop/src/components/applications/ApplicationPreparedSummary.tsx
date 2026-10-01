import { useMemo, useState } from 'react';
import type { FormSnapshot } from '@agent-dock/application-executor';
import type {
  ApplicationAnswerRecord,
  ApplicationArtifactSummary,
  ApplicationAttemptRecord,
  ConfirmApplicationAnswerResult,
  PreparedApplicationField,
} from '../../window.js';
import { applicationAnswerKeyForMatch } from './application-answer-match.js';

/**
 * Resolves each entry in `prepared.fields` to the live snapshot field it corresponds to right now,
 * by ordinal position among same-label-and-control-type fields rather than a first-match lookup
 * (#372). Two distinct fields can share an identical label and control type -- nothing on a real
 * page stops two textareas both being labelled "Additional comments" -- and a first-match `.find()`
 * would resolve both of them to the *same* live field, silently letting an action on the second row
 * fill (and a completion later flip) the first row's control instead.
 *
 * Correlating by "the Nth occurrence of this label+type in `prepared.fields`" against "the Nth
 * occurrence of this label+type among the live snapshot's own active fields" holds because both
 * lists were built by walking the same form's fields in the same document order --
 * `summarisePreparedFields` (`electron/application-value-table.ts`) built `prepared.fields` that way
 * originally, and a fresh `FormSnapshot` enumerates the same page the same way. If the page's field
 * order or count has genuinely changed since preparation, the Nth occurrence may not exist any more
 * (`undefined`) or may now be a different control -- `confirmApplicationAnswer` itself is the real
 * backstop for that (it re-checks label/controlType/status against the live field before writing
 * anything), so a stale mapping here fails safely rather than corrupting state.
 */
function resolveLiveFieldRefs(prepared: readonly PreparedApplicationField[], snapshot: FormSnapshot): (string | undefined)[] {
  const occurrencesSeen = new Map<string, number>();
  const liveByKey = new Map<string, string[]>();
  for (const field of snapshot.fields) {
    if (!field.active) continue;
    const key = `${field.controlType}::${field.label}`;
    const refs = liveByKey.get(key);
    if (refs) refs.push(field.fieldRef);
    else liveByKey.set(key, [field.fieldRef]);
  }
  return prepared.map((field) => {
    const key = `${field.controlType}::${field.label}`;
    const occurrence = occurrencesSeen.get(key) ?? 0;
    occurrencesSeen.set(key, occurrence + 1);
    return liveByKey.get(key)?.[occurrence];
  });
}

export interface ApplicationPreparedSummaryProps {
  attempt: ApplicationAttemptRecord;
  /** The artifacts registered against this exact attempt id. Read through
   * `workspace.listApplicationArtifacts`, which scopes by attempt in SQL. */
  documents: readonly ApplicationArtifactSummary[];
  onOpenArtifact?: (artifactId: string) => void;
  /** The live form's own fields (#372), used only to resolve which `fieldRef` a matching
   * `awaiting_you` label+controlType corresponds to right now. Absent for a review with no live
   * executor to confirm against (there is none today), which keeps every row read-only. */
  snapshot?: FormSnapshot;
  /** The reusable answer library (#372), already fetched by the caller once per review. */
  savedAnswers?: readonly ApplicationAnswerRecord[];
  /** Commits one confirmed answer into the live field. `fieldIndex` is this field's own position in
   * `attempt.preparedFields.fields`, passed straight through to the bridge so the main process can
   * update the exact entry that was confirmed even when another field shares its label and control
   * type. This prop's absence, like `snapshot`'s, keeps every row read-only rather than rendering
   * actions nothing can carry out. */
  onConfirmAnswer?: (fieldIndex: number, fieldRef: string, value: string) => Promise<ConfirmApplicationAnswerResult>;
  /** Persists an answer into the reusable library. Always a separate choice from confirming it into
   * the live field (the ticket's own "saving and using are separate choices") -- never called by
   * this component on its own, only in response to the person explicitly checking "Save for future
   * applications" alongside a fill. */
  onSaveAnswer?: (input: { label: string; controlType: 'text' | 'textarea'; answer: string }) => Promise<void>;
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

/** Whether this field is even eligible for the reusable-answer flow at all (#372 V1's own explicit
 * boundary): active, unclassified `text`/`textarea` fields only -- consent, credential, file,
 * checkbox/radio/select and CAPTCHA/challenge fields never get a "reuse" or "type an answer" action
 * here, no matter their status. */
function isReusableAnswerField(field: PreparedApplicationField): field is PreparedApplicationField & { controlType: 'text' | 'textarea' } {
  return field.status === 'awaiting_you' && (field.controlType === 'text' || field.controlType === 'textarea');
}

interface AwaitingAnswerRowProps {
  field: PreparedApplicationField & { controlType: 'text' | 'textarea' };
  fieldIndex: number;
  fieldRef: string | undefined;
  savedAnswer: ApplicationAnswerRecord | undefined;
  onConfirmAnswer: (fieldIndex: number, fieldRef: string, value: string) => Promise<ConfirmApplicationAnswerResult>;
  onSaveAnswer?: (input: { label: string; controlType: 'text' | 'textarea'; answer: string }) => Promise<void>;
}

/**
 * One `awaiting_you` text/textarea field, rendered as something a person can actually act on instead
 * of only being told about (#372). Its own component, not inline in the `.map` below, because each
 * row needs its own draft-text/busy/error state -- `useState` inside a `.map` callback would share
 * that state across every row instead of giving each one its own.
 *
 * Reuse is always a suggestion, never applied on its own: `onConfirmAnswer` only ever runs from this
 * row's own button click, and a saved answer's text is shown, not silently filled, until that click
 * happens -- the ticket's "reuse is suggested, never silently committed" rule, including while an
 * automatic-submission grant exists for this attempt (nothing about that grant reaches this
 * component at all, so it has no way to bypass this either).
 */
function AwaitingAnswerRow({ field, fieldIndex, fieldRef, savedAnswer, onConfirmAnswer, onSaveAnswer }: AwaitingAnswerRowProps) {
  const [draft, setDraft] = useState('');
  // Defaults unchecked, not checked: the ticket's own "saving and using are separate choices" rule
  // means saving into the reusable library must be something a person opts into, not something
  // they have to notice and opt out of while they're just trying to fill this one field.
  const [saveForFuture, setSaveForFuture] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (!fieldRef) {
    // The page changed since this attempt's fields were prepared (a re-render, a dynamic form) and
    // this label/control type no longer has a live counterpart -- never invite an action that
    // cannot be verified against the real control, same honesty rule the rest of this summary
    // already follows.
    return (
      <li className="flex items-start justify-between gap-3 text-xs">
        <span className="min-w-0">
          <span className="font-medium">{field.label || 'Unlabelled field'}</span>
          <span className="text-base-content/40">: </span>
          <span className="text-base-content/60">{field.detail}</span>
        </span>
        <span className={`${STATUS_BADGE[field.status]} whitespace-nowrap`}>{STATUS_LABEL[field.status]}</span>
      </li>
    );
  }

  async function handleUseSavedAnswer() {
    if (!savedAnswer) return;
    setBusy(true);
    setError(undefined);
    const result = await onConfirmAnswer(fieldIndex, fieldRef!, savedAnswer.answer);
    setBusy(false);
    if (!result.ok) {
      setError(result.detail ?? 'the page did not accept this answer');
      return;
    }
    // Best-effort bookkeeping, not load-bearing: the field is already filled and verified either
    // way, so a failure here (a closed workspace, a raced delete of this saved answer) is swallowed
    // rather than shown as an error about the fill, which is what actually matters and already
    // succeeded.
    void window.workspace.recordApplicationAnswerUsed(savedAnswer.id).catch(() => undefined);
  }

  async function handleFillTyped() {
    const value = draft.trim();
    if (!value) return;
    setBusy(true);
    setError(undefined);
    const result = await onConfirmAnswer(fieldIndex, fieldRef!, value);
    if (!result.ok) {
      setBusy(false);
      setError(result.detail ?? 'the page did not accept this answer');
      return;
    }
    if (saveForFuture && onSaveAnswer) {
      try {
        await onSaveAnswer({ label: field.label, controlType: field.controlType, answer: value });
      } catch (err) {
        // The field is filled either way -- committing to the live page is the part that must not
        // be lost to a save failure. Surfaced as its own message so it reads as "saved for reuse
        // didn't work", not "the field itself failed".
        setError(err instanceof Error ? `Filled in, but could not save this answer for future applications: ${err.message}` : 'Filled in, but could not save this answer for future applications.');
      }
    }
    setBusy(false);
  }

  return (
    <li className="flex flex-col gap-1.5 text-xs">
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0 font-medium">{field.label || 'Unlabelled field'}</span>
        <span className={`${STATUS_BADGE[field.status]} whitespace-nowrap`}>{STATUS_LABEL[field.status]}</span>
      </div>

      {savedAnswer ? (
        <div className="rounded-box border border-base-300 bg-base-200 p-2">
          <p className="text-base-content/50">
            Saved answer, used at {savedAnswer.originCompany || 'a previous application'}
          </p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-base-content/80">{savedAnswer.answer}</p>
          <button type="button" className="btn btn-primary btn-xs mt-1.5" disabled={busy} onClick={() => void handleUseSavedAnswer()}>
            {busy ? 'Filling…' : 'Use this answer'}
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <textarea
            className="textarea textarea-xs textarea-bordered w-full"
            rows={2}
            placeholder="Type an answer for this application"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={busy}
            aria-label={field.label || 'Unlabelled field'}
          />
          <div className="flex items-center justify-between gap-2">
            {onSaveAnswer ? (
              <label className="flex cursor-pointer items-center gap-1.5 text-base-content/60">
                <input
                  type="checkbox"
                  className="checkbox checkbox-xs"
                  checked={saveForFuture}
                  onChange={(event) => setSaveForFuture(event.target.checked)}
                  disabled={busy}
                />
                Save for future applications
              </label>
            ) : (
              <span />
            )}
            <button type="button" className="btn btn-primary btn-xs" disabled={busy || draft.trim().length === 0} onClick={() => void handleFillTyped()}>
              {busy ? 'Filling…' : 'Fill this field'}
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-error">{error}</p>}
    </li>
  );
}

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
 *
 * #372 adds one more capability without weakening either guarantee: an `awaiting_you` text/textarea
 * field can be filled from here (a saved answer, or one typed for this application), but only ever
 * through `onConfirmAnswer` -- the same fill-then-verify-off-the-live-control path every other value
 * in this attempt went through, never a value this component invents or assumes committed.
 */
export function ApplicationPreparedSummary({
  attempt,
  documents,
  onOpenArtifact,
  snapshot,
  savedAnswers,
  onConfirmAnswer,
  onSaveAnswer,
}: ApplicationPreparedSummaryProps) {
  const prepared = attempt.preparedFields;
  const matchesThisAttempt = prepared != null && prepared.company === attempt.company && prepared.role === attempt.role;
  const liveFieldRefs = useMemo(
    () => (prepared && snapshot ? resolveLiveFieldRefs(prepared.fields, snapshot) : undefined),
    [prepared, snapshot],
  );

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
          <ul className="mt-1 flex flex-col gap-1.5">
            {prepared.fields.map((field, index) => {
              if (onConfirmAnswer && snapshot && isReusableAnswerField(field)) {
                const fieldRef = liveFieldRefs?.[index];
                const key = applicationAnswerKeyForMatch(field.label, field.controlType);
                const savedAnswer = savedAnswers?.find((answer) => answer.normalizedKey === key);
                return (
                  <AwaitingAnswerRow
                    key={`${field.label}-${index}`}
                    field={field}
                    fieldIndex={index}
                    fieldRef={fieldRef}
                    savedAnswer={savedAnswer}
                    onConfirmAnswer={onConfirmAnswer}
                    onSaveAnswer={onSaveAnswer}
                  />
                );
              }
              return (
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
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
