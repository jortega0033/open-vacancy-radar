import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProviderId, ProviderStatus } from '@agent-dock/shared';
import type {
  ApplicationAttemptRecord,
  ApplicationRecord,
  CvDocumentRecord,
  LetterRecord,
  SavedJobRecord,
} from '../../window.js';
import { PROVIDER_LABEL } from '../../provider-labels.js';
import { resolveEffectiveProvider } from '../../resolve-effective-provider.js';
import { AiOutput } from '../cv/AiOutput.js';
import { describeError, useAgentRun } from '../cv/useAgentRun.js';
import { useEscapeToClose } from '../shell/useEscapeToClose.js';
import { INTERVIEW_PREPARABLE_STATUSES } from './application-status.js';
import { sortAttempts } from './attempt-status.js';
import { buildInterviewPrepPrompt, type InterviewPrepContext, type InterviewPrepStage } from './interview-prep-prompt.js';

export interface InterviewPrepDrawerProps {
  application: ApplicationRecord;
  savedJobs: readonly SavedJobRecord[];
  cvDocuments: readonly CvDocumentRecord[];
  letters: readonly LetterRecord[];
  onClose: () => void;
}

type CopyState = 'idle' | 'copied' | 'failed';
const COPY_FEEDBACK_MS = 2_000;

/**
 * "Prepare interview" (issue #358): one bounded, grounded, review-only AI prep pack built from
 * application context this app already owns -- the linked saved job, CV, letter, and the most
 * recent application attempt's job-description snapshot.
 *
 * Design decisions worth stating explicitly, matching this codebase's own convention:
 *
 * - **This drawer fetches `listApplicationAttempts()` itself**, rather than trusting a list passed
 *   down from `ApplicationsPage`. That page only keeps its own `attempts` state warm while the
 *   "Review queue" tab is open (see its polling effect); "Prepare interview" only ever appears on
 *   the Active/Archived/All table, where that state can be `null` or stale. Fetching here once, on
 *   mount, is the only way to guarantee the job-description snapshot this prompt builds from is
 *   the current one rather than whatever happened to be in memory from a different tab visit.
 * - **`savedJobs`/`cvDocuments`/`letters` are taken as props, not fetched again here.**
 *   `ApplicationsPage` already loads all three unconditionally on mount (its `loadLinkedRecords`
 *   effect), so re-fetching them here would just be a redundant round trip for data that is
 *   already in scope.
 * - **Generation is explicit, never automatic.** Opening this drawer does not start a run: the
 *   user presses "Generate prep pack" (mirroring `GapAnalysis.tsx`'s "Check ATS fit" button,
 *   the closest precedent this app has). Auto-running on every open would silently spend a real
 *   AI turn -- and, on `ApplicationAttemptDrawer`'s example, a read-only drawer is exactly the
 *   place a person expects nothing to happen just from opening it.
 * - **No auto-write-back of any kind.** This drawer never calls `updateApplication`,
 *   `updateCvDocument`, `updateLetter`, or creates anything. It only reads already-fetched
 *   records and renders AI output; the sole "keep this" affordance is copy-to-clipboard, matching
 *   the ticket's own non-goals for this slice.
 */
