import { X } from '@phosphor-icons/react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  ACTION_CHANNEL_LABEL,
  ACTION_KIND_LABEL,
  describeDue,
  dueStateOf,
  systemZone,
  type DueState,
} from '../../../electron/application-actions-core.js';
import type { ActionsResult, ActionsView, ActionView } from '../../../electron/application-actions-types.js';
import type { ApplicationRecord } from '../../window.js';
import { Dialog } from '../shell/Dialog.js';
import { ErrorBanner } from '../shell/index.js';
import { FollowUpDraftCard } from './FollowUpDraftCard.js';
import {
  CHANNEL_OPTIONS,
  KIND_OPTIONS,
  clockIn,
  emptyForm,
  formFromAction,
  knownZones,
  toDueRequest,
  toFields,
  type ActionForm,
} from './follow-up-form.js';

export interface FollowUpsDrawerProps {
  application: ApplicationRecord;
  onClose: () => void;
  /** Called after anything changed so the table can refresh its summary. */
  onChanged: () => void;
}

type Editing =
  | { mode: 'create'; requestId: string; origin: 'user' | 'suggestion_accepted'; form: ActionForm }
  | { mode: 'edit'; action: ActionView; form: ActionForm }
  | { mode: 'reschedule'; action: ActionView; form: ActionForm };

/**
 * Where keyboard focus goes when a control disappears. Every control that can be the target carries a
 * `data-focus-key`; a request lists keys in order of preference and the first one that is on screen and
 * enabled gets focus, so a person who pressed Dismiss, Cancel or Save never lands on the page behind the
 * dialog. The key of the control that opened a form or a confirmation comes first.
 */
const ADD_KEY = 'add-followup';
const PLAN_KEY = 'plan-followup';
const FORM_FIRST_KEY = 'form-first';
const SUBMIT_KEY = 'form-submit';
const rowKey = (verb: string, id: string): string => `${verb}:${id}`;
const returnKeyOf = (editing: Editing): string =>
  editing.mode === 'create'
    ? editing.origin === 'suggestion_accepted'
      ? PLAN_KEY
      : ADD_KEY
    : rowKey(editing.mode === 'edit' ? 'edit' : 'reschedule', editing.action.id);

const STATE_LABEL: Record<Exclude<DueState, 'closed'>, string> = {
  overdue: 'Overdue',
  due_today: 'Due today',
  upcoming: 'Upcoming',
};
const STATE_BADGE: Record<Exclude<DueState, 'closed'>, string> = {
  overdue: 'badge badge-sm badge-error badge-soft',
  due_today: 'badge badge-sm badge-warning badge-soft',
  upcoming: 'badge badge-sm badge-outline',
};

const requestId = (): string => globalThis.crypto.randomUUID();

type DueFailure = { issue: NonNullable<Extract<ActionsResult, { ok: false }>['dueIssue']>; options: Extract<ActionsResult, { ok: false }>['dueOptions'] };

/**
 * "Follow-ups" for one application (#692). Your own next steps with a due date or time, kept on this
 * computer. It is a reminder list inside the open app: it does not send anything, contact anyone,
 * write to a calendar, run in the background or change the application's status, next step or notes.
 */
