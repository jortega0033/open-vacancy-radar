import { CheckCircle, Circle, Lock, WarningCircle } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';
import type { CvEvidenceOverlayRecord, CvSourceDocument } from '../../window.js';
import { deriveCaseProgress, type CaseStep, type CaseStepState } from './case-progress.js';
import type { VacancyLead } from './types.js';
import { caseKeyFor } from './vacancy-key.js';

export interface CaseStepTrackerProps {
  cvId: string | null;
  vacancy: VacancyLead | null;
  sourceCv: CvSourceDocument | null;
  /** Bumped by the workspace when it knows the case just changed, to re-read at once. */
  refreshKey?: number;
}

/** How often the tracker re-reads the stored case. The cards below write to it independently and do
 * not report back, so reading the stored case is what keeps the steps honest. A local read. */
const POLL_MS = 3000;

const STATE_TEXT: Record<CaseStepState, string> = {
  done: 'Done',
  needs_you: 'Needs you',
  blocked: 'Blocked',
  not_started: 'Not started',
};

const STATE_CLASS: Record<CaseStepState, string> = {
  done: 'text-success',
  needs_you: 'text-warning',
  blocked: 'text-error',
  not_started: 'text-base-content/60',
};

/** Not colour alone: each state has its own icon as well as its own word. */
function StateIcon({ state }: { state: CaseStepState }) {
  const props = { size: 16, weight: 'bold' as const, 'aria-hidden': true, className: 'flex-none' };
  switch (state) {
    case 'done':
      return <CheckCircle {...props} />;
    case 'needs_you':
      return <WarningCircle {...props} />;
    case 'blocked':
      return <Lock {...props} />;
    case 'not_started':
      return <Circle {...props} />;
  }
}

/** Scrolls a card section into view and moves focus to it. A step whose card is not on screen yet
 * (the Files card exists only after approval) falls back to the nearest earlier card. */
function openStep(step: CaseStep, steps: readonly CaseStep[]): void {
  const index = steps.findIndex((candidate) => candidate.id === step.id);
  for (let i = index; i >= 0; i -= 1) {
    const target = document.getElementById(steps[i]!.targetId);
    if (target) {
      target.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
      target.focus({ preventScroll: true });
      return;
    }
  }
}

/**
 * The step list and the one-line "Next" for a tailoring case (#446). Sits at the top of the
 * workspace, sticky only on wide and tall windows so it never covers the work area at 760x600.
 */
export function CaseStepTracker({ cvId, vacancy, sourceCv, refreshKey = 0 }: CaseStepTrackerProps) {
  const [overlay, setOverlay] = useState<CvEvidenceOverlayRecord | null>(null);
  const [cvChanged, setCvChanged] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const caseKey = vacancy ? caseKeyFor(vacancy) : null;

  const load = useCallback(async () => {
    if (!cvId || !caseKey) return;
    try {
      const record = await window.workspace.getCvEvidenceOverlay(cvId, caseKey);
      setOverlay(record);
      if (record) {
        const plan = await window.workspace.previewCvEvidenceRebase(record.id).catch(() => null);
        setCvChanged(!!plan?.inputsChanged);
      } else {
        setCvChanged(false);
      }
    } catch {
      // Keep what is showing; the cards report their own load errors.
    } finally {
      setLoaded(true);
    }
  }, [cvId, caseKey]);

  useEffect(() => {
    setLoaded(false);
    setOverlay(null);
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load, refreshKey]);

  if (!vacancy || !cvId) return null;
  if (!loaded) return null;

  const progress = deriveCaseProgress({ overlay, sourceCv, cvChanged });

  return (
    <nav
      aria-label="Tailoring steps"
      className="rounded-box border border-base-300 bg-base-100 p-3 shadow-sm lg:[@media(min-height:720px)]:sticky lg:[@media(min-height:720px)]:top-0 lg:[@media(min-height:720px)]:z-10"
    >
      <ol className="flex flex-wrap gap-x-4 gap-y-1">
        {progress.steps.map((step) => (
          <li key={step.id}>
            <button
              type="button"
              className="flex items-center gap-1.5 rounded px-1 py-0.5 text-left text-sm hover:bg-base-200"
              onClick={() => openStep(step, progress.steps)}
              aria-label={`Step ${step.number}: ${step.label}. ${STATE_TEXT[step.state]}. ${step.detail}`.trim()}
              title={step.detail}
            >
              <span className={STATE_CLASS[step.state]}>
                <StateIcon state={step.state} />
              </span>
              <span className="font-medium">
                {step.number} {step.label}
              </span>
              <span className={`text-xs ${STATE_CLASS[step.state]}`}>{STATE_TEXT[step.state]}</span>
            </button>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-sm font-medium" role="status">
        {progress.next}
      </p>
    </nav>
  );
}
