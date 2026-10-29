import { X } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApplicationAttemptRecord,
  ApplicationRecord,
  CvDocumentRecord,
  LetterRecord,
  SavedJobRecord,
} from '../../window.js';
import { PROVIDER_LABEL } from '../../provider-labels.js';
import { useEffectiveProvider } from '../../use-effective-provider.js';
import { AiOutput } from '../cv/AiOutput.js';
import { describeError, useAgentRun } from '../cv/useAgentRun.js';
import { Dialog } from '../shell/Dialog.js';
import { INTERVIEW_PREPARABLE_STATUSES } from './application-status.js';
import { sortAttempts } from './attempt-status.js';
import { buildInterviewPrepPrompt, type InterviewPrepContext, type InterviewPrepStage } from './interview-prep-prompt.js';
import { CompanyEvidencePanel } from './CompanyEvidencePanel.js';
import { SubmittedDocumentsPanel } from './SubmittedDocumentsPanel.js';
import { InterviewRoundsPanel } from './InterviewRoundsPanel.js';
import { basisSummary, defaultNextRoundId, roundsForPrep, submittedBasis } from './interview-context-labels.js';
import type { InterviewContextView } from '../../../electron/interview-context-types.js';
import type { CompanyEvidenceProseFact } from '../../../electron/company-evidence.js';
import { ErrorBanner, WarningBanner } from '../shell/index.js';

export interface InterviewPrepDrawerProps {
  application: ApplicationRecord;
  savedJobs: readonly SavedJobRecord[];
  cvDocuments: readonly CvDocumentRecord[];
  letters: readonly LetterRecord[];
  onClose: () => void;
}

type CopyState = 'idle' | 'copied' | 'failed';

/**
 * #691: the documents and rounds recorded for this application. `unavailable` = a build with no such
 * bridge (the drawer behaves exactly as #358 shipped it: current documents, labelled as current).
 */
type ContextState =
  | { status: 'loading' }
  | { status: 'ready'; view: InterviewContextView }
  | { status: 'unavailable' }
  | { status: 'failed'; message: string };
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
 *   `updateCvDocument`, `updateLetter`, or creates anything from the AI output; the sole "keep this"
 *   affordance for a prep pack is copy-to-clipboard.
 * - **#691: the recorded documents come first.** `window.interviewContext` returns the packages of
 *   THIS application only (by its own attempts, never by company name or the latest attempt at the
 *   employer). The selected package's document text, version, fingerprint and how it is known go to
 *   the prompt; the current linked CV/letter are used only as a labelled fallback. The two panels
 *   below write only when the person presses Save (their statement about what they sent, or a round
 *   they record), and never touch the application status, the CV, the letter or the notes.
 */
