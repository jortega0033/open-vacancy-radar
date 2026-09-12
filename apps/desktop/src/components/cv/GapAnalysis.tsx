import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderId } from '@agent-dock/shared';
import type { CvProfile, CvSourceDocument, SavedJobRecord } from '../../window.js';
import { PROVIDER_LABEL } from '../../provider-labels.js';
import { buildGenerationInputBundle } from '../../../electron/generation-input.js';
import { buildGenerationPromptContext } from '../generation/prompts.js';
import { AiOutput } from './AiOutput.js';
import { findSavedJobForVacancy, saveGapAnalysis } from './gap-analysis-store.js';
import { buildAtsFitPrompt } from './prompts.js';
import { describeError, useAgentRun } from './useAgentRun.js';
import type { CvDocument, VacancyLead } from './types.js';

/**
 * Compares the loaded CV against one vacancy via the user's own installed CLI and streams the
 * answer back. Self-contained: it owns its run state, so wiring it into the app shell is a single
 * `<GapAnalysis cv={cv} vacancy={vacancy} />`.
 *
 * The answer can also be kept. "Save analysis" writes it onto the saved job this vacancy belongs
 * to, so reopening that job's drawer tomorrow shows the result without re-running anything (and
 * without the CV text and vacancy details leaving the machine a second time). The button is only
 * live for a vacancy that is already a saved job -- there is no row to write onto otherwise -- and
 * the panel says which job it would write to, so "Save" is never a guess the user cannot see.
 */
export interface GapAnalysisProps {
  cv: CvDocument | null;
  vacancy: VacancyLead | null;
  /** Optional provider model id (e.g. 'sonnet'); omitted means the CLI's own default. */
  model?: string;
  /** Which installed CLI to run through; omitted means Claude Code. */
  provider?: ProviderId;
  /** Reviewed CV evidence and corrected profile carried into the shared generation bundle. */
  sourceCv?: CvSourceDocument | null;
  profile?: CvProfile | null;
  /**
   * The saved job to keep the analysis on. Omitted in the app today: `CvAssistant` renders from a
   * `VacancyLead`, which carries no row id, so this component resolves the job itself from the
   * lead (see `gap-analysis-store.ts`). A caller that already knows the id can skip that lookup.
   */
  savedJobId?: string;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';
type CopyState = 'idle' | 'copied' | 'failed';
const COPY_FEEDBACK_MS = 2_000;

export function GapAnalysis({
  cv,
  vacancy,
  model,
  provider,
  sourceCv,
  profile,
  savedJobId,
}: GapAnalysisProps) {
  const run = useAgentRun();
  const [target, setTarget] = useState<SavedJobRecord | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveError, setSaveError] = useState<string>();
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [copyError, setCopyError] = useState<string>();
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(
    () => () => {
      if (copyTimeoutRef.current !== undefined) clearTimeout(copyTimeoutRef.current);
    },
    [],
  );

  // Which saved job (if any) this vacancy is. Re-resolved whenever the selected vacancy changes,
  // and best-effort: a failed lookup just leaves the save action disabled (see the store module).
  useEffect(() => {
    if (!vacancy || savedJobId) {
      setTarget(null);
      return;
    }
    let cancelled = false;
    void findSavedJobForVacancy(vacancy).then((job) => {
      if (!cancelled) setTarget(job);
    });
    return () => {
      cancelled = true;
    };
  }, [vacancy, savedJobId]);

  const canRun = !!cv && !!vacancy && !run.isBusy;
  const hasResult = run.text.trim().length > 0;
  const targetId = savedJobId ?? target?.id;
  const canSave = hasResult && !run.isBusy && !!targetId && saveState !== 'saving';

  const handleRun = useCallback(() => {
    if (!cv || !vacancy) return;
    // A new run supersedes whatever the previous one's save state was saying.
    setSaveState('idle');
    setSaveError(undefined);
    setCopyState('idle');
    setCopyError(undefined);
    const bundle = buildGenerationInputBundle({
      documentType: 'tailored_cv',
      cv,
      vacancy,
      sourceCv: sourceCv ?? null,
      profile: profile ?? null,
    });
    void run.start(buildAtsFitPrompt(cv, vacancy, buildGenerationPromptContext(bundle)), {
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
    });
  }, [cv, vacancy, sourceCv, profile, model, provider, run]);