export function InterviewPrepDrawer({
  application,
  savedJobs,
  cvDocuments,
  letters,
  onClose,
}: InterviewPrepDrawerProps) {
  useEscapeToClose(onClose);
  const run = useAgentRun();

  const [attempts, setAttempts] = useState<ApplicationAttemptRecord[] | null>(null);
  const [attemptsError, setAttemptsError] = useState<string>();
  // The persisted preference, and the live provider-status list detection actually reports.
  // Neither is the provider a run goes through by itself -- see `resolveEffectiveProvider` below
  // (issue #400).
  const [preferredProvider, setPreferredProvider] = useState<ProviderId>('claude');
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [model, setModel] = useState('');
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [copyError, setCopyError] = useState<string>();
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(
    () => () => {
      if (copyTimeoutRef.current !== undefined) clearTimeout(copyTimeoutRef.current);
    },
    [],
  );

  // Best effort, matching every other linked-record lookup this feature relies on: a failed fetch
  // just means the prep pack proceeds without a job-description snapshot, stated as such by the
  // prompt builder itself, rather than blocking the drawer entirely.
  useEffect(() => {
    let cancelled = false;
    setAttempts(null);
    setAttemptsError(undefined);
    void window.workspace
      .listApplicationAttempts()
      .then((rows) => {
        if (!cancelled) setAttempts(rows);
      })
      .catch((err) => {
        if (!cancelled) {
          setAttempts([]);
          setAttemptsError(
            describeError(err, 'could not load the job description snapshot for this application'),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [application.id]);

  // The default provider is a settings preference (set from the AI Runtime page); a failure here
  // just leaves the Claude Code default in place rather than blocking the feature.
  useEffect(() => {
    let cancelled = false;
    void window.workspace
      .getSettings()
      .then((settings) => {
        if (!cancelled) setPreferredProvider(settings.defaultProvider);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Best effort: the model picker is a convenience, so a failed provider listing just hides it
  // rather than blocking the feature (the CLI's own default model is always a valid choice).
  // Fetched once, independent of the preference above: resolving the effective provider needs the
  // full list regardless of which provider ends up preferred.
  useEffect(() => {
    let cancelled = false;
    window.agentDock
      .listProviders()
      .then((list) => {
        if (!cancelled) setProviders(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // The provider a run through this drawer actually uses: the preference if it is installed, else
  // the one other installed CLI, else the preference unchanged (issue #400). Never written back to
  // settings -- purely a runtime choice for this render.
  const provider = resolveEffectiveProvider(preferredProvider, providers);
  const providerStatus = providers.find((p) => p.id === provider);

  const context = useMemo<InterviewPrepContext | null>(() => {
    const status = application.status;
    if (!INTERVIEW_PREPARABLE_STATUSES.has(status)) return null;

    const savedJob = application.savedJobId
      ? (savedJobs.find((job) => job.id === application.savedJobId) ?? null)
      : null;
    const cv = application.cvId ? (cvDocuments.find((doc) => doc.id === application.cvId) ?? null) : null;
    const letter = application.letterId
      ? (letters.find((row) => row.id === application.letterId) ?? null)
      : null;
    // Most-recently-updated attempt linked to this application, via the same comparator
    // `ApplicationsPage`'s own review queue already sorts by (`sortAttempts`) -- reused rather
    // than re-derived, so a future fix to tie-breaking/date-parsing only has one place to land. A
    // `null` `attempts` (still loading) resolves to no snapshot rather than throwing; the
    // "Generate" button stays disabled until the fetch above settles, so a run never actually goes
    // out built from this transient state.
    const attempt = sortAttempts((attempts ?? []).filter((row) => row.applicationId === application.id))[0] ?? null;

    return {
      role: application.role,
      company: application.company,
      location: application.location,
      status: status as InterviewPrepStage,
      nextStep: application.nextStep,
      contact: application.contact,
      notes: application.notes,
      savedJob: savedJob
        ? { salary: savedJob.salary, arrangement: savedJob.arrangement, verification: savedJob.verification }
        : null,
      jdSnapshot:
        attempt && attempt.jdSnapshot.trim().length > 0
          ? { text: attempt.jdSnapshot, complete: attempt.jdComplete }
          : null,
      cv: cv ? { name: cv.name, text: cv.text } : null,
      letter: letter ? { type: letter.type, body: letter.body } : null,
    };
  }, [application, savedJobs, cvDocuments, letters, attempts]);

  const attemptsLoaded = attempts !== null;
  const providerUnavailable = providerStatus && !providerStatus.installed;
  const providerLabel = PROVIDER_LABEL[provider];
  const availableModels = providerStatus?.availableModels ?? [];
  const canRun = !!context && attemptsLoaded && !providerUnavailable && !run.isBusy;
  const hasResult = run.text.trim().length > 0;

  const handleRun = useCallback(() => {
    if (!context) return;
    setCopyState('idle');
    setCopyError(undefined);
    const prompt = buildInterviewPrepPrompt(context);
    void run.start(prompt, {
      provider,
      ...(model ? { model } : {}),
    });
  }, [context, provider, model, run]);

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
    <div className="modal modal-open modal-end" role="dialog" aria-modal="true">
      <div className="modal-box flex max-w-md flex-col rounded-none p-0">
        <div className="flex items-center justify-between border-b border-base-300 px-5 py-3.5">
          <h2 className="text-sm font-semibold">
            Prepare interview <span className="text-base-content/60">for</span> {application.role}{' '}
            <span className="text-base-content/60">at</span> {application.company}
          </h2>
          <button type="button" aria-label="Close" className="btn btn-ghost btn-sm btn-circle" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <p className="text-sm text-base-content/60">
            Runs on your own authenticated {providerLabel} CLI. Review-only: nothing here is saved
            automatically.
          </p>

          {!context && (
            <div className="alert alert-warning text-sm" role="alert">
              Prepare interview is only available once this application has reached the recruiter
              screen or interview stage.
            </div>
          )}

          {context && (
            <>
              {providerUnavailable && (
                <div className="alert alert-error text-sm" role="alert">
                  {providerLabel} is not installed or not detected, so this cannot run. Install and
                  authenticate the CLI, or choose a different default in AI Runtime, then reopen
                  this drawer.
                </div>
              )}

              {attemptsError && (
                <div className="alert alert-error text-sm" role="alert">
                  {attemptsError}
                </div>
              )}

              {availableModels.length > 0 && (
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">Model</span>
                  <select className="select w-full" value={model} onChange={(e) => setModel(e.target.value)}>
                    <option value="">Provider default</option>
                    {availableModels.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <div className="flex flex-wrap items-center gap-2">
                <button className="btn btn-primary" type="button" onClick={handleRun} disabled={!canRun}>
                  {run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled'
                    ? 'Regenerate prep pack'
                    : 'Generate prep pack'}
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
              </div>

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
                label="Interview prep result"
                idleHint="No prep pack yet."
                busyLabel="Building your interview prep pack…"
                providerLabel={providerLabel}
              />
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-base-300 px-5 py-3.5">
          <button type="button" className="btn btn-outline" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <button type="button" className="modal-backdrop" aria-label="Close" onClick={onClose} />
    </div>
  );
}
