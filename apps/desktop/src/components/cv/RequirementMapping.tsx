import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProviderId } from '@agent-dock/shared';
import {
  CV_EVIDENCE_CLASSES,
  CV_REQUIREMENT_CLASSIFICATIONS,
  CV_REQUIREMENT_MAX_BATCHES,
  currentCvJdRevisionId,
  describeCvJdGaps,
  describeCvRequirementGaps,
  locateJdQuote,
} from '../../../electron/workspace/cv-evidence-schema.js';
import type {
  CvEvidenceClass,
  CvEvidenceOverlayRecord,
  CvRequirementClassification,
  CvRequirementMapping,
  CvSourceDocument,
} from '../../window.js';
import { jobDescriptionBody } from '../../../electron/generation-input.js';
import { PROVIDER_LABEL } from '../../provider-labels.js';
import { ClarificationForm } from './ClarificationForm.js';
import { applyClarificationAnswer, type ClarificationAnswer } from './clarification-answer.js';
import { sha256Hex, sha256HexOfSource } from './content-hash.js';
import { buildRequirementMappingPrompt } from './prompts.js';
import { mergeRequirementMappings } from './requirement-mapping-merge.js';
import { parseRequirementMappingResponse, type RejectedRequirementProposal } from './requirement-mapping-response.js';
import { sourceAnchors } from './source-anchors.js';
import type { CvDocument, VacancyLead } from './types.js';
import { describeError, useAgentRun } from './useAgentRun.js';
import { caseKeyFor } from './vacancy-key.js';

export interface RequirementMappingProps {
  /** The CV Library record this session's evidence belongs to. This feature needs a persisted CV
   * to key its overlay against (see `cv-evidence-schema.ts`'s header on why an ad-hoc upload with
   * no library id cannot have one yet), so it renders nothing useful, and says so, until one is
   * selected. */
  cvId: string | null;
  cv: CvDocument | null;
  vacancy: VacancyLead | null;
  sourceCv?: CvSourceDocument | null;
  model?: string;
  provider?: ProviderId;
  /** Called when a save changes the case, so sibling panels that show its facts can reload. */
  onOverlayChanged?: () => void;
}

function anchorLabel(source: CvSourceDocument | null | undefined, anchorParentId: string): string {
  if (!anchorParentId) return '';
  return sourceAnchors(source).find((anchor) => anchor.id === anchorParentId)?.label ?? anchorParentId;
}

/**
 * The overlay for this (cvId, vacancyKey) if one already exists, or a freshly created one.
 * Shared by the mapping-run-completion effect and `handleAddRequirement` below -- both need "get
 * or create" and nothing else, and hashing the whole reviewed CV (only needed on the create path)
 * is skipped entirely once an overlay already exists, the common case for either caller.
 */
async function getOrCreateOverlay(
  existing: CvEvidenceOverlayRecord | null,
  cvId: string,
  vacancyKey: string,
  sourceCv: CvSourceDocument | null | undefined,
  vacancy: VacancyLead,
): Promise<CvEvidenceOverlayRecord> {
  if (existing) return existing;
  const [sourceCvContentHash, jdSnapshotHash] = await Promise.all([
    sha256HexOfSource(sourceCv ?? null),
    sha256Hex(jobDescriptionBody(vacancy)),
  ]);
  return window.workspace.createCvEvidenceOverlay({
    cvId,
    vacancyKey,
    caseTitle: vacancy.title,
    caseCompany: vacancy.company,
    sourceCvContentHash,
    jdSnapshotHash,
    jdSnapshot: jobDescriptionBody(vacancy),
    origin: vacancyKey.startsWith('manual:') ? 'manual' : 'vacancy',
    jdOrigin: vacancy.jdOrigin ?? 'found',
    jdUrl: vacancy.url,
    ...(vacancy.jdRequisition ? { jdRequisition: vacancy.jdRequisition } : {}),
  });
}

