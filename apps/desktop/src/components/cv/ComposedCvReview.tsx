import { useCallback, useEffect, useMemo, useState } from 'react';
import { composeApprovedTailoredResume } from '../../../electron/resume-source.js';
import { cvArtifactStatus, snapshotNeedsReapproval } from '../../../electron/workspace/cv-artifact-status.js';
import { describeCvSourceGaps, selectSourceProjects } from '../../../electron/workspace/cv-source-schema.js';
import type {
  CvEvidenceOverlayRecord,
  CvProfile,
  CvRebasePlan,
  CvSourceDocument,
} from '../../window.js';
import { sha256HexOfSource } from './content-hash.js';
import { CvArtifactPanel } from './CvArtifactPanel.js';
import type { VacancyLead } from './types.js';
import { describeError } from './useAgentRun.js';
import { caseKeyFor } from './vacancy-key.js';
import { ErrorBanner, WarningBanner } from '../shell/index.js';

export interface ComposedCvReviewProps {
  cvId: string | null;
  vacancy: VacancyLead | null;
  sourceCv?: CvSourceDocument | null;
  profile?: CvProfile | null;
  /** Opens this CV's review (#447). Without it the notice only describes what is missing. */
  onReviewSource?: () => void;
}

/**
 * The candidate-approved composition path (#419, steps 8-9): previews and approves the CV
 * `composeApprovedTailoredResume` builds from unchanged reviewed source text and active,
 * candidate-approved wording only -- never from `TailorCv`'s free-form advisory draft, which this
 * component neither reads nor affects. That draft is labelled unchecked and has no route into this
 * panel, so copying it cannot give it approved status. The card's title never says "Approved" on its
 * own: a badge names the real state of the stored case.
 *
 * Three steps sit in front of approving the whole CV, in order:
 *  1. If the source CV, profile text or skills changed after the case was started, the candidate
 *     reads what changed and rebases the case onto the new CV. Nothing is rebased automatically.
 *  2. The candidate approves which projects the CV shows (the pinned ones plus what the project limit
 *     allows). Changing a pin or the limit later makes that approval stale.
 *  3. The candidate approves the complete assembled CV shown here.
 *
 * This component never approves wording (#419 step 7: the candidate approves the exact displayed
 * text of each variant, one at a time, in the facts and wording review). The preview composes only
 * variants that are already approved and whose facts are still approved; a draft or rejected
 * variant adds nothing to it. The approve actions send only the case id and revision: the main
 * process recomposes and re-verifies every gap itself before writing anything.
 */
