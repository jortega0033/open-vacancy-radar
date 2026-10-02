import { useCallback, useEffect, useState } from 'react';
import {
  findCvFactConflicts,
  editCvWordingVariant,
  proposeWordingFromFacts,
  supersedeCvFact,
} from '../../../electron/workspace/cv-evidence-schema.js';
import type {
  CvApprovedWording,
  CvEvidenceFact,
  CvEvidenceOverlayPatch,
  CvEvidenceOverlayRecord,
  CvFactOwnership,
  CvSourceDocument,
} from '../../window.js';
import { sourceAnchors } from './source-anchors.js';
import type { VacancyLead } from './types.js';
import { describeError } from './useAgentRun.js';
import { caseKeyFor } from './vacancy-key.js';

export interface EvidenceReviewProps {
  cvId: string | null;
  vacancy: VacancyLead | null;
  sourceCv?: CvSourceDocument | null;
}

const OWNERSHIP_LABEL: Record<CvFactOwnership, string> = {
  sole: 'I did this alone',
  shared: 'Shared with a team',
  unknown: 'Not stated',
};

function provenanceLabel(fact: CvEvidenceFact): string {
  if (fact.verification === 'candidate_confirmed_gap') return 'Your statement that this was not your work';
  if (fact.verification === 'unreviewed') return 'Proposed by a connected app. You have not confirmed it yet.';
  if (fact.sourceKind === 'repository_inspection') {
    return 'Repository inspection. It can corroborate how something was built, but not that you wrote it or that it ran in production.';
  }
  return fact.verification === 'corroborated' ? 'Corroborated' : 'Self-reported by you';
}

interface FactCorrection {
  activity: string;
  mechanism: string;
  result: string;
  timePhase: string;
  ownership: CvFactOwnership;
}

/**
 * The per-fact and per-wording review (#419, step 7). Every distilled fact is shown with the role or
 * project it belongs to, the client relationship, the time phase, ownership, mechanism, result,
 * provenance and the basis for any number, and the candidate approves, rejects or corrects it. A
 * correction supersedes the old fact (kept in the history) and withdraws every wording that cited
 * it. Wording is proposed from approved facts as drafts; the candidate approves the exact displayed
 * text one variant at a time, and editing a variant creates a new one.
 *
 * Every write goes through `updateCvEvidenceOverlay`, where the main process enforces the same rules
 * again, so nothing shown here is trusted just because this component sent it.
 */