const CLASSIFICATION_LABEL: Record<CvRequirementClassification, string> = {
  required: 'Required',
  preferred: 'Preferred',
  unclear: 'Unclear',
};

const EVIDENCE_CLASS_LABEL: Record<CvEvidenceClass, string> = {
  direct: 'Direct',
  transferable: 'Transferable',
  unsupported: 'Unsupported',
  needs_verification: 'Needs verification',
  candidate_confirmed_gap: 'A gap I confirm',
};

/**
 * Maps every material requirement in the selected vacancy to what the reviewed source CV actually
 * evidences (#419, step 2), as a persisted, candidate-reviewable list -- not a one-off read like
 * #361's ATS fit, which this stays structurally separate from.
 */
export function RequirementMapping({ cvId, cv, vacancy, sourceCv, model, provider, onOverlayChanged }: RequirementMappingProps) {
  const run = useAgentRun({ chunkSeparator: '' });
  const [overlay, setOverlay] = useState<CvEvidenceOverlayRecord | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [newRequirementText, setNewRequirementText] = useState('');
  const [newRequirementQuote, setNewRequirementQuote] = useState('');
  /** Proposals the last mapping run made whose quote is not in the job description. Shown, never
   * saved. */
  const [rejectedProposals, setRejectedProposals] = useState<RejectedRequirementProposal[]>([]);
  /** Batches read in the current mapping run, and whether it stopped with more still owed. */
  const batchesRef = useRef(0);
  const [batchNumber, setBatchNumber] = useState(0);
  /** Which requirement has its "not a requirement" reason box open, and the reason typed so far. */
  const [excludingId, setExcludingId] = useState<string | null>(null);
  const [exclusionReason, setExclusionReason] = useState('');
  /** Which requirement's clarification form is open, at most one at a time. */
  const [openRequirementId, setOpenRequirementId] = useState<string | null>(null);

  const vacancyKey = vacancy ? caseKeyFor(vacancy) : null;

  // Loads (or clears) the overlay whenever the CV or the selected vacancy changes. A missing
  // overlay is the normal first-visit state (`getCvEvidenceOverlay` returns null, never throws),
  // not an error -- see that bridge method's own doc comment in `types.ts`.
  useEffect(() => {
    setLoadError(undefined);
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
        if (!cancelled) setLoadError(describeError(err, 'could not load this vacancy’s requirement mapping'));
      });
    return () => {
      cancelled = true;
    };
  }, [cvId, vacancyKey]);

  const caseRevision = overlay?.caseRevision;
  const lastReportedRevision = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (caseRevision === undefined || caseRevision === lastReportedRevision.current) return;
    // The first load is not a change; only later revisions are reported.
    if (lastReportedRevision.current !== undefined) onOverlayChanged?.();
    lastReportedRevision.current = caseRevision;
  }, [caseRevision, onOverlayChanged]);

  const canRun = !!cvId && !!cv && !!vacancy && !run.isBusy;

  const startBatch = useCallback(
    (alreadyListed: readonly string[]) => {
      if (!cv || !vacancy) return;
      batchesRef.current += 1;
      setBatchNumber(batchesRef.current);
      run.reset();
      void run.start(buildRequirementMappingPrompt(cv, vacancy, sourceCv ?? null, undefined, alreadyListed), {
        ...(model ? { model } : {}),
        ...(provider ? { provider } : {}),
      });
    },
    [cv, vacancy, sourceCv, model, provider, run],
  );

  /** Starts a fresh mapping run, or with `continuing` carries on with the batches still owed for
   * the list already saved (#419 step 5). */
  const handleRun = useCallback(
    (continuing = false) => {
      setSaveError(undefined);
      if (!continuing) {
        setRejectedProposals([]);
        batchesRef.current = 0;
      }
      startBatch(overlay?.requirements.map((requirement) => requirement.text) ?? []);
    },
    [overlay, startBatch],
  );

  // Reacts to the mapping run's terminal status: parse, merge into whatever is already on the
  // overlay, create the overlay on a first visit or patch it on a later one.
  useEffect(() => {
    if (run.status !== 'completed' || !cvId || !vacancy || !vacancyKey) return;
    let cancelled = false;
    void (async () => {
      const jdText = jobDescriptionBody(vacancy);
      let batch: ReturnType<typeof parseRequirementMappingResponse>;
      try {
        batch = parseRequirementMappingResponse(run.text, jdText);
      } catch (err) {
        if (!cancelled) setSaveError(describeError(err, 'could not read the requirement mapping'));
        return;
      }
      try {
        const base = await getOrCreateOverlay(overlay, cvId, vacancyKey, sourceCv, vacancy);
        const [sourceCvContentHash, jdSnapshotHash] = await Promise.all([
          sha256HexOfSource(sourceCv ?? null),
          sha256Hex(jdText),
        ]);
        const merged = mergeRequirementMappings(base.requirements, batch.accepted);
        // A batch that comes back full may have been cut off by the model's output cap, so the list
        // stays "partial" until a later batch finishes it or the candidate confirms it.
        const exhausted = batch.hasMore && batchesRef.current >= CV_REQUIREMENT_MAX_BATCHES;
        const updated = await window.workspace.updateCvEvidenceOverlay(base.id, {
          sourceCvContentHash,
          jdSnapshot: jdText,
          jdSnapshotHash,
          jdOrigin: vacancy.jdOrigin ?? 'found',
          jdUrl: vacancy.url,
          ...(vacancy.jdRequisition ? { jdRequisition: vacancy.jdRequisition } : {}),
          requirements: merged,
          ...(jdText.trim()
            ? { requirementCoverage: { status: batch.hasMore ? ('partial' as const) : ('complete' as const), batches: batchesRef.current } }
            : {}),
        });
        if (cancelled) return;
        setOverlay(updated);
        setRejectedProposals((previous) => [...previous, ...batch.rejected]);
        // Carry on with the next batch while the model says more remain and this one still added
        // something. A batch that added nothing new stops here, with coverage left partial.
        if (batch.hasMore && !exhausted && merged.length > base.requirements.length) {
          startBatch(updated.requirements.map((requirement) => requirement.text));
        }
      } catch (err) {
        if (!cancelled) setSaveError(describeError(err, 'could not save the requirement mapping'));
      }
    })();
    return () => {
      cancelled = true;
    };
    // `overlay` and `startBatch` are read but not listed: this effect must react only to a new run
    // completing, and including them would re-run (and re-save) every time a row edit updates local
    // overlay state.
  }, [run.status, run.text, cvId, vacancy, vacancyKey, sourceCv]);

  const patchRequirement = useCallback(
    async (requirementId: string, patch: Partial<CvRequirementMapping>) => {
      if (!overlay) return;
      const next = overlay.requirements.map((requirement) =>
        requirement.requirementId === requirementId ? { ...requirement, ...patch } : requirement,
      );
      setOverlay({ ...overlay, requirements: next }); // optimistic, so a checkbox click feels instant
      try {
        const updated = await window.workspace.updateCvEvidenceOverlay(overlay.id, { requirements: next });
        setOverlay(updated);
      } catch (err) {
        setSaveError(describeError(err, 'could not save that change'));
      }
    },
    [overlay],
  );

  const handleAnswer = useCallback(
    async (requirement: CvRequirementMapping, answer: ClarificationAnswer) => {
      if (!overlay) return;
      let applied: ReturnType<typeof applyClarificationAnswer>;
      try {
        applied = applyClarificationAnswer(requirement, answer, sourceCv);
      } catch (err) {
        setSaveError(describeError(err, 'could not save that answer'));
        return;
      }
      const { requirement: nextRequirement, fact } = applied;
      const nextRequirements = overlay.requirements.map((existing) =>
        existing.requirementId === requirement.requirementId ? nextRequirement : existing,
      );
      const nextFacts = fact ? [...overlay.facts, fact] : overlay.facts;
      setOverlay({ ...overlay, requirements: nextRequirements, facts: nextFacts }); // optimistic
      setOpenRequirementId(null);
      try {
        const updated = await window.workspace.updateCvEvidenceOverlay(overlay.id, {
          requirements: nextRequirements,
          facts: nextFacts,
        });
        setOverlay(updated);
      } catch (err) {
        setSaveError(describeError(err, 'could not save that answer'));
      }
    },
    [overlay],
  );

  const handleAddRequirement = useCallback(async () => {
    const text = newRequirementText.trim();
    const quote = newRequirementQuote.trim();
    if (!text || !cvId || !vacancy || !vacancyKey) return;
    setSaveError(undefined);
    // A requirement the candidate adds needs an exact quote from the frozen JD text (#419 step 5).
    // Checked here for a quick answer; the main process checks it again against the stored text.
    if (!locateJdQuote(jobDescriptionBody(vacancy), quote)) {
      setSaveError('The quote must be copied exactly from the job description. It was not found there.');
      return;
    }
    try {
      const base = await getOrCreateOverlay(overlay, cvId, vacancyKey, sourceCv, vacancy);
      const added: CvRequirementMapping = {
        requirementId: crypto.randomUUID(),
        text,
        jdAnchor: quote,
        classification: 'unclear',
        evidenceClass: 'needs_verification',
        anchorParentId: '',
        // The candidate just typed this: it is both their own addition and, by definition,
        // already looked at.
        candidateAdded: true,
        reviewed: true,
        quoteStart: -1,
        quoteEnd: -1,
        jdRevisionId: '',
        excluded: false,
        exclusionReason: '',
        sourceIds: [],
        factIds: [],
      };
      const updated = await window.workspace.updateCvEvidenceOverlay(base.id, {
        requirements: [...base.requirements, added],
      });
      setOverlay(updated);
      setNewRequirementText('');
      setNewRequirementQuote('');
    } catch (err) {
      setSaveError(describeError(err, 'could not add that requirement'));
    }
  }, [newRequirementText, newRequirementQuote, cvId, vacancy, vacancyKey, sourceCv, overlay]);

  const confirmCoverage = useCallback(async () => {
    if (!overlay) return;
    setSaveError(undefined);
    try {
      setOverlay(
        await window.workspace.updateCvEvidenceOverlay(overlay.id, {
          requirementCoverage: { status: 'complete', batches: overlay.requirementCoverage.batches },
        }),
      );
    } catch (err) {
      setSaveError(describeError(err, 'could not save that confirmation'));
    }
  }, [overlay]);

  const toggleLink = useCallback(
    (requirement: CvRequirementMapping, field: 'sourceIds' | 'factIds', id: string) => {
      const current = requirement[field];
      void patchRequirement(requirement.requirementId, {
        [field]: current.includes(id) ? current.filter((existing) => existing !== id) : [...current, id],
      });
    },
    [patchRequirement],
  );

  // Only requirement-review completeness is surfaced here. Full approvability -- source-CV drift,
  // JD completeness, stale/ungrounded approved wording -- is `describeCvEvidenceOverlayGaps`'s job
  // at the composition/approval gate (slice 3), where a *live* current-source hash is actually
  // being checked against something about to be approved, not just displayed.
  const requirementGaps = overlay ? describeCvRequirementGaps(overlay) : [];
  const currentRevisionId = overlay ? currentCvJdRevisionId(overlay) : '';
  const approvedFacts = overlay?.facts.filter((fact) => fact.approval === 'approved' && fact.verification !== 'candidate_confirmed_gap') ?? [];
  const anchors = sourceAnchors(sourceCv);
  const coverageCurrent =
    !!overlay && overlay.requirementCoverage.revisionId === currentRevisionId ? overlay.requirementCoverage.status : 'not_run';
  // Unlike the rest of the approval gate, the JD itself is shown here: a mapping built on an empty
  // or cut-off posting is worth nothing, and the candidate should see that before reviewing rows.
  const jdGaps = overlay ? describeCvJdGaps(overlay) : [];

  return (
    <div className="card card-border rounded-box border-base-300 bg-base-100">
      <div className="card-body gap-3 p-5">
        <div className="card-title text-base font-bold">Requirement mapping</div>
        <p className="text-sm text-base-content/60">
          Every material requirement in this vacancy, mapped to what your reviewed CV actually
          evidences. This decides what a tailored CV may claim -- separate from the ATS fit check
          above, which is advisory only.
        </p>

        {!cvId && (
          <div className="text-sm text-base-content/60">
            Select a saved CV from your library above to enable this -- an uploaded CV not yet saved
            has nowhere to keep this mapping.
          </div>
        )}
        {cvId && !vacancy && (
          <div className="text-sm text-base-content/60">Select a vacancy to map its requirements.</div>
        )}

        {loadError && (
          <div className="alert alert-error text-sm" role="alert">
            {loadError}
          </div>
        )}
        {jdGaps.length > 0 && (
          <div className="alert alert-warning text-sm" role="status">
            <ul className="list-disc pl-4">
              {jdGaps.map((gap) => (
                <li key={gap}>This CV cannot reach approved status: {gap}.</li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" type="button" onClick={() => handleRun(false)} disabled={!canRun}>
            {overlay && overlay.requirements.length > 0 ? 'Re-map requirements' : 'Map requirements'}
          </button>
          {overlay && coverageCurrent === 'partial' && (
            <button className="btn btn-outline" type="button" onClick={() => handleRun(true)} disabled={!canRun}>
              Read the rest of the job description
            </button>
          )}
          <button className="btn btn-outline" type="button" onClick={() => void run.cancel()} disabled={!run.isBusy}>
            Cancel
          </button>
        </div>

        {run.isBusy && (
          <div className="flex items-center gap-3 text-sm text-base-content/70" role="status">
            <span className="loading loading-spinner loading-sm" aria-hidden="true" />
            <span>
              {run.status === 'starting'
                ? `Starting ${PROVIDER_LABEL[provider ?? 'claude']}…`
                : `Mapping requirements against your reviewed CV (batch ${batchNumber})…`}
            </span>
          </div>
        )}
        {run.status === 'failed' && run.error && (
          <div className="alert alert-error text-sm" role="alert">
            {run.error}
          </div>
        )}
        {saveError && (
          <div className="alert alert-error text-sm" role="alert">
            {saveError}
          </div>
        )}
        {rejectedProposals.length > 0 && (
          <div className="alert alert-warning text-sm" role="status">
            <div>
              <p>
                {rejectedProposals.length} proposed requirement(s) were not added because their quote is not an exact
                passage of the job description. Add them yourself with a quote if they are real.
              </p>
              <ul className="mt-1 list-disc pl-4 text-xs">
                {rejectedProposals.map((proposal, index) => (
                  <li key={`${proposal.text}-${index}`}>
                    {proposal.text}: {proposal.reason}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {overlay && (overlay.requirements.length > 0 || coverageCurrent !== 'not_run') && (
          <div className="flex flex-col gap-2" aria-label="Requirement coverage">
            {requirementGaps.length > 0 ? (
              <div className="alert alert-warning text-sm" role="status">
                <ul className="list-disc pl-4">
                  {requirementGaps.map((gap) => (
                    <li key={gap}>This list cannot back an approved CV yet: {gap}.</li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="text-sm text-base-content/60">
                Every requirement on this list is reviewed against the current job description.
              </div>
            )}
            {coverageCurrent !== 'complete' && (
              <button
                type="button"
                className="btn btn-outline btn-sm self-start"
                onClick={() => void confirmCoverage()}
                disabled={!overlay.jdSnapshot.trim()}
              >
                I read the whole job description and this list covers it
              </button>
            )}
          </div>
        )}

        {overlay && overlay.requirements.length > 0 && (
          <ul className="flex flex-col gap-3" aria-label="Requirement mapping">
            {overlay.requirements.map((requirement) => (
              <li
                key={requirement.requirementId}
                className={`rounded-box border border-base-300 p-3 text-sm ${requirement.excluded ? 'bg-base-200/50 text-base-content/60' : ''}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="font-medium">
                    {requirement.text}
                    {requirement.candidateAdded && (
                      <span className="ml-2 text-xs font-normal text-base-content/50">(added by you)</span>
                    )}
                    {requirement.excluded && <span className="ml-2 text-xs font-normal">(not a requirement)</span>}
                    {!requirement.excluded && requirement.jdRevisionId !== currentRevisionId && (
                      <span className="ml-2 text-xs font-normal text-warning">(read against an older job description)</span>
                    )}
                  </div>
                  {!requirement.excluded && (
                    <label className="flex shrink-0 items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        className="checkbox checkbox-xs"
                        checked={requirement.reviewed}
                        onChange={(event) =>
                          void patchRequirement(requirement.requirementId, { reviewed: event.currentTarget.checked })
                        }
                      />
                      Reviewed
                    </label>
                  )}
                </div>
                {requirement.jdAnchor && (
                  <blockquote className="mt-1 border-l-2 border-base-300 pl-2 text-xs text-base-content/60">
                    “{requirement.jdAnchor}”
                    {requirement.quoteStart < 0 && (
                      <span className="ml-1 text-warning">(not found in the current job description)</span>
                    )}
                  </blockquote>
                )}
                {!requirement.jdAnchor && !requirement.excluded && (
                  <p className="mt-1 text-xs text-warning">No quote from the job description yet.</p>
                )}
                {requirement.excluded && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <span>Reason: {requirement.exclusionReason}</span>
                    <button
                      type="button"
                      className="btn btn-outline btn-xs"
                      onClick={() =>
                        void patchRequirement(requirement.requirementId, {
                          excluded: false,
                          exclusionReason: '',
                          reviewed: false,
                        })
                      }
                    >
                      Treat as a requirement again
                    </button>
                  </div>
                )}
                {!requirement.excluded && (
                  <>
                    <div className="mt-2 flex flex-wrap items-center gap-3">
                      <label className="flex items-center gap-1 text-xs">
                        Importance
                        <select
                          className="select select-xs"
                          value={requirement.classification}
                          onChange={(event) =>
                            void patchRequirement(requirement.requirementId, {
                              classification: event.currentTarget.value as CvRequirementClassification,
                            })
                          }
                        >
                          {CV_REQUIREMENT_CLASSIFICATIONS.map((value) => (
                            <option key={value} value={value}>
                              {CLASSIFICATION_LABEL[value]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="flex items-center gap-1 text-xs">
                        Evidence
                        <select
                          className="select select-xs"
                          value={requirement.evidenceClass}
                          onChange={(event) => {
                            const value = event.currentTarget.value as CvEvidenceClass;
                            const clearsLinks = value === 'unsupported' || value === 'candidate_confirmed_gap';
                            void patchRequirement(requirement.requirementId, {
                              evidenceClass: value,
                              ...(clearsLinks ? { anchorParentId: '', sourceIds: [], factIds: [] } : {}),
                            });
                          }}
                        >
                          {CV_EVIDENCE_CLASSES.map((value) => (
                            <option key={value} value={value}>
                              {EVIDENCE_CLASS_LABEL[value]}
                            </option>
                          ))}
                        </select>
                      </label>
                      {requirement.anchorParentId && (
                        <span className="text-xs text-base-content/60">
                          {anchorLabel(sourceCv, requirement.anchorParentId)}
                        </span>
                      )}
                      {requirement.evidenceClass === 'needs_verification' && openRequirementId !== requirement.requirementId && (
                        <button
                          type="button"
                          className="btn btn-outline btn-xs"
                          onClick={() => setOpenRequirementId(requirement.requirementId)}
                        >
                          Answer
                        </button>
                      )}
                      {excludingId !== requirement.requirementId && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          onClick={() => {
                            setExcludingId(requirement.requirementId);
                            setExclusionReason('');
                          }}
                        >
                          Not a requirement
                        </button>
                      )}
                    </div>
                    {(requirement.evidenceClass === 'direct' || requirement.evidenceClass === 'transferable') && (
                      <details className="mt-2 text-xs">
                        <summary className="cursor-pointer">
                          Linked evidence ({requirement.sourceIds.length + requirement.factIds.length})
                        </summary>
                        <fieldset className="mt-1 flex flex-col gap-1">
                          <legend className="font-medium">Roles and projects</legend>
                          {anchors.length === 0 && <span className="text-base-content/60">No reviewed source yet.</span>}
                          {anchors.map((anchor) => (
                            <label key={anchor.id} className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                className="checkbox checkbox-xs"
                                checked={requirement.sourceIds.includes(anchor.id)}
                                onChange={() => toggleLink(requirement, 'sourceIds', anchor.id)}
                              />
                              {anchor.label}
                            </label>
                          ))}
                        </fieldset>
                        <fieldset className="mt-2 flex flex-col gap-1">
                          <legend className="font-medium">Approved facts</legend>
                          {approvedFacts.length === 0 && (
                            <span className="text-base-content/60">No approved facts yet. Approve one in the fact review below.</span>
                          )}
                          {approvedFacts.map((fact) => (
                            <label key={fact.factId} className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                className="checkbox checkbox-xs"
                                checked={requirement.factIds.includes(fact.factId)}
                                onChange={() => toggleLink(requirement, 'factIds', fact.factId)}
                              />
                              {fact.activity.slice(0, 100)}
                            </label>
                          ))}
                        </fieldset>
                      </details>
                    )}
                    {excludingId === requirement.requirementId && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <input
                          type="text"
                          className="input input-sm min-w-48 flex-1"
                          placeholder="Why is this not a requirement?"
                          aria-label="Reason this is not a requirement"
                          value={exclusionReason}
                          onChange={(event) => setExclusionReason(event.currentTarget.value)}
                        />
                        <button
                          type="button"
                          className="btn btn-outline btn-sm"
                          disabled={exclusionReason.trim().length === 0}
                          onClick={() => {
                            void patchRequirement(requirement.requirementId, {
                              excluded: true,
                              exclusionReason: exclusionReason.trim(),
                              reviewed: true,
                            });
                            setExcludingId(null);
                          }}
                        >
                          Mark as not a requirement
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setExcludingId(null)}>
                          Cancel
                        </button>
                      </div>
                    )}
                    {openRequirementId === requirement.requirementId && (
                      <ClarificationForm
                        sourceCv={sourceCv}
                        onAnswer={(answer) => void handleAnswer(requirement, answer)}
                        onCancel={() => setOpenRequirementId(null)}
                      />
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        {cvId && vacancy && (
          <div className="flex flex-col gap-2">
            <input
              type="text"
              className="input input-sm"
              placeholder="Add a requirement the extraction missed"
              value={newRequirementText}
              onChange={(event) => setNewRequirementText(event.currentTarget.value)}
              aria-label="New requirement text"
            />
            <textarea
              className="textarea textarea-sm"
              rows={2}
              placeholder="Exact quote from the job description"
              value={newRequirementQuote}
              onChange={(event) => setNewRequirementQuote(event.currentTarget.value)}
              aria-label="Exact quote from the job description"
            />
            <button
              type="button"
              className="btn btn-outline btn-sm self-start"
              onClick={() => void handleAddRequirement()}
              disabled={newRequirementText.trim().length === 0 || newRequirementQuote.trim().length === 0}
            >
              Add
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
