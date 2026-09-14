import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderId } from '@agent-dock/shared';
import { PROVIDER_LABEL } from '../../provider-labels.js';
import { AiOutput } from './AiOutput.js';
import {
  buildAchievementRewritePrompt,
  buildBestFitRolesPrompt,
  buildResumeAuditPrompt,
  MAX_AUDIT_FOCUS_CODE_POINTS,
  validateAuditFocus,
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

/** `audit` is handled separately in `handleRun` below, since it alone takes an optional target-role
 * focus (issue #362) that the other two modes never see. */
const PROMPT_BUILDER: Record<'achievements' | 'roles', (cv: CvDocument) => string> = {
  achievements: buildAchievementRewritePrompt,
  roles: buildBestFitRolesPrompt,
};

type CopyState = 'idle' | 'copied' | 'failed';
const COPY_FEEDBACK_MS = 2_000;

export function ResumeToolkit({ cv, model, provider }: ResumeToolkitProps) {
  const [mode, setMode] = useState<ResumeToolMode>('audit');
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [copyError, setCopyError] = useState<string>();
  // The audit-only "Target role" focus (issue #362). Kept in this component only (never lifted, per
  // the issue's own "Keep focus in the mounted toolkit only"): the draft survives a mode switch
  // away from and back to audit, but a fresh CV (`cvKey` below) or a remount always starts blank.
  const [targetRoleDraft, setTargetRoleDraft] = useState('');
  // The normalized focus the *currently displayed* run was actually started with -- null means no
  // audit run has been started yet under the current CV. Distinct from `targetRoleDraft` (what's
  // live in the input) so a result and its "Review focus" label stay bound to what produced them,
  // not to whatever the user has since typed.
  const [appliedFocus, setAppliedFocus] = useState<string | null>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const run = useAgentRun();
  const { reset } = run;
  const detail = MODE_DETAILS[mode];
  const cvKey = cv ? `${cv.fileName}:${cv.text.length}` : '';
  const focusValidation = validateAuditFocus(targetRoleDraft);

  useEffect(() => {
    reset();
    setCopyState('idle');
    setCopyError(undefined);
    setTargetRoleDraft('');
    setAppliedFocus(null);
  }, [cvKey, reset]);

  useEffect(
    () => () => {
      if (copyTimeoutRef.current !== undefined) clearTimeout(copyTimeoutRef.current);
    },
    [],
  );

  // Issue #362: a completed (or in-flight) audit result is bound to the normalized focus it was
  // started with. Once the draft's *normalized* value diverges from that -- not on a whitespace-only
  // edit that normalizes to the same thing -- the stale result and any copy feedback are cleared
  // immediately, and another explicit Run is required rather than the old answer quietly lingering
  // under a now-different label.
  useEffect(() => {
    if (mode !== 'audit' || appliedFocus === null || appliedFocus === focusValidation.value) return;
    reset();
    setCopyState('idle');
    setCopyError(undefined);
    setAppliedFocus(null);
  }, [appliedFocus, focusValidation.value, mode, reset]);

  const selectMode = useCallback(
    (nextMode: ResumeToolMode) => {
      if (nextMode === mode || run.isBusy) return;
      setMode(nextMode);
      reset();
      setCopyState('idle');
      setCopyError(undefined);
      setAppliedFocus(null);
    },
    [mode, reset, run.isBusy],
  );

  const handleRun = useCallback(() => {
    if (!cv) return;
    // Belt-and-suspenders alongside the disabled Run button below: an overlong focus never starts
    // a session, and is never silently truncated into a shorter one.
    if (mode === 'audit' && focusValidation.overlong) return;
    setCopyState('idle');
    setCopyError(undefined);
    if (mode === 'audit') {
      setAppliedFocus(focusValidation.value);
      void run.start(buildResumeAuditPrompt(cv, focusValidation.value || undefined), {
        ...(model ? { model } : {}),
        ...(provider ? { provider } : {}),
      });
      return;
    }
    void run.start(PROMPT_BUILDER[mode](cv), {
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
    });
  }, [cv, focusValidation, mode, model, provider, run]);

  const handleCopy = useCallback(async () => {
    if (copyTimeoutRef.current !== undefined) clearTimeout(copyTimeoutRef.current);
    // Issue #362: copied text carries the run's own captured focus label, not whatever is
    // currently (possibly since-edited) sitting in the input.
    const focusLabel =
      mode === 'audit' && appliedFocus !== null
        ? `Review focus: ${appliedFocus || 'General review'}\n\n`
        : '';
    try {
      await navigator.clipboard.writeText(`${focusLabel}${run.text}`);
      setCopyState('copied');
      setCopyError(undefined);
    } catch (err) {
      setCopyState('failed');
      setCopyError(describeError(err, 'could not copy to the clipboard'));
    }
    copyTimeoutRef.current = setTimeout(() => setCopyState('idle'), COPY_FEEDBACK_MS);
  }, [appliedFocus, mode, run.text]);

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

        {mode === 'audit' && (
          <div className="form-control w-full max-w-sm">
            <label className="label py-1" htmlFor="resume-audit-target-role">
              <span className="label-text text-sm">Target role (optional)</span>
            </label>
            <input
              id="resume-audit-target-role"
              type="text"
              className="input input-bordered input-sm w-full"
              placeholder="e.g. React Frontend Engineer"
              value={targetRoleDraft}
              onChange={(event) => setTargetRoleDraft(event.target.value)}
              disabled={run.isBusy}
              aria-invalid={focusValidation.overlong || undefined}
              aria-describedby={
                focusValidation.overlong ? 'resume-audit-target-role-error' : 'resume-audit-target-role-hint'
              }
            />
            {focusValidation.overlong ? (
              <p id="resume-audit-target-role-error" className="mt-1 text-xs text-error" role="alert">
                Target role must be {MAX_AUDIT_FOCUS_CODE_POINTS} characters or fewer.
              </p>
            ) : (
              <p id="resume-audit-target-role-hint" className="mt-1 text-xs text-base-content/60">
                Leave blank for a general review.
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            className="btn btn-primary"
            type="button"
            onClick={handleRun}
            disabled={!cv || run.isBusy || (mode === 'audit' && focusValidation.overlong)}
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

        {mode === 'audit' && appliedFocus !== null && (
          <p className="text-xs font-medium text-base-content/70">
            Review focus: {appliedFocus || 'General review'}
          </p>
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