export function ComposedCvReview({ cvId, vacancy, sourceCv, profile, onReviewSource }: ComposedCvReviewProps) {
  const [overlay, setOverlay] = useState<CvEvidenceOverlayRecord | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [currentHash, setCurrentHash] = useState<string | null>(null);
  const [rebasePlan, setRebasePlan] = useState<CvRebasePlan | null>(null);
  const [error, setError] = useState<string>();
  const [approving, setApproving] = useState(false);
  const [approvingProjects, setApprovingProjects] = useState(false);
  const [rebasing, setRebasing] = useState(false);
  const [approved, setApproved] = useState(false);

  const vacancyKey = vacancy ? caseKeyFor(vacancy) : null;

  const loadPlan = useCallback(async (record: CvEvidenceOverlayRecord | null) => {
    if (!record) {
      setRebasePlan(null);
      return;
    }
    try {
      setRebasePlan(await window.workspace.previewCvEvidenceRebase(record.id));
    } catch {
      setRebasePlan(null);
    }
  }, []);

  useEffect(() => {
    setPreviewing(false);
    setApproved(false);
    setError(undefined);
    if (!cvId || !vacancyKey) {
      setOverlay(null);
      setRebasePlan(null);
      return;
    }
    let cancelled = false;
    void window.workspace.getCvEvidenceOverlay(cvId, vacancyKey).then((record) => {
      if (cancelled) return;
      setOverlay(record);
      void loadPlan(record);
    });
    return () => {
      cancelled = true;
    };
  }, [cvId, vacancyKey, loadPlan]);

  useEffect(() => {
    let cancelled = false;
    setCurrentHash(null);
    if (!sourceCv) return;
    void sha256HexOfSource(sourceCv).then((hash) => {
      if (!cancelled) setCurrentHash(hash);
    });
    return () => {
      cancelled = true;
    };
  }, [sourceCv]);

  const composed = useMemo(() => {
    if (!previewing || !overlay || !sourceCv || !currentHash) return null;
    return composeApprovedTailoredResume(sourceCv, overlay, currentHash, profile?.skills ?? [], {
      projectSelection: overlay.projectSelection,
    });
  }, [previewing, overlay, sourceCv, currentHash, profile]);

  const selectedProjects = useMemo(() => (sourceCv ? selectSourceProjects(sourceCv) : []), [sourceCv]);
  const selectedIds = selectedProjects.map((project) => project.id).join('\n');
  const selectionApproved =
    selectedProjects.length === 0 || (overlay?.projectSelection?.projectIds.join('\n') ?? null) === selectedIds;
  const selectionStale = !!overlay?.projectSelection && !selectionApproved;
  const needsRebase = !!rebasePlan?.inputsChanged;
  // The main process refuses approval and export for the same reasons (#419); showing them here
  // tells the candidate why, and where to fix it, before they press anything.
  const sourceGaps = useMemo(() => (sourceCv ? describeCvSourceGaps(sourceCv) : []), [sourceCv]);
  const sourceBlocked = sourceGaps.length > 0;

  const canPreview = !!overlay && !!cvId && !!vacancyKey && !!sourceCv;

  const refresh = useCallback(async () => {
    if (!cvId || !vacancyKey) return null;
    const fresh = await window.workspace.getCvEvidenceOverlay(cvId, vacancyKey);
    setOverlay(fresh);
    await loadPlan(fresh);
    return fresh;
  }, [cvId, vacancyKey, loadPlan]);

  const handlePreview = useCallback(async () => {
    if (!cvId || !vacancyKey || !sourceCv) return;
    setError(undefined);
    setApproved(false);
    try {
      // Re-fetched fresh rather than trusting this component's own `overlay` state: the sibling
      // RequirementMapping panel (mounted alongside this one in CvAssistant) writes to the same
      // overlay row independently, and this component has no subscription to those writes.
      // Composing against a stale snapshot could show wrong blockers -- stale "still needs review"
      // warnings, or a missing one introduced after this component's initial mount fetch.
      const fresh = await refresh();
      setCurrentHash(await sha256HexOfSource(sourceCv));
      if (!fresh) {
        setError('Match the job requirements above first.');
        return;
      }
      setPreviewing(true);
    } catch (err) {
      setError(describeError(err, 'could not build the composed CV'));
    }
  }, [cvId, vacancyKey, sourceCv, refresh]);

  const runCaseAction = useCallback(
    async (action: (record: CvEvidenceOverlayRecord) => Promise<CvEvidenceOverlayRecord>, fallback: string) => {
      if (!overlay) return null;
      setError(undefined);
      try {
        const updated = await action(overlay);
        setOverlay(updated);
        await loadPlan(updated);
        return updated;
      } catch (err) {
        setError(describeError(err, fallback));
        await refresh();
        return null;
      }
    },
    [overlay, loadPlan, refresh],
  );

  const handleApproveProjects = useCallback(async () => {
    setApprovingProjects(true);
    setApproved(false);
    try {
      await runCaseAction((record) => window.workspace.approveCvProjectSelection(record.id, record.caseRevision), 'could not approve the project selection');
    } finally {
      setApprovingProjects(false);
    }
  }, [runCaseAction]);

  const handleRebase = useCallback(async () => {
    setRebasing(true);
    setApproved(false);
    try {
      await runCaseAction((record) => window.workspace.rebaseCvEvidenceOverlay(record.id, record.caseRevision), 'could not move this tailoring onto your current CV');
    } finally {
      setRebasing(false);
    }
  }, [runCaseAction]);

  const handleApprove = useCallback(async () => {
    if (!composed || composed.blockers.length > 0) return;
    setApproving(true);
    try {
      // #421: the main process re-derives wording from facts and re-verifies every gap itself
      // before writing anything -- this call sends only the overlay's id and the revision this
      // component last saw, never the wording or resume it computed for the preview above. A
      // conflicting write elsewhere fails the call rather than silently overwriting it; refetch so
      // the panel shows the real current state rather than the stale one this request was built
      // against.
      const updated = await runCaseAction((record) => window.workspace.approveCvEvidenceOverlay(record.id, record.caseRevision), 'could not approve this CV');
      if (updated) setApproved(true);
    } finally {
      setApproving(false);
    }
  }, [composed, runCaseAction]);

  // A snapshot approved under an older document format keeps its facts and wording, but cannot be
  // exported until the case is approved again, which builds it under the current format.
  const needsReapproval = !!overlay && snapshotNeedsReapproval(overlay);
  const isApproved = approved || overlay?.state === 'candidate_approved';
  // Files exported before the last approval, or under an older document format, no longer match it.
  const filesOutOfDate =
    !!overlay &&
    isApproved &&
    (needsReapproval || (['pdf', 'docx'] as const).some((format) => cvArtifactStatus(overlay, format) === 'stale'));

  if (!cvId || !vacancy) return null;

  const resume = composed?.resume;

  return (
    <div className="card card-border rounded-box border-base-300 bg-base-100">
      <div className="card-body gap-3 p-5">
        <div id="cv-step-approve" tabIndex={-1} className="card-title flex flex-wrap items-center gap-2 text-base font-bold outline-none">
          Your tailored CV
          {!isApproved ? (
            <span className="badge badge-warning badge-sm">Not approved yet</span>
          ) : filesOutOfDate ? (
            <span className="badge badge-warning badge-sm">Approved with files out of date</span>
          ) : (
            <span className="badge badge-success badge-sm">Approved</span>
          )}
        </div>
        <p className="text-sm text-base-content/60">
          Built from your CV and the wording you approved. The quick draft below is separate and is never
          approved.
        </p>

        {!overlay && (
          <div className="text-sm text-base-content/60">
            Match the job requirements above first.
          </div>
        )}

        {overlay && sourceBlocked && (
          <div className="alert alert-warning text-sm" role="alert" aria-label="CV details not checked">
            <div>
              <div className="font-medium">Check your CV details before approving or exporting</div>
              <ul className="list-disc pl-4">
                {sourceGaps.map((gap) => (
                  <li key={gap}>{gap}</li>
                ))}
              </ul>
              {onReviewSource ? (
                <>
                  <p className="mt-1">Check your CV details first. Review what was read from it, and confirm.</p>
                  <button type="button" className="btn btn-warning btn-sm mt-2" onClick={onReviewSource}>
                    Review this CV now
                  </button>
                </>
              ) : (
                <p className="mt-1">Check your CV details first. Open this CV in the CV Library, review what was read from it, and confirm.</p>
              )}
            </div>
          </div>
        )}

        {overlay && needsRebase && rebasePlan && (
          <section className="rounded-box border border-warning p-4 text-sm" aria-label="Changes since this tailoring was started">
            <h3 className="font-medium">Your CV changed</h3>
            <p className="mt-1 text-base-content/70">
              Update this tailoring to your current CV. What still fits is kept.
            </p>
            <details className="mt-2">
              <summary className="cursor-pointer font-medium">See what changes</summary>
              {rebasePlan.changes.length > 0 ? (
                <ul className="mt-2 list-disc pl-5">
                  {rebasePlan.changes.map((change) => (
                    <li key={`${change.area}-${change.detail}`}>
                      <span className="font-medium">{change.area}:</span> {change.detail}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2">
                  {rebasePlan.baselineKnown
                    ? 'Your CV was saved or reviewed again, with nothing different that matters here.'
                    : 'There is no earlier copy of your CV, so the changes cannot be listed.'}
                </p>
              )}
              {rebasePlan.droppedVariants.length > 0 && (
                <div className="mt-2">
                  <div className="font-medium">Wording that would be dropped</div>
                  <ul className="list-disc pl-5">
                    {rebasePlan.droppedVariants.map((variant) => (
                      <li key={variant.variantId}>
                        {variant.text} ({variant.reason})
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {rebasePlan.orphanedFactIds.length > 0 && (
                <p className="mt-2">
                  {rebasePlan.orphanedFactIds.length}{' '}
                  {rebasePlan.orphanedFactIds.length === 1 ? 'fact no longer matches' : 'facts no longer match'} a role or
                  project.
                </p>
              )}
              {rebasePlan.staleFacts.length > 0 && (
                <div className="mt-2">
                  <div className="font-medium">Facts that need your review again</div>
                  <ul className="list-disc pl-5">
                    {rebasePlan.staleFacts.map((stale) => (
                      <li key={stale.factId}>
                        {stale.activity || 'A fact'} ({stale.reason})
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {rebasePlan.requirementIdsToReview.length > 0 && (
                <p className="mt-2">
                  {rebasePlan.requirementIdsToReview.length}{' '}
                  {rebasePlan.requirementIdsToReview.length === 1 ? 'requirement needs' : 'requirements need'} another look.
                </p>
              )}
            </details>
            <button type="button" className="btn btn-warning mt-3" onClick={() => void handleRebase()} disabled={rebasing}>
              {rebasing && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
              Update to my current CV
            </button>
          </section>
        )}

        {overlay && selectedProjects.length > 0 && (
          <section className="rounded-box border border-base-300 p-4 text-sm" aria-label="Project selection">
            <h3 id="cv-step-projects" tabIndex={-1} className="font-medium outline-none">Projects on this CV</h3>
            <p className="mt-1 text-base-content/70">
              Pinned projects always appear. The project limit in your reviewed CV
              {sourceCv && sourceCv.maxProjects > 0 ? ` (${sourceCv.maxProjects})` : ' (no limit)'} decides how many of the
              rest are added.
            </p>
            <ol className="mt-2 list-decimal pl-5">
              {selectedProjects.map((project) => (
                <li key={project.id}>
                  {project.name || 'Unnamed project'}
                  {project.pinned ? ' (pinned)' : ''}
                </li>
              ))}
            </ol>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn btn-outline"
                onClick={() => void handleApproveProjects()}
                disabled={approvingProjects || selectionApproved || needsRebase || sourceBlocked}
              >
                {approvingProjects && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
                {selectionApproved ? 'Projects approved' : 'Approve these projects'}
              </button>
              {selectionStale && (
                <span className="text-warning" role="status">
                  The projects changed since you approved them. Approve the new selection.
                </span>
              )}
            </div>
          </section>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-outline" onClick={() => void handlePreview()} disabled={!canPreview}>
            Preview approved CV
          </button>
          {composed && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleApprove()}
              disabled={composed.blockers.length > 0 || approving || (isApproved && !needsReapproval) || needsRebase || sourceBlocked}
            >
              {approving && <span className="loading loading-spinner loading-xs" aria-hidden="true" />}
              {isApproved && !needsReapproval ? 'Approved' : needsReapproval ? 'Approve again' : 'Approve CV'}
            </button>
          )}
        </div>

        {error && (
          <ErrorBanner>
            {error}
          </ErrorBanner>
        )}
        {approved && (
          <div className="text-sm font-medium" role="status">
            Approved. This is the version ready for export.
          </div>
        )}

        {overlay && isApproved && needsReapproval && (
          <WarningBanner role="status">
            This CV was approved before the current document format. Your facts and wording are kept. Preview and approve
            it again to export it.
          </WarningBanner>
        )}

        {overlay && isApproved && !needsReapproval && <CvArtifactPanel overlay={overlay} onOverlayChange={setOverlay} sourceGaps={sourceGaps} {...(onReviewSource ? { onReviewSource } : {})} />}

        {composed && composed.blockers.length > 0 && (
          <div className="alert alert-warning text-sm" role="alert">
            <ul className="list-disc pl-4">
              {composed.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          </div>
        )}

        {resume && (
          <div className="rounded-box border border-base-300 p-4 text-sm" aria-label="Composed CV preview">
            <div className="mb-3">
              <div className="text-base font-semibold">{resume.contact.name}</div>
              {resume.contact.title && <div>{resume.contact.title}</div>}
              <div className="text-xs text-base-content/60">
                {[resume.contact.location, resume.contact.email, resume.contact.phone, ...resume.contact.links]
                  .filter((part) => part.trim() !== '')
                  .join(' | ')}
              </div>
            </div>
            {resume.summary && <p className="mb-3">{resume.summary}</p>}
            {resume.experience.length > 0 && <div className="mb-1 text-xs font-semibold uppercase">Experience</div>}
            {resume.experience.map((entry, index) => (
              <div key={`${index}-${entry.company}-${entry.title}`} className="mb-2">
                <div className="font-medium">
                  {entry.title} at {entry.company}
                  {entry.engagement === 'client_engagement' && entry.client ? ` (client: ${entry.client})` : ''}
                </div>
                {entry.dates && <div className="text-xs text-base-content/60">{entry.dates}</div>}
                <ul className="list-disc pl-5">
                  {entry.bullets.map((bullet) => (
                    <li key={bullet}>{bullet}</li>
                  ))}
                </ul>
              </div>
            ))}
            {resume.projects.length > 0 && <div className="mb-1 text-xs font-semibold uppercase">Projects</div>}
            {resume.projects.map((project, index) => (
              <div key={`${index}-${project.name}`} className="mb-2">
                <div className="font-medium">
                  {project.name}
                  {project.role ? `, ${project.role}` : ''}
                </div>
                {project.dates && <div className="text-xs text-base-content/60">{project.dates}</div>}
                <p>{project.description}</p>
              </div>
            ))}
            {resume.education.length > 0 && <div className="mb-1 text-xs font-semibold uppercase">Education</div>}
            {resume.education.map((entry, index) => (
              <div key={`${index}-${entry.institution}`} className="mb-1">
                {entry.credential}, {entry.institution}
                {entry.dates ? ` (${entry.dates})` : ''}
              </div>
            ))}
            {resume.skills.length > 0 && (
              <div className="mt-2 text-xs text-base-content/60">Skills: {resume.skills.join(', ')}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
