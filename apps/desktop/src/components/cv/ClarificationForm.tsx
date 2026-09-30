import { useState } from 'react';
import type { ClarificationAnswer } from './clarification-answer.js';
import type { CvSourceDocument } from '../../window.js';

export interface ClarificationFormProps {
  sourceCv: CvSourceDocument | null | undefined;
  onAnswer(answer: ClarificationAnswer): void;
  onCancel(): void;
}

interface AnchorOption {
  id: string;
  type: 'experience' | 'project';
  label: string;
}

function anchorOptions(source: CvSourceDocument | null | undefined): AnchorOption[] {
  if (!source) return [];
  return [
    ...source.experience.map((entry) => ({
      id: entry.id,
      type: 'experience' as const,
      label: `${entry.title || 'Role'} at ${entry.company || 'unknown employer'}`,
    })),
    ...source.projects.map((entry) => ({ id: entry.id, type: 'project' as const, label: `Project: ${entry.name || 'unnamed'}` })),
  ];
}

/**
 * The clarification ask for one `needs_verification` requirement (#419, step 3): three separate
 * questions -- what, how, and the result if known -- with no target keyword ever suggested as an
 * answer, plus the three honest non-answers ("I don't know", "not my work", "skip") that #419
 * requires stay gaps rather than being nudged toward a supported-evidence answer.
 */
export function ClarificationForm({ sourceCv, onAnswer, onCancel }: ClarificationFormProps) {
  const options = anchorOptions(sourceCv);
  const [anchor, setAnchor] = useState('');
  const [activity, setActivity] = useState('');
  const [mechanism, setMechanism] = useState('');
  const [result, setResult] = useState('');
  const [metricValue, setMetricValue] = useState('');
  const [metricUnit, setMetricUnit] = useState('');
  const [metricBasis, setMetricBasis] = useState('');

  const selected = options.find((option) => `${option.type}:${option.id}` === anchor);
  const canSave = !!selected && activity.trim().length > 0 && mechanism.trim().length > 0;
  const metricIncomplete = metricValue.trim().length > 0 && metricBasis.trim().length === 0;

  function handleSave() {
    if (!selected || !canSave || metricIncomplete) return;
    const answer: ClarificationAnswer = {
      kind: 'answered',
      parentId: selected.id,
      parentType: selected.type,
      activity,
      mechanism,
      result,
      ...(metricValue.trim() ? { metricValue, metricUnit, metricBasis } : {}),
    };
    onAnswer(answer);
  }

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-box border border-base-300 bg-base-200/40 p-3 text-sm">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium">Which role or project is this about?</span>
        <select
          className="select select-sm"
          value={anchor}
          onChange={(event) => setAnchor(event.currentTarget.value)}
          aria-label="Role or project"
        >
          <option value="">Choose one…</option>
          {options.map((option) => (
            <option key={`${option.type}:${option.id}`} value={`${option.type}:${option.id}`}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium">What did you personally do?</span>
        <textarea
          className="textarea textarea-sm"
          rows={2}
          value={activity}
          onChange={(event) => setActivity(event.currentTarget.value)}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium">How, including the actual tools and scope?</span>
        <textarea
          className="textarea textarea-sm"
          rows={2}
          value={mechanism}
          onChange={(event) => setMechanism(event.currentTarget.value)}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium">What was the result, or why it mattered, if known?</span>
        <textarea
          className="textarea textarea-sm"
          rows={2}
          value={result}
          onChange={(event) => setResult(event.currentTarget.value)}
        />
      </label>

      {result.trim().length > 0 && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">Number, if there is one</span>
            <input
              type="text"
              className="input input-sm w-28"
              value={metricValue}
              onChange={(event) => setMetricValue(event.currentTarget.value)}
              placeholder="e.g. 30%"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">Unit</span>
            <input
              type="text"
              className="input input-sm w-24"
              value={metricUnit}
              onChange={(event) => setMetricUnit(event.currentTarget.value)}
            />
          </label>
          <label className="flex min-w-40 flex-1 flex-col gap-1">
            <span className="text-xs font-medium">Where does that number come from?</span>
            <input
              type="text"
              className="input input-sm"
              value={metricBasis}
              onChange={(event) => setMetricBasis(event.currentTarget.value)}
              placeholder="e.g. a figure you remember, not a guess"
            />
          </label>
        </div>
      )}
      {metricIncomplete && (
        <p className="text-xs text-warning">A number needs a stated source before it can be saved.</p>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button type="button" className="btn btn-primary btn-sm" onClick={handleSave} disabled={!canSave || metricIncomplete}>
          Save answer
        </button>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => onAnswer({ kind: 'unknown' })}>
          I don&rsquo;t know
        </button>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => onAnswer({ kind: 'not_my_work' })}>
          Not my work
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Skip for now
        </button>
      </div>
    </div>
  );
}
