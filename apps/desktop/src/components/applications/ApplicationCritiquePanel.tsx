import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  CritiqueActionResult,
  CritiqueView,
  FindingView,
  ProposalView,
} from '../../../electron/application-critique-types.js';
import { Eyebrow } from '../shell/Eyebrow.js';

export interface ApplicationCritiquePanelProps {
  attemptId: string;
  /** The attempt's checkpoint, only to say truthfully what accepting a suggestion will close. */
  checkpoint: string;
  /** Changes whenever the surrounding record changes, so the stored review is read again. */
  reloadKey?: string | number;
  /** Fired after a suggestion was applied, so the page can refresh the attempt it describes. */
  onRevised?: () => void;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; view: CritiqueView };

const INTRO =
  'A second, separate AI session reads your CV, your letter and the job description and points out problems. It uses one AI request. It cannot add skills, achievements, metrics or dates, and it changes nothing unless you accept a suggestion.';

const EVIDENCE_LABEL = {
  jd: 'From the job description',
  cv_draft: 'From your CV',
  cover_letter_draft: 'From your cover letter',
  motivation_letter_draft: 'From your motivation letter',
} as const;

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function Pill({ tone, children }: { tone: 'neutral' | 'info' | 'success' | 'warning' | 'error'; children: ReactNode }) {
  const cls = { neutral: 'badge-neutral', info: 'badge-info', success: 'badge-success', warning: 'badge-warning', error: 'badge-error' }[tone];
  return <span className={`badge badge-soft badge-sm ${cls}`}>{children}</span>;
}