  const handleSave = useCallback(async () => {
    if (!targetId) return;
    setSaveState('saving');
    setSaveError(undefined);
    try {
      const updated = await saveGapAnalysis(targetId, run.text);
      setTarget(updated);
      setSaveState('saved');
    } catch (err) {
      setSaveState('failed');
      setSaveError(describeError(err, 'could not save this analysis'));
    }
  }, [targetId, run.text]);

  const handleCopy = useCallback(async () => {
    if (copyTimeoutRef.current !== undefined) clearTimeout(copyTimeoutRef.current);
    try {
      await navigator.clipboard.writeText(run.text);
      setCopyState('copied');
      setCopyError(undefined);
    } catch (err) {
      setCopyState('failed');
      setCopyError(describeError(err, 'could not copy to the clipboard'));
    }
    copyTimeoutRef.current = setTimeout(() => setCopyState('idle'), COPY_FEEDBACK_MS);
  }, [run.text]);

  return (
    <div className="card card-border rounded-box border-base-300 bg-base-100">
      <div className="card-body gap-3 p-5">
        <div className="card-title text-base font-bold">ATS fit</div>
        <p className="text-sm text-base-content/60">
          Compare this CV with the selected vacancy, including full-posting requirements and known
          input gaps.
        </p>

        {!cv && <div className="text-sm text-base-content/60">Load a CV above to enable this.</div>}
        {cv && !vacancy && (
          <div className="text-sm text-base-content/60">
            Select a vacancy to compare your CV against.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" type="button" onClick={handleRun} disabled={!canRun}>
            {run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled'
              ? 'Re-run ATS fit'
              : 'Check ATS fit'}
          </button>
          <button
            className="btn btn-outline"
            type="button"
            onClick={() => void run.cancel()}
            disabled={!run.isBusy}
          >
            Cancel
          </button>
          <button
            className="btn btn-outline"
            type="button"
            onClick={() => void handleSave()}
            disabled={!canSave}
          >
            {saveState === 'saving' && (
              <span
                className="loading loading-spinner loading-xs text-base-content"
                aria-hidden="true"
              />
            )}
            Save analysis
          </button>
          <button
            className="btn btn-outline"
            type="button"
            onClick={() => void handleCopy()}
            disabled={!hasResult || run.isBusy}
          >
            Copy to clipboard
          </button>
          {saveState === 'saved' && (
            <span className="text-sm font-medium" role="status">
              Saved to this job
            </span>
          )}
        </div>

        {/* Said before the user reaches for the button, not after it does nothing. */}
        {hasResult && !targetId && (
          <div className="text-sm text-base-content/60">
            Save this vacancy to your saved jobs first, and the analysis can be kept with it.
          </div>
        )}
        {hasResult && target && saveState !== 'saved' && (
          <div className="text-sm text-base-content/60">
            Saving keeps this analysis on {target.role} at {target.company}, on this computer, until
            you delete that saved job.
          </div>
        )}

        {saveState === 'failed' && saveError && (
          <div className="alert alert-error text-sm" role="alert">
            {saveError}
          </div>
        )}
        {copyState === 'failed' && copyError && (
          <div className="alert alert-error text-sm" role="alert">
            {copyError}
          </div>
        )}
        {copyState === 'copied' && (
          <span className="text-sm font-medium" role="status">
            Copied
          </span>
        )}

        <AiOutput
          status={run.status}
          text={run.text}
          {...(run.error ? { error: run.error } : {})}
          label="ATS fit result"
          idleHint="No analysis yet."
          busyLabel="Checking your CV against this vacancy…"
          providerLabel={PROVIDER_LABEL[provider ?? 'claude']}
        />
      </div>
    </div>
  );
}
