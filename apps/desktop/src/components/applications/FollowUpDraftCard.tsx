import { useEffect, useId, useRef, useState } from 'react';
import { ACTION_KIND_LABEL } from '../../../electron/application-actions-core.js';
import type { ActionsResult, DraftView } from '../../../electron/application-actions-types.js';

export interface FollowUpDraftCardProps {
  draft: DraftView;
  /** Another request is in flight; every control waits. */
  busy: boolean;
  /** Runs a request through the drawer, which lands its view and errors. Resolves true when it worked. */
  run: (task: () => Promise<ActionsResult>, notice?: string, focusKeys?: readonly string[]) => Promise<boolean>;
}

/**
 * One follow-up draft. Two different things are shown side by side and never merged:
 *  - the person's REVIEW of the text (not reviewed, approved, discarded), and
 *  - whether the message was SENT, which is only ever the person's own report. This app sends nothing;
 *    copying the text or approving it does not mean it was sent.
 */
export function FollowUpDraftCard({ draft, busy, run }: FollowUpDraftCardProps) {
  const baseId = useId();
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [confirming, setConfirming] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [sentOn, setSentOn] = useState('');
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const confirmRef = useRef<HTMLInputElement>(null);
  const sentButtonRef = useRef<HTMLButtonElement>(null);
  const copyButtonRef = useRef<HTMLButtonElement>(null);
  // When the confirmation opens, focus moves into it; when it closes, focus goes back to what opened it.
  const returnFocus = useRef<'sent' | 'copy' | null>(null);
  useEffect(() => {
    if (confirming) {
      confirmRef.current?.focus();
      return;
    }
    const target = returnFocus.current;
    returnFocus.current = null;
    if (target === 'sent') (sentButtonRef.current ?? copyButtonRef.current)?.focus();
    else if (target === 'copy') copyButtonRef.current?.focus();
  }, [confirming]);

  // A newer version of this draft (saved, approved, reported) replaces what the form shows.
  useEffect(() => {
    setSubject(draft.subject);
    setBody(draft.body);
  }, [draft.id, draft.version, draft.subject, draft.body]);

  const sent = draft.sendState === 'user_reported_sent';
  const discarded = draft.status === 'discarded';
  const locked = sent || discarded;
  const dirty = subject !== draft.subject || body !== draft.body;
  const target = { applicationId: draft.applicationId, draftId: draft.id, expectedVersion: draft.version };
  const title = `${ACTION_KIND_LABEL[draft.kind]} draft from ${draft.createdAt.slice(0, 10)}`;
  const keyOf = (name: string): string => `draft:${draft.id}:${name}`;
  const afterwards = (name: string): string[] => [keyOf(name), keyOf('copy')];

  async function copyText(): Promise<void> {
    try {
      await navigator.clipboard.writeText(draft.subject ? `Subject: ${subject}\n\n${body}` : body);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  }

  return (
    <li className="rounded-box border border-base-300 p-3 text-sm" data-testid="follow-up-draft" aria-label={title}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{title}</span>
        <span className="badge badge-sm badge-outline" data-testid="draft-review-state">
          {discarded ? 'Discarded' : draft.status === 'approved' ? 'Text approved by you' : 'Not reviewed yet'}
        </span>
        <span className={sent ? 'badge badge-sm badge-info badge-soft' : 'badge badge-sm badge-outline'} data-testid="draft-send-state">
          {sent ? `You reported sending this${draft.sentOn ? ` on ${draft.sentOn}` : ''}` : 'Not sent'}
        </span>
        {draft.edited && <span className="badge badge-sm badge-outline">Edited by you</span>}
      </div>
      <p className="mt-1 text-xs text-base-content/70" data-testid="draft-basis">
        {draft.basis.label}
        {draft.basis.manifestHash ? ` Record ${draft.basis.manifestHash}.` : ''}
      </p>
      {draft.basis.documents.length > 0 && (
        <p className="text-xs text-base-content/70">
          Documents considered: {draft.basis.documents.map((doc) => `${doc.slot === 'cv' ? 'CV' : 'Letter'}${doc.version !== null ? ` v${doc.version}` : ''}`).join(', ')}.
        </p>
      )}

      <label className="mt-2 block" htmlFor={`${baseId}-subject`}>
        <span className="mb-1 block ovr-eyebrow">Subject</span>
        <input id={`${baseId}-subject`} aria-label="Subject" className="input input-sm w-full" maxLength={200} value={subject} readOnly={locked} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <label className="mt-2 block" htmlFor={`${baseId}-body`}>
        <span className="mb-1 block ovr-eyebrow">Message</span>
        <textarea id={`${baseId}-body`} aria-label="Message" className="textarea textarea-sm w-full" rows={8} maxLength={8000} value={body} readOnly={locked} onChange={(e) => setBody(e.target.value)} />
      </label>
      <p className="mt-1 text-xs text-base-content/70">
        This app has not sent this message and cannot. Copy it and send it yourself from your own email or messaging app.
      </p>

      {!sent && !discarded && dirty && <p className="mt-1 text-xs">You changed the text. Save your changes before approving it or recording that you sent it.</p>}
      {!discarded && (
        <div className="mt-2 flex flex-wrap gap-1">
          {!sent && dirty && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || body.trim().length === 0}
              data-focus-key={keyOf('save')}
              onClick={() => void run(() => window.applicationActions.editDraft({ ...target, subject, body }), 'Draft saved. Approve it again if you want it marked as reviewed.', afterwards('save'))}
            >
              Save changes
            </button>
          )}
          {!sent && draft.status !== 'approved' && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || dirty}
              data-focus-key={keyOf('approve')}
              onClick={() => void run(() => window.applicationActions.approveDraft(target), 'Text approved. It has not been sent.', afterwards('approve'))}
            >
              Approve this text
            </button>
          )}
          <button ref={copyButtonRef} type="button" className="btn btn-ghost btn-sm" data-focus-key={keyOf('copy')} onClick={() => void copyText()}>
            Copy
          </button>
          {!sent && (
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} data-focus-key={keyOf('discard')} onClick={() => void run(() => window.applicationActions.discardDraft(target), 'Draft discarded.', afterwards('discard'))}>
              Discard
            </button>
          )}
          {!sent && !confirming && (
            <button ref={sentButtonRef} type="button" className="btn btn-ghost btn-sm" disabled={busy || dirty} data-focus-key={keyOf('sent')} onClick={() => setConfirming(true)}>
              I sent this
            </button>
          )}
          <span role="status" aria-live="polite" className="self-center text-xs text-base-content/70">
            {copy === 'copied' ? 'Copied. Nothing was sent.' : copy === 'failed' ? 'Could not copy. Select the text and copy it.' : ''}
          </span>
        </div>
      )}

      {!sent && !discarded && confirming && (
        <fieldset className="mt-2 space-y-2 rounded-box border border-warning p-2" aria-label="Confirm you sent this message">
          <legend className="px-1 text-xs font-medium">Only say this if you sent it yourself</legend>
          <label className="flex items-start gap-2 text-xs">
            <input ref={confirmRef} type="checkbox" className="checkbox checkbox-xs mt-0.5" aria-label="I sent this message myself" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
            I sent this message myself, outside this app. This is my own statement.
          </label>
          <label className="block text-xs" htmlFor={`${baseId}-sent-on`}>
            Date sent (optional)
            <input id={`${baseId}-sent-on`} aria-label="Date sent" type="date" className="input input-sm mt-1 w-full" value={sentOn} onChange={(e) => setSentOn(e.target.value)} />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy || !acknowledged}
              onClick={() =>
                void run(
                  () => window.applicationActions.reportDraftSent({ ...target, sentOn: sentOn === '' ? null : sentOn, confirmed: true }),
                  'Recorded as sent, as you reported. The follow-up itself is unchanged.',
                  afterwards('sent'),
                ).then((worked) => {
                  if (worked) setConfirming(false);
                })
              }
            >
              Record that I sent it
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                returnFocus.current = 'sent';
                setConfirming(false);
              }}
            >
              Not yet
            </button>
          </div>
        </fieldset>
      )}
    </li>
  );
}
