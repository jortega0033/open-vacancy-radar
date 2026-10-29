import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderId } from '@agent-dock/shared';
import { BATCH_LIMITS } from '../../../electron/application-brief.js';
import { runAgentPrompt } from '../cv/run-agent-prompt.js';
import { PROVIDER_LABEL } from '../../provider-labels.js';
import { useEffectiveProvider } from '../../use-effective-provider.js';
import type { SavedJobRecord } from '../../window.js';
import { ConfirmDialog } from '../shell/ConfirmDialog.js';
import { BATCH_MAX_REQUESTS, runAssessSelectedJobs, type AssessDeps, type BatchJobState, type BatchSnapshot } from './assess-selected-jobs.js';

export interface AssessSelectedJobsProps {
  /** The saved jobs the person ticked. Nothing happens to them until they confirm. */
  selected: readonly SavedJobRecord[];
  onClearSelection: () => void;
  /** Called once a run ends (finished, stopped or failed) so the page can refresh what it shows. */
  onFinished?: () => void;
}

export const BATCH_STATE_LABEL: Record<BatchJobState, string> = {
  waiting: 'Waiting',
  running: 'Working',
  assessed: 'Assessed',
  partial: 'Only partly read',
  unassessed: 'Could not be assessed',
  failed: 'Failed',
  cancelled: 'Not finished',
  discarded: 'Result discarded',
};

/**
 * "Assess selected jobs" (#688): the ONE place the application brief can start an AI request, and only
 * after an explicit confirmation that names what will be sent and the limits. It never starts on render,
 * navigation or selection, never rescans, and never applies a suggestion. See `assess-selected-jobs.ts`
 * for the limits and the exact behaviour of a failed or cancelled run.
 */
export function AssessSelectedJobs({ selected, onClearSelection, onFinished }: AssessSelectedJobsProps) {
  const [snapshot, setSnapshot] = useState<BatchSnapshot | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Leaving the page stops the live request; nothing keeps running unattended.
      abortRef.current?.abort();
    };
  }, []);

  const start = useCallback(async (provider: ProviderId) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    const deps: AssessDeps = {
      prepare: (id) => window.applicationBrief.prepareAssessment(id),
      commit: (input) => window.applicationBrief.commitAssessment(input),
      async loadCv(cvId) {
        const documents = await window.workspace.listCvDocuments();
        const record = documents.find((document) => document.id === cvId);
        return record ? { cv: { fileName: record.name, text: record.text }, source: record.source } : null;
      },
      runPrompt: (prompt, options) => runAgentPrompt(prompt, { ...options, provider }),
      now: () => Date.now(),
      onUpdate: (next) => {
        if (mounted.current) setSnapshot(next);
      },
    };
    try {
      await runAssessSelectedJobs(
        selected.map((job) => ({ id: job.id, label: `${job.role} at ${job.company}` })),
        deps,
        controller.signal,
      );
    } finally {
      abortRef.current = null;
      if (mounted.current) setRunning(false);
      onFinished?.();
    }
  }, [onFinished, selected]);

  const cancel = useCallback(() => abortRef.current?.abort(), []);
  const dismiss = useCallback(() => {
    setSnapshot(null);
    onClearSelection();
  }, [onClearSelection]);

  // Nothing to show (and so no provider lookup) until something is ticked or a run is on screen.
  if (selected.length === 0 && snapshot === null) return null;
  return (
    <AssessPanel
      selected={selected}
      snapshot={snapshot}
      running={running}
      onStart={start}
      onCancel={cancel}
      onDismiss={dismiss}
      onClearSelection={onClearSelection}
    />
  );
}

interface AssessPanelProps {
  selected: readonly SavedJobRecord[];
  snapshot: BatchSnapshot | null;
  running: boolean;
  onStart: (provider: ProviderId) => Promise<void>;
  onCancel: () => void;
  onDismiss: () => void;
  onClearSelection: () => void;
}

function AssessPanel({ selected, snapshot, running, onStart, onCancel, onDismiss, onClearSelection }: AssessPanelProps) {
  const { provider } = useEffectiveProvider();
  const [confirming, setConfirming] = useState(false);
  const overCap = selected.length > BATCH_LIMITS.maxJobs;
  const providerName = PROVIDER_LABEL[provider] ?? provider;

  return (
    <section aria-label="Assess selected jobs" className="mt-4 rounded-box border border-base-300 p-3.5">
      {snapshot === null ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <span className="font-medium">{selected.length} selected.</span>{' '}
            <span className="text-base-content/70">
              {overCap
                ? `You can assess up to ${BATCH_LIMITS.maxJobs} jobs at a time. Untick ${selected.length - BATCH_LIMITS.maxJobs}.`
                : 'Compare each posting with your reviewed CV. Nothing starts until you confirm.'}
            </span>
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClearSelection}>
              Clear selection
            </button>
            <button type="button" className="btn btn-primary btn-sm" disabled={overCap || running} onClick={() => setConfirming(true)}>
              Assess selected jobs ({selected.length})
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Assessing {snapshot.jobs.length} jobs</h3>
            {running ? (
              <button type="button" className="btn btn-outline btn-sm" onClick={onCancel}>
                Cancel assessment
              </button>
            ) : (
              <button type="button" className="btn btn-primary btn-sm" onClick={onDismiss}>
                Done
              </button>
            )}
          </div>
          <p className="text-xs text-base-content/60">
            Requests used: {snapshot.requests} of up to {BATCH_MAX_REQUESTS}. One job at a time.
          </p>
          <ul className="space-y-1.5" aria-label="Assessment progress">
            {snapshot.jobs.map((job) => (
              <li key={job.savedJobId} className="text-sm">
                <span className="font-medium">{job.label}</span>
                {': '}
                <span>{BATCH_STATE_LABEL[job.state]}</span>
                {job.detail && <div className="text-xs text-base-content/70">{job.detail}</div>}
              </li>
            ))}
          </ul>
          {snapshot.summary && (
            <p className="text-sm font-medium" role="status">
              {snapshot.summary}
            </p>
          )}
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title={`Assess ${selected.length} selected job${selected.length === 1 ? '' : 's'}?`}
          confirmLabel="Start assessment"
          message={
            <>
              <p>
                This sends each job&apos;s description, your CV text and the roles and projects from your reviewed CV details to{' '}
                {providerName}, one job at a time, and saves what it finds on this computer.
              </p>
              <ul className="mt-2 list-disc space-y-0.5 pl-5">
                <li>
                  At most {BATCH_LIMITS.passesPerJob} requests per job ({Math.min(selected.length, BATCH_LIMITS.maxJobs) * BATCH_LIMITS.passesPerJob} at
                  most in total).
                </li>
                <li>
                  Each request stops after {Math.round(BATCH_LIMITS.requestTimeoutMs / 60_000)} minutes, and no new job starts after{' '}
                  {Math.round(BATCH_LIMITS.totalTimeoutMs / 60_000)} minutes.
                </li>
                <li>
                  Jobs that cannot be assessed (no CV details, no description, already up to date, or assessed earlier against another
                  description or an earlier CV) are skipped without a request.
                </li>
                <li>You can cancel at any time. A job that was not finished is left exactly as it was.</li>
              </ul>
            </>
          }
          onConfirm={() => {
            setConfirming(false);
            void onStart(provider);
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </section>
  );
}