export function EvidenceReview({ cvId, vacancy, sourceCv }: EvidenceReviewProps) {
  const [overlay, setOverlay] = useState<CvEvidenceOverlayRecord | null>(null);
  const [error, setError] = useState<string>();
  const [correcting, setCorrecting] = useState<{ factId: string; values: FactCorrection } | null>(null);
  const [editing, setEditing] = useState<{ variantId: string; text: string } | null>(null);
  const [notice, setNotice] = useState<string>();

  const vacancyKey = vacancy ? caseKeyFor(vacancy) : null;
  const anchors = sourceAnchors(sourceCv);

  useEffect(() => {
    setError(undefined);
    setNotice(undefined);
    if (!cvId || !vacancyKey) {
      setOverlay(null);
      return;
    }
    let cancelled = false;
    void window.workspace
      .getCvEvidenceOverlay(cvId, vacancyKey)
      .then((record) => {
        if (!cancelled) setOverlay(record);
      })
      .catch((err) => {
        if (!cancelled) setError(describeError(err, 'could not load this case’s facts'));
      });
    return () => {
      cancelled = true;
    };
  }, [cvId, vacancyKey]);

  /** Re-reads the overlay, builds a patch from that fresh copy, and saves it. The sibling panels
   * write to the same row, so a patch built from this component's own state could undo theirs. */
  const mutate = useCallback(
    async (build: (fresh: CvEvidenceOverlayRecord) => CvEvidenceOverlayPatch | null, failure: string) => {
      if (!cvId || !vacancyKey) return;
      setError(undefined);
      setNotice(undefined);
      try {
        const fresh = await window.workspace.getCvEvidenceOverlay(cvId, vacancyKey);
        if (!fresh) return;
        const patch = build(fresh);
        if (!patch) {
          setOverlay(fresh);
          return;
        }
        setOverlay(await window.workspace.updateCvEvidenceOverlay(fresh.id, patch));
      } catch (err) {
        setError(describeError(err, failure));
        const refreshed = await window.workspace.getCvEvidenceOverlay(cvId, vacancyKey).catch(() => null);
        if (refreshed) setOverlay(refreshed);
      }
    },
    [cvId, vacancyKey],
  );

  const setFactApproval = useCallback(
    (factId: string, approval: 'approved' | 'rejected') =>
      mutate(
        (fresh) => ({ facts: fresh.facts.map((fact) => (fact.factId === factId ? { ...fact, approval } : fact)) }),
        approval === 'approved' ? 'could not approve that fact' : 'could not reject that fact',
      ),
    [mutate],
  );

  const saveCorrection = useCallback(
    async (factId: string, values: FactCorrection) => {
      await mutate((fresh) => {
        const next = supersedeCvFact(fresh, factId, values, new Date().toISOString());
        return { facts: next.facts, wordingVariants: next.wordingVariants };
      }, 'could not save that correction');
      setCorrecting(null);
    },
    [mutate],
  );

  const setVariantStatus = useCallback(
    (variantId: string, status: 'candidate_approved' | 'rejected') =>
      mutate(
        (fresh) => ({
          wordingVariants: fresh.wordingVariants.map((variant) => (variant.variantId === variantId ? { ...variant, status } : variant)),
        }),
        status === 'candidate_approved' ? 'could not approve that wording' : 'could not reject that wording',
      ),
    [mutate],
  );

  const saveEditedVariant = useCallback(
    async (variantId: string, text: string) => {
      await mutate((fresh) => ({ wordingVariants: editCvWordingVariant(fresh.wordingVariants, variantId, text).wordingVariants }), 'could not save that wording');
      setEditing(null);
    },
    [mutate],
  );

  const proposeWording = useCallback(async () => {
    await mutate((fresh) => {
      const proposed = proposeWordingFromFacts(fresh);
      if (proposed.length === 0) {
        setNotice('There is no approved fact left without wording.');
        return null;
      }
      return { wordingVariants: [...fresh.wordingVariants, ...proposed] };
    }, 'could not propose wording');
  }, [mutate]);

  if (!cvId || !vacancy || !overlay) return null;
  if (overlay.facts.length === 0 && overlay.wordingVariants.length === 0) return null;

  const factById = new Map(overlay.facts.map((fact) => [fact.factId, fact]));
  const conflicts = findCvFactConflicts(overlay.facts);
  const conflicted = new Set(conflicts.flatMap((conflict) => conflict.factIds));
  const liveFacts = overlay.facts.filter((fact) => fact.approval === 'proposed' || fact.approval === 'approved');
  const pastFacts = overlay.facts.filter((fact) => fact.approval === 'rejected' || fact.approval === 'superseded');
  const liveVariants = overlay.wordingVariants.filter((variant) => variant.status === 'draft' || variant.status === 'candidate_approved');
  const pastVariants = overlay.wordingVariants.filter((variant) => variant.status === 'rejected' || variant.status === 'superseded');

  function parentLabel(fact: CvEvidenceFact): string {
    if (!fact.parentId) return 'No role or project';
    return anchors.find((anchor) => anchor.id === fact.parentId)?.label ?? fact.parentId;
  }

  function startCorrection(fact: CvEvidenceFact) {
    setCorrecting({
      factId: fact.factId,
      values: {
        activity: fact.activity,
        mechanism: fact.mechanism,
        result: fact.result,
        timePhase: fact.timePhase,
        ownership: fact.ownership,
      },
    });
  }

  function variantFacts(variant: CvApprovedWording): string {
    return variant.factIds.map((id) => factById.get(id)?.activity.slice(0, 60) ?? 'unknown fact').join('; ');
  }

  return (
    <div className="card card-border rounded-box border-base-300 bg-base-100">
      <div className="card-body gap-3 p-5">
        <div className="card-title text-base font-bold">Facts and wording</div>
        <p className="text-sm text-base-content/60">
          Approve each fact before it can back any CV wording, then approve the exact wording shown. A fact
          you correct is replaced and the wording that used it is withdrawn.
        </p>

        {error && (
          <div className="alert alert-error text-sm" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="text-sm text-base-content/70" role="status">
            {notice}
          </div>
        )}
        {conflicts.length > 0 && (
          <div className="alert alert-warning text-sm" role="alert">
            <div>
              <p>These facts contradict each other. None of them can be used until you reject or correct one of each pair.</p>
              <ul className="mt-1 list-disc pl-4 text-xs">
                {conflicts.map((conflict) => (
                  <li key={conflict.factIds.join('|')}>
                    {conflict.reason}: “{factById.get(conflict.factIds[0])?.activity.slice(0, 60)}” and “
                    {factById.get(conflict.factIds[1])?.activity.slice(0, 60)}”
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <ul className="flex flex-col gap-3" aria-label="Facts">
          {liveFacts.map((fact) => (
            <li key={fact.factId} className="rounded-box border border-base-300 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">{parentLabel(fact)}</span>
                <span className="text-xs text-base-content/60">
                  {fact.approval === 'approved' ? 'Approved' : 'Not approved yet'}
                  {conflicted.has(fact.factId) ? ' (in a contradiction)' : ''}
                </span>
              </div>
              {fact.verification === 'candidate_confirmed_gap' ? (
                <p className="mt-1 text-xs text-base-content/70">You said this was not your work.</p>
              ) : (
                <dl className="mt-1 grid gap-x-3 gap-y-1 text-xs sm:grid-cols-[8rem_1fr]">
                  <dt className="text-base-content/60">What you did</dt>
                  <dd>{fact.activity}</dd>
                  <dt className="text-base-content/60">Client relationship</dt>
                  <dd>{fact.client || 'None stated'}</dd>
                  <dt className="text-base-content/60">When</dt>
                  <dd>{fact.timePhase || 'Not stated'}</dd>
                  <dt className="text-base-content/60">Ownership</dt>
                  <dd>{OWNERSHIP_LABEL[fact.ownership]}</dd>
                  <dt className="text-base-content/60">How</dt>
                  <dd>{fact.mechanism || 'Not stated'}</dd>
                  <dt className="text-base-content/60">Result</dt>
                  <dd>{fact.result || 'Not stated'}</dd>
                  {fact.metricValue && (
                    <>
                      <dt className="text-base-content/60">Number</dt>
                      <dd>
                        {fact.metricValue} {fact.metricUnit} (basis: {fact.metricBasis})
                      </dd>
                    </>
                  )}
                  <dt className="text-base-content/60">Provenance</dt>
                  <dd>{provenanceLabel(fact)}</dd>
                </dl>
              )}
              {correcting?.factId === fact.factId ? (
                <div className="mt-2 flex flex-col gap-2">
                  <label className="flex flex-col gap-1 text-xs">
                    What you did
                    <textarea
                      className="textarea textarea-sm"
                      rows={2}
                      value={correcting.values.activity}
                      onChange={(event) => setCorrecting({ ...correcting, values: { ...correcting.values, activity: event.currentTarget.value } })}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    How
                    <textarea
                      className="textarea textarea-sm"
                      rows={2}
                      value={correcting.values.mechanism}
                      onChange={(event) => setCorrecting({ ...correcting, values: { ...correcting.values, mechanism: event.currentTarget.value } })}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs">
                    Result
                    <textarea
                      className="textarea textarea-sm"
                      rows={2}
                      value={correcting.values.result}
                      onChange={(event) => setCorrecting({ ...correcting, values: { ...correcting.values, result: event.currentTarget.value } })}
                    />
                  </label>
                  <div className="flex flex-wrap gap-2">
                    <label className="flex flex-col gap-1 text-xs">
                      When
                      <input
                        type="text"
                        className="input input-sm"
                        value={correcting.values.timePhase}
                        onChange={(event) => setCorrecting({ ...correcting, values: { ...correcting.values, timePhase: event.currentTarget.value } })}
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-xs">
                      Ownership
                      <select
                        className="select select-sm"
                        value={correcting.values.ownership}
                        onChange={(event) =>
                          setCorrecting({
                            ...correcting,
                            values: { ...correcting.values, ownership: event.currentTarget.value as CvFactOwnership },
                          })
                        }
                      >
                        {(Object.keys(OWNERSHIP_LABEL) as CvFactOwnership[]).map((value) => (
                          <option key={value} value={value}>
                            {OWNERSHIP_LABEL[value]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={correcting.values.activity.trim().length === 0}
                      onClick={() => void saveCorrection(fact.factId, correcting.values)}
                    >
                      Replace this fact
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCorrecting(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  {fact.approval !== 'approved' && (
                    <button type="button" className="btn btn-primary btn-xs" onClick={() => void setFactApproval(fact.factId, 'approved')}>
                      Approve this fact
                    </button>
                  )}
                  <button type="button" className="btn btn-outline btn-xs" onClick={() => void setFactApproval(fact.factId, 'rejected')}>
                    Reject
                  </button>
                  {fact.verification !== 'candidate_confirmed_gap' && (
                    <button type="button" className="btn btn-outline btn-xs" onClick={() => startCorrection(fact)}>
                      Correct
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-outline btn-sm" onClick={() => void proposeWording()}>
            Propose wording from approved facts
          </button>
        </div>

        <ul className="flex flex-col gap-3" aria-label="Wording">
          {liveVariants.map((variant) => (
            <li key={variant.variantId} className="rounded-box border border-base-300 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-base-content/60">
                <span>{variant.targetField.replace('_', ' ')}</span>
                <span>{variant.status === 'candidate_approved' ? 'Approved wording' : 'Draft, not approved'}</span>
              </div>
              {editing?.variantId === variant.variantId ? (
                <div className="mt-1 flex flex-col gap-2">
                  <textarea
                    className="textarea textarea-sm"
                    rows={3}
                    aria-label="Edited wording"
                    value={editing.text}
                    onChange={(event) => setEditing({ ...editing, text: event.currentTarget.value })}
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={editing.text.trim().length === 0}
                      onClick={() => void saveEditedVariant(variant.variantId, editing.text)}
                    >
                      Save as new wording
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <blockquote className="mt-1 border-l-2 border-base-300 pl-2">{variant.text}</blockquote>
                  <div className="mt-1 text-xs text-base-content/60">Based on: {variantFacts(variant)}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {variant.status === 'draft' && (
                      <button
                        type="button"
                        className="btn btn-primary btn-xs"
                        onClick={() => void setVariantStatus(variant.variantId, 'candidate_approved')}
                      >
                        Approve this wording
                      </button>
                    )}
                    <button type="button" className="btn btn-outline btn-xs" onClick={() => setEditing({ variantId: variant.variantId, text: variant.text })}>
                      Edit
                    </button>
                    <button type="button" className="btn btn-outline btn-xs" onClick={() => void setVariantStatus(variant.variantId, 'rejected')}>
                      Reject
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>

        {(pastFacts.length > 0 || pastVariants.length > 0) && (
          <details className="text-xs text-base-content/60">
            <summary className="cursor-pointer">History ({pastFacts.length + pastVariants.length})</summary>
            <ul className="mt-1 list-disc pl-4">
              {pastFacts.map((fact) => (
                <li key={fact.factId}>
                  Fact {fact.approval}: {fact.activity || 'Not my work'}
                </li>
              ))}
              {pastVariants.map((variant) => (
                <li key={variant.variantId}>
                  Wording {variant.status}: {variant.text}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