export function FollowUpsDrawer({ application, onClose, onChanged }: FollowUpsDrawerProps) {
  const baseId = useId();
  const [view, setView] = useState<ActionsView | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [error, setError] = useState<string>();
  const [dueFailure, setDueFailure] = useState<DueFailure | null>(null);
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [confirmDismiss, setConfirmDismiss] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // A draft is being written for the step it names (null = a general follow-up). Only an explicit press sets this.
  const [drafting, setDrafting] = useState<{ actionId: string | null } | null>(null);
  // One request id per intent: pressing again after a failure or a cancel reuses it (nothing was saved, so a
  // retry cannot duplicate), and a success clears it so the next press is a new intent.
  const draftRequest = useRef<{ actionId: string | null; requestId: string } | null>(null);
  const currentId = useRef(application.id);
  currentId.current = application.id;
  const loadSeq = useRef(0);
  const viewerZone = useMemo(() => systemZone(), []);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<readonly string[] | null>(null);
  const [, requestFocusRender] = useState(0);

  /** Ask for focus once the next render has put the right controls on screen. */
  function focusSoon(...keys: string[]): void {
    pendingFocus.current = keys;
    requestFocusRender((count) => count + 1);
  }

  useEffect(() => {
    const keys = pendingFocus.current;
    const body = bodyRef.current;
    if (!keys || !body) return;
    pendingFocus.current = null;
    const candidates = Array.from(body.querySelectorAll<HTMLElement>('[data-focus-key]'));
    for (const key of keys) {
      const target = candidates.find((element) => element.dataset.focusKey === key);
      if (target && !(target as HTMLButtonElement).disabled) {
        target.focus();
        return;
      }
    }
    // Nothing named is left (the step moved to the history): stay inside the dialog, not on the page behind it.
    body.focus();
  });

  // Closing the drawer while a draft is being written cancels it: the person left, so nothing should be
  // saved behind their back into a list they are no longer looking at.
  const draftingRef = useRef(false);
  draftingRef.current = drafting !== null;
  useEffect(
    () => () => {
      if (draftingRef.current) void window.applicationActions.cancelDraft(currentId.current).catch(() => {});
    },
    [],
  );

  // The page is open, so a minute tick is only a re-render: it changes which label an action shows.
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const land = useCallback(
    (result: ActionsResult): boolean => {
      if (result.view && result.view.applicationId === currentId.current) setView(result.view);
      if (!result.ok) {
        setError(result.message);
        setDueFailure(result.dueIssue ? { issue: result.dueIssue, options: result.dueOptions } : null);
        return false;
      }
      setError(undefined);
      setDueFailure(null);
      onChanged();
      return true;
    },
    [onChanged],
  );

  useEffect(() => {
    const seq = ++loadSeq.current;
    setView(null);
    setLoadError(undefined);
    setEditing(null);
    setError(undefined);
    if (typeof window.applicationActions?.get !== 'function') {
      setLoadError('Follow-ups are not available in this build.');
      return undefined;
    }
    void window.applicationActions
      .get(application.id)
      .then((result) => {
        if (seq !== loadSeq.current) return;
        if (result.ok) setView(result.view);
        else setLoadError(result.message);
      })
      .catch(() => {
        if (seq === loadSeq.current) setLoadError('Your follow-ups could not be read.');
      });
    return () => {
      loadSeq.current += 1;
    };
  }, [application.id]);

  async function run(task: () => Promise<ActionsResult>, done?: string, focusKeys?: readonly string[]): Promise<boolean> {
    setBusy(true);
    setNotice(undefined);
    let result: ActionsResult;
    try {
      result = await task();
    } catch {
      result = { ok: false, code: 'failed', message: 'Something went wrong. Nothing was changed.', view: null, dueIssue: null, dueOptions: [] };
    }
    setBusy(false);
    const worked = land(result);
    if (worked && done) setNotice(done);
    if (focusKeys && focusKeys.length > 0) focusSoon(...focusKeys);
    return worked;
  }

  async function draftMessage(actionId: string | null, triggerKey: string): Promise<void> {
    if (!view || drafting) return;
    if (draftRequest.current?.actionId !== actionId) draftRequest.current = { actionId, requestId: requestId() };
    const request = draftRequest.current;
    setDrafting({ actionId });
    setBusy(true);
    setNotice(undefined);
    let result: ActionsResult;
    try {
      result = await window.applicationActions.generateDraft({ applicationId: view.applicationId, actionId, requestId: request.requestId });
    } catch {
      result = { ok: false, code: 'failed', message: 'Something went wrong. Nothing was saved.', view: null, dueIssue: null, dueOptions: [] };
    }
    setBusy(false);
    setDrafting(null);
    if (land(result)) {
      draftRequest.current = null;
      setNotice('Draft ready to review. Nothing was sent.');
    }
    focusSoon(triggerKey, ADD_KEY);
  }

  function startCreate(origin: 'user' | 'suggestion_accepted'): void {
    setError(undefined);
    setDueFailure(null);
    setEditing({ mode: 'create', requestId: requestId(), origin, form: emptyForm(Date.now()) });
    focusSoon(FORM_FIRST_KEY);
  }

  function closeForm(): void {
    const keys = editing ? [returnKeyOf(editing), ADD_KEY] : [ADD_KEY];
    setEditing(null);
    setError(undefined);
    setDueFailure(null);
    focusSoon(...keys);
  }

  async function submit(): Promise<void> {
    if (!editing || !view) return;
    const due = toDueRequest(editing.form);
    const worked = await run(() => {
      if (editing.mode === 'create') {
        return window.applicationActions.create({
          applicationId: view.applicationId,
          requestId: editing.requestId,
          fields: toFields(editing.form),
          due,
          origin: editing.origin,
        });
      }
      if (editing.mode === 'reschedule') {
        return window.applicationActions.reschedule({
          applicationId: view.applicationId,
          actionId: editing.action.id,
          expectedVersion: editing.action.version,
          due,
        });
      }
      return window.applicationActions.update({
        applicationId: view.applicationId,
        actionId: editing.action.id,
        expectedVersion: editing.action.version,
        fields: toFields(editing.form),
        due,
      });
    }, editing.mode === 'create' ? 'Follow-up added.' : editing.mode === 'reschedule' ? 'Follow-up rescheduled.' : 'Follow-up saved.');
    if (worked) {
      const keys = [returnKeyOf(editing), ADD_KEY];
      setEditing(null);
      focusSoon(...keys);
    } else {
      focusSoon(SUBMIT_KEY);
    }
  }

  const patch = (change: Partial<ActionForm>): void =>
    setEditing((current) => (current ? { ...current, form: { ...current.form, ...change, ...('date' in change || 'time' in change || 'timeZone' in change || 'dueMode' in change ? { ambiguity: null } : {}) } } : current));

  const open = view?.actions.filter((action) => action.state === 'open') ?? [];
  const history = view?.actions.filter((action) => action.state !== 'open') ?? [];
  const zones = useMemo(() => knownZones([viewerZone ?? '', editing?.form.timeZone ?? '']), [viewerZone, editing?.form.timeZone]);

  function renderAction(action: ActionView) {
    const state = dueStateOf(
      { state: action.state, dueKind: action.dueKind, dueDate: action.dueDate, dueLocal: action.dueLocal, dueTimeZone: action.dueTimeZone, dueAtMs: Date.parse(action.dueAt) },
      nowMs,
    );
    const text = describeDue(
      {
        state: action.state,
        dueKind: action.dueKind,
        dueDate: action.dueDate,
        dueLocal: action.dueLocal,
        dueTimeZone: action.dueTimeZone,
        dueUtcOffsetMinutes: action.dueUtcOffsetMinutes,
        dueAtMs: Date.parse(action.dueAt),
      },
      viewerZone,
    );
    const label = `${ACTION_KIND_LABEL[action.kind]}${action.title ? `: ${action.title}` : ''}`;
    return (
      <li key={action.id} className="rounded-box border border-base-300 p-3 text-sm" data-testid="follow-up-action">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{label}</span>
          {state !== 'closed' && <span className={STATE_BADGE[state]}>{STATE_LABEL[state]}</span>}
          {action.state === 'completed' && <span className="badge badge-sm badge-outline">Done</span>}
          {action.state === 'dismissed' && <span className="badge badge-sm badge-outline">Dismissed</span>}
        </div>
        <p className="mt-1 text-xs">
          <span className="text-base-content/70">{action.state === 'open' ? 'Due ' : 'Was due '}</span>
          {text.primary}
        </p>
        {text.viewerLocal && <p className="text-xs text-base-content/70">{text.viewerLocal}</p>}
        {action.dueResolution && action.dueResolution !== 'unique' && (
          <p className="text-xs text-base-content/70">You chose the {action.dueResolution} of the two times that clock reading happens.</p>
        )}
        {action.rescheduleCount > 0 && (
          <p className="text-xs text-base-content/70">
            Moved {action.rescheduleCount} {action.rescheduleCount === 1 ? 'time' : 'times'}.
          </p>
        )}
        {(action.channel !== 'unspecified' || action.contactDetail) && (
          <p className="mt-1 text-xs">
            <span className="text-base-content/70">Contact: </span>
            {[action.channel !== 'unspecified' ? ACTION_CHANNEL_LABEL[action.channel] : '', action.contactDetail].filter(Boolean).join(', ')}
          </p>
        )}
        {action.note && <p className="mt-1 whitespace-pre-wrap break-words text-xs">{action.note}</p>}
        <p className="mt-1 text-xs text-base-content/70">
          {action.origin === 'suggestion_accepted' ? 'Added from the follow-up prompt. ' : 'Added by you. '}
          {action.completedAt ? `Done ${action.completedAt.slice(0, 10)}.` : action.dismissedAt ? `Dismissed ${action.dismissedAt.slice(0, 10)}.` : ''}
        </p>
        {action.state === 'open' && (
          <div className="mt-2 flex flex-wrap gap-1">
            <button type="button" className="btn btn-sm" disabled={busy} aria-label={`Mark done: ${label}`} data-focus-key={rowKey('done', action.id)} onClick={() => void run(() => window.applicationActions.complete({ applicationId: action.applicationId, actionId: action.id, expectedVersion: action.version }), 'Marked done.', [rowKey('done', action.id), ADD_KEY])}>
              Mark done
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} aria-label={`Reschedule: ${label}`} data-focus-key={rowKey('reschedule', action.id)} onClick={() => { setError(undefined); setDueFailure(null); setEditing({ mode: 'reschedule', action, form: formFromAction(action) }); focusSoon(FORM_FIRST_KEY); }}>
              Reschedule
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !view?.draft.available} aria-label={`Draft a message: ${label}`} data-focus-key={rowKey('draft', action.id)} onClick={() => void draftMessage(action.id, rowKey('draft', action.id))}>
              Draft a message
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} aria-label={`Edit: ${label}`} data-focus-key={rowKey('edit', action.id)} onClick={() => { setError(undefined); setDueFailure(null); setEditing({ mode: 'edit', action, form: formFromAction(action) }); focusSoon(FORM_FIRST_KEY); }}>
              Edit
            </button>
            {confirmDismiss === action.id ? (
              <span className="flex flex-wrap items-center gap-1" role="group" aria-label={`Confirm dismiss: ${label}`}>
                <span className="text-xs">Dismiss it? It stays in your history.</span>
                <button
                  type="button"
                  className="btn btn-sm btn-warning"
                  disabled={busy}
                  data-focus-key={rowKey('confirm-dismiss', action.id)}
                  onClick={() => {
                    setConfirmDismiss(null);
                    void run(
                      () => window.applicationActions.dismiss({ applicationId: action.applicationId, actionId: action.id, expectedVersion: action.version }),
                      'Dismissed.',
                      [rowKey('dismiss', action.id), ADD_KEY],
                    );
                  }}
                >
                  Dismiss
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  data-focus-key={rowKey('keep', action.id)}
                  onClick={() => {
                    setConfirmDismiss(null);
                    focusSoon(rowKey('dismiss', action.id));
                  }}
                >
                  Keep
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={busy}
                aria-label={`Dismiss: ${label}`}
                data-focus-key={rowKey('dismiss', action.id)}
                onClick={() => {
                  setConfirmDismiss(action.id);
                  focusSoon(rowKey('confirm-dismiss', action.id));
                }}
              >
                Dismiss
              </button>
            )}
          </div>
        )}
      </li>
    );
  }

  function renderForm(form: Editing) {
    const f = form.form;
    const dueOnly = form.mode === 'reschedule';
    const heading = form.mode === 'create' ? 'New follow-up' : form.mode === 'edit' ? 'Edit follow-up' : 'Reschedule follow-up';
    const field = (name: string) => `${baseId}-${name}`;
    return (
      <form
        aria-label={heading}
        className="space-y-3 rounded-box border border-base-300 p-3 text-sm"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h3 className="text-sm font-semibold">{heading}</h3>
        {!dueOnly && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <label className="block" htmlFor={field('kind')}>
                <span className="mb-1 block ovr-eyebrow">What</span>
                <select id={field('kind')} aria-label="What" data-focus-key={FORM_FIRST_KEY} className="select select-sm w-full" value={f.kind} onChange={(e) => patch({ kind: e.target.value as ActionForm['kind'] })}>
                  {KIND_OPTIONS.map((kind) => (
                    <option key={kind} value={kind}>{ACTION_KIND_LABEL[kind]}</option>
                  ))}
                </select>
              </label>
              <label className="block" htmlFor={field('channel')}>
                <span className="mb-1 block ovr-eyebrow">How you will reach them</span>
                <select id={field('channel')} aria-label="How you will reach them" className="select select-sm w-full" value={f.channel} onChange={(e) => patch({ channel: e.target.value as ActionForm['channel'] })}>
                  {CHANNEL_OPTIONS.map((channel) => (
                    <option key={channel} value={channel}>{ACTION_CHANNEL_LABEL[channel]}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block" htmlFor={field('title')}>
              <span className="mb-1 block ovr-eyebrow">Short title</span>
              <input id={field('title')} aria-label="Short title" className="input input-sm w-full" maxLength={120} value={f.title} onChange={(e) => patch({ title: e.target.value })} />
            </label>
            <label className="block" htmlFor={field('contact')}>
              <span className="mb-1 block ovr-eyebrow">Who or where (optional)</span>
              <input id={field('contact')} aria-label="Who or where (optional)" className="input input-sm w-full" maxLength={200} value={f.contactDetail} onChange={(e) => patch({ contactDetail: e.target.value })} />
            </label>
            <label className="block" htmlFor={field('note')}>
              <span className="mb-1 block ovr-eyebrow">Note (optional)</span>
              <textarea id={field('note')} aria-label="Note (optional)" className="textarea textarea-sm w-full" rows={2} maxLength={1000} value={f.note} onChange={(e) => patch({ note: e.target.value })} />
            </label>
          </>
        )}
        <fieldset className="space-y-2">
          <legend className="mb-1 block ovr-eyebrow">When</legend>
          <div className="flex gap-3">
            <label className="flex items-center gap-1 text-xs">
              <input type="radio" aria-label="Any time that day" name={field('mode')} data-focus-key={dueOnly ? FORM_FIRST_KEY : undefined} className="radio radio-xs" checked={f.dueMode === 'date'} onChange={() => patch({ dueMode: 'date' })} />
              Any time that day
            </label>
            <label className="flex items-center gap-1 text-xs">
              <input type="radio" aria-label="At a set time" name={field('mode')} className="radio radio-xs" checked={f.dueMode === 'datetime'} onChange={() => patch({ dueMode: 'datetime' })} />
              At a set time
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block" htmlFor={field('date')}>
              <span className="mb-1 block text-xs">Date</span>
              <input id={field('date')} aria-label="Date" type="date" className="input input-sm w-full" value={f.date} onChange={(e) => patch({ date: e.target.value })} />
            </label>
            {f.dueMode === 'datetime' && (
              <label className="block" htmlFor={field('time')}>
                <span className="mb-1 block text-xs">Time</span>
                <input id={field('time')} aria-label="Time" type="time" className="input input-sm w-full" value={f.time} onChange={(e) => patch({ time: e.target.value })} />
              </label>
            )}
          </div>
          <label className="block" htmlFor={field('zone')}>
            <span className="mb-1 block text-xs">Time zone</span>
            <input id={field('zone')} aria-label="Time zone" list={field('zones')} className="input input-sm w-full" value={f.timeZone} onChange={(e) => patch({ timeZone: e.target.value })} />
            <datalist id={field('zones')}>
              {zones.map((zone) => (
                <option key={zone} value={zone} aria-label={zone} />
              ))}
            </datalist>
          </label>
          <p className="text-xs text-base-content/70">
            {f.dueMode === 'date'
              ? `Due until the end of that day in ${f.timeZone || 'the zone you choose'}.`
              : `The time is read in ${f.timeZone || 'the zone you choose'}. If this computer moves to another zone, the follow-up keeps this one.`}
          </p>
          {dueFailure?.issue === 'ambiguous_local_time' && (
            <fieldset className="rounded-box border border-warning p-2" aria-label="Which time do you mean">
              <legend className="px-1 text-xs font-medium">That time happens twice. Which one do you mean?</legend>
              {dueFailure.options.map((option) => (
                <label key={option.choice} className="flex items-center gap-2 text-xs">
                  <input
                    type="radio"
                    aria-label={option.choice === 'earlier' ? 'The first time' : 'The second time'}
                    name={field('ambiguity')}
                    className="radio radio-xs"
                    checked={f.ambiguity === option.choice}
                    onChange={() => setEditing((current) => (current ? { ...current, form: { ...current.form, ambiguity: option.choice } } : current))}
                  />
                  {option.choice === 'earlier' ? 'The first time' : 'The second time'}: {clockIn(option.instant, f.timeZone)} at UTC{option.offsetMinutes < 0 ? '-' : '+'}
                  {String(Math.floor(Math.abs(option.offsetMinutes) / 60)).padStart(2, '0')}:{String(Math.abs(option.offsetMinutes) % 60).padStart(2, '0')}
                </label>
              ))}
            </fieldset>
          )}
        </fieldset>
        <div className="flex gap-2">
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy} data-focus-key={SUBMIT_KEY}>
            {form.mode === 'create' ? 'Add follow-up' : 'Save'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={closeForm}>
            Cancel
          </button>
        </div>
      </form>
    );
  }

  return (
    <Dialog
      aria-label={`Follow-ups for ${application.role} at ${application.company}`}
      placement="end"
      boxClassName="flex max-w-md flex-col rounded-none p-0"
      onClose={onClose}
    >
      <div className="flex items-center justify-between border-b border-base-300 px-5 py-3.5">
        <h2 className="text-sm font-semibold">
          Follow-ups <span className="text-base-content/60">for</span> {application.role} <span className="text-base-content/60">at</span> {application.company}
        </h2>
        <button type="button" aria-label="Close" className="btn btn-ghost btn-sm btn-circle" onClick={onClose}>
          <X size={16} weight="bold" aria-hidden="true" />
        </button>
      </div>

      <div ref={bodyRef} tabIndex={-1} className="flex-1 space-y-4 overflow-y-auto px-5 py-4 outline-none">
        <p className="text-sm text-base-content/60">
          Your own list, kept on this computer. Nothing here sends a message, contacts anyone or changes the application.
        </p>

        {loadError && <ErrorBanner>{loadError}</ErrorBanner>}
        {!view && !loadError && <p className="text-sm" role="status">Loading follow-ups.</p>}
        {error && <ErrorBanner>{error}</ErrorBanner>}
        <div role="status" aria-live="polite" className="text-xs text-base-content/80 empty:hidden" data-testid="follow-up-notice">{notice}</div>

        {view && (
          <>
            <section aria-label="Where this application stands" className="rounded-box border border-base-300 p-3 text-sm">
              <p>
                <span className="text-base-content/70">Status: </span>
                {application.status.replace('_', ' ')}. {view.application.submissionLabel}
              </p>
              <p className="mt-1 text-xs text-base-content/70" data-testid="follow-up-suggestion-line">{view.suggestion.line}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {view.suggestion.eligible && !editing && (
                  <button type="button" className="btn btn-sm" disabled={busy} data-focus-key={PLAN_KEY} onClick={() => startCreate('suggestion_accepted')}>
                    Plan a follow-up
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  aria-pressed={view.suppressed}
                  data-focus-key="suppress"
                  onClick={() => void run(() => window.applicationActions.setSuppressed({ applicationId: view.applicationId, suppressed: !view.suppressed }), view.suppressed ? 'Suggestions are back on.' : 'Suggestions are off for this application.', ['suppress'])}
                >
                  {view.suppressed ? 'Allow follow-up suggestions' : 'Stop suggesting follow-ups'}
                </button>
              </div>
            </section>

            {editing ? (
              renderForm(editing)
            ) : (
              <button type="button" className="btn btn-sm" disabled={busy} data-focus-key={ADD_KEY} onClick={() => startCreate('user')}>
                Add a follow-up
              </button>
            )}

            <section aria-label="Open follow-ups">
              <h3 className="mb-2 text-sm font-semibold">Open</h3>
              {open.length === 0 ? (
                <p className="text-xs text-base-content/70" data-testid="follow-ups-empty">
                  No follow-ups planned. Add one when you want a reminder of what to do next. Nothing is scheduled or sent for you.
                </p>
              ) : (
                <ul className="space-y-2">{open.map(renderAction)}</ul>
              )}
            </section>

            <section aria-label="Drafts" className="space-y-2">
              <h3 className="text-sm font-semibold">Drafts</h3>
              <p className="text-xs text-base-content/70">
                A draft is text for you to review and send yourself. It is written only when you press Draft a message, with{' '}
                {view.draft.provider === 'claude' ? 'Claude' : view.draft.provider} on this computer, from facts this app holds about this application. Nothing is sent, and
                nothing is marked as sent unless you say so.
              </p>
              {!view.draft.available && view.draft.reason && <p className="text-xs" data-testid="draft-unavailable">{view.draft.reason}</p>}
              {(drafting || view.running) && (
                <div className="flex items-center gap-2 text-xs" role="status">
                  <span>Writing a draft. This can take a minute.</span>
                  <button type="button" className="btn btn-ghost btn-xs" onClick={() => void window.applicationActions.cancelDraft(view.applicationId)}>
                    Cancel
                  </button>
                </div>
              )}
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy || !view.draft.available || view.running || drafting !== null}
                data-focus-key="draft-general"
                onClick={() => void draftMessage(null, 'draft-general')}
              >
                Draft a message
              </button>
              {view.drafts.length === 0 ? (
                <p className="text-xs text-base-content/70" data-testid="drafts-empty">No drafts yet.</p>
              ) : (
                <ul className="space-y-2">
                  {view.drafts.map((draft) => (
                    <FollowUpDraftCard key={draft.id} draft={draft} busy={busy} run={run} />
                  ))}
                </ul>
              )}
            </section>

            {history.length > 0 && (
              <details>
                <summary className="cursor-pointer text-sm font-semibold">History ({history.length})</summary>
                <ul className="mt-2 space-y-2">{history.map(renderAction)}</ul>
              </details>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