export function InterviewPrepDrawer({
  application,
  savedJobs,
  cvDocuments,
  letters,
  onClose,
}: InterviewPrepDrawerProps) {
  const run = useAgentRun();

  const [attempts, setAttempts] = useState<ApplicationAttemptRecord[] | null>(null);
  const [attemptsError, setAttemptsError] = useState<string>();
  const { provider, providerStatus } = useEffectiveProvider();
  // #689: sourced company facts the support policy approved, or undefined until they have loaded (and
  // on a build with no such bridge, where the prompt says nothing about company evidence at all).
  const [companyEvidence, setCompanyEvidence] = useState<CompanyEvidenceProseFact[] | undefined>(undefined);
  const [evidenceVersion, setEvidenceVersion] = useState(0);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [copyError, setCopyError] = useState<string>();
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const [recorded, setRecorded] = useState<ContextState>({ status: 'loading' });
  const [selectedPackageId, setSelectedPackageId] = useState<string | null>(null);
  const [nextRoundId, setNextRoundId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [generatedFrom, setGeneratedFrom] = useState<string>();
  // Only the newest load may land: switching application (or a save) while a read is in flight must
  // never show the older answer for the newer state.
  const loadSeq = useRef(0);

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
            describeError(err, 'could not load the saved job description for this application'),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [application.id]);

  // The application this drawer shows right now: a save that finishes after a switch must not land.
  const currentApplicationId = useRef(application.id);
  currentApplicationId.current = application.id;

  // #691: one read, and every later view comes back from the save that changed it.
  const applyView = useCallback((view: InterviewContextView) => {
    if (view.applicationId !== currentApplicationId.current) return;
    loadSeq.current += 1;
    setRecorded({ status: 'ready', view });
    setSelectedPackageId((current) =>
      current && view.packages.some((pkg) => pkg.id === current) ? current : view.defaultPackageId,
    );
    setNextRoundId((current) =>
      current && view.rounds.some((round) => round.id === current && round.state === 'planned')
        ? current
        : defaultNextRoundId(view.rounds),
    );
  }, []);

  useEffect(() => {
    const seq = ++loadSeq.current;
    setRecorded({ status: 'loading' });
    setSelectedPackageId(null);
    setNextRoundId(null);
    setGeneratedFrom(undefined);
    if (typeof window.interviewContext?.get !== 'function') {
      setRecorded({ status: 'unavailable' });
      return undefined;
    }
    void window.interviewContext
      .get(application.id)
      .then((result) => {
        if (seq !== loadSeq.current) return;
        if (result.ok) applyView(result.view);
        else setRecorded({ status: 'failed', message: result.message });
      })
      .catch(() => {
        if (seq === loadSeq.current) setRecorded({ status: 'failed', message: 'The documents you sent could not be read.' });
      });
    return () => {
      loadSeq.current += 1;
    };
  }, [application.id, applyView]);

  useEffect(() => {
    let cancelled = false;
    setCompanyEvidence(undefined);
    if (typeof window.companyEvidence?.prose !== 'function') return undefined;
    void window.companyEvidence
      .prose({ applicationId: application.id })
      .then((result) => {
        if (!cancelled) setCompanyEvidence(result.ok ? result.facts : []);
      })
      .catch(() => {
        // Evidence is optional: fail to "none on file", never to an unchecked list.
        if (!cancelled) setCompanyEvidence([]);
      });
    return () => {
      cancelled = true;
    };
  }, [application.id, evidenceVersion]);

  const view = recorded.status === 'ready' ? recorded.view : null;
  const selectedPackage = view?.packages.find((pkg) => pkg.id === selectedPackageId) ?? null;
  // A package with no listed document (a hand-tracked row nobody has described yet) is no basis at all:
  // the current documents are used, labelled as current.
  const basisPackage = selectedPackage && selectedPackage.documents.length > 0 ? selectedPackage : null;

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
    // #691: a selected package brings its own posting text, verified against the hash it recorded.
    const packagePosting =
      basisPackage && basisPackage.posting.text && basisPackage.posting.matches !== false
        ? { text: basisPackage.posting.text, complete: basisPackage.posting.complete ?? false }
        : null;
    const fallbackPosting =
      attempt && attempt.jdSnapshot.trim().length > 0 ? { text: attempt.jdSnapshot, complete: attempt.jdComplete } : null;

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
      jdSnapshot: basisPackage ? (basisPackage.posting.matches === false ? null : (packagePosting ?? fallbackPosting)) : fallbackPosting,
      cv: cv ? { name: cv.name, text: cv.text } : null,
      letter: letter ? { type: letter.type, body: letter.body } : null,
      ...(companyEvidence === undefined ? {} : { companyEvidence }),
      staleLinks: { cv: !!application.cvId && !cv, letter: !!application.letterId && !letter },
      ...(basisPackage ? { submitted: submittedBasis(basisPackage) } : {}),
      ...(view ? { rounds: roundsForPrep(view.rounds, nextRoundId) } : {}),
    };
  }, [application, savedJobs, cvDocuments, letters, attempts, companyEvidence, basisPackage, view, nextRoundId]);

  const linked = {
    cv: !!application.cvId && cvDocuments.some((doc) => doc.id === application.cvId),
    letter: !!application.letterId && letters.some((row) => row.id === application.letterId),
  };
  const priorRoundCount = view ? view.rounds.filter((round) => round.state === 'held').length : 0;
  const basisLine = basisSummary(basisPackage, linked, priorRoundCount);
  const mustChoose = view?.selection === 'choose' && !selectedPackage;

  const attemptsLoaded = attempts !== null;
  const providerUnavailable = providerStatus && !providerStatus.installed;
  const providerLabel = PROVIDER_LABEL[provider];
  const canRun =
    !!context && attemptsLoaded && recorded.status !== 'loading' && !saving && !mustChoose && !providerUnavailable && !run.isBusy;
  const hasResult = run.text.trim().length > 0;

  const handleRun = useCallback(() => {
    if (!context) return;
    setCopyState('idle');
    setCopyError(undefined);
    const prompt = buildInterviewPrepPrompt(context);
    // The label of a result is the basis it was built from, captured now: a later change of selection
    // or a new round never relabels a pack that was already generated.
    setGeneratedFrom(basisLine);
    void run.start(prompt, {
      provider,
    });
  }, [context, provider, run, basisLine]);

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
    <Dialog
      aria-label={`Prepare interview for ${application.role} at ${application.company}`}
      placement="end"
      boxClassName="flex max-w-md flex-col rounded-none p-0"
      onClose={onClose}
    >
        <div className="flex items-center justify-between border-b border-base-300 px-5 py-3.5">
          <h2 className="text-sm font-semibold">
            Prepare interview <span className="text-base-content/60">for</span> {application.role}{' '}
            <span className="text-base-content/60">at</span> {application.company}
          </h2>
          <button type="button" aria-label="Close" className="btn btn-ghost btn-sm btn-circle" onClick={onClose}>
            <X size={16} weight="bold" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <p className="text-sm text-base-content/60">
            Made with {providerLabel} on this computer. Copy what you want to keep. Nothing is saved
            automatically.
          </p>

          {!context && (
            <WarningBanner>
              Prepare interview is only available once this application has reached the recruiter
              screen or interview stage.
            </WarningBanner>
          )}

          {context && (
            <>
              {providerUnavailable && (
                <ErrorBanner>
                  {providerLabel} is not set up yet. Set it up in Settings, then reopen this.
                </ErrorBanner>
              )}

              {attemptsError && (
                <ErrorBanner>
                  {attemptsError}
                </ErrorBanner>
              )}

              {recorded.status === 'failed' && (
                <ErrorBanner>
                  {recorded.message} The prep pack uses your current CV and letter and says they may differ from
                  what you sent.
                </ErrorBanner>
              )}

              {view && (
                <SubmittedDocumentsPanel
                  applicationId={application.id}
                  view={view}
                  selectedId={selectedPackageId}
                  onSelect={setSelectedPackageId}
                  onView={applyView}
                  linked={linked}
                  disabled={run.isBusy || saving}
                  onBusyChange={setSaving}
                />
              )}

              {view && (
                <InterviewRoundsPanel
                  applicationId={application.id}
                  rounds={view.rounds}
                  nextRoundId={nextRoundId}
                  onNextRoundChange={setNextRoundId}
                  onView={applyView}
                  disabled={run.isBusy || saving}
                  onBusyChange={setSaving}
                />
              )}

              <CompanyEvidencePanel
                target={{ applicationId: application.id }}
                reloadKey={application.id}
                onChanged={() => setEvidenceVersion((version) => version + 1)}
              />

              <p className="text-xs text-base-content/70" data-testid="prep-basis">
                {recorded.status === 'loading' ? 'Reading the documents you sent…' : `This prep pack uses: ${basisLine}`}
              </p>

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
                <ErrorBanner>
                  {copyError}
                </ErrorBanner>
              )}
              {copyState === 'copied' && (
                <span className="text-sm font-medium" role="status">
                  Copied
                </span>
              )}

              {generatedFrom && hasResult && (
                <p className="text-xs text-base-content/70" data-testid="prep-generated-from">
                  Built from: {generatedFrom}
                </p>
              )}

              <AiOutput
                status={run.status}
                text={run.text}
                {...(run.error ? { error: run.error } : {})}
                label="Interview prep result"
                idleHint="No prep pack yet."
                busyLabel="Building your interview prep pack…"
                providerId={provider}
                onRetry={handleRun}
              />
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-base-300 px-5 py-3.5">
          <button type="button" className="btn btn-outline" onClick={onClose}>
            Close
          </button>
        </div>
    </Dialog>
  );
}
