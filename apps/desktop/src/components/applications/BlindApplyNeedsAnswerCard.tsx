import { useId, useState } from 'react';
import type { BlindApplyFeedItem } from '../../../electron/blind-apply-types.js';

export interface BlindApplyNeedsAnswerCardProps {
  item: BlindApplyFeedItem;
  /** Resolves with true when the answer was accepted. */
  onSubmit: (answers: Array<{ label: string; answer: string }>, remember: boolean) => Promise<boolean>;
}

/** Display only: an identifier like `workArrangement` reads as "Work arrangement". The answer is still
 * keyed by the field's own label, unchanged. */
function readable(label: string): string {
  // Only an identifier is reworded; a label already written as a question is shown exactly as the form wrote it.
  if (/\s/.test(label.trim())) return label;
  const spaced = label.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The one card Blind Apply shows when a required question has no truthful stored answer (#722). It lists
 * every missing question for that one application at once, so the person answers once. Nothing is
 * pre-selected and nothing is guessed: a select starts empty, and "Decline to answer" is only ever
 * offered when the employer's own form lists it.
 */
export function BlindApplyNeedsAnswerCard({ item, onSubmit }: BlindApplyNeedsAnswerCardProps) {
  const fields = item.missingFields ?? [];
  const idBase = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const complete = fields.length > 0 && fields.every((field) => (values[field.label] ?? '').trim() !== '');

  async function submit(): Promise<void> {
    setBusy(true);
    setFailed(false);
    const ok = await onSubmit(
      fields.map((field) => ({ label: field.label, answer: (values[field.label] ?? '').trim() })),
      remember,
    );
    setBusy(false);
    if (!ok) setFailed(true);
  }

  return (
    <form
      className="mt-2 space-y-3 rounded-box border border-base-300 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (complete && !busy) void submit();
      }}
      aria-label={`Answer for ${item.role} at ${item.company}`}
    >
      {fields.map((field, index) => {
        const id = `${idBase}-${index}`;
        return (
          <div key={field.label}>
            <label htmlFor={id} className="block text-sm font-medium">
              {readable(field.label)}
            </label>
            {field.controlType === 'select' ? (
              <select
                id={id}
                aria-label={readable(field.label)}
                className="select select-bordered select-sm mt-1 w-full"
                value={values[field.label] ?? ''}
                onChange={(event) => setValues((current) => ({ ...current, [field.label]: event.target.value }))}
              >
                <option value="">Choose one</option>
                {(field.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : field.controlType === 'textarea' ? (
              <textarea
                id={id}
                aria-label={readable(field.label)}
                className="textarea textarea-bordered mt-1 w-full"
                rows={3}
                value={values[field.label] ?? ''}
                onChange={(event) => setValues((current) => ({ ...current, [field.label]: event.target.value }))}
              />
            ) : (
              <input
                id={id}
                aria-label={readable(field.label)}
                type="text"
                className="input input-bordered input-sm mt-1 w-full"
                value={values[field.label] ?? ''}
                onChange={(event) => setValues((current) => ({ ...current, [field.label]: event.target.value }))}
              />
            )}
          </div>
        );
      })}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" aria-label="Use this answer for Blind Apply on later forms with the same question" className="checkbox checkbox-sm" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
        Use this answer for Blind Apply on later forms with the same question
      </label>
      {failed && (
        <p role="alert" className="text-sm text-error">
          That answer could not be used. Check it and try again.
        </p>
      )}
      <button type="submit" className="btn btn-primary btn-sm" disabled={!complete || busy}>
        {busy ? 'Saving…' : 'Save answer and continue'}
      </button>
    </form>
  );
}
