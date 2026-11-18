import { useEffect, useState } from 'react';
import type { ApplyCopyContact, ApplyCopyView } from '../../../electron/apply-copy-types.js';
import { CopyButton } from '../shell/index.js';

/**
 * #660: the values a person retypes into an employer form, next to one Copy button each. Everything
 * shown comes from `window.applyCopyFields`, which only returns values pinned to a verified staged
 * document version; when a staged document has no verified text, this says so and offers nothing.
 * Copying happens in the browser clipboard on a click; no call leaves the renderer for it.
 */

export interface ApplyCopyFieldsProps {
  attemptId: string;
  /** Changes when the attempt changed (a critique revision restages documents), to read again. */
  reloadKey: string;
}

const LETTER_LABEL = { cover_letter: 'cover letter', motivation_letter: 'motivation letter' } as const;

const CONTACT_FIELDS: ReadonlyArray<{ key: 'name' | 'email' | 'phone' | 'location'; label: string }> = [
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'location', label: 'Location' },
];

function CopyRow({ label, value, buttonLabel }: { label: string; value: string; buttonLabel: string }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2">
      <span className="min-w-0 text-sm">
        <span className="font-medium">{label}</span>
        <span className="ml-2 break-all text-base-content/70">{value}</span>
      </span>
      <CopyButton text={value} label={buttonLabel} />
    </li>
  );
}

function contactRows(contact: ApplyCopyContact) {
  const fields = CONTACT_FIELDS.filter(({ key }) => contact[key].length > 0).map(({ key, label }) => (
    <CopyRow key={key} label={label} value={contact[key]} buttonLabel={`Copy ${label.toLowerCase()}`} />
  ));
  const links = contact.links.map((link, index) => (
    // Keyed by position: the same link may appear twice, and the order is fixed for a given view.
    <CopyRow key={`link-${index}`} label={contact.links.length > 1 ? `Link ${index + 1}` : 'Link'} value={link} buttonLabel={contact.links.length > 1 ? `Copy link ${index + 1}` : 'Copy link'} />
  ));
  return [...fields, ...links];
}

export function ApplyCopyFields({ attemptId, reloadKey }: ApplyCopyFieldsProps) {
  const [view, setView] = useState<ApplyCopyView | null>(null);

  useEffect(() => {
    let cancelled = false;
    setView(null);
    const bridge = (window as { applyCopyFields?: typeof window.applyCopyFields }).applyCopyFields;
    if (!bridge) return;
    bridge
      .get(attemptId)
      .then((result) => {
        if (!cancelled) setView(result.ok ? result.view : null);
      })
      .catch(() => {
        if (!cancelled) setView(null);
      });
    return () => {
      cancelled = true;
    };
  }, [attemptId, reloadKey]);

  if (!view) return null;
  const rows = view.contact ? contactRows(view.contact) : [];
  const empty = view.letters.length === 0 && !view.letterUnavailable && rows.length === 0 && !view.contactUnavailable;
  if (empty) return null;

  return (
    <section aria-label="Copy for the employer form" data-testid="apply-copy-fields" className="rounded-box border border-base-300 px-3 py-2">
      <h4 className="text-sm font-medium">Copy for the employer form</h4>
      <ul className="mt-2 space-y-2">
        {view.letters.map((letter) => (
          <li key={letter.kind} className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">{`${LETTER_LABEL[letter.kind][0]!.toUpperCase()}${LETTER_LABEL[letter.kind].slice(1)} text`}</span>
            <CopyButton text={letter.text} label={`Copy ${LETTER_LABEL[letter.kind]} text`} />
          </li>
        ))}
        {view.letterUnavailable && (
          <li className="text-sm text-base-content/70" data-testid="apply-copy-letter-unavailable">
            Letter text is not available to copy. Open the letter to copy it by hand.
          </li>
        )}
        {rows}
        {view.contactUnavailable && (
          <li className="text-sm text-base-content/70" data-testid="apply-copy-contact-unavailable">
            Contact details are not available to copy.
          </li>
        )}
      </ul>
    </section>
  );
}
