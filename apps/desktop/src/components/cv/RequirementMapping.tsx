import { useCallback, useEffect, useState } from 'react';
import type { ProviderId } from '@agent-dock/shared';
import { CV_EVIDENCE_CLASSES, CV_REQUIREMENT_CLASSIFICATIONS } from '../../../electron/workspace/cv-evidence-schema.js';
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
import { parseRequirementMappingResponse } from './requirement-mapping-response.js';
import { sourceAnchors } from './source-anchors.js';
import type { CvDocument, VacancyLead } from './types.js';
import { describeError, useAgentRun } from './useAgentRun.js';
import { vacancyKeyFor } from './vacancy-key.js';

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
    sourceCvContentHash,
    jdSnapshotHash,
    jdSnapshot: jobDescriptionBody(vacancy),
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
};

/**
 * Maps every material requirement in the selected vacancy to what the reviewed source CV actually
 * evidences (#419, step 2), as a persisted, candidate-reviewable list -- not a one-off read like
 * #361's ATS fit, which this stays structurally separate from.
 */
export function RequirementMapping({ cvId, cv, vacancy, sourceCv, model, provider }: RequirementMappingProps) {
  const run = useAgentRun({ chunkSeparator: '' });
  const [overlay, setOverlay] = useState<CvEvidenceOverlayRecord | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const [newRequirementText, setNewRequirementText] = useState('');
  /** Which requirement's clarification form is open, at most one at a time. */
  const [openRequirementId, setOpenRequirementId] = useState<string | null>(null);

  const vacancyKey = vacancy ? vacancyKeyFor(vacancy) : null;

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

  const canRun = !!cvId && !!cv && !!vacancy && !run.isBusy;

  const handleRun = useCallback(() => {
    if (!cv || !vacancy) return;
    setSaveError(undefined);
    run.reset();
    void run.start(buildRequirementMappingPrompt(cv, vacancy, sourceCv ?? null), {
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
    });
  }, [cv, vacancy, sourceCv, model, provider, run]);

  // Reacts to the mapping run's terminal status: parse, merge into whatever is already on the
  // overlay, create the overlay on a first visit or patch it on a later one.
  useEffect(() => {
    if (run.status !== 'completed' || !cvId || !vacancy || !vacancyKey) return;
    let cancelled = false;
    void (async () => {
      let extracted: CvRequirementMapping[];
      try {
        extracted = parseRequirementMappingResponse(run.text);
      } catch (err) {
        if (!cancelled) setSaveError(describeError(err, 'could not read the requirement mapping'));
        return;
      }
      try {
        const base = await getOrCreateOverlay(overlay, cvId, vacancyKey, sourceCv, vacancy);
        const [sourceCvContentHash, jdSnapshotHash] = await Promise.all([
          sha256HexOfSource(sourceCv ?? null),
          sha256Hex(jobDescriptionBody(vacancy)),
        ]);
        const merged = mergeRequirementMappings(base.requirements, extracted);
        const updated = await window.workspace.updateCvEvidenceOverlay(base.id, {
          sourceCvContentHash,
          jdSnapshot: jobDescriptionBody(vacancy),
          jdSnapshotHash,
          requirements: merged,
        });
        if (!cancelled) setOverlay(updated);
      } catch (err) {
        if (!cancelled) setSaveError(describeError(err, 'could not save the requirement mapping'));
      }
    })();
    return () => {
      cancelled = true;
    };
    // `overlay` is read but not listed: this effect must react only to a new run completing, and
    // including it would re-run (and re-save) every time a row edit updates local overlay state.
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
      const { requirement: nextRequirement, fact } = applyClarificationAnswer(requirement, answer, sourceCv);
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
    if (!text || !cvId || !vacancy || !vacancyKey) return;
    setSaveError(undefined);
    try {
      const base = await getOrCreateOverlay(overlay, cvId, vacancyKey, sourceCv, vacancy);
      const added: CvRequirementMapping = {
        requirementId: crypto.randomUUID(),
        text,
        jdAnchor: '',
        classification: 'unclear',
        evidenceClass: 'needs_verification',
        anchorParentId: '',
        // The candidate just typed this: it is both their own addition and, by definition,
        // already looked at.
        candidateAdded: true,
        reviewed: true,
      };
      const updated = await window.workspace.updateCvEvidenceOverlay(base.id, {
        requirements: [...base.requirements, added],
      });
      setOverlay(updated);
      setNewRequirementText('');
    } catch (err) {
      setSaveError(describeError(err, 'could not add that requirement'));
    }
  }, [newRequirementText, cvId, vacancy, vacancyKey, sourceCv, overlay]);

  // Only requirement-review completeness is surfaced here. Full approvability -- source-CV drift,
  // JD completeness, stale/ungrounded approved wording -- is `describeCvEvidenceOverlayGaps`'s job
  // at the composition/approval gate (slice 3), where a *live* current-source hash is actually
  // being checked against something about to be approved, not just displayed.
  const unreviewedCount = overlay?.requirements.filter((requirement) => !requirement.reviewed).length ?? 0;

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

        <div className="flex flex-wrap items-center gap-2">
          <button className="btn btn-primary" type="button" onClick={handleRun} disabled={!canRun}>
            {overlay && overlay.requirements.length > 0 ? 'Re-map requirements' : 'Map requirements'}
          </button>
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
                : 'Mapping requirements against your reviewed CV…'}
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

        {overlay && overlay.requirements.length > 0 && (
          <>
            {unreviewedCount > 0 && (
              <div className="text-sm text-base-content/60">
                {unreviewedCount} of {overlay.requirements.length} requirement(s) not yet reviewed.
              </div>
            )}

            <ul className="flex flex-col gap-3" aria-label="Requirement mapping">
              {overlay.requirements.map((requirement) => (
                <li
                  key={requirement.requirementId}
                  className="rounded-box border border-base-300 p-3 text-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-medium">
                      {requirement.text}
                      {requirement.candidateAdded && (
                        <span className="ml-2 text-xs font-normal text-base-content/50">(added by you)</span>
                      )}
                    </div>
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
                  </div>
                  {requirement.jdAnchor && (
                    <blockquote className="mt-1 border-l-2 border-base-300 pl-2 text-xs text-base-content/60">
                      “{requirement.jdAnchor}”
                    </blockquote>
                  )}
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
                        onChange={(event) =>
                          void patchRequirement(requirement.requirementId, {
                            evidenceClass: event.currentTarget.value as CvEvidenceClass,
                            anchorParentId:
                              event.currentTarget.value === 'unsupported' ? '' : requirement.anchorParentId,
                          })
                        }
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
                  </div>
                  {openRequirementId === requirement.requirementId && (
                    <ClarificationForm
                      sourceCv={sourceCv}
                      onAnswer={(answer) => void handleAnswer(requirement, answer)}
                      onCancel={() => setOpenRequirementId(null)}
                    />
                  )}
                </li>
              ))}
            </ul>
          </>
        )}

        {cvId && vacancy && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              className="input input-sm flex-1"
              placeholder="Add a requirement the extraction missed"
              value={newRequirementText}
              onChange={(event) => setNewRequirementText(event.currentTarget.value)}
              aria-label="New requirement text"
            />
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => void handleAddRequirement()}
              disabled={newRequirementText.trim().length === 0}
            >
              Add
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
