import { useId, useState } from 'react';
import {
  ROUND_STATES,
  ROUND_TYPES,
  type InterviewContextResult,
  type InterviewContextView,
  type InterviewRoundView,
} from '../../../electron/interview-context-types.js';
import { ErrorBanner } from '../shell/index.js';
import { ROUND_STATE_LABEL, ROUND_TYPE_LABEL } from './interview-context-labels.js';
import { describeRoundPrepUse, ROUNDS_PROMPT_BUDGET, type RoundPrepUse } from './interview-rounds-budget.js';

export interface InterviewRoundsPanelProps {
  applicationId: string;
  rounds: readonly InterviewRoundView[];
  /** How a prep pack uses each held round (by id): what is left out or cut before generating. */
  prepUse: ReadonlyMap<string, RoundPrepUse>;
  /** The planned round the next prep pack is for, or null. */
  nextRoundId: string | null;
  onNextRoundChange(roundId: string | null): void;
  onView(view: InterviewContextView): void;
  disabled: boolean;
  onBusyChange(busy: boolean): void;
}

interface Draft {
  roundType: InterviewRoundView['roundType'];
  scheduledOn: string;
  state: InterviewRoundView['state'];
  feedback: string;
  topics: string;
}

const EMPTY: Draft = { roundType: 'technical', scheduledOn: '', state: 'planned', feedback: '', topics: '' };

function toDraft(round: InterviewRoundView): Draft {
  return {
    roundType: round.roundType,
    scheduledOn: round.scheduledOn ?? '',
    state: round.state,
    feedback: round.feedback,
    topics: round.openTopics.join('\n'),
  };
}

/**
 * #691: interview rounds as the person records them. Their own record only: saving a round never moves
 * the application to another status, never edits the CV or notes, and the feedback is shown and sent to
 * the prep pack as "your notes", never as anything the employer or this app established.
 */
