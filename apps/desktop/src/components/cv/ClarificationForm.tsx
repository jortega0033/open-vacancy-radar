import { useEffect, useRef, useState } from 'react';
import { metricBasisProblem, type ClarificationAnswer } from './clarification-answer.js';
import { sourceAnchors } from './source-anchors.js';
import type { CvSourceDocument } from '../../window.js';

export interface ClarificationFormProps {
  /** The requirement being asked about, shown at the top so the questions have a subject. */
  requirementText?: string;
  sourceCv: CvSourceDocument | null | undefined;
  onAnswer(answer: ClarificationAnswer): void;
  onCancel(): void;
}

type Step = 1 | 2 | 3;

const STEP_COUNT = 3;

/**
 * The clarification ask for one `needs_verification` requirement (#419, step 6): three separate
 * steps -- what the candidate personally did and where, how with the actual tools and scope, and the
 * result or purpose if known -- with no target keyword ever suggested as an answer. Every step offers
 * the same explicit non-answers: "I don't know" (considered, no answer), "Not my work" (recorded as a
 * gap the candidate confirmed) and "Skip" (nothing recorded). Steps two and three may also be left
 * unstated with "Don't know this part", so an unknown mechanism or result stays unstated rather than
 * being guessed.
 */
export function ClarificationForm({ requirementText, sourceCv, onAnswer, onCancel }: ClarificationFormProps) {
  const options = sourceAnchors(sourceCv);
  const [step, setStep] = useState<Step>(1);
  const [anchor, setAnchor] = useState('');
  const [activity, setActivity] = useState('');
  const [timePhase, setTimePhase] = useState('');
  const [mechanism, setMechanism] = useState('');
  const [result, setResult] = useState('');
  const [metricValue, setMetricValue] = useState('');
  const [metricUnit, setMetricUnit] = useState('');
  const [metricBasis, setMetricBasis] = useState('');
  // An exit action waiting for the candidate to confirm that typed text will be discarded.
  const [pendingExit, setPendingExit] = useState<{ message: string; confirmLabel: string; run: () => void } | null>(null);
  const firstField = useRef<HTMLSelectElement & HTMLTextAreaElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);

  // Each step replaces the last one, so the button that was pressed unmounts and focus would fall
  // to the page. Put it on the new step's first field instead.
  useEffect(() => {
    if (mounted.current) firstField.current?.focus();
    mounted.current = true;
  }, [step]);
  useEffect(() => {
    if (pendingExit) keepButton.current?.focus();
  }, [pendingExit]);

  const selected = options.find((option) => `${option.type}:${option.id}` === anchor);
  const hasMetric = metricValue.trim().length > 0;
  const basisProblem = hasMetric ? metricBasisProblem(metricBasis) : null;

  const stepComplete =
    step === 1 ? !!selected && activity.trim().length > 0 : step === 2 ? mechanism.trim().length > 0 : true;

  function handleSave() {
    if (!selected || activity.trim().length === 0 || basisProblem) return;
    onAnswer({
      kind: 'answered',
      parentId: selected.id,
      parentType: selected.type,
      activity,
      mechanism,
      result,
      ...(timePhase.trim() ? { timePhase } : {}),
      ...(hasMetric ? { metricValue, metricUnit, metricBasis } : {}),
    });
  }

  const anyText = [activity, timePhase, mechanism, result, metricValue, metricUnit, metricBasis].some((value) => value.trim().length > 0);

  /** Runs `run` now, or asks first when there is typed text that it would throw away. */
  function exitWith(hasText: boolean, message: string, confirmLabel: string, run: () => void) {
    if (hasText) setPendingExit({ message, confirmLabel, run });
    else run();
  }

  function next() {
    setPendingExit(null);
    if (step < STEP_COUNT) setStep((step + 1) as Step);
  }

  function back() {
    setPendingExit(null);
    if (step > 1) setStep((step - 1) as Step);
  }

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-box border border-base-300 bg-base-200/40 p-3 text-sm">
      {requirementText && <p className="text-xs font-medium">About: {requirementText}</p>}
      <div className="text-xs text-base-content/60" aria-live="polite">
        Question {step} of {STEP_COUNT}
      </div>

      {step === 1 && (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">Which role or project is this about?</span>
            <select
              ref={firstField}
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
            <span className="text-xs font-medium">What did you personally do, and where?</span>
            <textarea
              className="textarea textarea-sm"
              rows={2}
              value={activity}
              onChange={(event) => setActivity(event.currentTarget.value)}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">When did this happen, if you want to say</span>
            <input
              type="text"
              className="input input-sm"
              value={timePhase}
              onChange={(event) => setTimePhase(event.currentTarget.value)}
              placeholder="e.g. the first year, or 2021 to 2022"
            />
          </label>
        </>
      )}

      {step === 2 && (
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium">How did you do it, including the actual tools and scope?</span>
          <textarea
            ref={firstField}
            className="textarea textarea-sm"
            rows={3}
            value={mechanism}
            onChange={(event) => setMechanism(event.currentTarget.value)}
          />
        </label>
      )}

      {step === 3 && (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium">What was the result, or what was it for, if you know?</span>
            <textarea
              ref={firstField}
              className="textarea textarea-sm"
              rows={2}
              value={result}
              onChange={(event) => setResult(event.currentTarget.value)}
            />
          </label>
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
                placeholder="e.g. a report you were sent"
              />
            </label>
          </div>
          {basisProblem && <p className="text-xs text-warning">{basisProblem}</p>}
        </>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {step > 1 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={back}>
            Back
          </button>
        )}
        {step < STEP_COUNT && (
          <button type="button" className="btn btn-primary btn-sm" onClick={next} disabled={!stepComplete}>
            Next
          </button>
        )}
        {step === 2 && (
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() =>
              exitWith(mechanism.trim().length > 0, 'Clear what you typed here and leave this part unstated?', 'Clear it', () => {
                setMechanism('');
                next();
              })
            }
          >
            Don&rsquo;t know this part
          </button>
        )}
        {step === STEP_COUNT && (
          <>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleSave}
              disabled={!selected || activity.trim().length === 0 || !!basisProblem}
            >
              Save answer
            </button>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() =>
                exitWith(
                  [result, metricValue, metricUnit, metricBasis].some((value) => value.trim().length > 0),
                  'Clear what you typed here and leave this part unstated?',
                  'Clear it',
                  () => {
                    setResult('');
                    setMetricValue('');
                    setMetricUnit('');
                    setMetricBasis('');
                  },
                )
              }
            >
              Don&rsquo;t know this part
            </button>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-base-300 pt-2">
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={() => exitWith(anyText, 'Discard your answer and record “I don’t know”?', 'Discard and record', () => onAnswer({ kind: 'unknown' }))}
        >
          I don&rsquo;t know
        </button>
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={() => exitWith(anyText, 'Discard your answer and record “Not my work”?', 'Discard and record', () => onAnswer({ kind: 'not_my_work' }))}
        >
          Not my work
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Skip for now
        </button>
      </div>
      {pendingExit && (
        <div className="alert alert-warning flex-wrap text-sm" role="alert">
          <span>{pendingExit.message}</span>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => {
                const { run } = pendingExit;
                setPendingExit(null);
                run();
              }}
            >
              {pendingExit.confirmLabel}
            </button>
            <button ref={keepButton} type="button" className="btn btn-ghost btn-sm" onClick={() => setPendingExit(null)}>
              Keep my answer
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
