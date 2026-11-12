import { useState } from 'react';
import type { BlindApplyEvidenceView, BlindApplyFeedItem } from '../../../electron/blind-apply-types.js';
import { BLIND_APPLY_INTERVENTION_LABELS } from '../../../electron/blind-apply-types.js';
import { BlindApplyNeedsAnswerCard } from './BlindApplyNeedsAnswerCard.js';
import { useBlindApply } from './use-blind-apply.js';

export interface BlindApplyFeedProps {
  /** Called after "Open" starts or finds the item's application, with its id, so the page can open
   * it in the Review & apply workspace (#657). */
  onOpened?: (attemptId: string) => void;
}

const BADGE_CLASS: Record<string, string> = {
  Submitted: 'badge-success',
  'Could not submit': 'badge-error',
  "Sent? Couldn't confirm": 'badge-warning',
  'Needs one answer': 'badge-warning',
  'Needs you': 'badge-warning',
};

function EvidenceDetails({ itemId }: { itemId: string }) {
  const [evidence, setEvidence] = useState<BlindApplyEvidenceView | null | undefined>(undefined);

  return (
    <details
      className="mt-2 text-xs"
      onToggle={(event) => {
        if ((event.currentTarget as HTMLDetailsElement).open && evidence === undefined) {
          void window.blindApply.evidence(itemId).then(setEvidence, () => setEvidence(null));
        }
      }}
    >
      <summary className="cursor-pointer text-base-content/70">Details</summary>
      {evidence === undefined && <p className="mt-1">Loading…</p>}
      {evidence === null && <p className="mt-1">No details were recorded.</p>}
      {evidence && (
        <div className="mt-1 space-y-2">
          {evidence.receipt && (
            <section aria-label="Receipt">
              <h4 className="font-semibold">Receipt</h4>
              <p>{evidence.receipt.outcome === 'submitted' ? 'The site showed a confirmation.' : evidence.receipt.detail}</p>
              {evidence.receipt.evidenceReference && <p>Seen on the page: {evidence.receipt.evidenceReference}</p>}
              <p>Sent to: {evidence.receipt.destination}</p>
              <p>Seen at: {new Date(evidence.receipt.observedAt).toLocaleString()}</p>
            </section>
          )}
          <section aria-label="Documents">
            <h4 className="font-semibold">Documents sent</h4>
            <p>CV: {evidence.documents.cvHash ? `fingerprint ${evidence.documents.cvHash.slice(0, 12)}` : 'none recorded'}</p>
            <p>Letter: {evidence.documents.letterHash ? `fingerprint ${evidence.documents.letterHash.slice(0, 12)}` : 'none'}</p>
          </section>
          {evidence.answers.length > 0 && (
            <section aria-label="Answers used">
              <h4 className="font-semibold">Answers used</h4>
              <ul className="list-disc pl-4">
                {evidence.answers.map((answer) => (
                  <li key={`${answer.label}-${answer.answerId ?? answer.provenance}`}>
                    {answer.label}: {answer.provenance === 'saved_answer' ? 'an answer you saved' : answer.provenance === 'cv' ? 'from your CV' : 'from your saved details'}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section aria-label="History">
            <h4 className="font-semibold">History</h4>
            <ol className="list-decimal pl-4">
              {evidence.events.map((event, index) => (
                <li key={`${event.at}-${index}`}>
                  {new Date(event.at).toLocaleString()}: {event.detail || event.to}
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </details>
  );
}

function FeedRow({ item, onChanged, onOpened }: { item: BlindApplyFeedItem; onChanged: () => void; onOpened?: (attemptId: string) => void }) {
  const [opening, setOpening] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);

  async function open(): Promise<void> {
    setOpening(true);
    setOpenFailed(false);
    const result = await window.blindApply.open(item.id).catch(() => ({ ok: false as const }));
    setOpening(false);
    if (result.ok) onOpened?.(result.attemptId);
    else setOpenFailed(true);
    onChanged();
  }

  const explanation = item.intervention ? BLIND_APPLY_INTERVENTION_LABELS[item.intervention] : item.detail;

  return (
    <li className="py-3" data-testid="blind-apply-item">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {item.role} <span className="font-normal text-base-content/70">at {item.company}</span>
          </p>
          {explanation && <p className="mt-0.5 text-xs text-base-content/70">{explanation}</p>}
        </div>
        <div className="flex flex-none items-center gap-2">
          <span className={`badge badge-sm ${BADGE_CLASS[item.label] ?? 'badge-ghost'}`}>{item.label}</span>
          {item.open && (
            <button type="button" className="btn btn-outline btn-xs" disabled={opening} onClick={() => void open()}>
              Open
            </button>
          )}
        </div>
      </div>
      {openFailed && (
        <p role="alert" className="mt-1 text-xs text-error">
          That one could not be opened right now.
        </p>
      )}
      {item.state === 'needs_answer' && (
        <BlindApplyNeedsAnswerCard
          item={item}
          onSubmit={async (answers, remember) => {
            const result = await window.blindApply.answer({ itemId: item.id, answers, remember });
            onChanged();
            return result.ok;
          }}
        />
      )}
      <EvidenceDetails itemId={item.id} />
    </li>
  );
}

/**
 * The one compact Blind Apply activity feed and its one Stop control (#722). Renders nothing until Blind
 * Apply has been turned on at least once, so a person who never uses it never sees it.
 *
 * Plain words only: the labels are the fixed set in `blind-apply-types.ts`. Evidence (receipt, documents,
 * answers used, history) is behind "Details" and is fetched only when opened. There is no limit control and
 * no per-job approval anywhere in it.
 */
export function BlindApplyFeed({ onOpened }: BlindApplyFeedProps) {
  const { status, feed, error, refresh } = useBlindApply();
  const [stopping, setStopping] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (!status || (!status.active && feed.length === 0)) return null;

  const skipped = status.counts.skipped;

  async function stop(): Promise<void> {
    setStopping(true);
    await window.blindApply.stop().catch(() => undefined);
    setStopping(false);
    await refresh();
  }

  async function confirmAgain(): Promise<void> {
    setConfirming(true);
    await window.blindApply.enable().catch(() => undefined);
    setConfirming(false);
    await refresh();
  }

  return (
    <section aria-label="Blind Apply activity" className="mb-6 rounded-box border border-base-300 p-4" data-testid="blind-apply-feed">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Blind Apply</h2>
          <p className="text-xs text-base-content/70" role="status">
            {status.active ? 'On. Applying to matching frontend roles without asking about each one.' : 'Off.'}
            {status.active && status.supported.real.length === 0 && ' It can only send to the local test form right now; everything else says Apply yourself.'}
          </p>
        </div>
        {status.active && (
          <button type="button" className="btn btn-error btn-sm" onClick={() => void stop()} disabled={stopping}>
            Stop Blind Apply
          </button>
        )}
      </div>

      {status.paused && (
        <div role="alert" className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
          <span>{status.paused.detail}</span>
          <button type="button" className="btn btn-outline btn-sm" onClick={() => void confirmAgain()} disabled={confirming}>
            Confirm again
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm text-error">
          {error}
        </p>
      )}

      {feed.length === 0 ? (
        <p className="mt-3 text-sm text-base-content/70">Nothing yet. Matching roles will show up here.</p>
      ) : (
        <ul className="mt-3 divide-y divide-base-300" aria-label="Blind Apply results">
          {feed.map((item) => (
            <FeedRow key={item.id} item={item} onChanged={() => void refresh()} {...(onOpened ? { onOpened } : {})} />
          ))}
        </ul>
      )}
      {skipped > 0 && <p className="mt-3 text-xs text-base-content/60">{skipped} skipped (closed, already applied, or outside your filters).</p>}
    </section>
  );
}
