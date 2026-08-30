import { useCallback } from 'react';
import type { ProviderId } from '@agent-dock/shared';
import { AiOutput } from './AiOutput.js';
import { buildGapAnalysisPrompt } from './prompts.js';
import { useAgentRun } from './useAgentRun.js';
import type { CvDocument, VacancyLead } from './types.js';

/**
 * Compares the loaded CV against one vacancy via the user's own installed CLI and streams the
 * answer back. Self-contained: it owns its run state, so wiring it into the app shell is a single
 * `<GapAnalysis cv={cv} vacancy={vacancy} />`.
 */
export interface GapAnalysisProps {
  cv: CvDocument | null;
  vacancy: VacancyLead | null;
  /** Optional provider model id (e.g. 'sonnet'); omitted means the CLI's own default. */
  model?: string;
  /** Which installed CLI to run through; omitted means Claude Code. */
  provider?: ProviderId;
}

export function GapAnalysis({ cv, vacancy, model, provider }: GapAnalysisProps) {
  const run = useAgentRun();
  const canRun = !!cv && !!vacancy && !run.isBusy;

  const handleRun = useCallback(() => {
    if (!cv || !vacancy) return;
    void run.start(buildGapAnalysisPrompt(cv, vacancy), {
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
    });
  }, [cv, vacancy, model, provider, run]);

  return (
    <div className="card card-border rounded-box border-base-300 bg-base-100">
      <div className="card-body gap-3 p-5">
        <div className="card-title text-base font-bold">Gap analysis</div>
        <p className="text-sm text-base-content/60">
          Where your CV already matches this vacancy, and what it is missing.
        </p>

        {!cv && <div className="text-sm text-base-content/60">Load a CV above to enable this.</div>}
        {cv && !vacancy && (
          <div className="text-sm text-base-content/60">Select a vacancy to compare your CV against.</div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" type="button" onClick={handleRun} disabled={!canRun}>
            {run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled'
              ? 'Re-run analysis'
              : 'Analyse gaps'}
          </button>
          <button className="btn btn-outline" type="button" onClick={() => void run.cancel()} disabled={!run.isBusy}>
            Cancel
          </button>
        </div>

        <AiOutput
          status={run.status}
          text={run.text}
          {...(run.error ? { error: run.error } : {})}
          label="gap analysis result"
          idleHint="No analysis yet."
          busyLabel="Analysing your CV against this vacancy…"
        />
      </div>
    </div>
  );
}