function EvidenceList({ finding }: { finding: FindingView }) {
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-base-content/70">
      {finding.evidence.map((item, index) => (
        <li key={`${finding.id}-${index}`}>
          {item.source === 'cv_fact' ? (
            <>Your reviewed CV says: “{item.text}”</>
          ) : item.source === 'company_fact' ? (
            <>Approved company fact: “{item.text}”</>
          ) : item.source === 'gap' ? (
            <>Nothing in your reviewed CV covers this: {item.note}</>
          ) : (
            <>
              {EVIDENCE_LABEL[item.source]}: “{item.quote}”
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function FindingItem({ finding }: { finding: FindingView }) {
  return (
    <li className={`rounded-box border border-base-300 p-2.5 ${finding.current ? '' : 'bg-base-200'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={finding.current ? 'warning' : 'neutral'}>{finding.label}</Pill>
        {!finding.current && <Pill tone="neutral">Earlier version</Pill>}
      </div>
      <p className={`mt-1 text-sm ${finding.current ? '' : 'text-base-content/60'}`}>{finding.summary}</p>
      <EvidenceList finding={finding} />
      {finding.suggestion && finding.current && (
        <p className="mt-1 text-xs text-base-content/70">Reviewer’s idea (not applied): {finding.suggestion}</p>
      )}
      {!finding.current && (
        <p className="mt-1 text-xs text-base-content/70">
          This was true of an earlier version ({finding.outdatedBecause.join(', ')}) and may no longer apply. Review again for a current answer.
        </p>
      )}
    </li>
  );
}

/** The honest tail of a shortened list: the stored total, not the length of what is shown. */
function moreNotListed(count: number, noun: 'reason' | 'change' | 'item'): string {
  return `${count} more ${noun}${count === 1 ? '' : 's'} not listed here.`;
}

function ProposalCard({
  proposal,
  busy,
  closesForm,
  onAccept,
  onReject,
}: {
  proposal: ProposalView;
  busy: boolean;
  closesForm: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  const label = proposal.label;
  return (
    <li className="rounded-box border border-base-300 p-2.5">
      <p className="text-sm font-medium">Suggested change to your {label}</p>
      {proposal.status === 'refused' && (
        <div className="mt-1 text-xs text-base-content/70">
          <p>This suggestion was not offered because it did not pass the checks against your reviewed CV:</p>
          <ul className="list-disc pl-4">
            {proposal.reasons.map((reason, index) => (
              <li key={index}>{reason}</li>
            ))}
            {proposal.reasonsOmitted > 0 && <li>{moreNotListed(proposal.reasonsOmitted, 'reason')}</li>}
          </ul>
        </div>
      )}
      {proposal.status !== 'refused' && (
        <>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-base-content/80">
            {proposal.changes.map((change, index) => (
              <li key={index}>{change}</li>
            ))}
            {proposal.changesOmitted > 0 && (
              <li>
                {moreNotListed(proposal.changesOmitted, 'change')} Read the revised {label} for all of them.
              </li>
            )}
          </ul>
          {proposal.preview && (
            <details className="mt-1.5">
              <summary className="cursor-pointer text-xs font-medium">Read the revised {label}</summary>
              <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-box bg-base-200 p-2 text-xs">{proposal.preview}</pre>
            </details>
          )}
        </>
      )}
      {proposal.status === 'accepted' && (
        <p className="mt-1.5 text-xs text-base-content/70">
          Applied as version {proposal.acceptedVersion}. The earlier version is kept. This does not change what was already sent anywhere.
        </p>
      )}
      {proposal.status === 'rejected' && <p className="mt-1.5 text-xs text-base-content/70">You declined this suggestion. Nothing was changed.</p>}
      {proposal.status === 'pending' && !proposal.current && (
        <p className="mt-1.5 text-xs text-base-content/70">
          This no longer applies because {proposal.outdatedBecause.join(', ')} changed after the review. Review again to get a current suggestion.
        </p>
      )}
      {proposal.acceptable && (
        <>
          {closesForm && (
            <p className="mt-1.5 text-xs text-base-content/70">
              The prepared application form already holds the earlier file, so accepting closes it. You then prepare the application again to attach the revised documents.
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={onAccept}>
              Use this {label}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onReject}>
              Not now
            </button>
          </div>
        </>
      )}
    </li>
  );
}

const LAST_RUN_TONE = { reviewed: 'info', failed: 'error', cancelled: 'warning', timed_out: 'warning', provider_limit: 'warning', invalid_output: 'error', discarded: 'warning' } as const;

/**
 * "Review this application" on the application detail drawer (#690). It reads the stored review through
 * `window.applicationCritique` (a local read: opening it never starts a session) and offers one explicit
 * action. Findings are shown with the evidence the app itself verified; suggestions are shown as a diff
 * and a full read of the revised document, and only a click on "Use this" applies one.
 */
export function ApplicationCritiquePanel({ attemptId, checkpoint, reloadKey, onRevised }: ApplicationCritiquePanelProps) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  // True from the click on "Review this application" until its answer arrives (the main process holds it).
  const [reviewing, setReviewing] = useState(false);
  const [notice, setNotice] = useState<string>();
  const generation = useRef(0);
  const attemptRef = useRef(attemptId);
  attemptRef.current = attemptId;

  const apply = useCallback((result: CritiqueActionResult, mine: number): void => {
    // A response for an application the panel has since moved away from is dropped, so a slow answer
    // can never paint another application's review.
    if (mine !== generation.current) return;
    if (result.ok) {
      setState({ status: 'ready', view: result.view });
      return;
    }
    setNotice(result.message);
    if (result.view) setState({ status: 'ready', view: result.view });
    else setState((current) => (current.status === 'ready' ? current : { status: 'error', message: result.message }));
  }, []);

  const load = useCallback(async () => {
    const mine = (generation.current += 1);
    if (typeof window.applicationCritique?.get !== 'function') {
      setState({ status: 'error', message: '' });
      return;
    }
    try {
      apply(await window.applicationCritique.get(attemptRef.current), mine);
    } catch {
      if (mine === generation.current) setState({ status: 'error', message: 'We could not load the review.' });
    }
  }, [apply]);

  useEffect(() => {
    setState({ status: 'loading' });
    setNotice(undefined);
    setBusy(false);
    setReviewing(false);
    void load();
    return () => {
      generation.current += 1;
    };
  }, [attemptId, reloadKey, load]);

  // While a review runs in the main process, keep the panel honest about it without starting anything.
  const running = state.status === 'ready' && state.view.running;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [running, load]);

  async function act(task: () => Promise<CritiqueActionResult>, revised = false, isReview = false): Promise<void> {
    const mine = generation.current;
    setBusy(true);
    if (isReview) setReviewing(true);
    setNotice(undefined);
    try {
      const result = await task();
      apply(result, mine);
      if (revised && result.ok) onRevised?.();
    } catch {
      if (mine === generation.current) setNotice('Something went wrong. Your documents were not changed.');
    } finally {
      if (mine === generation.current) {
        setBusy(false);
        setReviewing(false);
      }
    }
  }

  if (state.status === 'loading') {
    return <p className="text-sm text-base-content/60">Loading the review…</p>;
  }
  if (state.status === 'error') {
    // A bridge from an older build says nothing rather than failing the drawer around it.
    return state.message ? <p className="text-sm text-error">{state.message}</p> : null;
  }

  const { view } = state;
  const review = view.review;
  const lastRunAfterReview =
    view.lastRun && view.lastRun.outcome !== 'reviewed' && (!review || view.lastRun.at > review.reviewedAt) ? view.lastRun : null;
  const closesForm = checkpoint === 'ready';
  const inProgress = reviewing || view.running;

  return (
    <section aria-labelledby={`critique-title-${attemptId}`} className="space-y-2.5 rounded-box border border-base-300 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Eyebrow as="h3">
          <span id={`critique-title-${attemptId}`}>Independent review</span>
        </Eyebrow>
        {review && review.state !== 'current' && <Pill tone="warning">{review.state === 'outdated' ? 'Out of date' : 'Partly out of date'}</Pill>}
      </div>

      {view.documents.length > 0 && (
        <p className="text-xs text-base-content/60">
          Reads: {view.documents.map((document) => `${document.label} (version ${document.version})`).join(', ')}.
        </p>
      )}

      {!inProgress && view.unavailable && <p className="text-sm text-base-content/70">{view.unavailable.message}</p>}
      {!inProgress && !view.unavailable && !review && <p className="text-sm text-base-content/70">{INTRO}</p>}

      <div role="status" aria-live="polite" className="space-y-2">
        {inProgress && <p className="text-sm">Reviewing your application… this can take a minute. Your documents are not being changed.</p>}
        {notice && <p className="text-sm text-base-content/80">{notice}</p>}
        {lastRunAfterReview && !notice && (
          <p className={`text-sm ${LAST_RUN_TONE[lastRunAfterReview.outcome] === 'error' ? 'text-error' : 'text-base-content/80'}`}>
            The last review ({formatDateTime(lastRunAfterReview.at)}): {lastRunAfterReview.detail}
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {inProgress ? (
          <button type="button" className="btn btn-outline btn-sm" onClick={() => void window.applicationCritique.cancel(attemptId)}>
            Cancel review
          </button>
        ) : (
          view.canReview && (
            <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => void act(() => window.applicationCritique.run(attemptId), false, true)}>
              {review ? 'Review again' : 'Review this application'}
            </button>
          )
        )}
      </div>

      {review && (
        <div className="space-y-2.5">
          <p className="text-xs text-base-content/60">
            Reviewed {formatDateTime(review.reviewedAt)} · {review.calls} AI request{review.calls === 1 ? '' : 's'}
            {review.tokens ? ` · ${review.tokens.inputTokens ?? '?'} tokens in, ${review.tokens.outputTokens ?? '?'} out (as reported)` : ' · token usage not reported'}
          </p>
          {review.state !== 'current' && (
            <p className="text-sm text-base-content/80">
              {review.outdatedBecause.join(', ')} changed after this review, so the parts that depended on it are marked as an earlier version.
            </p>
          )}
          {review.noFindings && <p className="text-sm">No problems found. Your documents were left exactly as they are.</p>}
          {!review.noFindings && review.findings.length === 0 && (
            <p className="text-sm">No finding could be backed by evidence the app can check, so none is shown. Your documents were not changed.</p>
          )}
          {review.findings.length > 0 && (
            <ul className="space-y-2" aria-label="Review findings">
              {review.findings.map((finding) => (
                <FindingItem key={finding.id} finding={finding} />
              ))}
            </ul>
          )}
          {review.proposals.length > 0 && (
            <ul className="space-y-2" aria-label="Suggested changes">
              {review.proposals.map((proposal) => (
                <ProposalCard
                  key={`${proposal.document}-${proposal.baseContentHash}`}
                  proposal={proposal}
                  busy={busy}
                  closesForm={closesForm}
                  onAccept={() =>
                    void act(
                      () =>
                        window.applicationCritique.accept({
                          attemptId,
                          runId: review.runId,
                          document: proposal.document,
                          baseContentHash: proposal.baseContentHash,
                        }),
                      true,
                    )
                  }
                  onReject={() =>
                    void act(() =>
                      window.applicationCritique.reject({
                        attemptId,
                        runId: review.runId,
                        document: proposal.document,
                        baseContentHash: proposal.baseContentHash,
                      }),
                    )
                  }
                />
              ))}
            </ul>
          )}
          {review.refused.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs font-medium">
                Left out because it could not be checked ({review.refused.length + review.refusedOmitted})
              </summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-base-content/70">
                {review.refused.map((entry, index) => (
                  <li key={index}>
                    {entry.summary ? `“${entry.summary}”: ` : ''}
                    {entry.reason}.
                  </li>
                ))}
                {review.refusedOmitted > 0 && <li>{moreNotListed(review.refusedOmitted, 'item')}</li>}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