export function InterviewRoundsPanel({
  applicationId,
  rounds,
  prepUse,
  nextRoundId,
  onNextRoundChange,
  onView,
  disabled,
  onBusyChange,
}: InterviewRoundsPanelProps) {
  const baseId = useId();
  const [editing, setEditing] = useState<{ id: string | null; updatedAt: string | null; draft: Draft } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const planned = rounds.filter((round) => round.state === 'planned');

  async function call(action: () => Promise<InterviewContextResult>): Promise<boolean> {
    setSaving(true);
    onBusyChange(true);
    setError(undefined);
    let result: InterviewContextResult;
    try {
      result = await action();
    } catch {
      result = { ok: false, code: 'failed', message: 'Something went wrong. Nothing was changed.', view: null };
    }
    setSaving(false);
    onBusyChange(false);
    if (result.view) onView(result.view);
    if (!result.ok) setError(result.message);
    return result.ok;
  }

  async function save(): Promise<void> {
    if (!editing) return;
    const { draft } = editing;
    const ok = await call(() =>
      window.interviewContext.saveRound({
        applicationId,
        roundId: editing.id,
        expectedUpdatedAt: editing.updatedAt,
        round: {
          roundType: draft.roundType,
          scheduledOn: draft.scheduledOn.trim() ? draft.scheduledOn.trim() : null,
          state: draft.state,
          feedback: draft.feedback,
          openTopics: draft.topics
            .split('\n')
            .map((topic) => topic.trim().slice(0, 300))
            .filter(Boolean)
            .slice(0, 12),
        },
      }),
    );
    if (ok) setEditing(null);
  }

  const busy = disabled || saving;
  const draft = editing?.draft;
  const set = (patch: Partial<Draft>) => setEditing((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current));

  return (
    <section aria-label="Interview rounds" className="rounded-box border border-base-300 p-3 text-sm">
      <h3 className="text-sm font-semibold">Interview rounds</h3>
      <p className="mt-1 text-xs text-base-content/70">
        Your own record. Saving a round does not change the application status, your CV or your notes.
      </p>

      {rounds.length === 0 ? (
        <p className="mt-2 text-xs text-base-content/70">No rounds recorded yet.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {rounds.map((round) => (
            <li key={round.id} className="rounded-box border border-base-300 p-2" data-testid="interview-round">
              <p className="flex flex-wrap items-center gap-1 text-xs">
                <span className="font-medium">{ROUND_TYPE_LABEL[round.roundType]}</span>
                <span>{round.scheduledOn ?? 'Date not recorded'}</span>
                <span className="badge badge-sm badge-outline">{ROUND_STATE_LABEL[round.state]}</span>
              </p>
              {round.feedback && (
                <p className="mt-1 whitespace-pre-wrap break-words text-xs">
                  <span className="text-base-content/70">Your notes: </span>
                  {round.feedback}
                </p>
              )}
              {(() => {
                const use = prepUse.get(round.id);
                const note = use ? describeRoundPrepUse(use) : null;
                return note ? (
                  <p className="mt-1 text-xs text-base-content/70" data-testid="round-prep-use">
                    {note}
                  </p>
                ) : null;
              })()}
              {round.openTopics.length > 0 && (
                <p className="mt-1 break-words text-xs">
                  <span className="text-base-content/70">Still open for you: </span>
                  {round.openTopics.join('; ')}
                </p>
              )}
              <div className="mt-1 flex gap-2">
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  disabled={busy}
                  onClick={() => setEditing({ id: round.id, updatedAt: round.updatedAt, draft: toDraft(round) })}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  disabled={busy}
                  aria-label={`Delete ${ROUND_TYPE_LABEL[round.roundType]} ${round.scheduledOn ?? ''}`.trim()}
                  onClick={() => void call(() => window.interviewContext.deleteRound({ applicationId, roundId: round.id }))}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {planned.length > 0 && (
        <div className="mt-2">
          <label htmlFor={`${baseId}-next`} className="text-xs font-medium">
            Preparing for
          </label>
          <select
            id={`${baseId}-next`}
            className="select select-bordered select-xs mt-1 w-full"
            value={nextRoundId ?? ''}
            disabled={busy}
            onChange={(event) => onNextRoundChange(event.target.value || null)}
          >
            <option value="">The next round (not recorded)</option>
            {planned.map((round) => (
              <option key={round.id} value={round.id}>
                {ROUND_TYPE_LABEL[round.roundType]}
                {round.scheduledOn ? ` on ${round.scheduledOn}` : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {error && <ErrorBanner>{error}</ErrorBanner>}

      {!draft ? (
        <button
          type="button"
          className="btn btn-outline btn-xs mt-2"
          disabled={busy}
          onClick={() => setEditing({ id: null, updatedAt: null, draft: EMPTY })}
        >
          Add a round
        </button>
      ) : (
        <form
          aria-label={editing?.id ? 'Edit round' : 'New round'}
          className="mt-2 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs">
              <span className="font-medium">Type</span>
              <select
                aria-label="Type"
                className="select select-bordered select-xs mt-1 w-full"
                value={draft.roundType}
                disabled={saving}
                onChange={(event) => set({ roundType: event.target.value as Draft['roundType'] })}
              >
                {ROUND_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {ROUND_TYPE_LABEL[type]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs">
              <span className="font-medium">Date (optional)</span>
              <input
                aria-label="Date (optional)"
                type="date"
                className="input input-bordered input-xs mt-1 w-full"
                value={draft.scheduledOn}
                disabled={saving}
                onChange={(event) => set({ scheduledOn: event.target.value })}
              />
            </label>
          </div>
          <label className="block text-xs">
            <span className="font-medium">Status</span>
            <select
              aria-label="Status"
              className="select select-bordered select-xs mt-1 w-full"
              value={draft.state}
              disabled={saving}
              onChange={(event) => set({ state: event.target.value as Draft['state'] })}
            >
              {ROUND_STATES.map((state) => (
                <option key={state} value={state}>
                  {ROUND_STATE_LABEL[state]}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-xs">
            <span className="font-medium">What you were told or noticed</span>
            <textarea
              aria-label="What you were told or noticed"
              className="textarea textarea-bordered textarea-xs mt-1 w-full"
              rows={3}
              maxLength={4000}
              value={draft.feedback}
              disabled={saving}
              onChange={(event) => set({ feedback: event.target.value })}
            />
            {draft.feedback.trim().length > ROUNDS_PROMPT_BUDGET.feedbackChars && (
              <span className="mt-1 block text-base-content/70" data-testid="round-feedback-limit">
                You have written {draft.feedback.trim().length.toLocaleString('en-US')} characters. All of it is saved, but a prep
                pack uses only the first {ROUNDS_PROMPT_BUDGET.feedbackChars.toLocaleString('en-US')}: put what matters most first.
              </span>
            )}
          </label>
          <label className="block text-xs">
            <span className="font-medium">Topics still open for you (one per line)</span>
            <textarea
              aria-label="Topics still open for you (one per line)"
              className="textarea textarea-bordered textarea-xs mt-1 w-full"
              rows={2}
              value={draft.topics}
              disabled={saving}
              onChange={(event) => set({ topics: event.target.value })}
            />
          </label>
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary btn-xs" disabled={saving}>
              Save round
            </button>
            <button type="button" className="btn btn-ghost btn-xs" disabled={saving} onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
