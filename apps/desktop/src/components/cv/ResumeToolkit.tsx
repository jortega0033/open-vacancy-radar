import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderId } from '@agent-dock/shared';
import { PROVIDER_LABEL } from '../../provider-labels.js';
import { AiOutput } from './AiOutput.js';
import {
  buildAchievementRewritePrompt,
  buildBestFitRolesPrompt,
  buildResumeAuditPrompt,
} from './prompts.js';
import { describeError, useAgentRun } from './useAgentRun.js';
import type { CvDocument } from './types.js';

export type ResumeToolMode = 'audit' | 'achievements' | 'roles';

export interface ResumeToolkitProps {
  cv: CvDocument | null;
  model?: string;
  provider?: ProviderId;
}

const MODE_DETAILS: Record<
  ResumeToolMode,
  { label: string; action: string; busy: string; output: string; description: string }
> = {
  audit: {
    label: 'Resume audit',
    action: 'Run resume audit',
    busy: 'Auditing your CV…',
    output: 'resume audit result',
    description: 'Find clarity, evidence, structure and credibility issues in this CV.',
  },
  achievements: {
    label: 'Improve achievements',
    action: 'Find achievement rewrites',
    busy: 'Finding evidence-grounded rewrites…',
    output: 'achievement rewrite result',
    description: 'Turn duty-heavy lines into stronger wording without adding facts or metrics.',
  },
  roles: {
    label: 'Best-fit roles',
    action: 'Find best-fit roles',
    busy: 'Finding realistic role directions…',
    output: 'best-fit role result',
    description: 'Find realistic search directions supported by this CV alone.',
  },
};

const PROMPT_BUILDER: Record<ResumeToolMode, (cv: CvDocument) => string> = {
  audit: buildResumeAuditPrompt,
  achievements: buildAchievementRewritePrompt,
  roles: buildBestFitRolesPrompt,
};

type CopyState = 'idle' | 'copied' | 'failed';
const COPY_FEEDBACK_MS = 2_000;

export function ResumeToolkit({ cv, model, provider }: ResumeToolkitProps) {
  const [mode, setMode] = useState<ResumeToolMode>('audit');
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [copyError, setCopyError] = useState<string>();
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const run = useAgentRun();
  const { reset } = run;
  const detail = MODE_DETAILS[mode];
  const cvKey = cv ? `${cv.fileName}:${cv.text.length}` : '';

  useEffect(() => {
    reset();
    setCopyState('idle');
    setCopyError(undefined);
  }, [cvKey, reset]);

  useEffect(
    () => () => {
      if (copyTimeoutRef.current !== undefined) clearTimeout(copyTimeoutRef.current);
    },
    [],
  );

  const selectMode = useCallback(
    (nextMode: ResumeToolMode) => {
      if (nextMode === mode || run.isBusy) return;
      setMode(nextMode);
      reset();
      setCopyState('idle');
      setCopyError(undefined);
    },
    [mode, reset, run.isBusy],
  );

  const handleRun = useCallback(() => {
    if (!cv) return;
    setCopyState('idle');
    setCopyError(undefined);
    void run.start(PROMPT_BUILDER[mode](cv), {
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
    });
  }, [cv, mode, model, provider, run]);

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

  const hasResult = run.text.trim().length > 0;

  return (
    <div className="card card-border rounded-box border-base-300 bg-base-100">
      <div className="card-body gap-3 p-5">
        <div className="card-title text-base font-bold">Improve this CV</div>
        <div
          className="join join-vertical w-full sm:join-horizontal"
          role="tablist"
          aria-label="CV review mode"
        >
          {(Object.keys(MODE_DETAILS) as ResumeToolMode[]).map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={mode === candidate}
              className={`btn join-item h-auto min-h-10 w-full min-w-0 whitespace-normal sm:flex-1 ${mode === candidate ? 'btn-active' : 'btn-outline'}`}
              disabled={run.isBusy}
              onClick={() => selectMode(candidate)}
            >
              {MODE_DETAILS[candidate].label}
            </button>
          ))}
        </div>

        <p className="text-sm text-base-content/60">{detail.description}</p>
        {!cv && <div className="text-sm text-base-content/60">Load a CV above to enable this.</div>}

        <div className="flex flex-wrap items-center gap-2">
          <button
            className="btn btn-primary"
            type="button"
            onClick={handleRun}
            disabled={!cv || run.isBusy}
          >
            {hasResult && !run.isBusy ? `Re-run ${detail.label.toLowerCase()}` : detail.action}
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
            onClick={() => void handleCopy()}
            disabled={!hasResult || run.isBusy}
          >
            Copy to clipboard
          </button>
          {copyState === 'copied' && (
            <span className="text-sm font-medium" role="status">
              Copied
            </span>
          )}
        </div>

        {copyState === 'failed' && copyError && (
          <div className="alert alert-error text-sm" role="alert">
            {copyError}
          </div>
        )}

        <AiOutput
          status={run.status}
          text={run.text}
          {...(run.error ? { error: run.error } : {})}
          label={detail.output}
          idleHint={`No ${detail.label.toLowerCase()} yet.`}
          busyLabel={detail.busy}
          providerLabel={PROVIDER_LABEL[provider ?? 'claude']}
        />
      </div>
    </div>
  );
}
